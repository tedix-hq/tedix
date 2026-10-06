import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ConnectionTokenLookupError,
	fetchTenantConnectionToken,
} from "@tedix/auth/connections";
import { decryptCatalogAppSecret } from "@tedix/db/utils/secrets-encryption";
import { resolveTedixInternalScanHeaders } from "../../../lib/catalog-internal-scan";
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
vi.mock("../../../lib/catalog-internal-scan", () => ({
	resolveTedixInternalScanHeaders: vi.fn(),
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
	it("preserves existing first-party auth after an unavailable lookup", async () => {
		vi.mocked(fetchTenantConnectionToken).mockRejectedValue(
			new ConnectionTokenLookupError(503),
		);
		vi.mocked(resolveTedixInternalScanHeaders).mockReturnValue({
			Authorization: "internal",
		});
		expect(
			await resolveCatalogScanHeaders(context, {
				...app,
				scanAuthHeaders: null,
			} as never),
		).toEqual({ Authorization: "internal" });
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
