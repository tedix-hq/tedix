import { describe, expect, it, vi } from "vite-plus/test";
import {
	resolveToolAnnotations,
	withDerivedToolOperationalRiskPolicy,
} from "@tedix/api-contract/schemas/tools";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import { assertCodeModeInnerToolAuthorized } from "./codemode-auth";
import { requireDestructiveToolApproval } from "./governance";
import type { AppTool, ServerContext } from "./server-context";

// These are the RPC/write bindings projected by tool-schema-sync into D1.
const bindings = [
	["work", "report_work_agent_session_status", "workAgentSessions/report"],
	["work", "heartbeat_work_item_attempt", "workItems/heartbeatAttempt"],
	["work", "add_comment", "workItems/addComment"],
	["work", "start_work_item_attempt", "workItems/startAttempt"],
	["work", "settle_work_item_attempt", "workItems/settleAttempt"],
	["os", "create_os_output", "osWorkspaces/outputs/create"],
	["os", "revise_os_output", "osWorkspaces/outputs/revise"],
] as const;

function tool(
	toolId: string,
	endpoint: string,
): Pick<AppTool, "toolId" | "title" | "config" | "writeCapability" | "meta"> {
	const config = { transport: "rpc", endpoint };
	return {
		toolId,
		title: toolId,
		config,
		writeCapability: "write",
		meta:
			withDerivedToolOperationalRiskPolicy({
				config,
				writeCapability: "write",
			}) ?? null,
	};
}

function context(authType: "oauth" | "external_agent", maxRisk = "medium") {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "connect",
		app: { organizationId: "fictional-org" },
		callerIdentity: {
			authType,
			userId: "fictional-owner",
			...(authType === "external_agent"
				? {
						externalAgentPrincipalId: "fictional-agent",
						externalAgentSessionId: "fictional-session",
					}
				: {}),
			scopes: ["mcp:work.write", "mcp:apps.write"],
		},
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					autonomy: { version: 1, maxRisk },
				})),
				resolveToolApprovalGrant: vi.fn(async () => ({ approved: false })),
			},
		},
	} as unknown as ServerContext;
}

const tasks = {
	_meta: {
		[MCP_CLIENT_CAPABILITIES_META_KEY]: {
			extensions: { [MCP_TASKS_EXTENSION]: {} },
			elicitation: {},
		},
	},
};

describe.each(["oauth", "external_agent"] as const)(
	"coding writes under %s standing consent",
	(authType) => {
		it.each(bindings)(
			"allows %s.%s in native and Code Mode paths",
			async (_namespace, toolId, endpoint) => {
				const binding = tool(toolId, endpoint);
				for (const allowSyncMrtr of [true, false]) {
					const ctx = context(authType);
					expect(
						await requireDestructiveToolApproval(
							ctx,
							binding,
							resolveToolAnnotations(binding),
							{ extra: tasks, allowSyncMrtr },
						),
					).toBeNull();
					expect(
						ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
					).toHaveBeenCalledWith({ organizationId: "fictional-org" });
					expect(ctx.server.server.elicitInput).not.toHaveBeenCalled();
				}
			},
		);

		it.each(bindings)(
			"preserves always-ask and destructive gates for %s.%s",
			async (_namespace, toolId, endpoint) => {
				const binding = tool(toolId, endpoint);
				for (const destructive of [true, false]) {
					const guarded = {
						...binding,
						config: {
							...binding.config,
							...(destructive ? {} : { approvalPolicy: "always" }),
						},
					};
					expect(
						await requireDestructiveToolApproval(
							context(authType),
							guarded,
							{ destructiveHint: destructive, readOnlyHint: false },
							{ extra: tasks, autoConfirmAgent: true, allowSyncMrtr: false },
						),
					).not.toBeNull();
				}
			},
		);
	},
);

it.each([undefined, tasks])(
	"uses verified external-agent identity independently of client capabilities (%s)",
	async (extra) => {
		const ctx = context("external_agent", "low");
		const binding = tool("add_comment", "workItems/addComment");
		expect(
			await requireDestructiveToolApproval(
				ctx,
				binding,
				resolveToolAnnotations(binding),
				{ extra, allowSyncMrtr: false },
			),
		).not.toBeNull();
		expect(
			ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
		).toHaveBeenCalledWith({ organizationId: "fictional-org" });
	},
);

it.each(bindings)(
	"standing consent cannot grant missing scopes for %s.%s",
	(namespace, toolId, endpoint) => {
		const ctx = context("external_agent");
		ctx.callerIdentity!.scopes = ["mcp:work.read", "mcp:apps.read"];
		expect(() =>
			assertCodeModeInnerToolAuthorized(ctx, tool(toolId, endpoint), namespace),
		).toThrow();
	},
);

it.each([undefined, { version: 1, maxRisk: "medium" }] as const)(
	"allows only verified own lifecycle writes without relying on autonomy (%s)",
	async (autonomy) => {
		for (const endpoint of [
			"workItems/heartbeatAttempt",
			"workItems/addComment",
			"workItems/settleAttempt",
			"externalAgentIdentity/recordKnowledgeCheckpoint",
			"osWorkspaces/outputs/create",
			"osWorkspaces/outputs/revise",
		]) {
			const ctx = context("external_agent");
			vi.mocked(
				ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
			).mockResolvedValue({
				requireExplicitApprovalPolicy: false,
				autonomy,
			});
			const resolve = vi.fn(async () => ({ approved: true }));
			Object.assign(ctx.apiClient.mcpGovernance, {
				resolveAgentLifecycleAuthorization: resolve,
			});
			const binding = tool("bounded_lifecycle_write", endpoint);
			expect(
				await requireDestructiveToolApproval(
					ctx,
					binding,
					resolveToolAnnotations(binding),
					{ args: { id: "own-work" }, allowSyncMrtr: false },
				),
			).toBeNull();
			expect(resolve).toHaveBeenCalledWith({
				organizationId: "fictional-org",
				principalId: "fictional-agent",
				sessionId: "fictional-session",
				endpoint,
				args: { id: "own-work" },
			});
		}
	},
);

it("keeps unowned writes and explicit or human-reserved gates closed without autonomy", async () => {
	const ctx = context("external_agent");
	vi.mocked(
		ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
	).mockResolvedValue({ requireExplicitApprovalPolicy: false });
	const resolve = vi.fn(async () => ({ approved: false }));
	Object.assign(ctx.apiClient.mcpGovernance, {
		resolveAgentLifecycleAuthorization: resolve,
	});
	const binding = tool("add_comment", "workItems/addComment");
	expect(
		await requireDestructiveToolApproval(
			ctx,
			binding,
			resolveToolAnnotations(binding),
			{ args: { id: "other-work" }, allowSyncMrtr: false },
		),
	).not.toBeNull();
	resolve.mockResolvedValue({ approved: true });
	for (const approvalPolicy of ["always", "work_item", "once"]) {
		expect(
			await requireDestructiveToolApproval(
				ctx,
				{ ...binding, config: { ...binding.config, approvalPolicy } },
				resolveToolAnnotations(binding),
				{ args: { id: "own-work" }, allowSyncMrtr: false },
			),
		).not.toBeNull();
	}
	expect(
		await requireDestructiveToolApproval(
			ctx,
			binding,
			{ destructiveHint: true },
			{ args: { id: "own-work" }, allowSyncMrtr: false },
		),
	).not.toBeNull();
});

it.each([false, true])(
	"consults the once grant even with autonomy (approved: %s)",
	async (approved) => {
		const ctx = context("external_agent");
		vi.mocked(
			ctx.apiClient.mcpGovernance.resolveToolApprovalGrant,
		).mockResolvedValue({
			approved,
			grantId: approved ? "one-time-grant" : null,
		});
		const binding = tool("add_comment", "workItems/addComment");
		binding.config = { ...binding.config, approvalPolicy: "once" };
		const result = await requireDestructiveToolApproval(
			ctx,
			binding,
			resolveToolAnnotations(binding),
			{ allowSyncMrtr: false },
		);
		expect(result === null).toBe(approved);
		expect(
			ctx.apiClient.mcpGovernance.resolveToolApprovalGrant,
		).toHaveBeenCalledWith(expect.objectContaining({ grantKind: "once" }));
	},
);

it.each(["add_member", "assign_role", "invite_member"])(
	"does not exempt member governance for %s",
	async (toolId) => {
		const ctx = context("external_agent");
		vi.mocked(
			ctx.apiClient.mcpGovernance.resolveAgentTransportPolicy,
		).mockResolvedValue({ requireExplicitApprovalPolicy: false });
		const resolve = vi.fn(async () => ({ approved: true }));
		Object.assign(ctx.apiClient.mcpGovernance, {
			resolveAgentLifecycleAuthorization: resolve,
		});
		const binding = tool(toolId, "workItems/addComment");
		expect(
			await requireDestructiveToolApproval(
				ctx,
				binding,
				resolveToolAnnotations(binding),
				{ args: { id: "own-work" }, allowSyncMrtr: false },
			),
		).not.toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	},
);
