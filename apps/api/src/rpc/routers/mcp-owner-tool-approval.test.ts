import { createRouterClient } from "@orpc/server";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { workItems } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vite-plus/test";
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
	latch: vi.fn(),
	agent: vi.fn(),
	agentWork: vi.fn(),
	work: vi.fn(),
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (load) => ({
		...(await load<object>()),
		resolveAuthorizedExternalAgentMcpSession: mocks.agent,
	}),
);
vi.mock("@tedix/db/queries/work-items/attempts", async (load) => ({
	...(await load<object>()),
	findAgentApprovalWork: mocks.agentWork,
}));
vi.mock("@tedix/db/queries/work-items/factory-state", async (load) => ({
	...(await load<object>()),
	getScopedWorkItem: mocks.work,
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
vi.mock("@tedix/db/queries/sensitive-data-latch", async (load) => ({
	...(await load<object>()),
	getRunSensitiveDataLatch: mocks.latch,
}));
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
describe("exact fetch approvals", () => {
	const binding = {
		runRef: { kind: "skill_run" as const, id: "run-1" },
		latchedAt: "2026-11-01T00:00:00Z",
		url: "https://example.com/page",
		configHash: "hash",
	};
	const fetchInput = {
		...input,
		toolId: "fetch_page",
		target: { transport: "external", sensitiveDataEgress: binding },
		args: {},
	};
	async function seed() {
		mocks.organization.mockResolvedValue({
			slug: "example",
			metadata: { sensitiveDataEgressApproval: true },
		});
		mocks.latch.mockResolvedValue({
			known: true,
			active: true,
			latch: { latchedAt: binding.latchedAt },
		});
		const result = await client().requestOwnerToolApproval(fetchInput);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "owner-1",
		});
		return { ...fetchInput, approvalRequestId: result.approvalRequestId };
	}
	it("stores the URL and retained lock in the existing audited approval card", async () => {
		const retry = await seed();
		expect(mocks.create.mock.calls[0]![1].description).toContain(
			"Fetch https://example.com/page once",
		);
		expect(mocks.create.mock.calls[0]![1].description).toContain(
			"lock stays on",
		);
		expect(mocks.create.mock.calls[0]![2].metadata.sensitiveDataEgress).toEqual(
			binding,
		);
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
		});
	});
	it.each(["disabled", "ended", "relatched", "foreign run", "URL changed"])(
		"does not consume an approval after %s",
		async (condition) => {
			const retry = await seed();
			if (condition === "disabled")
				mocks.organization.mockResolvedValue({ slug: "example", metadata: {} });
			if (condition === "ended")
				mocks.latch.mockResolvedValue({
					known: true,
					active: false,
					latch: { latchedAt: binding.latchedAt },
				});
			if (condition === "relatched")
				mocks.latch.mockResolvedValue({
					known: true,
					active: true,
					latch: { latchedAt: "later" },
				});
			if (condition === "foreign run")
				mocks.latch.mockResolvedValue({ known: false, latch: null });
			if (condition === "URL changed")
				retry.target = {
					...retry.target,
					sensitiveDataEgress: {
						...binding,
						url: "https://other.example.com/",
					},
				};
			await expect(
				client().requestOwnerToolApproval(retry),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.consume).not.toHaveBeenCalled();
		},
	);
});

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
	it("requires one visible enrollment decision and consumes it on the identical CLI retry", async () => {
		const enrollment = {
			...input,
			directUserCall: true,
			toolId: "external__create_external_agent_principal",
			target: {
				transport: "rpc",
				endpoint: "externalAgentIdentity/createPrincipal",
			},
			args: {
				organizationId: "org-1",
				key: "local-runner",
				credentialBindingType: "aih_m2m",
			},
		};
		const first = await client().requestOwnerToolApproval(enrollment);
		expect(first).toMatchObject({ approved: false, status: "pending" });
		const row = mocks.create.mock.calls[0]![1];
		expect(row.orgId).toBe("org-1");
		mocks.pending.mockResolvedValue(row);
		expect(await client().requestOwnerToolApproval(enrollment)).toMatchObject({
			approvalRequestId: first.approvalRequestId,
			status: "pending",
		});
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:owner-1",
		});
		expect(
			await client().requestOwnerToolApproval({
				...enrollment,
				approvalRequestId: first.approvalRequestId,
			}),
		).toMatchObject({ approved: true });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.consume).toHaveBeenCalledTimes(1);
	});

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
		[
			"retire_unstarted_skill_workflow",
			{},
			"Retire the old workflow without restarting it",
		],
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
		const row = mocks.create.mock.calls[0]![1];
		// Evidence comes from the stored request: its approver, and a hash of
		// the card's description plus the stored call identity and arguments.
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
			status: "consumed",
			evidence: {
				approverId: "owner-1",
				approvedAt: expect.any(String),
				presentedHash: await canonicalDigest({
					description: row.description,
					presentation: "owner_request.v1",
					appSlug: input.appSlug,
					toolId: input.toolId,
					requesterUserId: input.userId,
					argsDigest: await canonicalDigest(input.args),
				}),
			},
		});
		mocks.consume.mockResolvedValue(false);
		const refused = await client().requestOwnerToolApproval(retry);
		expect(refused).toMatchObject({ approved: false });
		expect(refused).not.toHaveProperty("evidence");
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
	it("consumes a renamed RPC call only for the same endpoint and arguments", async () => {
		const call = {
			...input,
			toolId: "cto__update_project",
			target: { transport: "rpc", endpoint: "projects/update" },
		};
		const created = await client().requestOwnerToolApproval(call);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "owner-1",
		});
		const retry = {
			...call,
			toolId: "tedix__update_projects",
			approvalRequestId: created.approvalRequestId,
		};
		await expect(
			client().requestOwnerToolApproval({
				...retry,
				args: { body: "changed" },
			}),
		).rejects.toThrow(/arguments differ/);
		await expect(
			client().requestOwnerToolApproval({
				...retry,
				target: { transport: "rpc", endpoint: "projects/delete" },
			}),
		).rejects.toThrow(/target differ/);
		expect(mocks.consume).not.toHaveBeenCalled();
		await expect(
			client().requestOwnerToolApproval(retry),
		).resolves.toMatchObject({ approved: true, status: "consumed" });
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

describe("agent exact native approvals", () => {
	const requestingAgent = {
		principalId: "11111111-1111-4111-8111-111111111111",
		sessionId: "22222222-2222-4222-8222-222222222222",
		clientRecordId: "client-1",
	};
	const workItemId = "33333333-3333-4333-8333-333333333333";
	const admittedWork = {
		workItemId,
		attemptId: "attempt-1",
		accountableOwnerType: "user",
		accountableOwnerId: "owner-1",
		reviewerType: null,
		reviewerId: null,
	};
	const call = {
		...input,
		userId: undefined,
		requestingAgent,
		toolId: "cms_landing__menu_set_items",
		target: {
			transport: "rpc",
			endpoint: "cmsLanding/menuSetItems",
			configHash: "config-1",
		},
		args: { items: [{ label: "Home", url: "/" }] },
	};
	beforeEach(() => {
		mocks.agent.mockResolvedValue({
			principal: {
				credentialBindingType: "api_key",
				credentialBindingId: "machine-client",
			},
			session: { externalSessionKey: "codex:example" },
		});
		mocks.agentWork.mockResolvedValue(admittedWork);
		mocks.work.mockResolvedValue({
			id: workItemId,
			version: 4,
			disposition: "accepted",
		});
	});
	it.each(["api_key", "aih_m2m", "owner_user"])(
		"parks a %s agent's exact call for its Work owner and reuses its pending card",
		async (credentialBindingType) => {
			mocks.agent.mockResolvedValue({
				principal: {
					credentialBindingType,
					credentialBindingId:
						credentialBindingType === "owner_user"
							? "owner-1"
							: "machine-client",
				},
				session: { externalSessionKey: "codex:example" },
			});
			const first = await client().requestOwnerToolApproval(call);
			expect(first.approved).toBe(false);
			expect(mocks.create.mock.calls[0]![1].payload).toMatchObject({
				requestingAgent,
				workItemId,
				requestingAttemptId: "attempt-1",
				initiatedByUserId: "owner-1",
				approverUserId: "owner-1",
				args: call.args,
				target: call.target,
			});
			expect(mocks.create.mock.calls[0]![2]).toMatchObject({
				actorType: "external_agent",
				actorId: requestingAgent.principalId,
			});
			mocks.pending.mockResolvedValue({ id: first.approvalRequestId });
			expect(await client().requestOwnerToolApproval(call)).toMatchObject({
				approvalRequestId: first.approvalRequestId,
				status: "pending",
				approved: false,
			});
			expect(mocks.create).toHaveBeenCalledTimes(1);
			expect(mocks.consume).not.toHaveBeenCalled();
		},
	);
	it("parks one exact MCP call, allows polling only, and fences human replay to its approver and Work revision", async () => {
		const connected = {
			...call,
			target: {
				transport: "mcp",
				mcpToolName: "menu_set_items",
				mcpServerUrl: "https://builder.example.test/mcp",
				configHash: "config-1",
			},
		};
		const first = await client().requestOwnerToolApproval(connected);
		const row = mocks.create.mock.calls[0]![1];
		expect(row.payload).toMatchObject({
			requestingAgent,
			requestingAttemptId: "attempt-1",
			workItemId,
			requestingWorkVersion: 4,
			target: connected.target,
			args: call.args,
			approverUserId: "owner-1",
		});
		mocks.pending.mockResolvedValue({ id: first.approvalRequestId });
		expect(await client().requestOwnerToolApproval(connected)).toMatchObject({
			approvalRequestId: first.approvalRequestId,
			status: "pending",
			approved: false,
		});
		expect(mocks.create).toHaveBeenCalledTimes(1);
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:owner-1",
		});
		const retry = { ...connected, approvalRequestId: first.approvalRequestId };
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: false,
		});
		expect(mocks.consume).not.toHaveBeenCalled();
		const replay = { ...retry, requestingAgent: undefined, userId: "owner-1" };
		for (const patch of [
			{ args: { items: [] } },
			{
				target: {
					...connected.target,
					mcpServerUrl: "https://other.example.test/mcp",
				},
			},
		]) {
			await expect(
				client().requestOwnerToolApproval({
					...replay,
					...patch,
					replayUserId: "owner-1",
				}),
			).rejects.toThrow(/different call/);
		}
		for (const replayUserId of [undefined, "other-owner"]) {
			expect(
				await client().requestOwnerToolApproval({ ...replay, replayUserId }),
			).toMatchObject({ approved: false });
		}
		expect(mocks.consume).not.toHaveBeenCalled();
		const sqlite = new DatabaseSync(":memory:");
		onTestFinished(() => sqlite.close());
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(schemaDdl(workItems, tediApprovalRequests));
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,accountable_owner_type,accountable_owner_id,created_at,version) VALUES(?,'org-1','Approval','accepted','user','owner-1','2026-11-21',5)",
			)
			.run(workItemId);
		sqlite
			.prepare(
				"INSERT INTO tedi_approval_requests(id,org_id,tedi_id,action_type,description,payload,status,created_at,expires_at) VALUES(?,'org-1','anchor','mcp.tool_call','Exact call',?,'approved',?,?)",
			)
			.run(row.id, JSON.stringify(row.payload), row.createdAt, row.expiresAt);
		const db = createDbClient(createD1Facade(sqlite));
		const { consumeOwnerToolApproval } = await vi.importActual<
			typeof import("@tedix/db/queries/approvals")
		>("@tedix/db/queries/approvals");
		mocks.consume.mockImplementation((_db, input) =>
			consumeOwnerToolApproval(db, input),
		);
		// The read saw version 4, but an edit won before the atomic claim.
		expect(
			await client().requestOwnerToolApproval({
				...replay,
				replayUserId: "owner-1",
			}),
		).toMatchObject({ approved: false });
		sqlite.exec("UPDATE work_items SET version=4");
		expect(
			await client().requestOwnerToolApproval({
				...replay,
				replayUserId: "owner-1",
			}),
		).toMatchObject({ approved: true });
		expect(
			await client().requestOwnerToolApproval({
				...replay,
				replayUserId: "owner-1",
			}),
		).toMatchObject({ approved: false });
		mocks.consume.mockClear();
		mocks.work.mockResolvedValue({
			id: workItemId,
			version: 5,
			disposition: "accepted",
		});
		await expect(client().requestOwnerToolApproval(retry)).rejects.toThrow(
			/Work changed/,
		);
		await expect(
			client().requestOwnerToolApproval({ ...replay, replayUserId: "owner-1" }),
		).rejects.toThrow(/Work changed/);
		expect(mocks.consume).not.toHaveBeenCalled();
		mocks.pending.mockResolvedValue(undefined);
		const next = await client().requestOwnerToolApproval(connected);
		expect(next.approvalRequestId).not.toBe(first.approvalRequestId);
		expect(mocks.create.mock.calls[1]![1].payload.requestingWorkVersion).toBe(
			5,
		);
		expect(mocks.create.mock.calls[1]![1].payload.fingerprint).not.toBe(
			row.payload.fingerprint,
		);
	});
	it("creates no MCP approval without a qualifying live Attempt", async () => {
		mocks.agentWork.mockResolvedValue(undefined);
		await expect(
			client().requestOwnerToolApproval({
				...call,
				target: { transport: "mcp" },
			}),
		).rejects.toThrow(/live Work Attempt/);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("routes to the Work's designated human reviewer", async () => {
		mocks.agentWork.mockResolvedValue({
			...admittedWork,
			reviewerType: "user",
			reviewerId: "reviewer",
		});
		await client().requestOwnerToolApproval(call);
		expect(mocks.create.mock.calls[0]![1].payload.approverUserId).toBe(
			"reviewer",
		);
	});
	it.each([
		"revoked",
		"foreign owner",
		"owner-bound foreign Work",
		"non-user owner",
		"no Attempt",
		"foreign Work",
		"external",
		"self approval",
	])("refuses %s without a new card or execution", async (mode) => {
		if (mode === "revoked") mocks.agent.mockResolvedValue(null);
		if (mode === "owner-bound foreign Work")
			mocks.agent.mockResolvedValue({
				principal: {
					credentialBindingType: "owner_user",
					credentialBindingId: "other",
				},
				session: { externalSessionKey: "codex:example" },
			});
		if (mode === "non-user owner")
			mocks.agentWork.mockResolvedValue({
				...admittedWork,
				accountableOwnerType: "tedi",
			});
		if (mode === "no Attempt") mocks.agentWork.mockResolvedValue(undefined);
		if (mode === "self approval")
			mocks.agentWork.mockResolvedValue({
				...admittedWork,
				reviewerType: "user",
				reviewerId: requestingAgent.principalId,
			});
		await expect(
			client().requestOwnerToolApproval({
				...call,
				...(mode === "foreign owner" ? { userId: "other" } : {}),
				...(mode === "foreign Work"
					? { workItemId: "55555555-5555-4555-8555-555555555555" }
					: {}),
				...(mode === "external" ? { target: { transport: "external" } } : {}),
			}),
		).rejects.toThrow();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("polls the stored outcome on a successor Attempt without consuming it", async () => {
		const first = await client().requestOwnerToolApproval(call);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:owner-1",
			payload: { ...row.payload, execution: { status: "executed" } },
		});
		mocks.agentWork.mockResolvedValue({
			...admittedWork,
			attemptId: "attempt-2",
		});
		expect(
			await client().requestOwnerToolApproval({
				...call,
				approvalRequestId: first.approvalRequestId,
			}),
		).toMatchObject({ approved: false, status: "executed" });
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("binds requests to the original Attempt, tool, arguments and target", async () => {
		const first = await client().requestOwnerToolApproval(call);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:owner-1",
		});
		for (const patch of [
			{ toolId: "different_tool" },
			{ args: { items: [] } },
			{ target: { ...call.target, configHash: "changed" } },
		]) {
			await expect(
				client().requestOwnerToolApproval({
					...call,
					...patch,
					approvalRequestId: first.approvalRequestId,
				}),
			).rejects.toThrow(/different call/);
		}
		mocks.agentWork.mockResolvedValue({
			...admittedWork,
			attemptId: "attempt-2",
		});
		await client().requestOwnerToolApproval(call);
		expect(mocks.create.mock.calls[1]![1].payload.fingerprint).not.toBe(
			row.payload.fingerprint,
		);
		expect(mocks.consume).not.toHaveBeenCalled();
	});
	it("permits only the exact approved stored call to consume once on human replay", async () => {
		const first = await client().requestOwnerToolApproval(call);
		const row = mocks.create.mock.calls[0]![1];
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:owner-1",
		});
		const replay = {
			...call,
			requestingAgent: undefined,
			userId: "owner-1",
			approvalRequestId: first.approvalRequestId,
		};
		await expect(
			client().requestOwnerToolApproval({ ...replay, args: { items: [] } }),
		).rejects.toThrow(/different call/);
		expect(mocks.consume).not.toHaveBeenCalled();
		expect(await client().requestOwnerToolApproval(replay)).toMatchObject({
			approved: true,
		});
		mocks.consume.mockResolvedValue(false);
		expect(await client().requestOwnerToolApproval(replay)).toMatchObject({
			approved: false,
		});
	});
});

describe("owner role delegation", () => {
	it.each(["owner", "admin"])(
		"authorizes a %s's own direct call inline",
		async (role) => {
			mocks.member.mockResolvedValue({ role, status: "active" });
			expect(
				await client().requestOwnerToolApproval({
					...input,
					directUserCall: true,
				}),
			).toMatchObject({
				approved: true,
				status: "self_authorized",
				approvedUserId: "owner-1",
			});
			expect(mocks.create).not.toHaveBeenCalled();
			expect(mocks.consume).not.toHaveBeenCalled();
		},
	);
	it("does not authorize a non-admin direct call", async () => {
		mocks.member.mockResolvedValue({ role: "member", status: "active" });
		await expect(
			client().requestOwnerToolApproval({ ...input, directUserCall: true }),
		).rejects.toThrow(/owner or admin/);
	});
	it("shows the required role before approval and grants only the active approver", async () => {
		const ownerOnly = {
			...input,
			target: { ...input.target, requiredRole: "owner" },
		};
		const created = await client().requestOwnerToolApproval(ownerOnly);
		const row = mocks.create.mock.calls[0]![1];
		expect(row.description).toContain("Only an owner can run this tool");
		mocks.get.mockResolvedValue({
			...row,
			status: "approved",
			resolvedBy: "user:approver-1",
		});
		const retry = {
			...ownerOnly,
			approvalRequestId: created.approvalRequestId,
		};
		mocks.member.mockImplementation(async (_db, _org, userId) => ({
			role: userId === "approver-1" ? "member" : "owner",
			status: "active",
		}));
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: false,
		});
		expect(mocks.consume).not.toHaveBeenCalled();
		mocks.member.mockResolvedValue({ role: "owner", status: "active" });
		expect(await client().requestOwnerToolApproval(retry)).toMatchObject({
			approved: true,
			approvedUserId: "approver-1",
		});
		mocks.consume.mockResolvedValueOnce(false);
		const reused = await client().requestOwnerToolApproval(retry);
		expect(reused.approved).toBe(false);
		expect(reused.approvedUserId).toBeUndefined();
	});
});

it("refuses an admin's direct call to an owner-only tool", async () => {
	mocks.member.mockResolvedValue({ role: "admin", status: "active" });
	await expect(
		client().requestOwnerToolApproval({
			...input,
			directUserCall: true,
			target: { ...input.target, requiredRole: "owner" },
		}),
	).rejects.toThrow("Only an owner can run this tool");
	expect(mocks.create).not.toHaveBeenCalled();
});
