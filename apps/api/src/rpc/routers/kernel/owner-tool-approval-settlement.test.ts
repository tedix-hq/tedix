import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { tediApprovalRequests } from "@tedix/db/schema/approvals";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	reclaim: vi.fn(),
	record: vi.fn(),
	receipt: vi.fn(),
	audit: vi.fn(),
	member: vi.fn(),
	organization: vi.fn(),
	executor: vi.fn(),
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	claimOwnerToolApprovalExecution: mocks.claim,
	reclaimOwnerToolApprovalExecution: mocks.reclaim,
	recordOwnerToolApprovalExecution: mocks.record,
}));
vi.mock("@tedix/db/queries/approval-simulations", async (load) => ({
	...(await load<object>()),
	recordApprovalExecutionReceipt: mocks.receipt,
}));
vi.mock("@tedix/db/queries/audit", async (load) => ({
	...(await load<object>()),
	insertAuditEvent: mocks.audit,
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
import {
	ownerToolReplayAppSlug,
	parseOwnerToolCallPayload,
	retryOwnerToolCallExecution,
	setOwnerToolExecutorForTest,
	settleOwnerToolCallApproval,
} from "./owner-tool-approval-settlement";
import { settleHomeToolWriteApproval } from "./write-approval-settlement";
import { resolveReplayTool } from "./write-executor";

type ApprovalRow = typeof tediApprovalRequests.$inferSelect;
const context = {
	db: {},
	env: { MCP_URL: "https://mcp.example.test", MCP_SERVICE: { fetch: vi.fn() } },
	authType: "user",
	user: { sub: "owner-1" },
} as unknown as BaseContext;
const payload = {
	kind: "mcp_tool_call",
	initiatedByUserId: "owner-1",
	appSlug: "connect",
	toolId: "example_unified_tedix__delete_descope_aih_mcp_client",
	target: {
		transport: "rpc",
		endpoint: "descopeAih/deleteMcpClient",
		mcpToolName: null,
		providerId: null,
		configHash: "abc",
	},
	args: { id: "client-1", mcpServerId: "server-1", confirmDestructive: true },
	fingerprint: "fp-1",
};
function approval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		tediId: "anchor",
		orgId: "org-1",
		actionType: "mcp.tool_call",
		description: "Delete descope aih mcp client",
		payload,
		status: "approved",
		createdAt: "2026-10-28T10:00:00.000Z",
		expiresAt: "2099-10-29T10:00:00.000Z",
		resolvedAt: "2026-10-28T10:48:00.000Z",
		resolvedBy: "user:owner-1",
		resolution: null,
		workflowId: null,
		...overrides,
	} as ApprovalRow;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.claim.mockResolvedValue(true);
	mocks.reclaim.mockResolvedValue(true);
	mocks.record.mockResolvedValue(undefined);
	mocks.receipt.mockResolvedValue({});
	mocks.audit.mockResolvedValue(undefined);
	mocks.member.mockResolvedValue({ role: "owner", status: "active" });
	mocks.organization.mockResolvedValue({ id: "org-1", slug: "example" });
	mocks.executor.mockResolvedValue({ ok: true, data: { success: true } });
	setOwnerToolExecutorForTest(mocks.executor);
});
afterEach(() => setOwnerToolExecutorForTest(null));

describe("owner tool approval settlement", () => {
	it("runs the stored call once on approval and records the result on the request", async () => {
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: approval(),
				status: "approved",
			}),
		).toBe("succeeded");
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "11111111-1111-4111-8111-111111111111",
				organizationId: "org-1",
			}),
		);
		expect(mocks.executor).toHaveBeenCalledTimes(1);
		expect(mocks.executor).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalRequestId: "11111111-1111-4111-8111-111111111111",
				payload: {
					appSlug: "example-unified",
					toolId: payload.toolId,
					args: payload.args,
					organizationId: "org-1",
					initiatedByUserId: "owner-1",
				},
			}),
		);
		expect(mocks.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				execution: expect.objectContaining({
					status: "executed",
					summary: "Delete descope aih mcp client",
				}),
			}),
		);
		expect(mocks.receipt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				outcome: "succeeded",
				idempotencyKey: "owner-tool-call:11111111-1111-4111-8111-111111111111",
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "approval.executed",
				actorId: "owner-1",
			}),
		);
	});
	it("reaches the stored call through the shared Home settle point", async () => {
		expect(
			await settleHomeToolWriteApproval(context, {
				approval: approval(),
				status: "approved",
			}),
		).toBe("succeeded");
		expect(mocks.executor).toHaveBeenCalledTimes(1);
	});
	it("runs once when approved twice or settled again", async () => {
		const row = approval();
		await settleOwnerToolCallApproval(context, {
			approval: row,
			status: "approved",
		});
		mocks.claim.mockResolvedValue(false);
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: row,
				status: "approved",
			}),
		).toBe("unknown");
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: approval({
					payload: {
						...payload,
						execution: { status: "executed", startedAt: "x" },
					},
				}),
				status: "approved",
			}),
		).toBe("succeeded");
		expect(mocks.executor).toHaveBeenCalledTimes(1);
	});
	it.each(["rejected", "cancelled"] as const)(
		"never runs a %s decision",
		async (status) => {
			expect(
				await settleOwnerToolCallApproval(context, {
					approval: approval({ status }),
					status,
				}),
			).toBe("not_applicable");
			expect(mocks.claim).not.toHaveBeenCalled();
			expect(mocks.executor).not.toHaveBeenCalled();
		},
	);
	it("never runs an expired request (the claim refuses it)", async () => {
		mocks.claim.mockResolvedValue(false);
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: approval({ expiresAt: "2026-10-28T19:01:00.000Z" }),
				status: "approved",
			}),
		).toBe("unknown");
		expect(mocks.executor).not.toHaveBeenCalled();
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("records a failure when the target changed at apply time", async () => {
		mocks.executor.mockResolvedValue({
			ok: false,
			error:
				'Tool "example_unified_tedix__delete_descope_aih_mcp_client" is no longer available on example-unified',
		});
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: approval(),
				status: "approved",
			}),
		).toBe("failed");
		expect(mocks.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				execution: expect.objectContaining({
					status: "failed",
					error: expect.stringContaining("no longer available"),
				}),
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "approval.execution_failed" }),
		);
	});
	it.each([
		["requester", [{ role: "member", status: "active" }]],
		[
			"approver",
			[
				{ role: "owner", status: "active" },
				{ role: "owner", status: "suspended" },
			],
		],
	])(
		"refuses to run when the %s lost authority at apply time",
		async (who, members) => {
			for (const member of members) mocks.member.mockResolvedValueOnce(member);
			expect(
				await settleOwnerToolCallApproval(context, {
					approval: approval(),
					status: "approved",
				}),
			).toBe("failed");
			expect(mocks.executor).not.toHaveBeenCalled();
			expect(mocks.record).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					execution: expect.objectContaining({
						status: "failed",
						error: expect.stringContaining(who),
					}),
				}),
			);
		},
	);
	it("ignores policy rows and other payload kinds", async () => {
		expect(
			parseOwnerToolCallPayload({
				kind: "mcp_tool_call",
				appSlug: "tedix-unified",
				toolId: "tedix__add_comment",
				platformOperation: "work_items",
				initiatedByUserId: "owner-1",
			}),
		).toBeNull();
		expect(
			await settleOwnerToolCallApproval(context, {
				approval: approval({
					actionType: "home.tool_write",
					payload: { kind: "home_tool_write" },
				}),
				status: "approved",
			}),
		).toBe("not_applicable");
	});
	it("replays a connect request on the organization gateway and others where they ran", () => {
		expect(
			ownerToolReplayAppSlug({
				appSlug: "connect",
				organizationId: "org-1",
				organizationSlug: "example",
			}),
		).toBe("example-unified");
		expect(
			ownerToolReplayAppSlug({
				appSlug: "mail",
				organizationId: "org-1",
				organizationSlug: "example",
			}),
		).toBe("mail");
	});
	it("finds the mounted tool by its source-qualified name", () => {
		const tools = [
			{ name: "tedix__delete_descope_aih_mcp_client" },
			{ name: "mail__send" },
			{ name: "send" },
		];
		expect(
			resolveReplayTool(
				tools,
				"example_unified_tedix__delete_descope_aih_mcp_client",
			)?.name,
		).toBe("tedix__delete_descope_aih_mcp_client");
		expect(resolveReplayTool(tools, "mail__send")?.name).toBe("mail__send");
		expect(resolveReplayTool(tools, "other_mail__delete")).toBeUndefined();
		// A bare suffix is not a mount: "send" must not stand in for "mail__send".
		expect(resolveReplayTool(tools, "example_unified__send")).toBeUndefined();
	});
	it("records a platform-side failure as retryable and a refusal as final", async () => {
		mocks.executor.mockResolvedValueOnce({
			ok: false,
			error: 'Tool "x" is no longer available on example-unified',
			retryable: true,
		});
		await settleOwnerToolCallApproval(context, {
			approval: approval(),
			status: "approved",
		});
		expect(mocks.record).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				execution: expect.objectContaining({
					status: "failed",
					retryable: true,
				}),
			}),
		);
		mocks.executor.mockResolvedValueOnce({
			ok: false,
			error: "insufficient_scope: platform:admin",
		});
		await settleOwnerToolCallApproval(context, {
			approval: approval(),
			status: "approved",
		});
		expect(mocks.record).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				execution: expect.objectContaining({
					status: "failed",
					retryable: false,
				}),
			}),
		);
	});
});

describe("owner tool approval retry", () => {
	/** The retry's outcome, awaiting the claimed run the way the procedure does without `waitUntil`. */
	const retry = async (
		input: Parameters<typeof retryOwnerToolCallExecution>[1],
	) => {
		const outcome = await retryOwnerToolCallExecution(context, input);
		return typeof outcome === "string" ? outcome : outcome.run;
	};
	it("treats a run cut off before the gateway consumed the approval as failed", async () => {
		const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
		expect(
			await retry({
				approval: failed({
					status: "running",
					startedAt: stale,
					attempt: 2,
					retriedBy: "admin-1",
				}),
				retriedBy: "admin-2",
			}),
		).toBe("succeeded");
		expect(mocks.reclaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ staleBefore: expect.any(String) }),
		);
		expect(
			await retry({
				approval: failed({
					status: "running",
					startedAt: new Date().toISOString(),
				}),
				retriedBy: "admin-2",
			}),
		).toBe("still_running");
		expect(mocks.executor).toHaveBeenCalledTimes(1);
	});
	const failed = (
		execution: Record<string, unknown> = {
			status: "failed",
			startedAt: "2026-10-28T13:23:45.692Z",
			finishedAt: "2026-10-28T13:23:46.311Z",
			error:
				'Tool "example_unified_tedix__delete_descope_aih_mcp_client" is no longer available on example-unified',
		},
	) => approval({ payload: { ...payload, execution } });

	it("runs the stored call once more and records the second attempt", async () => {
		expect(
			await retry({
				approval: failed(),
				retriedBy: "admin-2",
			}),
		).toBe("succeeded");
		expect(mocks.reclaim).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: "11111111-1111-4111-8111-111111111111",
				organizationId: "org-1",
				retriedBy: "admin-2",
			}),
		);
		expect(mocks.executor).toHaveBeenCalledTimes(1);
		expect(mocks.executor).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalRequestId: "11111111-1111-4111-8111-111111111111",
				payload: expect.objectContaining({
					appSlug: "example-unified",
					toolId: payload.toolId,
					args: payload.args,
				}),
			}),
		);
		expect(mocks.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				execution: expect.objectContaining({
					status: "executed",
					attempt: 2,
					retriedBy: "admin-2",
				}),
			}),
		);
		expect(mocks.receipt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				idempotencyKey:
					"owner-tool-call:11111111-1111-4111-8111-111111111111:retry",
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "approval.executed",
				metadata: expect.objectContaining({ attempt: 2, retriedBy: "admin-2" }),
			}),
		);
	});
	it("re-checks requester and approver authority before the retry", async () => {
		mocks.member.mockResolvedValueOnce({ role: "member", status: "active" });
		expect(
			await retry({
				approval: failed(),
				retriedBy: "admin-2",
			}),
		).toBe("failed");
		expect(mocks.executor).not.toHaveBeenCalled();
	});
	it("refuses a second retry, a refusal by the target and a run that did not fail", async () => {
		expect(
			await retry({
				approval: failed({
					status: "failed",
					startedAt: "x",
					error: "Provider tool call failed (transport)",
					attempt: 2,
					retriedBy: "admin-2",
				}),
				retriedBy: "admin-2",
			}),
		).toBe("already_retried");
		expect(
			await retry({
				approval: failed({
					status: "failed",
					startedAt: "x",
					error: "insufficient_scope: platform:admin",
					retryable: false,
				}),
				retriedBy: "admin-2",
			}),
		).toBe("not_retryable");
		expect(
			await retry({
				approval: failed({ status: "executed", startedAt: "x" }),
				retriedBy: "admin-2",
			}),
		).toBe("not_failed");
		expect(
			await retry({
				approval: approval({ status: "expired" }),
				retriedBy: "admin-2",
			}),
		).toBe("not_owner_tool_call");
		expect(mocks.reclaim).not.toHaveBeenCalled();
		expect(mocks.executor).not.toHaveBeenCalled();
	});
	it("never runs when the retry claim is lost", async () => {
		mocks.reclaim.mockResolvedValue(false);
		expect(
			await retry({
				approval: failed(),
				retriedBy: "admin-2",
			}),
		).toBe("claim_lost");
		expect(mocks.executor).not.toHaveBeenCalled();
		expect(mocks.record).not.toHaveBeenCalled();
	});
});
