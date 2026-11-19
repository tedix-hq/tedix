import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ConnectionTokenLookupError,
	fetchTenantConnectionToken,
} from "@tedix/auth/connections";
import { decryptCatalogAppSecret } from "@tedix/db/utils/secrets-encryption";
import { resolveCatalogScanHeaders } from "./install-scan";
vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/connections", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/auth/connections")>()),
	fetchTenantConnectionToken: vi.fn(),
	fetchConnectionToken: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: async () => ({ descopeTenantId: "tenant" }),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMembersByOrganization: async () => [],
}));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptCatalogAppSecret: vi.fn(),
}));
const context = {
	db: {},
	env: { DESCOPE_MANAGEMENT_KEY: "test", SECRETS_MASTER_KEY: "test" },
} as never;
const app = {
	id: "app",
	scanConnectionId: "provider",
	scanOrganizationId: "org",
	scanAuthHeaders: "encrypted",
};
afterEach(() => vi.resetAllMocks());
describe("catalog scan credential fallback", () => {
	it("preserves encrypted credentials after a restricted tenant lookup", async () => {
		vi.mocked(fetchTenantConnectionToken).mockRejectedValue(
			new ConnectionTokenLookupError(403),
		);
		vi.mocked(decryptCatalogAppSecret).mockResolvedValue(
			JSON.stringify({ Authorization: "opaque" }),
		);
		expect(await resolveCatalogScanHeaders(context, app as never)).toEqual({
			Authorization: "opaque",
		});
	});
	it("surfaces unavailable when no authorized fallback resolves", async () => {
		vi.mocked(fetchTenantConnectionToken).mockRejectedValue(
			new ConnectionTokenLookupError(403),
		);
		await expect(
			resolveCatalogScanHeaders(context, {
				...app,
				scanAuthHeaders: null,
			} as never),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.stringContaining("403"),
		});
	});
	it("keeps truly absent credentials undefined", async () => {
		vi.mocked(fetchTenantConnectionToken).mockResolvedValue(null);
		expect(
			await resolveCatalogScanHeaders(context, {
				...app,
				scanAuthHeaders: null,
			} as never),
		).toBeUndefined();
	});
});

it("does not revive a stored Worker bearer on the external credential path", async () => {
	vi.mocked(decryptCatalogAppSecret).mockResolvedValue(
		JSON.stringify({ authorization: "Bearer platform-token" }),
	);
	const externalContext = {
		db: {},
		env: {
			SECRETS_MASTER_KEY: "test",
			PLATFORM_SERVICE_TOKEN: "platform-token",
		},
	} as never;
	expect(
		await resolveCatalogScanHeaders(externalContext, {
			id: "app",
			scanAuthHeaders: "encrypted",
		} as never),
	).toBeUndefined();
});
