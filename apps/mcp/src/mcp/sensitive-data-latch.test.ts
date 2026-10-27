import { describe, expect, it, vi } from "vite-plus/test";
import type { SensitiveDataLatch } from "@tedix/api-contract/schemas/sensitive-data-latch";
import {
	callToolResultText,
	requireDestructiveToolApproval,
} from "./governance";
import { callerRunRef, recordSensitiveRead } from "./sensitive-data-latch";
import type { ServerContext } from "./server-context";

const LATCH: SensitiveDataLatch = {
	version: 1,
	latchedAt: "2026-10-27T10:00:00.000Z",
	source: {
		appSlug: "hr",
		toolId: "list_salaries",
		connectionProviderId: "hr-system",
		reason: "connection_restricted",
	},
};

function runAgent(input: {
	latch: SensitiveDataLatch | null | "unavailable";
	caller?: Record<string, unknown>;
	governance?: Record<string, unknown>;
}) {
	const resolveRunSensitiveDataLatch = vi.fn(async () => {
		if (input.latch === "unavailable") throw new Error("api down");
		return { known: true, latch: input.latch };
	});
	const agent = {
		server: { server: { elicitInput: vi.fn() } },
		app: { organizationId: "org-1" },
		appSlug: "cms",
		env: {},
		ctx: { waitUntil: vi.fn() },
		callerIdentity: {
			authType: "service",
			organizationId: "org-1",
			tediId: "tedi-1",
			skillRunId: "run-1",
			skillId: "skill-1",
			workflowExecutionEpoch: 0,
			...input.caller,
		},
		apiClient: {
			mcpGovernance: {
				resolveRunSensitiveDataLatch,
				...input.governance,
			},
		},
	} as unknown as ServerContext;
	return { agent, resolveRunSensitiveDataLatch };
}

const publishTool = {
	toolId: "content_publish",
	title: "Publish",
	publicEgress: true,
	config: { transport: "rpc", endpoint: "cms/publish" },
};
// Declared egress that no other gate reserves for a person.
const exportTool = {
	toolId: "export_report",
	title: "Export report",
	publicEgress: true,
	config: { transport: "rpc", endpoint: "reports/export" },
};

describe("sensitive-data latch at the approval gate", () => {
	it("refuses public egress after a sensitive read, with the reason and next step", async () => {
		const { agent } = runAgent({ latch: LATCH });
		const result = await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(result?.isError).toBe(true);
		const text = callToolResultText(result!);
		expect(text).toContain("read data marked sensitive");
		expect(text).toContain("list_salaries on the hr-system connection");
		expect(text).toContain("owner or admin");
		expect(text).toContain("clear_run_sensitive_data_latch");
		expect(text).toContain("No side effect was executed");
	});

	it("allows the same egress for a run without a sensitive read", async () => {
		// A standing grant approves the export; only the latch could stop it.
		const governance = {
			resolveToolApprovalGrant: vi.fn(async () => ({
				approved: true,
				grantId: "grant-1",
			})),
		};
		const grantedExport = {
			...exportTool,
			config: { ...exportTool.config, approvalPolicy: "always" },
		};
		const { agent, resolveRunSensitiveDataLatch } = runAgent({
			latch: null,
			governance,
		});
		expect(
			await requireDestructiveToolApproval(agent, grantedExport, {
				destructiveHint: true,
			}),
		).toBeNull();
		expect(resolveRunSensitiveDataLatch).toHaveBeenCalledWith({
			organizationId: "org-1",
			runRef: { kind: "skill_run", id: "run-1" },
		});
		const latched = await requireDestructiveToolApproval(
			runAgent({ latch: LATCH, governance }).agent,
			grantedExport,
			{ destructiveHint: true },
		);
		expect(callToolResultText(latched!)).toContain(
			"read data marked sensitive",
		);
	});

	it("does not look up the latch for a caller outside any run", async () => {
		const { agent, resolveRunSensitiveDataLatch } = runAgent({
			latch: LATCH,
			caller: { skillRunId: undefined, requestRunId: undefined },
		});
		await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(resolveRunSensitiveDataLatch).not.toHaveBeenCalled();
	});

	it("refuses egress even on a Home approval replay of a latched kernel run", async () => {
		const resolveHomeToolApproval = vi.fn(async () => ({ approved: true }));
		const { agent } = runAgent({
			latch: LATCH,
			caller: {
				kernel: true,
				userId: "user-1",
				skillRunId: undefined,
				requestRunId: "home-1",
			},
			governance: { resolveHomeToolApproval },
		});
		const result = await requireDestructiveToolApproval(
			agent,
			publishTool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"com.tedix/homeApprovalRequestId":
							"00000000-0000-4000-8000-000000000009",
					},
				},
			},
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("read data marked sensitive");
		expect(resolveHomeToolApproval).not.toHaveBeenCalled();
	});

	it("fails closed on egress when the latch cannot be read", async () => {
		const { agent } = runAgent({ latch: "unavailable" });
		const result = await requireDestructiveToolApproval(agent, publishTool, {
			readOnlyHint: false,
		});
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("could not be checked");
	});

	it("refuses a durable-grant auto-approval while latched", async () => {
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-1",
		}));
		const { agent } = runAgent({
			latch: LATCH,
			governance: { resolveToolApprovalGrant },
		});
		const result = await requireDestructiveToolApproval(
			agent,
			{
				toolId: "update_record",
				title: "Update",
				config: { approvalPolicy: "always" },
			},
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("automatic approval");
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
	});

	it("still honors the grant for the same tool when the run is not latched", async () => {
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-1",
		}));
		const { agent } = runAgent({
			latch: null,
			governance: { resolveToolApprovalGrant },
		});
		expect(
			await requireDestructiveToolApproval(
				agent,
				{
					toolId: "update_record",
					title: "Update",
					config: { approvalPolicy: "always" },
				},
				{ destructiveHint: true },
				{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
			),
		).toBeNull();
		expect(resolveToolApprovalGrant).toHaveBeenCalled();
	});
});

describe("sensitive-data latch and an admin's action-type opt-in", () => {
	// A third-party write whose declared action type an admin let run without asking.
	const comment = {
		toolId: "github__add_issue_comment",
		title: "Comment on issue",
		actionType: "comment_on_issue",
		writeCapability: "write" as const,
		config: {
			transport: "mcp",
			mcpToolName: "add_issue_comment",
			auth: { type: "connection", connectionId: "github" },
		},
		meta: {
			"com.tedix/policy": {
				riskTier: "external_side_effect",
				blastRadius: "external_system",
			},
		},
	};
	const governance = () => ({
		resolveAgentTransportPolicy: vi.fn(async () => ({
			requireExplicitApprovalPolicy: false,
			autonomy: { version: 1, maxRisk: "medium" },
		})),
		resolveActionTypeOptIn: vi.fn(async () => ({
			approved: true,
			grantId: "grant-comment",
		})),
		recordPolicyToolApproval: vi.fn(async () => ({
			approvalRequestId: null,
		})),
	});
	const annotations = { readOnlyHint: false, destructiveHint: false };

	it("asks a person instead of using the opt-in once the run is latched", async () => {
		const clear = governance();
		const { agent } = runAgent({
			latch: null,
			caller: { authType: "tedi" },
			governance: clear,
		});
		expect(
			await requireDestructiveToolApproval(agent, comment, annotations, {
				args: { issue: 7, body: "Looks good" },
			}),
		).toBeNull();
		expect(clear.resolveActionTypeOptIn).toHaveBeenCalled();

		const latched = governance();
		const result = await requireDestructiveToolApproval(
			runAgent({
				latch: LATCH,
				caller: { authType: "tedi" },
				governance: latched,
			}).agent,
			comment,
			annotations,
			{ args: { issue: 7, body: "Looks good" } },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("automatic approval");
		expect(callToolResultText(result!)).toContain("read data marked sensitive");
		expect(latched.resolveActionTypeOptIn).not.toHaveBeenCalled();
	});
});

describe("recording a sensitive read", () => {
	it("maps the caller to its skill run or Home run", () => {
		expect(
			callerRunRef({ skillRunId: "run-1", requestRunId: "home-1" }),
		).toEqual({ kind: "skill_run", id: "run-1" });
		expect(callerRunRef({ requestRunId: "home-1" })).toEqual({
			kind: "kernel_run",
			id: "home-1",
		});
		expect(callerRunRef({})).toBeNull();
	});

	it("latches declared sensitive tools and connected reads, and nothing else", async () => {
		const latchRunSensitiveData = vi.fn(async () => ({
			known: true,
			latch: LATCH,
		}));
		const agent = {
			app: { organizationId: "org-1" },
			appSlug: "hr",
			callerIdentity: { authType: "service", skillRunId: "run-1" },
			apiClient: { mcpGovernance: { latchRunSensitiveData } },
		} as unknown as ServerContext;

		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_salaries", sensitiveData: true },
				null,
			),
		).toBe(true);
		expect(latchRunSensitiveData).toHaveBeenLastCalledWith({
			organizationId: "org-1",
			runRef: { kind: "skill_run", id: "run-1" },
			source: {
				appSlug: "hr",
				toolId: "list_salaries",
				connectionProviderId: null,
				toolDeclaredSensitive: true,
			},
		});

		await recordSensitiveRead(
			agent,
			{ toolId: "get_message", sensitiveData: false },
			{
				version: 1,
				kind: "connected_collection_read",
				source: {
					appId: "app-1",
					appSlug: "google-gmail",
					toolName: "get_message",
					connectionProviderId: "google-gmail",
				},
				collection: "messages",
				observedAt: "2026-10-27T10:00:00.000Z",
			},
		);
		expect(latchRunSensitiveData).toHaveBeenLastCalledWith(
			expect.objectContaining({
				source: expect.objectContaining({
					connectionProviderId: "google-gmail",
					toolDeclaredSensitive: false,
				}),
			}),
		);

		latchRunSensitiveData.mockClear();
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_apps", sensitiveData: false },
				null,
			),
		).toBe(true);
		expect(latchRunSensitiveData).not.toHaveBeenCalled();
	});

	it("withholds the read when the latch cannot be recorded for a run", async () => {
		const agent = {
			app: { organizationId: "org-1" },
			appSlug: "hr",
			callerIdentity: { authType: "service", requestRunId: "home-1" },
			apiClient: {
				mcpGovernance: {
					latchRunSensitiveData: vi.fn(async () => {
						throw new Error("api down");
					}),
				},
			},
		} as unknown as ServerContext;
		expect(
			await recordSensitiveRead(
				agent,
				{ toolId: "list_salaries", sensitiveData: true },
				null,
			),
		).toBe(false);
	});
});
