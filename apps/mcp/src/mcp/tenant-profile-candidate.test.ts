import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";

const mocks = vi.hoisted(() => ({
	target: vi.fn(),
	gateway: vi.fn(),
	candidate: vi.fn(),
	machineCandidate: vi.fn(),
	anyRoot: vi.fn(),
	app: vi.fn(),
	crossDigest: vi.fn(),
	authority: vi.fn(),
	fresh: vi.fn(),
	discovery: vi.fn(),
	profile: vi.fn(),
	prepare: vi.fn(),
	digest: vi.fn(),
	toolDigest: vi.fn(),
}));
vi.mock("./multi-org-tool-target", () => ({
	resolveMultiOrgToolTarget: mocks.target,
}));
vi.mock("../auth-helpers", () => ({
	resolveFreshExternalAgentAihAuthority: mocks.authority,
}));
vi.mock("@tedix/api-client/internal", () => ({
	getInternalApiClient: () => ({
		apps: { getByIdWithTools: mocks.app },
		mcpGovernance: {
			resolveMachinePolicyCandidate: mocks.machineCandidate,
			resolveMachinePolicyAnyRoot: mocks.anyRoot,
			resolveMachinePolicyDiscovery: mocks.discovery,
			resolveProviderIdentityProfile: mocks.profile,
		},
	}),
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		apps: { getBySlugWithTools: mocks.gateway },
		mcpGovernance: {
			resolveTenantPolicyCandidate: mocks.candidate,
			resolveMachinePolicyCandidate: mocks.machineCandidate,
			resolveTenantPolicyDiscovery: mocks.discovery,
			resolveProviderIdentityProfile: mocks.profile,
		},
	}),
}));
vi.mock("./tenant-policy-mount", () => ({
	prepareTenantIdentityProfileMount: mocks.prepare,
	resolveFreshPolicyMount: mocks.fresh,
	tenantPolicyDescriptorDigest: mocks.digest,
	tenantPolicyEffectiveToolDigest: mocks.toolDigest,
	tenantPolicyCrossMountDigest: mocks.crossDigest,
}));
import {
	resolveMachineCandidate,
	resolveTenantProfileCandidate,
	tenantProfileCandidateIsBounded,
	tenantProfileDiscoveryPotential,
} from "./tenant-profile-candidate";

const mount = {
	rootAppId: "root",
	mountedToolId: "gateway__edit",
	sourceAppId: "source",
	sourceToolRowId: "row",
	effectiveToolDigest: "tool-digest",
};
const probeMount = { rootAppId: "root", mountedToolId: "gateway__identity" };
const profile = {
	id: "profile",
	profileDigest: "profile-digest",
	profile: { version: 1, operation: "identity", selectors: [["id"]] },
	probeMount,
};
const candidate = {
	descriptor: {
		actorUserId: "owner",
		profileId: "profile",
		profileDigest: "profile-digest",
		accountRevisionDigest: "a".repeat(64),
		mount,
	},
	descriptorDigest: "descriptor",
	ruleDigest: "rule",
	revisionId: "revision",
	effect: {
		disposition: "allow",
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
};
const agent = {
	env: { API_SERVICE: {} },
	callerIdentity: {
		authType: "oauth",
		userId: "owner",
		scopes: ["connections.execute"],
	},
} as unknown as ServerContext;
const tool = {
	id: "row",
	toolId: "gateway__edit",
	config: { transport: "mcp" },
} as unknown as AppTool;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.target.mockReturnValue({
		organizationId: "org",
		gatewaySlug: "gateway",
	});
	mocks.gateway.mockResolvedValue({
		app: { id: "root", organizationId: "org" },
	});
	mocks.candidate.mockResolvedValue({ candidate });
	mocks.discovery.mockResolvedValue({ potential: true });
	mocks.profile.mockResolvedValue({ profile });
	mocks.prepare.mockImplementation(
		async ({ mountedToolId }: { mountedToolId: string }) => ({
			descriptorDigest:
				mountedToolId === mount.mountedToolId ? "mount" : "probe",
		}),
	);
	mocks.digest.mockImplementation(async (value: { mountedToolId?: string }) =>
		value.mountedToolId
			? value.mountedToolId === mount.mountedToolId
				? "mount"
				: "probe"
			: JSON.stringify(value),
	);
	mocks.toolDigest.mockResolvedValue("tool-digest");
	mocks.crossDigest.mockResolvedValue("cross-digest");
});

describe("machine policy candidate", () => {
	it("does not lower scopes for an explicitly high-impact tool", () => {
		const reviewed = {
			effect: {
				disposition: "allow",
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
		};
		const boundedTool = {
			...tool,
			annotations: { destructiveHint: true },
			meta: {
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			},
		} as unknown as AppTool;
		expect(
			tenantProfileCandidateIsBounded(reviewed as never, boundedTool),
		).toBe(true);
		for (const riskTier of ["high_impact_write", "external_side_effect"]) {
			const high = {
				...boundedTool,
				meta: {
					"com.tedix/policy": {
						riskTier,
						blastRadius:
							riskTier === "high_impact_write" ? "tenant" : "external_system",
					},
				},
			} as unknown as AppTool;
			expect(tenantProfileCandidateIsBounded(reviewed as never, high)).toBe(
				false,
			);
		}
	});
	it("verifies a direct source independently against the reviewed aggregate mount", async () => {
		const machine = {
			...agent,
			appId: "source",
			callerIdentity: {
				authType: "external_agent",
				organizationId: "org",
				externalAgentPrincipalId: "principal",
				externalAgentSessionId: "session",
				externalAgentClientRecordId: "record",
				externalAgentMcpServerId: "server",
				clientId: "client",
			},
		} as unknown as ServerContext;
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.fresh.mockImplementation(
			async ({ rootAppId }: { rootAppId: string }) =>
				rootAppId === "source" ? null : { sourceAppId: "source", tool },
		);
		mocks.app.mockResolvedValue({
			app: { organizationId: "org" },
			tools: [tool],
		});
		mocks.anyRoot.mockResolvedValue({
			candidate: {
				...candidate,
				descriptor: {
					...candidate.descriptor,
					kind: "machine",
					subject: {
						scope: "principal",
						principalId: "principal",
						mcpServerId: "server",
					},
				},
			},
		});
		const result = await resolveMachineCandidate(machine, tool, {
			page: "one",
		});
		expect(result?.probe.requireTenantCredential).toBe(true);
		mocks.crossDigest
			.mockResolvedValueOnce("changed")
			.mockResolvedValueOnce("original");
		expect(await result?.probe.revalidate()).toBe(false);
	});
	it("requires fresh machine authority and rejects revocation before dispatch", async () => {
		const machine = {
			...agent,
			appId: "root",
			callerIdentity: {
				authType: "external_agent",
				organizationId: "org",
				externalAgentPrincipalId: "principal",
				externalAgentSessionId: "session",
				externalAgentClientRecordId: "record",
				externalAgentMcpServerId: "server",
				clientId: "client",
			},
		} as unknown as ServerContext;
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.fresh.mockResolvedValue({ sourceAppId: "source", tool });
		mocks.machineCandidate.mockResolvedValue({
			candidate: {
				...candidate,
				descriptor: {
					...candidate.descriptor,
					kind: "machine",
					subject: {
						scope: "principal",
						principalId: "principal",
						mcpServerId: "server",
					},
				},
			},
		});
		const result = await resolveMachineCandidate(machine, tool, {
			page: "one",
		});
		expect(result?.probe.requireTenantCredential).toBe(true);
		expect(await result?.probe.revalidate()).toBe(true);
		mocks.authority.mockResolvedValue(null);
		expect(await result?.probe.revalidate()).toBe(false);
	});
	it("rejects another session for a session-scoped rule", async () => {
		const machine = {
			...agent,
			appId: "root",
			callerIdentity: {
				authType: "external_agent",
				organizationId: "org",
				externalAgentPrincipalId: "principal",
				externalAgentSessionId: "session",
				externalAgentClientRecordId: "record",
				externalAgentMcpServerId: "server",
				clientId: "client",
			},
		} as unknown as ServerContext;
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.fresh.mockResolvedValue({ sourceAppId: "source", tool });
		mocks.machineCandidate.mockResolvedValue({
			candidate: {
				...candidate,
				descriptor: {
					...candidate.descriptor,
					subject: {
						scope: "session",
						principalId: "principal",
						sessionId: "other",
						clientRecordId: "record",
						clientId: "client",
						mcpServerId: "server",
					},
				},
			},
		});
		expect(await resolveMachineCandidate(machine, tool, {})).toBeNull();
	});
	it("advertises only a currently authorized machine mount", async () => {
		const machine = {
			...agent,
			appId: "root",
			callerIdentity: {
				authType: "external_agent",
				organizationId: "org",
				externalAgentPrincipalId: "principal",
				externalAgentSessionId: "session",
				externalAgentClientRecordId: "record",
				externalAgentMcpServerId: "server",
				clientId: "client",
			},
		} as unknown as ServerContext;
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.fresh.mockResolvedValue({ sourceAppId: "source", tool });
		expect(await tenantProfileDiscoveryPotential(machine, tool)).toBe(true);
		mocks.authority.mockResolvedValue({ scopes: [] });
		expect(await tenantProfileDiscoveryPotential(machine, tool)).toBe(false);
	});
});

describe("profile-bound policy candidate", () => {
	it("requires the actual caller grant and an unchanged approved mount", async () => {
		const result = await resolveTenantProfileCandidate(agent, tool, {
			action: "edit",
		});
		expect(result).toMatchObject({
			revisionId: "revision",
			effect: { disposition: "allow" },
		});
		expect(await result?.probe.revalidate()).toBe(true);
		mocks.candidate.mockResolvedValue({ candidate: null });
		expect(await result?.probe.revalidate()).toBe(false);
	});
	it("rejects missing scopes, another actor, and stale tool configuration", async () => {
		expect(
			await resolveTenantProfileCandidate(
				{
					...agent,
					callerIdentity: { authType: "oauth", userId: "owner", scopes: [] },
				},
				tool,
				{},
			),
		).toBeNull();
		mocks.candidate.mockResolvedValueOnce({
			candidate: {
				...candidate,
				descriptor: { ...candidate.descriptor, actorUserId: "other" },
			},
		});
		expect(await resolveTenantProfileCandidate(agent, tool, {})).toBeNull();
		mocks.toolDigest.mockResolvedValueOnce("changed");
		expect(await resolveTenantProfileCandidate(agent, tool, {})).toBeNull();
	});
	it("refuses a call whose arguments change after its policy decision", async () => {
		const args = { action: "edit" };
		const result = await resolveTenantProfileCandidate(agent, tool, args);
		args.action = "delete";
		expect(await result?.probe.revalidate()).toBe(false);
	});
	it("advertises only a potential path to a caller holding execute scope", async () => {
		expect(await tenantProfileDiscoveryPotential(agent, tool)).toBe(true);
		const high = {
			...tool,
			meta: {
				"com.tedix/policy": {
					riskTier: "high_impact_write",
					blastRadius: "tenant",
				},
			},
		} as unknown as AppTool;
		expect(await tenantProfileDiscoveryPotential(agent, high)).toBe(false);
		expect(
			await tenantProfileDiscoveryPotential(
				{
					...agent,
					callerIdentity: { authType: "oauth", userId: "owner", scopes: [] },
				},
				tool,
			),
		).toBe(false);
		mocks.discovery.mockResolvedValue({ potential: false });
		expect(await tenantProfileDiscoveryPotential(agent, tool)).toBe(false);
	});
});
