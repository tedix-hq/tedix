import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { canonicalDigest } from "../../lib/blueprint-digest";
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
	policyTool: vi.fn(),
	policyRevisions: vi.fn(),
	policyGenerations: vi.fn(),
	policyFences: vi.fn(),
	policyProfile: vi.fn(),
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
vi.mock("@tedix/db/queries/tools", async (load) => ({
	...(await load<object>()),
	getToolByIdForOrganization: mocks.policyTool,
}));
vi.mock("@tedix/db/queries/tenant-tool-policy", async (load) => ({
	...(await load<object>()),
	findTenantToolPolicyRevisions: mocks.policyRevisions,
	findTenantToolPolicySubjectFences: mocks.policyFences,
	getProviderIdentityProfile: mocks.policyProfile,
	getTenantToolPolicyResourceGenerations: mocks.policyGenerations,
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
	mocks.policyTool.mockResolvedValue(undefined);
	mocks.policyRevisions.mockResolvedValue([]);
	mocks.policyGenerations.mockResolvedValue([]);
	mocks.policyFences.mockResolvedValue([]);
	mocks.policyProfile.mockResolvedValue(undefined);
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
	it("parks a target admin request and links to the target OS", async () => {
		mocks.member.mockImplementation(async (_db, orgId) =>
			orgId === "target" ? { role: "admin", status: "active" } : undefined,
		);
		mocks.organization.mockResolvedValue({ slug: "target" });
		const result = await headerOnlyClient("target").requestOwnerToolApproval({
			...input,
			organizationId: "target",
			appSlug: "connect",
		});
		expect(result).toMatchObject({ approved: false, status: "pending" });
		expect(new URL(result.url).hostname).toBe("target.os.tedix.dev");
		expect(mocks.member).toHaveBeenCalledWith(
			expect.anything(),
			"target",
			input.userId,
		);
		expect(mocks.organization).toHaveBeenCalledWith(
			expect.anything(),
			"target",
		);
		expect(mocks.create.mock.calls[0]![1].orgId).toBe("target");
	});
	it.each([
		["target non-admin", { role: "member", status: "active" }],
		["hosting-only admin", undefined],
		["inactive target admin", { role: "admin", status: "suspended" }],
	])(
		"refuses a %s even with an active hosting admin membership",
		async (_label, targetMember) => {
			mocks.member.mockImplementation(async (_db, orgId) =>
				orgId === "target" ? targetMember : { role: "admin", status: "active" },
			);
			await expect(
				headerOnlyClient("target").requestOwnerToolApproval({
					...input,
					organizationId: "target",
				}),
			).rejects.toThrow(/owner or admin/);
			expect(mocks.member).toHaveBeenCalledWith(
				expect.anything(),
				"target",
				input.userId,
			);
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);
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
	it("does not consume an approval with an invalid policy binding", async () => {
		const bound = {
			...input,
			target: { ...input.target, tenantPolicyBinding: {} },
		};
		const result = await client().requestOwnerToolApproval(bound);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "owner-1",
		});
		await expect(
			client().requestOwnerToolApproval({
				...bound,
				approvalRequestId: result.approvalRequestId,
			}),
		).rejects.toThrow(/policy binding is invalid/);
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("rechecks the owner-reviewed policy before consuming a replay", async () => {
		const mount = {
			version: 1 as const,
			organizationId: "org-1",
			rootAppId: "root",
			mountAppIds: ["root", "source"],
			sourceAppId: "source",
			sourceToolRowId: "tool-row",
			sourceToolId: "send",
			mountedToolId: "mail__send",
			transport: "mcp" as const,
			upstreamOperation: "send",
			endpointDigest: "a".repeat(64),
			authBindingDigest: "a".repeat(64),
			acceptsEmptyArguments: false,
			providerId: "provider",
			connectionInstanceId: "connection",
			connectionScope: "tenant" as const,
			requestedScopes: [],
			effectiveToolDigest: "a".repeat(64),
		};
		const probeMount = {
			...mount,
			sourceToolRowId: "probe",
			sourceToolId: "probe",
			mountedToolId: "mail__probe",
			upstreamOperation: "probe",
			acceptsEmptyArguments: true,
		};
		const profile = {
			version: 1 as const,
			operation: "probe",
			selectors: [["id"]],
		};
		const profileGenerations = await canonicalDigest({ mount: [], probe: [] });
		const profileDigest = await canonicalDigest({
			organizationId: "org-1",
			mount,
			probeMount,
			profile,
			safetyAttestation: "safe_empty_probe",
			resourceGenerationDigest: profileGenerations,
		});
		mocks.policyProfile.mockResolvedValue({
			id: "profile",
			organizationId: "org-1",
			mount,
			probeMount,
			profile,
			safetyAttestation: "safe_empty_probe",
			profileDigest,
			resourceGenerationDigest: profileGenerations,
			createdBy: "owner-1",
			createdAt: "2026-01-01",
			revokedAt: null,
		});
		const descriptor = {
			kind: "profile" as const,
			mount,
			profileId: "profile",
			profileDigest,
			actorUserId: "owner-1",
			accountRevisionDigest: "b".repeat(64),
		};
		const tool = { id: "tool-row", appId: "source", enabled: true, config: {} };
		const predicate = {
			version: 1,
			schema: {
				type: "object",
				properties: { body: { type: "string" } },
				required: ["body"],
				additionalProperties: false,
			},
		};
		const effect = {
			disposition: "ask",
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		};
		const policySet = {
			evaluatorVersion: 1,
			defaultDisposition: "ask",
			rules: [{ id: "review", predicate, effect }],
		};
		const toolDigest = await canonicalDigest(tool);
		const descriptorDigest = await canonicalDigest(descriptor);
		const resourceGenerationDigest = await canonicalDigest([]);
		const ruleDigest = await canonicalDigest({
			organizationId: "org-1",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mail__send",
			toolRowId: "tool-row",
			toolDigest,
			mountDigest: descriptorDigest,
			resourceGenerationDigest,
			policySet,
		});
		const revision = {
			id: "rev-1",
			organizationId: "org-1",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mail__send",
			toolRowId: "tool-row",
			toolDigest,
			mountDigest: descriptorDigest,
			resourceGenerationDigest,
			mountDescriptor: descriptor,
			ruleDigest,
			predicate,
			effect,
			policySet,
			revokedAt: null,
		};
		mocks.policyTool.mockResolvedValue(tool);
		mocks.policyRevisions.mockResolvedValue([revision]);
		const fences = [
			{
				subjectKey: JSON.stringify(["user", "owner-1"]),
				sequence: 1,
				policyId: "rev-1",
				policyRowId: "rev-1",
				revokedAt: null,
			},
		];
		mocks.policyFences.mockResolvedValue(fences);
		const compositeDigest = await canonicalDigest({
			fences,
			decisions: [{ revisionId: "rev-1", ruleDigest }],
		});
		const bound = {
			...input,
			target: {
				...input.target,
				tenantPolicyBinding: {
					descriptor,
					descriptorDigest,
					revisionId: "rev-1",
					ruleDigest: compositeDigest,
				},
			},
		};
		const created = await client().requestOwnerToolApproval(bound);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "owner-1",
		});
		const retry = { ...bound, approvalRequestId: created.approvalRequestId };
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
		});
		mocks.consume.mockClear();
		mocks.policyRevisions.mockResolvedValue([
			{ ...revision, revokedAt: "2026-01-01" },
		]);
		await expect(client().requestOwnerToolApproval(retry)).rejects.toThrow(
			/policy changed or was revoked/,
		);
		expect(mocks.consume).not.toHaveBeenCalled();
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
