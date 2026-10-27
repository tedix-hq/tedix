import { describe, expect, it, vi } from "vite-plus/test";
import { requireDestructiveToolApproval } from "./governance";
import type { AppTool, ServerContext } from "./server-context";

function context(options: {
	optedIn: string[];
	askForClasses?: string[];
	callerOrganizationId?: string;
}) {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "github",
		app: { organizationId: "org-1" },
		callerIdentity: {
			authType: "tedi",
			tediId: "tedi-1",
			organizationId: options.callerOrganizationId ?? "org-1",
		},
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					requireExplicitApprovalPolicy: false,
					autonomy: {
						version: 1,
						maxRisk: "medium",
						...(options.askForClasses
							? { askForClasses: options.askForClasses }
							: {}),
					},
				})),
				resolveActionTypeOptIn: vi.fn(
					async ({ actionType }: { actionType: string }) =>
						options.optedIn.includes(actionType)
							? { approved: true, grantId: `grant-${actionType}` }
							: { approved: false, grantId: null },
				),
				recordPolicyToolApproval: vi.fn(async () => ({
					approvalRequestId: null,
				})),
			},
		},
	} as unknown as ServerContext;
}

/** A third-party GitHub write: an external side effect that asks by default. */
function githubTool(toolId: string, actionType: string | null): AppTool {
	return {
		toolId,
		title: toolId,
		actionType,
		writeCapability: "write",
		config: {
			transport: "mcp",
			mcpToolName: toolId.split("__").at(-1),
			auth: { type: "connection", connectionId: "github" },
		},
		meta: {
			"com.tedix/policy": {
				riskTier: "external_side_effect",
				blastRadius: "external_system",
			},
		},
		annotations: { readOnlyHint: false, destructiveHint: false },
	} as unknown as AppTool;
}

const comment = githubTool("github__add_issue_comment", "comment_on_issue");
const close = githubTool("github__close_issue", "close_issue");
const undeclared = githubTool("github__add_issue_comment", null);

async function gate(ctx: ServerContext, tool: AppTool) {
	return requireDestructiveToolApproval(ctx, tool, tool.annotations, {
		args: { issue: 7, body: "Looks good" },
	});
}

describe("owner-declared safe action types", () => {
	it("runs an opted-in action type without asking and names the setting", async () => {
		const ctx = context({ optedIn: ["comment_on_issue"] });
		expect(await gate(ctx, comment)).toBeNull();
		const governance = ctx.apiClient.mcpGovernance;
		expect(governance.resolveActionTypeOptIn).toHaveBeenCalledWith({
			organizationId: "org-1",
			actionType: "comment_on_issue",
		});
		expect(governance.recordPolicyToolApproval).toHaveBeenCalledWith({
			organizationId: "org-1",
			appSlug: "github",
			toolId: "github__add_issue_comment",
			reason:
				'Allowed without asking by the organization setting for "comment on issue"',
			operationId: "action_type:comment_on_issue",
			tediId: "tedi-1",
		});
	});

	it("still asks before an action type the organization did not opt in", async () => {
		const ctx = context({ optedIn: ["comment_on_issue"] });
		const result = await gate(ctx, close);
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain(
			"Human approval required",
		);
		expect(
			ctx.apiClient.mcpGovernance.recordPolicyToolApproval,
		).not.toHaveBeenCalled();
	});

	it("still asks for a tool with no declared action type", async () => {
		const ctx = context({ optedIn: ["comment_on_issue"] });
		const result = await gate(ctx, undeclared);
		expect(result?.isError).toBe(true);
		expect(
			ctx.apiClient.mcpGovernance.resolveActionTypeOptIn,
		).not.toHaveBeenCalled();
	});

	it("never auto-approves a platform-critical action type", async () => {
		const ctx = context({ optedIn: ["send_email", "delete_data"] });
		for (const tool of [
			githubTool("mail__send_message", "send_email"),
			githubTool("github__remove_label", "delete_data"),
		])
			expect((await gate(ctx, tool))?.isError).toBe(true);
		expect(
			ctx.apiClient.mcpGovernance.resolveActionTypeOptIn,
		).not.toHaveBeenCalled();
	});

	it("never auto-approves a destructive tool, whatever it declares", async () => {
		const ctx = context({ optedIn: ["comment_on_issue"] });
		const destructive = {
			...comment,
			writeCapability: "destructive",
		} as AppTool;
		expect((await gate(ctx, destructive))?.isError).toBe(true);
	});

	it("respects a person's 'ask me' correction over the opt-in", async () => {
		for (const askForClasses of [
			["action_type:comment_on_issue"],
			["tool:github:github__add_issue_comment"],
			["*"],
		]) {
			const ctx = context({ optedIn: ["comment_on_issue"], askForClasses });
			expect((await gate(ctx, comment))?.isError).toBe(true);
		}
	});

	it("ignores an opt-in for a caller from another organization", async () => {
		const ctx = context({
			optedIn: ["comment_on_issue"],
			callerOrganizationId: "org-2",
		});
		expect((await gate(ctx, comment))?.isError).toBe(true);
		expect(
			ctx.apiClient.mcpGovernance.resolveActionTypeOptIn,
		).not.toHaveBeenCalled();
	});
});
