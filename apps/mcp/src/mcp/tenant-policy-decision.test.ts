import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";

const mocks = vi.hoisted(() => ({
	target: vi.fn(),
	gateway: vi.fn(),
	resolve: vi.fn(),
	prepare: vi.fn(),
	actual: vi.fn(),
	digest: vi.fn(),
}));
vi.mock("./multi-org-tool-target", () => ({
	resolveMultiOrgToolTarget: mocks.target,
}));
vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		apps: { getBySlugWithTools: mocks.gateway },
		mcpGovernance: { resolveTenantToolPolicy: mocks.resolve },
	}),
}));
vi.mock("./tenant-policy-mount", () => ({
	prepareTenantPolicyMount: mocks.prepare,
	tenantPolicyMountDescriptor: mocks.actual,
	tenantPolicyDescriptorDigest: mocks.digest,
}));
import { resolveTenantPolicyForCall } from "./tenant-policy-decision";

const instance = "00000000-0000-4000-8000-000000000001";
const descriptor = {
	version: 1,
	organizationId: "org",
	rootAppId: "root",
	sourceAppId: "source",
	sourceToolRowId: "tool",
	sourceToolId: "edit",
	mountAppIds: ["root", "source"],
	mountedToolId: "gateway__edit",
	transport: "mcp",
	upstreamOperation: "edit",
	providerId: "provider",
	connectionInstanceId: instance,
	credentialScope: "tenant",
	requestedScopes: [],
	effectiveToolDigest: "a".repeat(64),
};
const receipt = {
	organizationId: "org",
	providerId: "provider",
	scope: "tenant",
	connectionInstanceId: instance,
	accountRevisionDigest: "b".repeat(64),
};
const agent = { env: { API_SERVICE: {} } } as unknown as ServerContext;
const tool = {
	toolId: "gateway__edit",
	config: { _sourceAppId: "source" },
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
	mocks.prepare.mockResolvedValue({
		descriptor,
		descriptorDigest: "raw-digest",
	});
	mocks.actual.mockResolvedValue(descriptor);
	mocks.digest.mockImplementation(async (value: Record<string, unknown>) =>
		value.accountRevisionDigest ? "final-digest" : "raw-digest",
	);
	mocks.resolve.mockResolvedValue({
		matched: true,
		revisionId: "rev",
		ruleDigest: "rule",
		effect: {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
			autoApprove: true,
		},
	});
});

describe("tenant policy call resolution", () => {
	it("requires a fresh matching mount and actual account revision", async () => {
		expect(
			await resolveTenantPolicyForCall(
				agent,
				tool,
				{ action: "edit" },
				receipt,
			),
		).toMatchObject({ revisionId: "rev", descriptorDigest: "final-digest" });
		expect(mocks.resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				descriptorDigest: "final-digest",
				descriptor: expect.objectContaining({
					accountRevisionDigest: receipt.accountRevisionDigest,
				}),
			}),
		);
		expect(
			await resolveTenantPolicyForCall(
				agent,
				tool,
				{},
				{ ...receipt, accountRevisionDigest: undefined },
			),
		).toBeNull();
		expect(
			await resolveTenantPolicyForCall(
				agent,
				tool,
				{},
				{ ...receipt, providerId: "other" },
			),
		).toBeNull();
	});

	it("fails closed for stale mounts and revoked rules", async () => {
		mocks.digest.mockResolvedValueOnce("changed");
		expect(
			await resolveTenantPolicyForCall(agent, tool, {}, receipt),
		).toBeNull();
		expect(mocks.resolve).not.toHaveBeenCalled();
		mocks.resolve.mockResolvedValue({
			matched: false,
			revisionId: null,
			ruleDigest: null,
		});
		expect(
			await resolveTenantPolicyForCall(agent, tool, {}, receipt),
		).toBeNull();
	});
});
