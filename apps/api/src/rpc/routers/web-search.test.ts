import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { webSearchContractRouter } from "./web-search";

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	tedi: vi.fn(),
	provider: vi.fn(),
	credential: vi.fn(),
	search: vi.fn(),
	costs: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderById: mocks.provider,
}));
vi.mock("@tedix/db/queries/tedi-usage", () => ({
	insertCallCosts: mocks.costs,
}));
vi.mock("./connections/policy-resolution", () => ({
	resolveCredentialChain: mocks.credential,
}));
vi.mock("../../services/web-search", () => ({ runWebSearch: mocks.search }));

const orgId = "00000000-0000-4000-8000-000000000001";
const tediId = "00000000-0000-4000-8000-000000000002";
const { apiKeyContext } = bindTestContexts({
	organizationId: orgId,
	url: "https://api.example.test/rpc/web-search",
});
const policy = {
	enabled: true,
	provider: "tavily",
	fallbackProvider: "firecrawl",
	maxResults: 3,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.organization.mockResolvedValue({
		id: orgId,
		descopeTenantId: "tenant-example",
		metadata: { webSearch: policy },
	});
	mocks.tedi.mockResolvedValue({ id: tediId, retiredAt: null });
	mocks.provider.mockImplementation(async (_db, id) => ({ descopeAppId: id }));
	mocks.credential.mockResolvedValue({ accessToken: "test-token" });
	mocks.search.mockResolvedValue({
		status: "ok",
		query: "release",
		trust: "untrusted",
		results: [],
		citations: [],
		truncated: false,
	});
});

it("passes organization routing and resolves only that organization's API-key connections", async () => {
	const context = {
		...apiKeyContext({ scopes: ["web-search:execute"] }),
		tediId,
	};
	const client = createRouterClient(webSearchContractRouter, { context });
	await client.search({ query: "release", limit: 8 });
	const input = mocks.search.mock.calls[0]![0];
	expect(input).toMatchObject({
		policy,
		organizationId: orgId,
		tediId,
		limit: 3,
	});
	for (const provider of ["tavily", "firecrawl"]) {
		await expect(input.resolveCredential(provider)).resolves.toBe("test-token");
		expect(mocks.provider).toHaveBeenLastCalledWith(
			context.db,
			`${provider}-api-key`,
		);
		expect(mocks.credential).toHaveBeenLastCalledWith(context, {
			organizationId: orgId,
			descopeTenantId: "tenant-example",
			providerId: `${provider}-api-key`,
			scope: "tenant",
		});
	}
});

it("rejects a tedi outside the organization before accessing credentials", async () => {
	mocks.tedi.mockResolvedValue(null);
	const context = {
		...apiKeyContext({ scopes: ["web-search:execute"] }),
		tediId,
	};
	const client = createRouterClient(webSearchContractRouter, { context });
	await expect(client.search({ query: "release" })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.search).not.toHaveBeenCalled();
	expect(mocks.credential).not.toHaveBeenCalled();
});
