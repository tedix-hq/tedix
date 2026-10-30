import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { canonicalDigest } from "../../lib/blueprint-digest";
import { userContext } from "../test-context";
import type { TenantToolPolicySet } from "@tedix/api-contract/schemas/tenant-tool-policy";
const mocks = vi.hoisted(() => ({
	tool: vi.fn(),
	revisions: vi.fn(),
	generations: vi.fn(),
	member: vi.fn(),
	consume: vi.fn(),
	create: vi.fn(),
	prepare: vi.fn(),
	organization: vi.fn(),
	app: vi.fn(),
	credential: vi.fn(),
	fences: vi.fn(),
	activeMachine: vi.fn(),
}));
vi.mock("@tedix/db/queries/tools", async (load) => ({
	...(await load<object>()),
	getToolByIdForOrganization: mocks.tool,
}));
vi.mock("@tedix/db/queries/tenant-tool-policy", async (load) => ({
	...(await load<object>()),
	findTenantToolPolicyRevisions: mocks.revisions,
	findTenantToolPolicySubjectFences: mocks.fences,
	getTenantToolPolicyResourceGenerations: mocks.generations,
	consumeTenantToolPolicyPreparation: mocks.consume,
	createTenantToolPolicy: mocks.create,
	replaceTenantToolPolicy: mocks.create,
	createTenantToolPolicyPreparation: mocks.prepare,
}));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (load) => ({
		...(await load<object>()),
		resolveAuthorizedExternalAgentMcpSession: mocks.activeMachine,
	}),
);
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/app-records", async (load) => ({
	...(await load<object>()),
	getAppByIdForOrganization: mocks.app,
}));
vi.mock("./connections/policy-resolution", async (load) => ({
	...(await load<object>()),
	resolveCredentialChain: mocks.credential,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

const descriptor = {
	version: 1 as const,
	organizationId: "org-1",
	rootAppId: "root-1",
	mountAppIds: ["root-1", "app-1"],
	sourceAppId: "app-1",
	sourceToolRowId: "tool-1",
	sourceToolId: "action",
	mountedToolId: "mount__action",
	transport: "mcp" as const,
	upstreamOperation: "action",
	providerId: "provider-1",
	connectionInstanceId: "conn-1",
	credentialScope: "tenant" as const,
	requestedScopes: [],
	accountRevisionDigest: "c".repeat(64),
	effectiveToolDigest: "a".repeat(64),
};
const tool = {
	id: "tool-1",
	appId: "app-1",
	toolId: "action",
	enabled: true,
	config: { method: "action" },
};
const predicate = {
	version: 1 as const,
	schema: {
		type: "object" as const,
		properties: { action: { type: "string" as const, const: "safe" } },
		required: ["action"],
		additionalProperties: false,
	},
};
const effect = {
	disposition: "allow" as const,
	riskTier: "bounded_write" as const,
	blastRadius: "single_resource" as const,
};
const policySet = {
	evaluatorVersion: 1 as const,
	defaultDisposition: "ask" as const,
	rules: [{ id: "allow", predicate, effect }],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.tool.mockResolvedValue(tool);
	mocks.revisions.mockResolvedValue([]);
	mocks.fences.mockResolvedValue([]);
	mocks.activeMachine.mockResolvedValue({
		credential: { mcpServerId: "server" },
	});
	mocks.generations.mockResolvedValue([]);
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.organization.mockResolvedValue({
		id: "org-1",
		descopeTenantId: "tenant-1",
	});
	mocks.app.mockResolvedValue({ id: "root-1", organizationId: "org-1" });
	mocks.credential.mockResolvedValue({
		accessToken: "do-not-return-this-token",
		selectedCredential: {
			scope: "tenant",
			organizationId: "org-1",
			providerId: "provider-1",
			connectionInstanceId: "conn-1",
			accountRevisionDigest: "c".repeat(64),
		},
	});
});

const nativeDescriptor = {
	kind: "native_rpc" as const,
	mount: {
		version: 1 as const,
		organizationId: "org-1",
		rootAppId: "root-1",
		mountAppIds: ["root-1", "app-1"],
		sourceAppId: "app-1",
		sourceToolRowId: "tool-1",
		sourceToolId: "action",
		mountedToolId: "mount__action",
		transport: "rpc" as const,
		endpoint: "example/action",
		effectiveToolDigest: "a".repeat(64),
	},
	ownerUserId: "owner",
	subject: {
		scope: "principal" as const,
		principalId: "machine",
		mcpServerId: "server",
	},
	reviewSessionId: "session",
	reviewClientRecordId: "client",
};
async function revision(
	set: TenantToolPolicySet = policySet,
	reviewed = descriptor as unknown,
) {
	const toolDigest = await canonicalDigest(tool);
	const mountDigest = await canonicalDigest(reviewed);
	const resourceGenerationDigest = await canonicalDigest([]);
	const ruleDigest = await canonicalDigest({
		organizationId: "org-1",
		appId: "app-1",
		rootAppId: "root-1",
		mountedToolId: "mount__action",
		toolRowId: "tool-1",
		toolDigest,
		mountDigest,
		resourceGenerationDigest,
		policySet: set,
	});
	return {
		id: "rev-1",
		organizationId: "org-1",
		appId: "app-1",
		rootAppId: "root-1",
		mountedToolId: "mount__action",
		toolRowId: "tool-1",
		toolDigest,
		mountDigest,
		resourceGenerationDigest,
		ruleDigest,
		mountDescriptor: reviewed,
		predicate,
		effect,
		policySet: set,
		revokedAt: null,
	};
}

function useNativeRevision(row: Awaited<ReturnType<typeof revision>>) {
	const fences = [
		{
			subjectKey: JSON.stringify(["machine-principal", "machine", "server"]),
			sequence: 1,
			policyId: row.id,
			policyRowId: row.id,
			revokedAt: null,
		},
	];
	mocks.revisions.mockResolvedValue([row]);
	mocks.fences.mockResolvedValue(fences);
	return canonicalDigest({
		fences,
		decisions: [{ revisionId: row.id, ruleDigest: row.ruleDigest }],
	});
}

function serviceClient() {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType: "service-binding",
			organizationId: "org-1",
			externalAgentPrincipalId: "machine",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "client",
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext,
	});
}

function ownerClient(fetch: (request: Request) => Promise<Response>) {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: userContext({
			organizationId: "org-1",
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

describe("tenant tool policy draft", () => {
	it("prepares an owner-reviewed account receipt without disclosing the token", async () => {
		const { accountRevisionDigest: _digest, ...raw } = descriptor;
		const fetch = async () =>
			Response.json({
				descriptor: raw,
				descriptorDigest: await canonicalDigest(raw),
			});
		const result = await ownerClient(fetch).prepareTenantToolPolicy({
			rootAppId: "root-1",
			mountedToolId: "mount__action",
			exampleArgs: { action: "safe" },
		});
		expect(result.descriptor.accountRevisionDigest).toBe("c".repeat(64));
		expect(JSON.stringify(result)).not.toContain("do-not-return-this-token");
		expect(mocks.credential).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				scope: "tenant",
				providerId: "provider-1",
				connectionInstanceId: "conn-1",
				delegatedToolUse: { appId: "app-1", arguments: { action: "safe" } },
			}),
		);
		expect(mocks.prepare).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				exampleArgsDigest: await canonicalDigest({ action: "safe" }),
			}),
		);
	});
	it("does not authorize a call without a verified mount and credential binding", async () => {
		expect(
			await serviceClient().resolveTenantToolPolicy({
				organizationId: "org-1",
				descriptor,
				descriptorDigest: "wrong",
				args: {},
			}),
		).toEqual({ matched: false, revisionId: null, ruleDigest: null });
	});
	it("rejects an organization mismatch", async () => {
		await expect(
			serviceClient().resolveTenantToolPolicy({
				organizationId: "org-2",
				descriptor,
				descriptorDigest: "wrong",
				args: {},
			}),
		).rejects.toThrow(/does not match/);
	});
	it("matches a reviewed revision and its bounded arguments", async () => {
		const row = await revision(policySet, nativeDescriptor);
		const compositeDigest = await useNativeRevision(row);
		const input = {
			organizationId: "org-1",
			descriptor: nativeDescriptor,
			descriptorDigest: row.mountDigest,
			args: { action: "safe" },
		};
		expect(await serviceClient().resolveTenantToolPolicy(input)).toMatchObject({
			matched: true,
			revisionId: row.id,
			ruleDigest: compositeDigest,
			effect,
		});
		expect(
			await serviceClient().resolveTenantToolPolicy({
				...input,
				args: { action: "unsafe" },
			}),
		).toMatchObject({ matched: true, defaultAsk: true });
	});
	it("lets deny and ask override matching allows", async () => {
		const ask = { ...effect, disposition: "ask" as const };
		const deny = { ...effect, disposition: "deny" as const };
		const set: TenantToolPolicySet = {
			evaluatorVersion: 1,
			defaultDisposition: "ask",
			rules: [
				{ id: "allow", predicate, effect },
				{ id: "ask", predicate, effect: ask },
				{ id: "deny", predicate, effect: deny },
			],
		};
		const row = await revision(set, nativeDescriptor);
		await useNativeRevision(row);
		const input = {
			organizationId: "org-1",
			descriptor: nativeDescriptor,
			descriptorDigest: row.mountDigest,
			args: { action: "safe" },
		};
		expect(await serviceClient().resolveTenantToolPolicy(input)).toMatchObject({
			matched: true,
			effect: deny,
		});
		const ordered = await revision(
			{
				...set,
				rules: [set.rules[0]!, set.rules[1]!],
			},
			nativeDescriptor,
		);
		await useNativeRevision(ordered);
		expect(await serviceClient().resolveTenantToolPolicy(input)).toMatchObject({
			matched: true,
			effect: ask,
		});
	});
	it("never allows when a later deny exceeds the shared evaluation budget", async () => {
		const allow = {
			version: 1 as const,
			schema: {
				type: "object" as const,
				properties: {},
				additionalProperties: true,
			},
		};
		const deny = {
			version: 1 as const,
			schema: {
				type: "object" as const,
				properties: {
					values: {
						type: "array" as const,
						items: { type: "string" as const },
					},
				},
				required: ["values"],
				additionalProperties: false,
			},
		};
		const row = await revision(
			{
				evaluatorVersion: 1,
				defaultDisposition: "ask",
				rules: [
					{ id: "allow", predicate: allow, effect },
					{
						id: "deny",
						predicate: deny,
						effect: { ...effect, disposition: "deny" },
					},
				],
			},
			nativeDescriptor,
		);
		await useNativeRevision(row);
		expect(
			await serviceClient().resolveTenantToolPolicy({
				organizationId: "org-1",
				descriptor: nativeDescriptor,
				descriptorDigest: row.mountDigest,
				args: { values: Array(20_001).fill("x") },
			}),
		).toMatchObject({ matched: true, defaultAsk: true });
	});
	it("does not revive an older revision after a replacement is revoked", async () => {
		const row = await revision();
		mocks.revisions.mockResolvedValue([
			{ ...row, id: "newer", revokedAt: "2026-10-30T12:00:00.000Z" },
			row,
		]);
		expect(
			await serviceClient().resolveTenantToolPolicy({
				organizationId: "org-1",
				descriptor,
				descriptorDigest: row.mountDigest,
				args: { action: "safe" },
			}),
		).toMatchObject({ matched: false });
	});
	it("rejects a changed source tool", async () => {
		const row = await revision();
		mocks.revisions.mockResolvedValue([row]);
		mocks.tool.mockResolvedValue({ ...tool, config: { method: "different" } });
		expect(
			await serviceClient().resolveTenantToolPolicy({
				organizationId: "org-1",
				descriptor,
				descriptorDigest: row.mountDigest,
				args: { action: "safe" },
			}),
		).toMatchObject({ matched: false });
	});
	it("rejects a dependency generation change even if tool content was reverted", async () => {
		const row = await revision();
		mocks.revisions.mockResolvedValue([row]);
		mocks.generations.mockResolvedValue([
			{ kind: "app", id: "root-1", generation: 2 },
		]);
		expect(
			await serviceClient().resolveTenantToolPolicy({
				organizationId: "org-1",
				descriptor,
				descriptorDigest: row.mountDigest,
				args: { action: "safe" },
			}),
		).toMatchObject({ matched: false });
	});
	it("rejects source changes between review and creating a rule", async () => {
		const digest = await canonicalDigest(nativeDescriptor);
		mocks.consume.mockResolvedValue({
			descriptor: nativeDescriptor,
			descriptorDigest: digest,
			sourceToolDigest: "old-tool-digest",
			exampleArgsDigest: await canonicalDigest({}),
		});
		await expect(
			ownerClient(async () => {
				throw new Error("unexpected fetch");
			}).createTenantToolPolicy({
				preparationId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
				expectedDescriptorDigest: digest,
				exampleArgs: {},
				policySet,
			}),
		).rejects.toThrow(/Tool changed since review/);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("rejects a mount change between review and creating a rule", async () => {
		const digest = await canonicalDigest(nativeDescriptor);
		mocks.consume.mockResolvedValue({
			descriptor: nativeDescriptor,
			descriptorDigest: digest,
			sourceToolDigest: await canonicalDigest(tool),
			exampleArgsDigest: await canonicalDigest({}),
		});
		const changed = {
			...nativeDescriptor.mount,
			effectiveToolDigest: "b".repeat(64),
		};
		const fetch = async () =>
			Response.json({
				descriptor: changed,
				descriptorDigest: await canonicalDigest(changed),
			});
		await expect(
			ownerClient(fetch).createTenantToolPolicy({
				preparationId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
				expectedDescriptorDigest: digest,
				exampleArgs: {},
				policySet,
			}),
		).rejects.toThrow(/Native tool changed since review/);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("does not allow service principals to create owner rules", async () => {
		await expect(
			serviceClient().createTenantToolPolicy({
				preparationId: "5e8c7e58-0c4b-474a-8ae0-dbf36612482d",
				expectedDescriptorDigest: "digest",
				exampleArgs: {},
				policySet,
			}),
		).rejects.toThrow();
	});
});
