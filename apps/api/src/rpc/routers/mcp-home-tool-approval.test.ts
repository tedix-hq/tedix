import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	approval: vi.fn(),
	member: vi.fn(),
	run: vi.fn(),
	consume: vi.fn(),
	principal: vi.fn(),
	consumed: new Set<string>(),
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	getApprovalRequestById: mocks.approval,
	consumeHomeToolApprovalCall: mocks.consume,
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/principals",
	async (load) => ({
		...(await load<object>()),
		getExternalAgentPrincipal: mocks.principal,
	}),
);
vi.mock("@tedix/db/queries/kernel-runtime-runs", async (load) => ({
	...(await load<object>()),
	getKernelRuntimeRun: mocks.run,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

const input = {
	organizationId: "org-1",
	userId: "user-1",
	appSlug: "example-unified",
	toolName: "os.create_os_output",
	approvalRequestId: "11111111-1111-4111-8111-111111111111",
	args: {
		kind: "sheet",
		title: "Opportunities",
		workspaceId: "workspace-1",
		content: { kind: "sheet", columns: ["Topic"], rows: [["Pricing"]] },
	},
};
const payload = {
	kind: "home_tool_write",
	organizationId: input.organizationId,
	initiatedByUserId: input.userId,
	appSlug: input.appSlug,
	toolName: input.toolName,
	args: input.args,
	homeRunId: "run-1",
	conversationId: "chat-1",
	transport: "codemode",
};
const approval = {
	orgId: "org-1",
	actionType: "home.tool_write",
	status: "approved",
	resolvedBy: "user:owner-1",
	payload,
};
const run = {
	status: "running",
	conversationId: "chat-1",
	metadata: {
		approvalStatus: "approved",
		kernelWriteExecutedAt: "2026-10-25T12:00:00.000Z",
	},
};
function client(authType = "service-binding") {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType,
			organizationId: "org-1",
			db: {},
			env: {},
			headers: new Headers(
				authType === "service-binding" ? { "X-Service-Binding": "true" } : {},
			),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.consumed.clear();
	mocks.consume.mockImplementation(
		async (_db, call: { id: string; slot: string }) => {
			const key = `${call.id}:${call.slot}`;
			if (mocks.consumed.has(key)) return false;
			mocks.consumed.add(key);
			return true;
		},
	);
	mocks.approval.mockResolvedValue(approval);
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.run.mockResolvedValue(run);
});
describe("Home approval dispatch receipt", () => {
	it.each(["user:owner-1", "policy"])(
		"accepts the exact claimed write resolved by %s",
		async (resolvedBy) => {
			mocks.approval.mockResolvedValue({ ...approval, resolvedBy });
			expect(await client().resolveHomeToolApproval(input)).toEqual({
				approved: true,
			});
			expect(mocks.run).toHaveBeenCalledWith(expect.anything(), {
				id: "run-1",
				organizationId: "org-1",
			});
		},
	);
	it.each([
		{ userId: "other-user" },
		{ appSlug: "other-app" },
		{ toolName: "other.create_os_output" },
		{ args: { ...input.args, title: "Changed" } },
		{ args: { ...input.args, workspaceId: "other-workspace" } },
		{
			args: {
				...input.args,
				content: { ...input.args.content, rows: [["Changed"]] },
			},
		},
	])(
		"rejects a changed caller, target or nested argument: %j",
		async (patch) => {
			expect(
				await client().resolveHomeToolApproval({ ...input, ...patch }),
			).toEqual({ approved: false });
		},
	);
	it.each([
		undefined,
		{ ...approval, orgId: "other-org" },
		{ ...approval, status: "pending" },
		{ ...approval, payload: { ...payload, kind: "mcp_owner_tool" } },
	])("rejects an unavailable or different approval: %j", async (row) => {
		mocks.approval.mockResolvedValue(row);
		expect(await client().resolveHomeToolApproval(input)).toEqual({
			approved: false,
		});
	});
	it.each([
		undefined,
		{ ...run, status: "completed" },
		{ ...run, status: "requires_approval" },
		{ ...run, conversationId: "other-chat" },
		{ ...run, metadata: {} },
	])("rejects an unclaimed or terminal run: %j", async (row) => {
		mocks.run.mockResolvedValue(row);
		expect(await client().resolveHomeToolApproval(input)).toEqual({
			approved: false,
		});
	});
	it("authorizes each approved call once per credential path", async () => {
		expect(await client().resolveHomeToolApproval(input)).toEqual({
			approved: true,
		});
		expect(await client().resolveHomeToolApproval(input)).toEqual({
			approved: false,
		});
		const fallback = { ...input, credential: "tenant" as const };
		expect(await client().resolveHomeToolApproval(fallback)).toEqual({
			approved: true,
		});
		expect(await client().resolveHomeToolApproval(fallback)).toEqual({
			approved: false,
		});
		expect(mocks.consume).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: input.approvalRequestId,
				organizationId: "org-1",
				slot: expect.stringMatching(/^tenant_[0-9a-f]{64}$/),
			}),
		);
	});
	it("consumes nothing when the receipt does not match", async () => {
		mocks.run.mockResolvedValue({ ...run, status: "completed" });
		await client().resolveHomeToolApproval(input);
		await client().resolveHomeToolApproval({ ...input, userId: "other" });
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("rejects a suspended initiator", async () => {
		mocks.member.mockResolvedValue({ status: "suspended", role: "owner" });
		expect(await client().resolveHomeToolApproval(input)).toEqual({
			approved: false,
		});
	});
	describe("agent-started run (no initiator)", () => {
		const agentPayload = { ...payload, initiatedByUserId: null };
		const asApprover = {
			...input,
			userId: "owner-1",
			credential: "tenant" as const,
		};
		beforeEach(() => {
			mocks.approval.mockResolvedValue({ ...approval, payload: agentPayload });
		});
		it.each(["user:owner-1", "owner-1"])(
			"binds the receipt to the approving human (%s) on the tenant credential, once",
			async (resolvedBy) => {
				mocks.approval.mockResolvedValue({
					...approval,
					resolvedBy,
					payload: agentPayload,
				});
				expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
					approved: true,
				});
				// Approving twice writes once.
				expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
					approved: false,
				});
				expect(mocks.consume).toHaveBeenCalledTimes(2);
			},
		);
		it.each([
			["the approver's personal credential", { credential: "user" as const }],
			["another member", { userId: "user-1" }],
			["changed arguments", { args: { ...input.args, title: "Changed" } }],
		])("never carries %s", async (_label, patch) => {
			expect(
				await client().resolveHomeToolApproval({ ...asApprover, ...patch }),
			).toEqual({ approved: false });
			expect(mocks.consume).not.toHaveBeenCalled();
		});
		it.each(["policy", "tedi_1", null])(
			"refuses when no human approved it (%s)",
			async (resolvedBy) => {
				mocks.approval.mockResolvedValue({
					...approval,
					resolvedBy,
					payload: agentPayload,
				});
				// A tedi or service principal is never an organization member.
				mocks.member.mockImplementation(async (_db, _org, userId: string) =>
					userId === "tedi_1" ? undefined : { status: "active", role: "owner" },
				);
				expect(
					await client().resolveHomeToolApproval({
						...asApprover,
						userId: resolvedBy ?? "owner-1",
					}),
				).toEqual({ approved: false });
				expect(mocks.consume).not.toHaveBeenCalled();
			},
		);
		it("refuses at apply time once the approver lost access", async () => {
			mocks.member.mockResolvedValue({ status: "suspended", role: "owner" });
			expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
				approved: false,
			});
			expect(mocks.consume).not.toHaveBeenCalled();
		});
	});
	describe("recorded starting agent", () => {
		const agentPrincipalId = "22222222-2222-4222-8222-222222222222";
		const asApprover = {
			...input,
			userId: "owner-1",
			credential: "tenant" as const,
		};
		beforeEach(() => {
			mocks.approval.mockResolvedValue({
				...approval,
				payload: {
					...payload,
					initiatedByUserId: null,
					initiatedByAgentPrincipalId: agentPrincipalId,
				},
			});
			mocks.principal.mockResolvedValue({
				status: "active",
				credentialBindingType: "owner_user",
				credentialBindingId: "agent-owner",
			});
		});
		it("keeps the exact approver-bound receipt and consumes it once", async () => {
			expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
				approved: true,
			});
			expect(mocks.principal).toHaveBeenCalledWith(expect.anything(), {
				organizationId: "org-1",
				principalId: agentPrincipalId,
			});
			expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
				approved: false,
			});
		});
		it.each([
			["suspended", { status: "suspended" }],
			["retired", { status: "retired" }],
			["removed", null],
		])(
			"refuses a %s starting agent without consuming the receipt",
			async (_, principal) => {
				mocks.principal.mockResolvedValue(principal);
				expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
					approved: false,
				});
				expect(mocks.consume).not.toHaveBeenCalled();
			},
		);
		it.each([
			["removed", undefined],
			["suspended", { status: "suspended", role: "owner" }],
			["without Home access", { status: "active", role: "viewer" }],
		])("refuses an agent whose owning member is %s", async (_, member) => {
			mocks.member.mockImplementation(async (_db, _org, userId) =>
				userId === "agent-owner" ? member : { status: "active", role: "owner" },
			);
			expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
				approved: false,
			});
			expect(mocks.consume).not.toHaveBeenCalled();
		});
		it("honors an owning member's explicit Home grant", async () => {
			mocks.member.mockImplementation(async (_db, _org, userId) =>
				userId === "agent-owner"
					? { status: "active", role: "viewer", customPermissions: ["os:run"] }
					: { status: "active", role: "owner" },
			);
			expect(await client().resolveHomeToolApproval(asApprover)).toEqual({
				approved: true,
			});
		});
		it("does not accept another human or a personal credential for the receipt", async () => {
			for (const patch of [
				{ userId: "agent-owner" },
				{ credential: "user" as const },
				{ args: { ...input.args, title: "Changed" } },
			]) {
				expect(
					await client().resolveHomeToolApproval({ ...asApprover, ...patch }),
				).toEqual({ approved: false });
			}
			expect(mocks.consume).not.toHaveBeenCalled();
		});
	});
	it("rejects public callers and another gateway organization", async () => {
		await expect(
			client("user").resolveHomeToolApproval(input),
		).rejects.toThrow();
		await expect(
			client().resolveHomeToolApproval({
				...input,
				organizationId: "other-org",
			}),
		).rejects.toThrow(/does not match/);
	});
});
