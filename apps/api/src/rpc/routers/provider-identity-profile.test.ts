import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { canonicalDigest } from "../../lib/blueprint-digest";
import { userContext } from "../test-context";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	app: vi.fn(),
	generations: vi.fn(),
	prepare: vi.fn(),
	consume: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/app-records", async (load) => ({
	...(await load<object>()),
	getAppByIdForOrganization: mocks.app,
}));
vi.mock("@tedix/db/queries/tenant-tool-policy", async (load) => ({
	...(await load<object>()),
	getTenantToolPolicyResourceGenerations: mocks.generations,
	createProviderIdentityPreparation: mocks.prepare,
	consumeProviderIdentityPreparation: mocks.consume,
	createProviderIdentityProfile: mocks.create,
	getProviderIdentityProfile: mocks.get,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

const descriptor = {
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
const probe = {
	...descriptor,
	sourceToolRowId: "probe-row",
	sourceToolId: "probe",
	mountedToolId: "probe",
	upstreamOperation: "probe",
	effectiveToolDigest: "d".repeat(64),
	acceptsEmptyArguments: true,
};

function ownerClient() {
	const fetch = async (request: Request) => {
		const body = (await request.json()) as { mountedToolId: string };
		const value = body.mountedToolId === "write" ? descriptor : probe;
		return Response.json({
			descriptor: value,
			descriptorDigest: await canonicalDigest(value),
		});
	};
	return createRouterClient(mcpGovernanceContractRouter, {
		context: userContext({
			organizationId: "org-1",
			userId: "owner",
			permissions: ["settings:manage"],
			db: {} as BaseContext["db"],
			env: {
				ENVIRONMENT: "production",
				MCP_SERVICE: { fetch },
			} as CloudflareEnv,
		}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.app.mockResolvedValue({ id: "root", organizationId: "org-1" });
	mocks.generations.mockResolvedValue([]);
	mocks.prepare.mockImplementation(async (_db, row) => row);
	mocks.create.mockImplementation(async (_db, row) => ({
		...row,
		revokedAt: null,
	}));
});

describe("provider identity profile owner review", () => {
	it("records the exact prepared profile only with explicit safety attestation", async () => {
		const client = ownerClient();
		const prepared = await client.prepareProviderIdentityProfile({
			rootAppId: "root",
			mountedToolId: "write",
			probeMountedToolId: "probe",
			selectors: [["account", "id"]],
		});
		const savedPreparation = mocks.prepare.mock.calls[0]![1];
		mocks.consume.mockResolvedValue(savedPreparation);
		const result = await client.createProviderIdentityProfile({
			preparationId: prepared.preparationId,
			expectedProfileDigest: prepared.profileDigest,
			safetyAttestation: "safe_empty_probe",
		});
		expect(result.profile).toMatchObject({
			createdBy: "owner",
			safetyAttestation: "safe_empty_probe",
			profile: { operation: "probe", selectors: [["account", "id"]] },
			profileDigest: prepared.profileDigest,
		});
	});
	it("refuses using the target write itself as the identity check", async () => {
		await expect(
			ownerClient().prepareProviderIdentityProfile({
				rootAppId: "root",
				mountedToolId: "write",
				probeMountedToolId: "write",
				selectors: [["id"]],
			}),
		).rejects.toThrow(/same server and connection/);
		expect(mocks.prepare).not.toHaveBeenCalled();
	});
});
