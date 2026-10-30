import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";
import { buildHomeSurfaceTools } from "./home-surface-tools";

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

describe("generated Home policy provenance", () => {
	const ask = buildHomeSurfaceTools().find((entry) => entry.toolId === "ask")!;
	const root = {
		id: "root",
		slug: "gateway",
		organizationId: "org",
		metadata: { mcpConfig: { aggregateApps: [{ slug: "mounted" }] } },
	};
	beforeEach(() => {
		mocks.fresh.mockResolvedValue({
			sourceAppId: "root",
			sourceToolId: "ask",
			mountAppIds: ["root"],
			sourceKind: "home-surface",
			tool: ask,
		});
		mocks.toolDigest.mockImplementation(async (value: unknown) =>
			JSON.stringify(value),
		);
		mocks.app.mockResolvedValue({ app: root, tools: [] });
	});
	it("checks exact and any-root policy fences for a canonical generated tool", async () => {
		expect(await tenantMachinePolicyFallbackBlocked(agent, ask)).toBe(false);
		expect(mocks.presence.mock.calls).toEqual([
			[
				{
					organizationId: "org",
					sourceAppId: "root",
					sourceToolRowId: ask.id,
					sourceToolId: "ask",
					rootAppId: "root",
					mountedToolId: "ask",
				},
			],
			[
				{
					organizationId: "org",
					sourceAppId: "root",
					sourceToolRowId: ask.id,
					sourceToolId: "ask",
				},
			],
		]);
	});
	it.each([
		{ ...ask, id: "stored-row" },
		{ ...ask, meta: { ...ask.meta, source: "forged" } },
		{ ...ask, config: { ...ask.config, endpoint: "other/operation" } },
		{ ...ask, config: { ...ask.config, transport: "code" } },
		{ ...ask, inputSchema: { type: "object" as const, properties: {} } },
		{ ...ask, annotations: { readOnlyHint: true } },
		{ ...ask, authRequired: true },
	])("rejects a forged Home definition %#", async (changed) => {
		expect(await tenantMachinePolicyFallbackBlocked(agent, changed)).toBe(true);
		expect(mocks.presence).not.toHaveBeenCalled();
	});
	it("keeps revoked fences and failed reads closed", async () => {
		mocks.presence
			.mockResolvedValueOnce({ fenced: false })
			.mockResolvedValueOnce({ fenced: true });
		expect(await tenantMachinePolicyFallbackBlocked(agent, ask)).toBe(true);
		mocks.presence.mockRejectedValue(new Error("presence unavailable"));
		expect(await tenantMachinePolicyFallbackBlocked(agent, ask)).toBe(true);
		mocks.fresh.mockRejectedValue(new Error("fresh mount unavailable"));
		expect(await tenantMachinePolicyFallbackBlocked(agent, ask)).toBe(true);
	});
	it("cannot revive cached Home through a matching stored shadow", async () => {
		mocks.fresh.mockResolvedValue(null);
		const cached = { ...agent, appMetadata: root.metadata } as ServerContext;
		for (const currentRoot of [
			root,
			{ ...root, metadata: { mcpConfig: { aggregateApps: [] } } },
			{ ...root, organizationId: "another-org" },
		]) {
			mocks.app.mockResolvedValue({ app: currentRoot, tools: [ask] });
			expect(await tenantMachinePolicyFallbackBlocked(cached, ask)).toBe(true);
		}
		const shadow = { ...ask, id: "stored-row" };
		mocks.app.mockResolvedValue({ app: root, tools: [shadow] });
		expect(await tenantMachinePolicyFallbackBlocked(cached, shadow)).toBe(true);
		expect(mocks.presence).not.toHaveBeenCalled();
		mocks.fresh.mockResolvedValue({
			sourceAppId: "root",
			sourceToolId: "ask",
			sourceKind: "app-tool",
			tool: ask,
		});
		expect(await tenantMachinePolicyFallbackBlocked(agent, ask)).toBe(true);
		expect(mocks.presence).not.toHaveBeenCalled();
	});
	it("preserves an ordinary stored RPC tool on an app without Home exposure", async () => {
		mocks.fresh.mockResolvedValue(null);
		const stored = { ...tool, toolId: "ask" } as AppTool;
		mocks.app.mockResolvedValue({
			app: { ...root, metadata: { mcpConfig: { aggregateApps: [] } } },
			tools: [stored],
		});
		expect(await tenantMachinePolicyFallbackBlocked(agent, stored)).toBe(false);
	});
});
