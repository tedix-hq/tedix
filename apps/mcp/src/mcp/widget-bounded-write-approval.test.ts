import { describe, expect, it, vi } from "vite-plus/test";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import { requireDestructiveToolApproval } from "./governance";
import type { ServerContext } from "./server-context";

const revision = {
	toolId: "tedix__revise_os_output",
	title: "Revise output",
	config: { transport: "rpc", endpoint: "osWorkspaces/outputs/revise" },
	meta: {
		"com.tedix/policy": {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
	},
};
// The widget relay supports tasks, but cannot present elicitation prompts.
const extra = {
	_meta: {
		[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
		[MCP_CLIENT_CAPABILITIES_META_KEY]: {
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		},
	},
};

function context(authType = "oauth") {
	return {
		server: { server: { elicitInput: vi.fn() } },
		callerIdentity: { authType, userId: "fictional-reviewer" },
		app: { organizationId: "fictional-org" },
		appSlug: "fictional-unified",
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					requireExplicitApprovalPolicy: false,
				})),
				resolveToolApprovalGrant: vi.fn(async () => ({ approved: false })),
			},
		},
	} as unknown as ServerContext;
}

describe("widget bounded writes", () => {
	it("lets a signed-in reviewer save feedback without standing agent autonomy", async () => {
		const ctx = context();
		expect(
			await requireDestructiveToolApproval(
				ctx,
				revision,
				{ destructiveHint: false },
				{ extra },
			),
		).toBeNull();
		expect(ctx.server.server.elicitInput).not.toHaveBeenCalled();
	});

	it.each(["external_agent", "tedi", "service", "anonymous"])(
		"keeps %s writes gated without autonomy",
		async (authType) => {
			expect(
				await requireDestructiveToolApproval(
					context(authType),
					revision,
					{ destructiveHint: false },
					{ extra },
				),
			).not.toBeNull();
		},
	);

	it.each(["always", "once", "work_item"])(
		"preserves explicit %s approval",
		async (approvalPolicy) => {
			expect(
				await requireDestructiveToolApproval(
					context(),
					{ ...revision, config: { ...revision.config, approvalPolicy } },
					{ destructiveHint: false },
					{ extra },
				),
			).not.toBeNull();
		},
	);

	it.each(["*", "tool:fictional-unified:tedix__revise_os_output"])(
		"preserves organization ask-for class: %s",
		async (classId) => {
			const ctx = context();
			vi.mocked(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).mockResolvedValue({
				requireExplicitApprovalPolicy: false,
				autonomy: { version: 1, maxRisk: "medium", askForClasses: [classId] },
			});
			expect(
				await requireDestructiveToolApproval(
					ctx,
					revision,
					{ destructiveHint: false },
					{ extra },
				),
			).not.toBeNull();
		},
	);

	it.each(["invite_member", "assign_role", "publish_message"])(
		"keeps protected effect %s gated",
		async (toolId) => {
			expect(
				await requireDestructiveToolApproval(
					context(),
					{ ...revision, toolId },
					{ destructiveHint: false },
					{ extra },
				),
			).not.toBeNull();
		},
	);

	it("preserves destructive and unclassified write gates", async () => {
		for (const binding of [revision, { ...revision, meta: null }]) {
			expect(
				await requireDestructiveToolApproval(
					context(),
					binding,
					{ destructiveHint: binding === revision },
					{ extra },
				),
			).not.toBeNull();
		}
	});
});
