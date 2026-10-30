import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	redeem: vi.fn(),
	profile: vi.fn(),
	app: vi.fn(),
	prepare: vi.fn(),
	resolve: vi.fn(),
	digest: vi.fn(),
	toolDigest: vi.fn(),
	transport: vi.fn(),
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		mcpGovernance: {
			redeemProviderIdentityProbe: mocks.redeem,
			resolveProviderIdentityProfile: mocks.profile,
		},
		apps: { getByIdWithTools: mocks.app },
	}),
}));
vi.mock("./tenant-policy-mount", () => ({
	prepareTenantIdentityProfileMount: mocks.prepare,
	resolveFreshPolicyMount: mocks.resolve,
	tenantPolicyDescriptorDigest: mocks.digest,
	tenantPolicyEffectiveToolDigest: mocks.toolDigest,
}));
vi.mock("./handler-mcp-transport", () => ({
	executeMcpTransport: mocks.transport,
}));
import { probeReviewedProviderIdentity } from "./tenant-profile-probe";

const mount = {
	rootAppId: "root",
	mountedToolId: "mount__edit",
	sourceAppId: "source",
	sourceToolRowId: "row",
	effectiveToolDigest: "tool-digest",
};
const profile = {
	id: "profile",
	organizationId: "org",
	mount,
	probeMount: { ...mount, mountedToolId: "mount__identity" },
	profileDigest: "profile-digest",
	profile: { version: 1, operation: "identity", selectors: [["id"]] },
	revokedAt: null,
};
const input = {
	organizationId: "org",
	receiptId: "receipt",
	exampleArgs: { page: "one" },
	env: { API_SERVICE: {} } as CloudflareEnv,
	ctx: {} as ExecutionContext,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.redeem.mockResolvedValue({
		actorUserId: "owner",
		profileId: "profile",
		exampleArgs: input.exampleArgs,
		verifiedScopes: ["connections.execute"],
	});
	mocks.profile.mockResolvedValue({ profile });
	mocks.app.mockResolvedValue({
		app: { id: "root", organizationId: "org", metadata: {} },
	});
	mocks.prepare.mockImplementation(
		async ({ mountedToolId }: { mountedToolId: string }) => ({
			descriptorDigest:
				mountedToolId === mount.mountedToolId ? "mount-digest" : "probe-digest",
		}),
	);
	mocks.digest.mockImplementation(async (value: typeof mount) =>
		value.mountedToolId === mount.mountedToolId
			? "mount-digest"
			: "probe-digest",
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
		data: { accountRevisionDigest: "c".repeat(64) },
	});
});

describe("reviewed provider identity preparation", () => {
	it("exposes only the selected connection scope and instance to the requesting owner", async () => {
		const summary = vi.fn();
		mocks.transport.mockResolvedValue({
			status: 200,
			data: {
				accountRevisionDigest: "c".repeat(64),
				credentialSummary: {
					scope: "user",
					connectionInstanceId: "00000000-0000-4000-8000-000000000001",
					token: "never-share",
				},
			},
		});
		expect(
			await probeReviewedProviderIdentity({
				...input,
				onCredentialSummary: summary,
			}),
		).toBe("c".repeat(64));
		expect(summary).toHaveBeenCalledWith({
			scope: "user",
			connectionInstanceId: "00000000-0000-4000-8000-000000000001",
		});
	});
	it("uses only the redeemed requester and revalidates the owner-reviewed profile", async () => {
		expect(await probeReviewedProviderIdentity(input)).toBe("c".repeat(64));
		expect(mocks.redeem).toHaveBeenCalledWith({
			organizationId: "org",
			receiptId: "receipt",
			exampleArgs: input.exampleArgs,
		});
		const ctx = mocks.transport.mock.calls[0]?.[1];
		expect(ctx.callerIdentity).toMatchObject({
			userId: "owner",
			organizationId: "org",
			scopes: ["connections.execute"],
		});
		expect(await ctx.prepareIdentityProbe.revalidate()).toBe(true);
		mocks.profile.mockResolvedValue({ profile: null });
		expect(await ctx.prepareIdentityProbe.revalidate()).toBe(false);
	});
	it("never probes with missing authority or a changed mount", async () => {
		mocks.redeem.mockResolvedValueOnce({
			actorUserId: "owner",
			profileId: "profile",
			exampleArgs: input.exampleArgs,
			verifiedScopes: [],
		});
		expect(await probeReviewedProviderIdentity(input)).toBeNull();
		mocks.prepare.mockResolvedValue({ descriptorDigest: "changed" });
		expect(await probeReviewedProviderIdentity(input)).toBeNull();
		expect(mocks.transport).not.toHaveBeenCalled();
	});
});
