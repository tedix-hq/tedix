import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { canonicalDigest } from "../../lib/blueprint-digest";
import type { BaseContext } from "../orpc";
import { userContext } from "../test-context";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	profile: vi.fn(),
	generations: vi.fn(),
	issue: vi.fn(),
	redeem: vi.fn(),
	result: vi.fn(),
	machineResult: vi.fn(),
	machineList: vi.fn(),
	activeMachine: vi.fn(),
	machineAuthIssue: vi.fn(),
	machineAuthRedeem: vi.fn(),
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
vi.mock("@tedix/db/queries/tenant-tool-policy", async (load) => ({
	...(await load<object>()),
	getProviderIdentityProfile: mocks.profile,
	getTenantToolPolicyResourceGenerations: mocks.generations,
}));
vi.mock("@tedix/db/queries/provider-probe-receipts", async (load) => ({
	...(await load<object>()),
	createProviderProbeReceipt: mocks.issue,
	consumeProviderProbeReceipt: mocks.redeem,
	createProviderProbeResult: mocks.result,
	createMachineProviderProbeResult: mocks.machineResult,
	listMachineProviderProbeResults: mocks.machineList,
	createMachineProviderProbeAuthorization: mocks.machineAuthIssue,
	consumeMachineProviderProbeAuthorization: mocks.machineAuthRedeem,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

const mount = {
	version: 1 as const,
	organizationId: "org-1",
	rootAppId: "root",
	mountAppIds: ["root", "source"],
	sourceAppId: "source",
	sourceToolRowId: "write-row",
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
	sourceToolRowId: "probe-row",
	sourceToolId: "probe",
	mountedToolId: "probe",
	upstreamOperation: "probe",
	effectiveToolDigest: "d".repeat(64),
	acceptsEmptyArguments: true,
};
const profile = {
	version: 1 as const,
	operation: "probe",
	selectors: [["account", "id"]],
};
const safetyAttestation = "safe_empty_probe" as const;
const args = { action: "edit" };
const receiptId = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.generations.mockResolvedValue([]);
	const resourceGenerationDigest = await canonicalDigest({
		mount: [],
		probe: [],
	});
	const profileDigest = await canonicalDigest({
		organizationId: "org-1",
		mount,
		probeMount,
		profile,
		safetyAttestation,
		resourceGenerationDigest,
	});
	mocks.profile.mockResolvedValue({
		id: "profile",
		organizationId: "org-1",
		mount,
		probeMount,
		profile,
		safetyAttestation,
		profileDigest,
		resourceGenerationDigest,
		createdBy: "owner",
		createdAt: "2026-10-30T00:00:00Z",
		revokedAt: null,
	});
	mocks.issue.mockImplementation(async (_db, row) => row);
	mocks.result.mockImplementation(async (_db, row) => row);
});

function ownerClient(
	scopes: string[],
	fetch = async () => Response.json({ accountRevisionDigest: "e".repeat(64) }),
) {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: userContext({
			organizationId: "org-1",
			userId: "owner",
			sub: "owner",
			claims: { scopes },
			permissions: ["settings:manage"],
			db: {} as BaseContext["db"],
			env: {
				ENVIRONMENT: "test",
				MCP_SERVICE: { fetch },
			} as unknown as CloudflareEnv,
		}),
	});
}

describe("provider identity probe receipts", () => {
	it("redeems machine authorization only while session and profile remain current", async () => {
		const row = await mocks.profile();
		const receipt = {
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "record",
			clientId: "client",
			mcpServerId: "server",
			profileId: "profile",
			profileDigest: row.profileDigest,
		};
		const context = {
			authType: "service-binding",
			organizationId: "org-1",
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext;
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		mocks.machineAuthRedeem
			.mockResolvedValueOnce(receipt)
			.mockResolvedValueOnce(receipt)
			.mockResolvedValueOnce(null);
		mocks.activeMachine
			.mockResolvedValueOnce({ credential: { mcpServerId: "other" } })
			.mockResolvedValueOnce({ credential: { mcpServerId: "server" } });
		const input = { organizationId: "org-1", receiptId, exampleArgs: args };
		await expect(client.redeemMachineIdentityProbe(input)).rejects.toThrow(
			/changed/,
		);
		await expect(client.redeemMachineIdentityProbe(input)).resolves.toEqual({
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "record",
			clientId: "client",
			mcpServerId: "server",
			profileId: "profile",
			exampleArgs: args,
		});
		await expect(client.redeemMachineIdentityProbe(input)).rejects.toThrow(
			/expired or was already used/,
		);
	});
	it("requires a machine scope and active matching credential before initiating a probe", async () => {
		const machine = {
			authType: "service-binding",
			organizationId: "org-1",
			externalAgentPrincipalId: "principal",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "record",
			serviceBindingAuthorization: { source: "mcp-tool", toolId: "tool" },
			tediScopes: ["connections.execute"],
			db: {},
			env: {
				ENVIRONMENT: "test",
				MCP_SERVICE: { fetch: async () => Response.json({ receiptId }) },
			},
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-External-Agent-OAuth-Client-Id": "client",
				"X-Tedix-External-Agent-Mcp-Server-Id": "server",
			}),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as unknown as BaseContext;
		mocks.activeMachine.mockResolvedValue({
			credential: { mcpServerId: "server" },
		});
		const client = createRouterClient(mcpGovernanceContractRouter, {
			context: machine,
		});
		await expect(
			client.prepareMachineIdentityProbe({
				profileId: "profile",
				exampleArgs: args,
			}),
		).resolves.toEqual({ receiptId });
		expect(mocks.machineAuthIssue).toHaveBeenCalledTimes(1);
		const denied = createRouterClient(mcpGovernanceContractRouter, {
			context: { ...machine, tediScopes: [] },
		});
		await expect(
			denied.prepareMachineIdentityProbe({
				profileId: "profile",
				exampleArgs: args,
			}),
		).rejects.toThrow(/connections.execute/);
		mocks.activeMachine.mockResolvedValue({
			credential: { mcpServerId: "other" },
		});
		await expect(
			client.prepareMachineIdentityProbe({
				profileId: "profile",
				exampleArgs: args,
			}),
		).rejects.toThrow(/unavailable/);
	});
	it("lists machine proof metadata only for an active owner", async () => {
		mocks.machineList.mockResolvedValue([
			{
				id: receiptId,
				profileId: "profile",
				principalId: "principal",
				sessionId: "session",
				clientRecordId: "record",
				expiresAt: "2026-10-30T12:00:00.000Z",
				accountRevisionDigest: "private",
				argsDigest: "private",
			},
		]);
		const result = await ownerClient([]).listMachineProviderProbes();
		expect(result.items).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("private");
		mocks.member.mockResolvedValue({ status: "active", role: "member" });
		await expect(ownerClient([]).listMachineProviderProbes()).rejects.toThrow(
			/owner or admin/,
		);
	});
	it("records only the gateway-attributed active machine against the current profile", async () => {
		const row = await mocks.profile();
		const input = {
			organizationId: "org-1",
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "record",
			clientId: "client",
			mcpServerId: "server",
			profileId: "profile",
			profileDigest: row.profileDigest,
			exampleArgs: args,
			accountRevisionDigest: "e".repeat(64),
		};
		const context = {
			authType: "service-binding",
			organizationId: "org-1",
			externalAgentPrincipalId: "principal",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "record",
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext;
		const client = createRouterClient(mcpGovernanceContractRouter, { context });
		mocks.activeMachine.mockResolvedValue({
			credential: { mcpServerId: "server" },
		});
		await expect(
			client.recordMachineProviderProbe({ ...input, principalId: "other" }),
		).rejects.toThrow(/gateway-verified/);
		mocks.activeMachine.mockResolvedValueOnce(null);
		await expect(client.recordMachineProviderProbe(input)).rejects.toThrow(
			/unavailable/,
		);
		await expect(
			client.recordMachineProviderProbe({
				...input,
				profileDigest: "f".repeat(64),
			}),
		).rejects.toThrow(/unavailable/);
		const result = await client.recordMachineProviderProbe(input);
		expect(result.receiptId).toBeDefined();
		expect(mocks.machineResult).toHaveBeenCalledTimes(1);
		expect(mocks.machineResult.mock.calls[0]?.[1]).toMatchObject({
			principalId: "principal",
			sessionId: "session",
			clientRecordId: "record",
			profileId: "profile",
		});
	});
	it("requires a verified execute scope before issuing an authority receipt", async () => {
		await expect(
			ownerClient([]).probeProviderIdentityProfile({
				profileId: "profile",
				exampleArgs: args,
			}),
		).rejects.toThrow(/connections.execute/);
		expect(mocks.issue).not.toHaveBeenCalled();
	});

	it("stores an owner-bound result and returns only its opaque receipt id", async () => {
		const result = await ownerClient([
			"connections.execute",
		]).probeProviderIdentityProfile({
			profileId: "profile",
			exampleArgs: args,
		});
		expect(result).toEqual({ resultReceiptId: expect.any(String) });
		expect(mocks.issue).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actorUserId: "owner",
				argsDigest: await canonicalDigest(args),
			}),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actorUserId: "owner",
				argsDigest: await canonicalDigest(args),
				accountRevisionDigest: "e".repeat(64),
			}),
		);
		expect(JSON.stringify(result)).not.toContain("e".repeat(64));
	});

	it("service redemption rechecks active profile and owner before returning the recorded actor", async () => {
		const row = await mocks.profile();
		mocks.redeem.mockResolvedValueOnce({
			organizationId: "org-1",
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: row.profileDigest,
		});
		const client = createRouterClient(mcpGovernanceContractRouter, {
			context: {
				authType: "service-binding",
				organizationId: "org-1",
				db: {},
				env: { ENVIRONMENT: "test" },
				headers: new Headers({ "X-Service-Binding": "true" }),
				url: new URL("https://api.test/rpc"),
				rateLimiter: { limit: async () => ({ success: true }) },
			} as BaseContext,
		});
		expect(
			await client.redeemProviderIdentityProbe({
				organizationId: "org-1",
				receiptId,
				exampleArgs: args,
			}),
		).toEqual({
			actorUserId: "owner",
			profileId: "profile",
			exampleArgs: args,
			verifiedScopes: ["connections.execute"],
		});
		mocks.redeem.mockResolvedValueOnce({
			organizationId: "org-1",
			actorUserId: "owner",
			profileId: "profile",
			profileDigest: row.profileDigest,
		});
		mocks.profile.mockResolvedValueOnce({
			...row,
			revokedAt: "2026-10-30T00:00:00Z",
		});
		await expect(
			client.redeemProviderIdentityProbe({
				organizationId: "org-1",
				receiptId,
				exampleArgs: args,
			}),
		).rejects.toThrow(/changed or was revoked/);
	});
});
