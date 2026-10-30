import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";
const mocks = vi.hoisted(() => ({
	prepare: vi.fn(),
	decision: vi.fn(),
	profile: vi.fn(),
	app: vi.fn(),
	fresh: vi.fn(),
	mount: vi.fn(),
	digest: vi.fn(),
	effective: vi.fn(),
	cross: vi.fn(),
	probe: vi.fn(),
	client: vi.fn(),
}));
vi.mock("@tedix/api-client/internal", () => ({
	getInternalApiClient: mocks.client,
}));
vi.mock("./tenant-profile-probe", () => ({
	probeReviewedProviderIdentity: mocks.probe,
}));
vi.mock("./tenant-policy-mount", () => ({
	resolveFreshPolicyMount: mocks.fresh,
	prepareTenantIdentityProfileMount: mocks.mount,
	tenantPolicyDescriptorDigest: mocks.digest,
	tenantPolicyEffectiveToolDigest: mocks.effective,
	tenantPolicyCrossMountDigest: mocks.cross,
}));
import { resolveHumanPolicyReplay } from "./tenant-human-replay";

const tool = {
	id: "row",
	toolId: "edit",
	config: { transport: "mcp" },
} as unknown as AppTool;
const agent = {
	appId: "source",
	env: { API_SERVICE: {} },
	callerIdentity: {
		authType: "service",
		kernel: true,
		userId: "owner",
		organizationId: "org",
		scopes: ["connections.execute"],
	},
} as unknown as ServerContext;
const mount = {
	rootAppId: "root",
	mountedToolId: "root__edit",
	sourceAppId: "source",
	sourceToolRowId: "row",
};
const probeMount = { rootAppId: "root", mountedToolId: "root__identity" };
const binding = {
	descriptor: {
		kind: "profile",
		actorUserId: "owner",
		profileId: "profile",
		profileDigest: "profile-digest",
		accountRevisionDigest: "a".repeat(64),
		mount,
	},
	descriptorDigest: "descriptor",
	revisionId: "rev",
	ruleDigest: "rule",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.client.mockReturnValue({
		apps: { getByIdWithTools: mocks.app },
		mcpGovernance: {
			prepareOwnerPolicyReplay: mocks.prepare,
			resolveTenantToolPolicy: mocks.decision,
			resolveProviderIdentityProfile: mocks.profile,
		},
	});
	mocks.prepare.mockResolvedValue({ binding, probeReceiptId: "receipt" });
	mocks.decision.mockResolvedValue({
		matched: true,
		revisionId: "rev",
		ruleDigest: "rule",
		effect: {
			disposition: "ask",
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
	});
	mocks.profile.mockResolvedValue({
		profile: {
			id: "profile",
			profileDigest: "profile-digest",
			profile: { version: 1, operation: "identity", selectors: [["id"]] },
			probeMount,
		},
	});
	mocks.fresh.mockImplementation(
		async ({ rootAppId }: { rootAppId: string }) =>
			rootAppId === "root" ? { sourceAppId: "source", tool } : null,
	);
	mocks.app.mockResolvedValue({
		app: { organizationId: "org" },
		tools: [tool],
	});
	mocks.digest.mockImplementation(async (v: unknown) => JSON.stringify(v));
	mocks.mount.mockImplementation(
		async ({ mountedToolId }: { mountedToolId: string }) => ({
			descriptorDigest: JSON.stringify(
				mountedToolId === mount.mountedToolId ? mount : probeMount,
			),
		}),
	);
	mocks.effective.mockResolvedValue("effective");
	mocks.cross.mockResolvedValue("logical");
	mocks.probe.mockResolvedValue("a".repeat(64));
});

describe("owner policy replay", () => {
	it("verifies the direct source against the reviewed mount and probes before consumption", async () => {
		const args = { page: "one" };
		const result = await resolveHumanPolicyReplay(
			agent,
			tool,
			args,
			"receipt-id",
		);
		expect(result?.revisionId).toBe("rev");
		expect(mocks.probe).toHaveBeenCalledOnce();
		expect(await result?.probe.revalidate()).toBe(true);
		mocks.cross
			.mockResolvedValueOnce("changed")
			.mockResolvedValueOnce("reviewed");
		expect(await result?.probe.revalidate()).toBe(false);
	});
	it("does not infer a personal grant from a user ID", async () => {
		const noGrant = {
			...agent,
			callerIdentity: { ...agent.callerIdentity, scopes: [] },
		} as ServerContext;
		expect(
			await resolveHumanPolicyReplay(noGrant, tool, {}, "receipt-id"),
		).toBeNull();
		expect(mocks.prepare).not.toHaveBeenCalled();
	});
	it("preserves default ask as high impact, with the same dispatch probe", async () => {
		mocks.decision.mockResolvedValue({
			matched: true,
			revisionId: "rev",
			ruleDigest: "rule",
			defaultAsk: true,
		});
		const result = await resolveHumanPolicyReplay(
			agent,
			tool,
			{},
			"receipt-id",
		);
		expect(result?.effect).toMatchObject({
			disposition: "ask",
			riskTier: "high_impact_write",
		});
		expect(await result?.probe.revalidate()).toBe(true);
	});
});
