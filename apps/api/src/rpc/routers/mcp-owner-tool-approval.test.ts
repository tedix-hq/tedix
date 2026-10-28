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
	pending: vi.fn(),
	skill: vi.fn(),
	skillBySlug: vi.fn(),
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
	findPendingOwnerToolApproval: mocks.pending,
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", async (load) => ({
	...(await load<object>()),
	getSkillEntry: mocks.skill,
	getSkillEntryBySlug: mocks.skillBySlug,
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
	mocks.pending.mockResolvedValue(undefined);
	mocks.skill.mockResolvedValue(activeSkill);
	mocks.skillBySlug.mockResolvedValue(activeSkill);
});
const activeSkill = {
	id: "skill-1",
	title: "Example Reddit research",
	lifecycleState: "active",
	revision: 4,
	files: { "scripts/workflow.ts": "export default {}" },
};
const skillStart = {
	...input,
	appSlug: "example-unified",
	toolId: "tedi_1__run_skill_workflow",
	target: { transport: "rpc", endpoint: "skills/runWorkflow" },
	args: { skillId: "skill-1", confirmDestructive: true, reason: "run" },
};
describe("owner skill starts", () => {
	it("approves an active owner's start of an active executable skill", async () => {
		expect(
			await client().resolveOwnerSkillStart({
				organizationId: "org-1",
				userId: "owner-1",
				skillId: "skill-1",
			}),
		).toEqual({ approved: true, skillId: "skill-1", revision: 4 });
		expect(mocks.skill).toHaveBeenCalledWith(
			expect.anything(),
			"skill-1",
			"org-1",
		);
	});
	it.each([
		["a member", { role: "member", status: "active" }, activeSkill],
		["a suspended owner", { role: "owner", status: "suspended" }, activeSkill],
		["a draft", undefined, { ...activeSkill, lifecycleState: "draft" }],
		[
			"an archived skill",
			undefined,
			{ ...activeSkill, lifecycleState: "archived" },
		],
		["a skill without a workflow", undefined, { ...activeSkill, files: {} }],
		["a skill of another organization", undefined, undefined],
	])("refuses %s", async (_label, member, skill) => {
		if (member) mocks.member.mockResolvedValue(member);
		mocks.skill.mockResolvedValue(skill);
		expect(
			await client().resolveOwnerSkillStart({
				organizationId: "org-1",
				userId: "owner-1",
				skillId: "skill-1",
			}),
		).toEqual({ approved: false });
	});
	it("refuses another organization than the gateway names", async () => {
		await expect(
			client().resolveOwnerSkillStart({
				organizationId: "org-2",
				userId: "owner-1",
				skillId: "skill-1",
			}),
		).rejects.toThrow(/does not match the gateway context/);
	});
	it("titles a parked skill start in plain language", async () => {
		await client().requestOwnerToolApproval(skillStart);
		const row = mocks.create.mock.calls[0]![1];
		expect(row.description).toMatch(/^Run skill: Example Reddit research\./);
		expect(row.description).not.toContain("run_skill_workflow");
	});
	it("parks nothing for a skill the API would refuse", async () => {
		mocks.skill.mockResolvedValue(undefined);
		await expect(client().requestOwnerToolApproval(skillStart)).rejects.toThrow(
			/Skill not found/,
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
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
		expect(mocks.create.mock.calls[0]![1].description).toMatch(
			/^Run the send tool\./,
		);
	});
	it.each([
		[
			"execute",
			{ code: "return 1", token: "private-value" },
			"Run the submitted code",
		],
		["run", { command: "echo hello" }, "Run the submitted command"],
		["execute", {}, "Run the execute tool"],
		["createContactNote", {}, "Create Contact Note"],
	])(
		"describes %s with its app, requester and organization",
		async (toolId, args, action) => {
			mocks.member.mockResolvedValue({
				role: "owner",
				status: "active",
				name: "Alex",
			});
			mocks.organization.mockResolvedValue({
				slug: "example",
				name: "Example Team",
			});
			await client().requestOwnerToolApproval({ ...input, toolId, args });
			const description = mocks.create.mock.calls[0]![1].description;
			expect(description).toBe(
				`${action}. In mail for Alex (Example Team). Nothing has run yet; approving runs this exact call once.`,
			);
			expect(description).not.toContain("private-value");
			expect(description).not.toContain("return 1");
		},
	);
	it("reuses the open request for an identical call", async () => {
		mocks.pending.mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
		});
		expect(await client().requestOwnerToolApproval(input)).toMatchObject({
			approved: false,
			status: "pending",
			approvalRequestId: "11111111-1111-4111-8111-111111111111",
		});
		expect(mocks.pending).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org-1" }),
		);
		expect(mocks.create).not.toHaveBeenCalled();
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
	// Live 24 Oct 2026: withServiceAuth leaves context.organizationId unset, so
	// every production request was refused as an organization mismatch.
	function headerOnlyClient(orgHeader: string) {
		return createRouterClient(mcpGovernanceContractRouter, {
			context: {
				authType: "service-binding",
				db: {},
				env: { ENVIRONMENT: "production" },
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": orgHeader,
				}),
				url: new URL("https://api.test/rpc"),
				rateLimiter: { limit: async () => ({ success: true }) },
			} as BaseContext,
		});
	}
	it("takes the gateway organization from the service-binding header", async () => {
		await expect(
			headerOnlyClient("org-1").requestOwnerToolApproval(input),
		).resolves.toMatchObject({ approved: false, status: "pending" });
		expect(mocks.create).toHaveBeenCalled();
	});
	it("refuses an approval for another organization than the header names", async () => {
		await expect(
			headerOnlyClient("org-2").requestOwnerToolApproval(input),
		).rejects.toThrow(/does not match the gateway context/);
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
		[{ userId: "other-owner" }, /requester differ/],
		[{ toolId: "delete" }, /tool differ/],
		[{ target: { transport: "mcp", mcpToolName: "delete" } }, /target differ/],
		[{ args: { body: "Changed content" } }, /arguments differ/],
		[{ organizationId: "org-2" }, /./],
	])("rejects changed approval bindings %j", async (patch, reason) => {
		const retry = await seed();
		await expect(
			client().requestOwnerToolApproval({ ...retry, ...patch }),
		).rejects.toThrow(reason);
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	// The platform replays a `connect` approval on the organization gateway,
	// where the same tool carries no mount prefix and a different config hash.
	it.each([
		{ appSlug: "example-unified", toolId: "send" },
		{ appSlug: "example-unified", toolId: "mail__send" },
		{ target: { ...input.target, configHash: "other" } },
	])(
		"consumes the same call reached through another mount %j",
		async (patch) => {
			const retry = await seed();
			expect(
				await client().requestOwnerToolApproval({ ...retry, ...patch }),
			).toMatchObject({ approved: true, status: "consumed" });
			expect(mocks.consume).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					fingerprint: mocks.create.mock.calls[0]![1].payload.fingerprint,
				}),
			);
		},
	);
	it("refuses a mount-prefixed name of a different tool", async () => {
		const retry = await seed();
		await expect(
			client().requestOwnerToolApproval({ ...retry, toolId: "mail__delete" }),
		).rejects.toThrow(/tool differ/);
	});
	it.each([
		["consumed", { consumedAt: "2026-10-28T11:00:00.000Z" }],
		["executed", { execution: { status: "executed", startedAt: "x" } }],
		["failed", { execution: { status: "failed", startedAt: "x" } }],
	])("reports an approval already used as %s", async (status, extra) => {
		const retry = await seed();
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			payload: { ...row.payload, ...extra },
			status: "approved",
			resolvedBy: "owner-1",
		});
		mocks.consume.mockResolvedValue(false);
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: false,
			status,
		});
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
	it("records a platform-default gateway approval as an approved policy row", async () => {
		const result = await client().recordPolicyToolApproval({
			organizationId: "org-1",
			appSlug: "example-unified",
			toolId: "tedi_1__run_skill_workflow",
			reason: "Starting runs run without approval (platform default)",
			operationId: "runs",
			tediId: "tedi-1",
		});
		expect(result.approvalRequestId).toEqual(expect.any(String));
		const [, row, audit] = mocks.create.mock.calls[0]!;
		expect(row).toMatchObject({
			orgId: "org-1",
			tediId: "anchor",
			actionType: "mcp.tool_call",
			automaticApproval: {
				tediId: "policy",
				reason: "Starting runs run without approval (platform default)",
			},
			payload: { platformOperation: "runs", initiatedByTediId: "tedi-1" },
		});
		expect(audit).toMatchObject({
			action: "approval.approved",
			actorType: "tedi",
			metadata: { resolvedBy: "policy" },
		});
		await expect(
			client().recordPolicyToolApproval({
				organizationId: "org-2",
				appSlug: "example-unified",
				toolId: "add_comment",
				reason: "Work items run without approval (platform default)",
				operationId: "work_items",
			}),
		).rejects.toThrow(/does not match the gateway context/);
		expect(mocks.create).toHaveBeenCalledTimes(1);
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
