import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";

const mocks = vi.hoisted(() => ({
	authority: vi.fn(),
	mount: vi.fn(),
	fresh: vi.fn(),
	presence: vi.fn(),
	app: vi.fn(),
	digest: vi.fn(),
	toolDigest: vi.fn(),
	candidate: vi.fn(),
}));
vi.mock("../auth-helpers", () => ({
	resolveFreshExternalAgentAihAuthority: mocks.authority,
}));
vi.mock("@tedix/api-client/internal", () => ({
	getInternalApiClient: () => ({
		mcpGovernance: { resolveNativeRpcPolicyCandidate: mocks.candidate },
	}),
}));
vi.mock("@tedix/mcp-shared/auth/tool-scopes", () => ({
	resolveMcpToolNamespace: () => "example",
	resolveMcpToolRequiredScopes: () => ["example.execute"],
}));
vi.mock("./codemode-auth", () => ({
	resolveCodeModeInnerToolScopes: () => ["example.execute"],
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		apps: { getByIdWithTools: mocks.app },
		mcpGovernance: { resolveTenantPolicyPresence: mocks.presence },
	}),
}));
vi.mock("./tenant-policy-mount", () => ({
	prepareTenantNativePolicyMount: mocks.mount,
	resolveFreshPolicyMount: mocks.fresh,
	tenantPolicyDescriptorDigest: mocks.digest,
	tenantPolicyEffectiveToolDigest: mocks.toolDigest,
}));
import {
	resolveNativePolicyCandidate,
	tenantMachinePolicyFallbackBlocked,
} from "./tenant-native-candidate";

const caller = {
	authType: "external_agent",
	organizationId: "org",
	externalAgentPrincipalId: "principal",
	externalAgentSessionId: "session",
	externalAgentClientRecordId: "record",
	externalAgentMcpServerId: "server",
	clientId: "client",
};
const agent = {
	appId: "root",
	env: { API_SERVICE: {} },
	callerIdentity: caller,
} as unknown as ServerContext;
const tool = {
	id: "row",
	toolId: "mounted__call",
	config: { transport: "rpc" },
} as unknown as AppTool;
const mount = {
	sourceToolRowId: "row",
	sourceAppId: "source",
	effectiveToolDigest: "tool-digest",
};
const candidate = {
	descriptor: {
		mount,
		subject: {
			scope: "principal",
			principalId: "principal",
			mcpServerId: "server",
		},
	},
	descriptorDigest: "descriptor",
	revisionId: "revision",
	ruleDigest: "rule",
	effect: {
		disposition: "allow",
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.authority.mockResolvedValue({ scopes: ["example.execute"] });
	mocks.mount.mockResolvedValue({
		descriptor: mount,
		descriptorDigest: JSON.stringify(mount),
	});
	mocks.digest.mockImplementation(async (value: unknown) =>
		JSON.stringify(value),
	);
	mocks.toolDigest.mockResolvedValue("tool-digest");
	mocks.candidate.mockResolvedValue({ candidate });
	mocks.fresh.mockResolvedValue({
		sourceAppId: "source",
		sourceToolId: "call",
		tool,
	});
	mocks.presence.mockResolvedValue({ fenced: false });
});

describe("native rule candidate", () => {
	it("rechecks actual required scopes, arguments and revision before dispatch", async () => {
		const args = { value: "first" };
		const result = await resolveNativePolicyCandidate(agent, tool, args);
		expect(await result?.revalidate()).toBe(true);
		args.value = "changed";
		expect(await result?.revalidate()).toBe(false);
	});
	it("rejects revoked machine scopes and another principal", async () => {
		mocks.authority.mockResolvedValue({ scopes: [] });
		expect(await resolveNativePolicyCandidate(agent, tool, {})).toBeNull();
		mocks.authority.mockResolvedValue({ scopes: ["example.execute"] });
		mocks.candidate.mockResolvedValue({
			candidate: {
				...candidate,
				descriptor: {
					...candidate.descriptor,
					subject: { ...candidate.descriptor.subject, principalId: "other" },
				},
			},
		});
		expect(await resolveNativePolicyCandidate(agent, tool, {})).toBeNull();
	});
	it("blocks legacy fallback for an invalidated fence or failed presence lookup", async () => {
		expect(await tenantMachinePolicyFallbackBlocked(agent, tool)).toBe(false);
		mocks.presence.mockResolvedValue({ fenced: true });
		expect(await tenantMachinePolicyFallbackBlocked(agent, tool)).toBe(true);
		mocks.presence.mockRejectedValue(new Error("unavailable"));
		expect(await tenantMachinePolicyFallbackBlocked(agent, tool)).toBe(true);
	});
	it.each([
		{ authType: "oauth", userId: "owner", organizationId: "org" },
		{
			authType: "service",
			kernel: true,
			userId: "owner",
			organizationId: "org",
		},
	])(
		"blocks human and replay fallback on an invalidated source fence",
		async (identity) => {
			const mcpTool = { ...tool, config: { transport: "mcp" } } as AppTool;
			mocks.fresh.mockResolvedValue({
				sourceAppId: "source",
				sourceToolId: "edit",
				tool: mcpTool,
			});
			mocks.presence.mockResolvedValue({ fenced: true });
			expect(
				await tenantMachinePolicyFallbackBlocked(
					{ ...agent, callerIdentity: identity } as ServerContext,
					mcpTool,
				),
			).toBe(true);
			expect(mocks.presence).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceAppId: "source",
					sourceToolId: "edit",
				}),
			);
		},
	);
});
