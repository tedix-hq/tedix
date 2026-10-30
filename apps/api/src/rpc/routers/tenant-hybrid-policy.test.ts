import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { userContext } from "../test-context";
import { canonicalDigest } from "../../lib/blueprint-digest";

const mocks = vi.hoisted(() => ({
	tool: vi.fn(),
	member: vi.fn(),
	profile: vi.fn(),
	generations: vi.fn(),
	revisions: vi.fn(),
	sourceCandidates: vi.fn(),
	consumeResult: vi.fn(),
	prepare: vi.fn(),
	consumePreparation: vi.fn(),
	create: vi.fn(),
	createProbeReceipt: vi.fn(),
	machineResult: vi.fn(),
	activeMachine: vi.fn(),
	machineInventory: vi.fn(),
	legacyTools: vi.fn(),
	legacyGrants: vi.fn(),
	approval: vi.fn(),
	createApproval: vi.fn(),
	consumeApproval: vi.fn(),
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	getApprovalRequestById: mocks.approval,
	createApprovalRequestWithAudit: mocks.createApproval,
	consumeOwnerToolApproval: mocks.consumeApproval,
	findPendingOwnerToolApproval: vi.fn().mockResolvedValue(undefined),
	getApprovalAnchor: vi.fn().mockResolvedValue({ id: "anchor" }),
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: vi
		.fn()
		.mockResolvedValue({ slug: "example", name: "Example" }),
}));
vi.mock("@tedix/db/queries/tools", async (load) => ({
	...(await load<object>()),
	getToolByIdForOrganization: mocks.tool,
	listDeclaredActionToolsForOrganization: mocks.legacyTools,
}));
vi.mock("@tedix/db/queries/mcp-governance", async (load) => ({
	...(await load<object>()),
	listActionTypeOptIns: mocks.legacyGrants,
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/tenant-tool-policy", async (load) => {
	const actual =
		await load<typeof import("@tedix/db/queries/tenant-tool-policy")>();
	return {
		...actual,
		findTenantToolPolicySubjectFences: async (db: unknown, scope: unknown) => {
			const rows = (await mocks.revisions(db, scope)) ?? [];
			return rows.map(
				(row: {
					mountDescriptor: unknown;
					id: string;
					revokedAt: string | null;
				}) => ({
					subjectKey: actual.tenantPolicySubjectKey(row.mountDescriptor),
					sequence: 1,
					policyId: row.id,
					policyRowId: row.id,
					revokedAt: row.revokedAt,
				}),
			);
		},
		getProviderIdentityProfile: mocks.profile,
		getTenantToolPolicyResourceGenerations: mocks.generations,
		findTenantToolPolicyRevisions: mocks.revisions,
		findTenantToolPolicyCandidatesBySource: mocks.sourceCandidates,
		createTenantToolPolicyPreparation: mocks.prepare,
		consumeTenantToolPolicyPreparation: mocks.consumePreparation,
		createTenantToolPolicy: mocks.create,
		replaceTenantToolPolicy: mocks.create,
	};
});
vi.mock("@tedix/db/queries/provider-probe-receipts", async (load) => ({
	...(await load<object>()),
	consumeProviderProbeResult: mocks.consumeResult,
	createProviderProbeReceipt: mocks.createProbeReceipt,
	consumeMachineProviderProbeResult: mocks.machineResult,
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (load) => ({
		...(await load<object>()),
		resolveAuthorizedExternalAgentMcpSession: mocks.activeMachine,
		listMachinePolicyInventoryCandidates: mocks.machineInventory,
	}),
);
import { mcpGovernanceContractRouter } from "./mcp-governance";

const mount = {
	version: 1 as const,
	organizationId: "org",
	rootAppId: "root",
	mountAppIds: ["root", "source"],
	sourceAppId: "source",
	sourceToolRowId: "tool",
	sourceToolId: "write",
	mountedToolId: "write",
	transport: "mcp" as const,
	upstreamOperation: "write",
	endpointDigest: "a".repeat(64),
	effectiveToolDigest: "b".repeat(64),
	authBindingDigest: "c".repeat(64),
	acceptsEmptyArguments: false,
	providerId: "provider",
	connectionScope: "hybrid" as const,
	credentialPreference: "user-first" as const,
	requestedScopes: [],
};
const probeMount = {
	...mount,
	sourceToolRowId: "probe",
	sourceToolId: "probe",
	mountedToolId: "probe",
	upstreamOperation: "probe",
	effectiveToolDigest: "d".repeat(64),
	acceptsEmptyArguments: true,
};
const tool = { id: "tool", appId: "source", toolId: "write", enabled: true };
const args = { action: "edit" };
const policySet = {
	evaluatorVersion: 1 as const,
	defaultDisposition: "ask" as const,
	rules: [
		{
			id: "1",
			predicate: {
				version: 1 as const,
				schema: {
					type: "object" as const,
					properties: { action: { type: "string" as const, const: "edit" } },
					required: ["action"],
					additionalProperties: false,
				},
			},
			effect: {
				disposition: "allow" as const,
				riskTier: "bounded_write" as const,
				blastRadius: "single_resource" as const,
			},
		},
	],
};

async function profile() {
	const profile = {
		version: 1 as const,
		operation: "probe",
		selectors: [["id"]],
	};
	const resourceGenerationDigest = await canonicalDigest({
		mount: [],
		probe: [],
	});
	const profileDigest = await canonicalDigest({
		organizationId: "org",
		mount,
		probeMount,
		profile,
		safetyAttestation: "safe_empty_probe",
		resourceGenerationDigest,
	});
	return {
		id: "profile",
		organizationId: "org",
		mount,
		probeMount,
		profile,
		safetyAttestation: "safe_empty_probe",
		profileDigest,
		resourceGenerationDigest,
		createdBy: "owner",
		createdAt: "2026-10-30T00:00:00Z",
		revokedAt: null,
	};
}

function ownerClient(accountDigest = "e".repeat(64)) {
	const fetch = async (request: Request) =>
		request.url.endsWith("/probe-profile")
			? Response.json({ accountRevisionDigest: accountDigest })
			: Response.json({
					descriptor: mount,
					descriptorDigest: await canonicalDigest(mount),
				});
	return createRouterClient(mcpGovernanceContractRouter, {
		context: userContext({
			organizationId: "org",
			userId: "owner",
			sub: "owner",
			claims: { scopes: ["connections.execute"] },
			permissions: ["settings:manage"],
			db: {} as BaseContext["db"],
			env: {
				ENVIRONMENT: "production",
				MCP_SERVICE: { fetch },
			} as CloudflareEnv,
		}),
	});
}
function serviceClient() {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType: "service-binding",
			organizationId: "org",
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.tool.mockResolvedValue(tool);
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.generations.mockResolvedValue([]);
	mocks.activeMachine.mockResolvedValue({
		credential: { mcpServerId: "server" },
	});
	mocks.prepare.mockImplementation(async (_db, row) => row);
	mocks.create.mockImplementation(async (_db, row) => ({
		...row,
		revokedAt: null,
	}));
});

describe("profile-bound tenant policy", () => {
	it("inventories only tenant-scoped source tools matching active legacy grants", async () => {
		mocks.legacyGrants.mockResolvedValue([
			{
				grantId: "grant",
				actionType: "comment_on_issue",
				reason: null,
				createdAt: "now",
			},
		]);
		mocks.legacyTools.mockResolvedValue([
			{
				appId: "app",
				appName: "App",
				appSlug: "app",
				toolRowId: "one",
				toolId: "comment",
				title: "Comment",
				actionType: "comment_on_issue",
				enabled: true,
			},
			{
				appId: "app",
				appName: "App",
				appSlug: "app",
				toolRowId: "two",
				toolId: "other",
				title: "Other",
				actionType: "different",
				enabled: true,
			},
		]);
		const result = await ownerClient().listLegacyActionTypeInventory();
		expect(result.tools.map((tool) => tool.toolId)).toEqual(["comment"]);
		expect(mocks.legacyTools).toHaveBeenCalledWith(expect.anything(), "org");
		expect(mocks.legacyGrants).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org",
		});
	});
	it("lists only independently verified active machine registrations for owners", async () => {
		mocks.machineInventory.mockResolvedValue([
			{
				principalId: "principal",
				sessionId: "session",
				clientRecordId: "client",
			},
			{ principalId: "stale", sessionId: "ended", clientRecordId: "old" },
		]);
		mocks.activeMachine.mockImplementation(async (_db, input) =>
			input.principalId === "principal"
				? {
						principal: { id: "principal", displayName: "Agent" },
						session: { id: "session" },
						credential: { clientRecordId: "client", mcpServerId: "server" },
					}
				: null,
		);
		expect(await ownerClient().listMachinePolicyInventory()).toEqual({
			items: [
				{
					principalId: "principal",
					principalName: "Agent",
					sessionId: "session",
					clientRecordId: "client",
					mcpServerId: "server",
				},
			],
		});
		mocks.member.mockResolvedValue({ status: "active", role: "member" });
		await expect(ownerClient().listMachinePolicyInventory()).rejects.toThrow();
	});
	it("allows an owner-selected machine principal across independently verified sessions", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		const proof = {
			principalId: "principal",
			sessionId: "session-one",
			clientRecordId: "client-one",
			clientId: "oauth-one",
			mcpServerId: "server",
			accountRevisionDigest: "e".repeat(64),
		};
		mocks.machineResult.mockResolvedValue(proof);
		const prepared = await ownerClient().prepareMachineTenantToolPolicy({
			profileId: "profile",
			resultReceiptId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
			subjectScope: "principal",
			exampleArgs: args,
		});
		expect(prepared.descriptor.subject).toEqual({
			scope: "principal",
			principalId: "principal",
			mcpServerId: "server",
		});
		mocks.consumePreparation.mockResolvedValue(mocks.prepare.mock.calls[0]![1]);
		mocks.machineResult.mockResolvedValue({
			...proof,
			sessionId: "session-two",
			clientRecordId: "client-two",
			clientId: "oauth-two",
		});
		const saved = await ownerClient().createTenantToolPolicy({
			preparationId: prepared.preparationId,
			expectedDescriptorDigest: prepared.descriptorDigest,
			machineConfirmationReceiptId: "2f26f3e8-bf43-4336-8c25-99976247d801",
			exampleArgs: args,
			policySet,
		});
		expect(saved.policy.mountDescriptor).toMatchObject({
			kind: "machine",
			subject: { scope: "principal", principalId: "principal" },
		});
	});
	it("requires two matching tenant-machine proofs and a separate active owner attestation", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		const proof = {
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "client-row",
			clientId: "oauth-client",
			mcpServerId: "server",
			accountRevisionDigest: "e".repeat(64),
		};
		mocks.machineResult.mockResolvedValue(proof);
		const prepared = await ownerClient().prepareMachineTenantToolPolicy({
			profileId: "profile",
			resultReceiptId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
			exampleArgs: args,
		});
		expect(prepared.descriptor).toMatchObject({
			kind: "machine",
			ownerUserId: "owner",
			credentialScope: "tenant",
			subject: {
				principalId: "principal",
				sessionId: "session",
				clientRecordId: "client-row",
			},
		});
		mocks.consumePreparation.mockResolvedValue(mocks.prepare.mock.calls[0]![1]);
		const input = {
			preparationId: prepared.preparationId,
			expectedDescriptorDigest: prepared.descriptorDigest,
			machineConfirmationReceiptId: "2f26f3e8-bf43-4336-8c25-99976247d801",
			exampleArgs: args,
			policySet,
		};
		mocks.machineResult.mockResolvedValue({
			...proof,
			accountRevisionDigest: "f".repeat(64),
		});
		await expect(ownerClient().createTenantToolPolicy(input)).rejects.toThrow(
			/Machine identity or account changed/,
		);
		expect(mocks.create).not.toHaveBeenCalled();
		mocks.machineResult.mockResolvedValue(proof);
		const saved = await ownerClient().createTenantToolPolicy(input);
		expect(saved.policy.mountDescriptor).toMatchObject({
			kind: "machine",
			ownerUserId: "owner",
			credentialScope: "tenant",
		});
	});
	it("requires a one-use proof bound to requester, profile and exact arguments", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		mocks.consumeResult.mockResolvedValue({
			accountRevisionDigest: "e".repeat(64),
		});
		const result = await ownerClient().prepareHybridTenantToolPolicy({
			profileId: "profile",
			resultReceiptId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
			exampleArgs: args,
		});
		expect(result.descriptor).toMatchObject({
			kind: "profile",
			actorUserId: "owner",
			profileDigest: reviewed.profileDigest,
			accountRevisionDigest: "e".repeat(64),
		});
		expect(mocks.consumeResult).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org",
				actorUserId: "owner",
				profileId: "profile",
				profileDigest: reviewed.profileDigest,
				argsDigest: await canonicalDigest(args),
			}),
		);
	});
	it("re-probes the account before saving and refuses a changed account", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		mocks.consumeResult.mockResolvedValue({
			accountRevisionDigest: "e".repeat(64),
		});
		const prepared = await ownerClient().prepareHybridTenantToolPolicy({
			profileId: "profile",
			resultReceiptId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
			exampleArgs: args,
		});
		const savedPreparation = mocks.prepare.mock.calls[0]![1];
		mocks.consumePreparation.mockResolvedValue(savedPreparation);
		const create = {
			preparationId: prepared.preparationId,
			expectedDescriptorDigest: prepared.descriptorDigest,
			exampleArgs: args,
			policySet,
		};
		await expect(
			ownerClient("f".repeat(64)).createTenantToolPolicy(create),
		).rejects.toThrow(/Connection account changed since review/);
		expect(mocks.create).not.toHaveBeenCalled();
		mocks.consumePreparation.mockResolvedValue(savedPreparation);
		const result = await ownerClient().createTenantToolPolicy(create);
		expect(result.policy.policySet).toEqual(policySet);
	});
	it("returns a candidate only for the exact bound actor and current policy", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		const descriptor = {
			kind: "profile" as const,
			mount,
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: reviewed.profileDigest,
			accountRevisionDigest: "e".repeat(64),
		};
		const mountDigest = await canonicalDigest(descriptor),
			toolDigest = await canonicalDigest(tool),
			resourceGenerationDigest = await canonicalDigest([]);
		const ruleDigest = await canonicalDigest({
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "write",
			toolRowId: "tool",
			toolDigest,
			mountDigest,
			resourceGenerationDigest,
			policySet,
		});
		const row = {
			id: "rule",
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "write",
			toolRowId: "tool",
			toolDigest,
			mountDigest,
			resourceGenerationDigest,
			ruleDigest,
			mountDescriptor: descriptor,
			policySet,
			revokedAt: null,
		};
		mocks.revisions.mockResolvedValue([row]);
		const input = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "write",
			actorUserId: "owner",
			args,
		};
		expect(
			(await serviceClient().resolveTenantPolicyCandidate(input)).candidate,
		).toMatchObject({ revisionId: "rule", descriptorDigest: mountDigest });
		expect(
			(
				await serviceClient().resolveTenantPolicyCandidate({
					...input,
					actorUserId: "another",
				})
			).candidate,
		).toBeNull();
		expect(
			await serviceClient().resolveTenantPolicyDiscovery({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "write",
				actorUserId: "owner",
			}),
		).toEqual({ potential: true });
		expect(
			await serviceClient().resolveTenantPolicyDiscovery({
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "write",
				actorUserId: "another",
			}),
		).toEqual({ potential: false });
		const sourceInput = {
			organizationId: "org",
			rootAppId: "root",
			sourceAppId: "source",
			sourceToolRowId: "tool",
			actorUserId: "owner",
			args,
		};
		mocks.sourceCandidates.mockResolvedValue([row]);
		expect(
			(await serviceClient().resolveTenantPolicySourceCandidate(sourceInput))
				.candidate,
		).toMatchObject({ revisionId: "rule" });
		mocks.sourceCandidates.mockResolvedValue([
			row,
			{ ...row, id: "ambiguous", mountedToolId: "other" },
		]);
		expect(
			(await serviceClient().resolveTenantPolicySourceCandidate(sourceInput))
				.candidate,
		).toBeNull();
		const replayArgs = {};
		const approvalRequestId = "2f26f3e8-bf43-4336-8c25-99976247d801";
		const binding = {
			descriptor,
			descriptorDigest: mountDigest,
			revisionId: "rule",
			ruleDigest: (
				await serviceClient().resolveTenantPolicyCandidate({
					...input,
					args: replayArgs,
				})
			).candidate!.ruleDigest,
		};
		mocks.approval.mockResolvedValue({
			id: approvalRequestId,
			orgId: "org",
			actionType: "mcp.tool_call",
			status: "approved",
			resolvedBy: "user:owner",
			expiresAt: "2999-01-01T00:00:00.000Z",
			payload: {
				kind: "mcp_tool_call",
				initiatedByUserId: "owner",
				target: { tenantPolicyBinding: binding },
				args: replayArgs,
			},
		});
		const context = {
			authType: "service-binding",
			organizationId: "org",
			gatewayEndUserId: "owner",
			tediScopes: ["connections.execute"],
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Kernel": "true",
			}),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext;
		const replay = createRouterClient(mcpGovernanceContractRouter, { context });
		const replayInput = {
			organizationId: "org",
			approvalRequestId,
			args: replayArgs,
		};
		expect(await replay.prepareOwnerPolicyReplay(replayInput)).toMatchObject({
			binding,
			probeReceiptId: expect.any(String),
		});
		expect(mocks.createProbeReceipt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ actorUserId: "owner", profileId: "profile" }),
		);
		await expect(
			replay.prepareOwnerPolicyReplay({ ...replayInput, args }),
		).rejects.toThrow();
		const wrongActor = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...context, gatewayEndUserId: "other" },
		});
		await expect(
			wrongActor.prepareOwnerPolicyReplay(replayInput),
		).rejects.toThrow();
		const noGrant = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...context, tediScopes: [] },
		});
		await expect(
			noGrant.prepareOwnerPolicyReplay(replayInput),
		).rejects.toThrow();
		mocks.revisions.mockResolvedValue([
			{ ...row, revokedAt: "2026-10-30T00:00:00Z" },
		]);
		await expect(
			replay.prepareOwnerPolicyReplay(replayInput),
		).rejects.toThrow();
	});
	it("discovers only current machine rules for an authorized subject", async () => {
		const reviewed = await profile();
		mocks.profile.mockResolvedValue(reviewed);
		const descriptor = {
			kind: "machine" as const,
			mount,
			ownerUserId: "owner",
			profileId: "profile",
			profileDigest: reviewed.profileDigest,
			accountRevisionDigest: "e".repeat(64),
			credentialScope: "tenant" as const,
			subject: {
				scope: "principal" as const,
				principalId: "principal",
				mcpServerId: "server",
			},
		};
		const mountDigest = await canonicalDigest(descriptor),
			toolDigest = await canonicalDigest(tool),
			resourceGenerationDigest = await canonicalDigest([]);
		const base = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "write",
			toolRowId: "tool",
			toolDigest,
			mountDigest,
			resourceGenerationDigest,
			policySet,
		};
		const row = {
			...base,
			id: "rule",
			ruleDigest: await canonicalDigest(base),
			mountDescriptor: descriptor,
			revokedAt: null,
		};
		mocks.revisions.mockResolvedValue([row]);
		mocks.sourceCandidates.mockResolvedValue([row]);
		const context = {
			authType: "service-binding",
			organizationId: "org",
			externalAgentPrincipalId: "principal",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "client",
			tediScopes: ["connections.execute"],
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext;
		const input = {
			organizationId: "org",
			rootAppId: "root",
			sourceAppId: "source",
			sourceToolRowId: "tool",
		};
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		expect(await client.resolveMachinePolicyDiscovery(input)).toEqual({
			potential: true,
		});
		const sourceOnly = {
			organizationId: "org",
			sourceAppId: "source",
			sourceToolRowId: "tool",
			args,
		};
		expect(
			(await client.resolveMachinePolicyAnyRoot(sourceOnly)).candidate,
		).toMatchObject({ revisionId: "rule" });
		const sessionDescriptor = {
			...descriptor,
			subject: {
				scope: "session" as const,
				principalId: "principal",
				mcpServerId: "server",
				sessionId: "session",
				clientRecordId: "client",
				clientId: "oauth-client",
			},
		};
		const denySet = {
			...policySet,
			rules: policySet.rules.map((rule) => ({
				...rule,
				effect: { ...rule.effect, disposition: "deny" as const },
			})),
		};
		const sessionBase = {
			...base,
			mountDigest: await canonicalDigest(sessionDescriptor),
			policySet: denySet,
		};
		let sessionRow = {
			...sessionBase,
			id: "session-rule",
			ruleDigest: await canonicalDigest(sessionBase),
			mountDescriptor: sessionDescriptor,
			revokedAt: null as string | null,
		};
		const principalKey = JSON.stringify([
			"machine-principal",
			"principal",
			"server",
		]);
		const sessionKey = JSON.stringify([
			"machine-session",
			"principal",
			"server",
			"session",
			"client",
		]);
		mocks.revisions.mockImplementation(async (_db, scope) =>
			scope.subjectKey === principalKey
				? [row]
				: scope.subjectKey === sessionKey
					? [sessionRow]
					: [row, sessionRow],
		);
		mocks.sourceCandidates.mockResolvedValue([row, sessionRow]);
		const overlapping = (await client.resolveMachinePolicyAnyRoot(sourceOnly))
			.candidate;
		expect(overlapping?.effect?.disposition).toBe("deny");
		const askSet = {
			...policySet,
			rules: [
				policySet.rules[0]!,
				{
					...policySet.rules[0]!,
					id: "high-ask",
					effect: {
						disposition: "ask" as const,
						riskTier: "high_impact_write" as const,
						blastRadius: "tenant" as const,
					},
				},
			],
		};
		const askBase = { ...sessionBase, policySet: askSet };
		sessionRow = {
			...sessionRow,
			...askBase,
			ruleDigest: await canonicalDigest(askBase),
		};
		mocks.sourceCandidates.mockResolvedValue([row, sessionRow]);
		const higher = (await client.resolveMachinePolicyAnyRoot(sourceOnly))
			.candidate;
		expect(higher?.effect).toMatchObject({
			disposition: "ask",
			riskTier: "high_impact_write",
			blastRadius: "tenant",
		});
		expect(higher?.ruleDigest).not.toBe(overlapping?.ruleDigest);
		const externalSet = {
			...policySet,
			rules: [
				{
					id: "external",
					predicate: {
						version: 1 as const,
						schema: {
							type: "object" as const,
							properties: {},
							additionalProperties: true,
						},
					},
					effect: {
						disposition: "allow" as const,
						riskTier: "external_side_effect" as const,
						blastRadius: "external_system" as const,
					},
				},
			],
		};
		const externalBase = { ...sessionBase, policySet: externalSet };
		sessionRow = {
			...sessionRow,
			...externalBase,
			ruleDigest: await canonicalDigest(externalBase),
		};
		mocks.sourceCandidates.mockResolvedValue([row, sessionRow]);
		expect(
			(await client.resolveMachinePolicyAnyRoot({ ...sourceOnly, args: {} }))
				.candidate,
		).toBeNull();
		sessionRow = { ...sessionRow, revokedAt: "2026-10-30T00:00:00Z" };
		expect(
			(await client.resolveMachinePolicyAnyRoot(sourceOnly)).candidate,
		).toBeNull();
		mocks.revisions.mockResolvedValue([row]);
		mocks.sourceCandidates.mockResolvedValue([
			row,
			{ ...row, id: "another-root", rootAppId: "other" },
		]);
		expect(
			(await client.resolveMachinePolicyAnyRoot(sourceOnly)).candidate,
		).toBeNull();
		mocks.sourceCandidates.mockResolvedValue([row]);
		const call = {
			organizationId: "org",
			descriptor,
			descriptorDigest: mountDigest,
			revisionId: "rule",
			ruleDigest: (
				await client.resolveMachinePolicyAnyRoot({ ...sourceOnly, args: {} })
			).candidate!.ruleDigest,
			args: {},
		};
		const parked = await client.requestMachineToolApproval(call);
		const saved = mocks.createApproval.mock.calls.at(-1)![1];
		expect(saved.payload.kind).toBe("mcp_machine_tool_call");
		mocks.approval.mockResolvedValue({
			...saved,
			status: "approved",
			resolvedBy: "user:owner",
		});
		mocks.consumeApproval
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		expect(
			(
				await client.requestMachineToolApproval({
					...call,
					approvalRequestId: parked.approvalRequestId,
				})
			).approved,
		).toBe(true);
		expect(
			(
				await client.requestMachineToolApproval({
					...call,
					approvalRequestId: parked.approvalRequestId,
				})
			).approved,
		).toBe(false);
		await expect(
			client.requestMachineToolApproval({
				...call,
				args,
				approvalRequestId: parked.approvalRequestId,
			}),
		).rejects.toThrow();
		mocks.approval.mockResolvedValue({
			...saved,
			status: "approved",
			resolvedBy: "policy",
		});
		expect(
			(
				await client.requestMachineToolApproval({
					...call,
					approvalRequestId: parked.approvalRequestId,
				})
			).approved,
		).toBe(false);
		mocks.approval.mockResolvedValue({
			...saved,
			status: "approved",
			resolvedBy: "user:owner",
		});
		const otherPrincipal = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...context, externalAgentPrincipalId: "other" },
		});
		await expect(
			otherPrincipal.requestMachineToolApproval({
				...call,
				approvalRequestId: parked.approvalRequestId,
			}),
		).rejects.toThrow();
		const otherSession = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...context, externalAgentSessionId: "other-session" },
		});
		await expect(
			otherSession.requestMachineToolApproval({
				...call,
				approvalRequestId: parked.approvalRequestId,
			}),
		).rejects.toThrow();
		mocks.activeMachine.mockResolvedValue(null);
		expect(await client.resolveMachinePolicyDiscovery(input)).toEqual({
			potential: false,
		});
	});
	it("binds native RPC rules to the reviewed mount and verified machine", async () => {
		const nativeMount = {
			version: 1 as const,
			organizationId: "org",
			rootAppId: "root",
			mountAppIds: ["root", "source"],
			sourceAppId: "source",
			sourceToolRowId: "tool",
			sourceToolId: "write",
			mountedToolId: "write",
			transport: "rpc" as const,
			endpoint: "work/example",
			effectiveToolDigest: "a".repeat(64),
		};
		let effectiveMount = nativeMount;
		const fetch = async () =>
			Response.json({
				descriptor: effectiveMount,
				descriptorDigest: await canonicalDigest(effectiveMount),
			});
		mocks.activeMachine.mockResolvedValue({
			principal: { id: "principal" },
			credential: { mcpServerId: "server" },
		});
		const owner = createRouterClient(mcpGovernanceContractRouter, {
			context: userContext({
				organizationId: "org",
				userId: "owner",
				sub: "owner",
				permissions: ["settings:manage"],
				db: {} as BaseContext["db"],
				env: {
					ENVIRONMENT: "production",
					MCP_SERVICE: { fetch },
				} as CloudflareEnv,
			}),
		});
		const prepared = await owner.prepareNativeRpcPolicy({
			rootAppId: "root",
			mountedToolId: "write",
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "client",
			exampleArgs: args,
		});
		const receipt = mocks.prepare.mock.calls.at(-1)![1];
		mocks.consumePreparation.mockResolvedValue(receipt);
		effectiveMount = { ...nativeMount, endpoint: "work/changed" };
		const create = {
			preparationId: prepared.preparationId,
			expectedDescriptorDigest: prepared.descriptorDigest,
			exampleArgs: args,
			policySet,
		};
		await expect(owner.createTenantToolPolicy(create)).rejects.toThrow(
			/changed since review/,
		);
		effectiveMount = nativeMount;
		mocks.consumePreparation.mockResolvedValue(receipt);
		await owner.createTenantToolPolicy(create);
		const row = {
			...mocks.create.mock.calls.at(-1)![1],
			id: "rule",
			revokedAt: null,
		};
		mocks.revisions.mockResolvedValue([row]);
		mocks.sourceCandidates.mockResolvedValue([row]);
		const context = {
			authType: "service-binding",
			organizationId: "org",
			externalAgentPrincipalId: "principal",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "client",
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext;
		const gateway = createRouterClient(mcpGovernanceContractRouter, {
			context,
		});
		const input = {
			organizationId: "org",
			rootAppId: "root",
			sourceAppId: "source",
			sourceToolRowId: "tool",
			args,
		};
		expect(
			(await gateway.resolveNativeRpcPolicyCandidate(input)).candidate,
		).toMatchObject({ revisionId: "rule" });
		const call = {
			organizationId: "org",
			descriptor: prepared.descriptor,
			descriptorDigest: prepared.descriptorDigest,
			revisionId: "rule",
			ruleDigest: (
				await gateway.resolveNativeRpcPolicyCandidate({ ...input, args: {} })
			).candidate!.ruleDigest,
			args: {},
		};
		const parked = await gateway.requestNativeMachineToolApproval(call);
		const saved = mocks.createApproval.mock.calls.at(-1)![1];
		mocks.approval.mockResolvedValue({
			...saved,
			status: "approved",
			resolvedBy: "user:owner",
		});
		mocks.consumeApproval
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		expect(
			(
				await gateway.requestNativeMachineToolApproval({
					...call,
					approvalRequestId: parked.approvalRequestId,
				})
			).approved,
		).toBe(true);
		expect(
			(
				await gateway.requestNativeMachineToolApproval({
					...call,
					approvalRequestId: parked.approvalRequestId,
				})
			).approved,
		).toBe(false);
		const wrong = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...context, externalAgentSessionId: "different" },
		});
		await expect(
			wrong.requestNativeMachineToolApproval({
				...call,
				approvalRequestId: parked.approvalRequestId,
			}),
		).rejects.toThrow();
		await expect(
			gateway.requestNativeMachineToolApproval({
				...call,
				args,
				approvalRequestId: parked.approvalRequestId,
			}),
		).rejects.toThrow();
		mocks.activeMachine.mockResolvedValue(null);
		await expect(
			gateway.requestNativeMachineToolApproval(call),
		).rejects.toThrow();
		expect(
			(await gateway.resolveNativeRpcPolicyCandidate(input)).candidate,
		).toBeNull();
	});
});
