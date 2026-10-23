import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	organization: vi.fn(),
	tedis: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	consume: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	createApprovalRequestWithAudit: mocks.create,
	getApprovalRequestById: mocks.get,
	consumeOwnerToolApproval: mocks.consume,
	getApprovalAnchor: mocks.tedis,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";
const input = {
	organizationId: "org-1",
	userId: "owner-1",
	appSlug: "mail",
	toolId: "send",
	target: { transport: "mcp", mcpToolName: "send" },
	args: { body: "Approved content" },
};
function client(authType = "service-binding") {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType,
			organizationId: "org-1",
			db: {},
			env: { ENVIRONMENT: "production" },
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
	mocks.member.mockResolvedValue({ role: "owner", status: "active" });
	mocks.organization.mockResolvedValue({ slug: "example" });
	mocks.tedis.mockResolvedValue({ id: "anchor" });
	mocks.create.mockImplementation(async (_db, row) => row);
	mocks.consume.mockResolvedValue(true);
});
describe("owner gateway approvals", () => {
	it("creates an audited pending request in the existing OS queue", async () => {
		const result = await client().requestOwnerToolApproval(input);
		expect(result).toMatchObject({ approved: false, status: "pending" });
		expect(result.url).toContain(`/work/approvals#${result.approvalRequestId}`);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actionType: "mcp.tool_call",
				payload: expect.objectContaining({
					initiatedByUserId: "owner-1",
					args: input.args,
				}),
			}),
			expect.objectContaining({
				actorId: "owner-1",
				action: "approval.requested",
			}),
		);
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it.each([
		{ role: "member", status: "active" },
		{ role: "owner", status: "suspended" },
		undefined,
	])("rejects unauthorized membership %j", async (member) => {
		mocks.member.mockResolvedValue(member);
		await expect(client().requestOwnerToolApproval(input)).rejects.toThrow(
			/owner or admin/,
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("requires a trusted service binding", async () => {
		await expect(
			client("user").requestOwnerToolApproval(input),
		).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
	});
	async function seed(status = "approved") {
		const result = await client().requestOwnerToolApproval(input);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status,
			resolvedBy: status === "approved" ? "owner-1" : null,
		});
		return { ...input, approvalRequestId: result.approvalRequestId };
	}
	it("consumes an approved exact call once", async () => {
		const retry = await seed();
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
			status: "consumed",
		});
		mocks.consume.mockResolvedValue(false);
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: false,
		});
	});
	it.each(["pending", "rejected", "cancelled", "expired"])(
		"does not execute a %s decision",
		async (status) => {
			expect(
				await client().requestOwnerToolApproval(await seed(status)),
			).toMatchObject({ approved: false, status });
			expect(mocks.consume).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ userId: "other-owner" },
		{ appSlug: "other-app" },
		{ toolId: "delete" },
		{ target: { transport: "mcp", mcpToolName: "delete" } },
		{ args: { body: "Changed content" } },
		{ organizationId: "org-2" },
	])("rejects changed approval bindings %j", async (patch) => {
		const retry = await seed();
		await expect(
			client().requestOwnerToolApproval({ ...retry, ...patch }),
		).rejects.toThrow();
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("requires the approver to remain an active owner/admin", async () => {
		const retry = await seed();
		mocks.member
			.mockResolvedValueOnce({ role: "owner", status: "active" })
			.mockResolvedValueOnce({ role: "member", status: "active" });
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: false,
		});
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("accepts the OS user-prefixed approver identity", async () => {
		const retry = await seed();
		const approval = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...approval,
			status: "approved",
			resolvedBy: "user:owner-1",
		});
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
		});
		expect(mocks.member).toHaveBeenLastCalledWith(
			expect.anything(),
			"org-1",
			"owner-1",
		);
	});
});
