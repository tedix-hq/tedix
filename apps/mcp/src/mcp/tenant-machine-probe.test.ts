import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ServerContext } from "./server-context";

const mocks = vi.hoisted(() => ({
	authority: vi.fn(),
	profile: vi.fn(),
	app: vi.fn(),
	record: vi.fn(),
	prepare: vi.fn(),
	resolve: vi.fn(),
	digest: vi.fn(),
	toolDigest: vi.fn(),
	transport: vi.fn(),
	client: vi.fn(),
}));
vi.mock("../auth-helpers", () => ({
	resolveFreshExternalAgentAihAuthority: mocks.authority,
}));
vi.mock("../lib/api-client", () => ({ getApiClient: mocks.client }));
vi.mock("./tenant-policy-mount", () => ({
	prepareTenantIdentityProfileMount: mocks.prepare,
	resolveFreshPolicyMount: mocks.resolve,
	tenantPolicyDescriptorDigest: mocks.digest,
	tenantPolicyEffectiveToolDigest: mocks.toolDigest,
}));
vi.mock("./handler-mcp-transport", () => ({
	executeMcpTransport: mocks.transport,
}));
import { prepareMachineProviderProof } from "./tenant-machine-probe";

const mount = {
	rootAppId: "root",
	mountedToolId: "mount__edit",
	sourceAppId: "source",
	sourceToolRowId: "row",
	effectiveToolDigest: "tool-digest",
	connectionScope: "tenant",
};
const profile = {
	id: "profile",
	organizationId: "org",
	mount,
	probeMount: { ...mount, mountedToolId: "mount__identity" },
	profileDigest: "profile-digest",
	profile: { version: 1, operation: "identity", selectors: [["id"]] },
};
const caller = {
	authType: "external_agent",
	organizationId: "org",
	externalAgentPrincipalId: "principal",
	externalAgentSessionId: "session",
	externalAgentClientRecordId: "record",
	externalAgentMcpServerId: "server",
	clientId: "client",
	scopes: ["connections.execute"],
};
const agent = {
	appId: "root",
	env: { API_SERVICE: {} },
	callerIdentity: caller,
} as unknown as ServerContext;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.client.mockReturnValue({
		mcpGovernance: {
			resolveProviderIdentityProfile: mocks.profile,
			recordMachineProviderProbe: mocks.record,
		},
		apps: { getByIdWithTools: mocks.app },
	});
	mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
	mocks.profile.mockResolvedValue({ profile });
	mocks.app.mockResolvedValue({
		app: { id: "root", organizationId: "org", metadata: {} },
	});
	mocks.prepare.mockImplementation(
		async ({ mountedToolId }: { mountedToolId: string }) => ({
			descriptorDigest:
				mountedToolId === mount.mountedToolId ? "mount" : "probe",
		}),
	);
	mocks.digest.mockImplementation(async (value: typeof mount) =>
		value.mountedToolId === mount.mountedToolId ? "mount" : "probe",
	);
	mocks.resolve.mockResolvedValue({
		sourceAppId: "source",
		tool: {
			id: "row",
			toolId: "mount__edit",
			config: { transport: "mcp" },
			inputSchema: {},
		},
	});
	mocks.toolDigest.mockResolvedValue("tool-digest");
	mocks.transport.mockResolvedValue({
		status: 200,
		data: { accountRevisionDigest: "a".repeat(64) },
	});
	mocks.record.mockResolvedValue({ receiptId: "receipt" });
});

describe("machine provider proof", () => {
	it("uses the verified machine identity and tenant-only credential", async () => {
		expect(
			await prepareMachineProviderProof(agent, {
				profileId: "profile",
				exampleArgs: { page: "one" },
			}),
		).toEqual({ receiptId: "receipt" });
		expect(mocks.record).toHaveBeenCalledWith(
			expect.objectContaining({
				principalId: "principal",
				sessionId: "session",
				clientRecordId: "record",
				organizationId: "org",
			}),
		);
		const ctx = mocks.transport.mock.calls[0]?.[1];
		expect(ctx.callerIdentity).toBe(caller);
		expect(ctx.prepareIdentityProbe.requireTenantCredential).toBe(true);
		expect(ctx.callerIdentity.userId).toBeUndefined();
	});
	it("rejects missing fresh execute authority or a personal-only connection", async () => {
		mocks.authority.mockResolvedValue({ scopes: [] });
		await expect(
			prepareMachineProviderProof(agent, {
				profileId: "profile",
				exampleArgs: {},
			}),
		).rejects.toThrow(/access/);
		mocks.authority.mockResolvedValue({ scopes: ["connections.execute"] });
		mocks.profile.mockResolvedValue({
			profile: { ...profile, mount: { ...mount, connectionScope: "user" } },
		});
		await expect(
			prepareMachineProviderProof(agent, {
				profileId: "profile",
				exampleArgs: {},
			}),
		).rejects.toThrow(/profile/);
		expect(mocks.record).not.toHaveBeenCalled();
	});
});
