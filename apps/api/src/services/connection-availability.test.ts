import {
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	fetchConnectionToken,
	fetchTenantConnectionToken,
	fetchConnectionTokenByScopes,
} from "@tedix/auth/connections";
import { resolveConnectionAvailability } from "./connection-availability";

vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/connections", () => ({
	fetchConnectionToken: vi.fn(),
	fetchTenantConnectionToken: vi.fn(),
	fetchConnectionTokenByScopes: vi.fn(),
	fetchTenantConnectionTokenByScopes: vi.fn(),
}));
const registry = vi.hoisted(() => ({ byId: vi.fn(), byAppId: vi.fn() }));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderById: registry.byId,
	getConnectionProviderByDescopeAppId: registry.byAppId,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationDescopeTenantId: async () => "tenant",
}));
const input = {
	db: {} as never,
	env: { DESCOPE_MANAGEMENT_KEY: "test" } as never,
	organizationId: "org",
	ownerUserId: "owner",
	providerId: "provider",
	tokenScope: "either" as const,
	scopes: [],
};
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
	registry.byId.mockImplementation(async (_db, id) =>
		id === "provider"
			? { id: "provider", descopeAppId: "provider" }
			: undefined,
	);
	registry.byAppId.mockResolvedValue(undefined);
});
describe("connection availability during partial provider failure", () => {
	it.each([
		["calendar-template", "calendar-outbound", true],
		["calendar-outbound", "calendar-outbound", false],
		["calendar-alias", "calendar-alias", false],
	])(
		"resolves registry/app/alias identity %s without switching the vault namespace",
		async (providerId, expectedAppId, templateInput) => {
			const provider = {
				id: "calendar-template",
				descopeAppId: "calendar-outbound",
				descopeAppAliases: ["calendar-alias"],
			};
			registry.byId.mockImplementation(async (_db, id) =>
				id === provider.id ? provider : undefined,
			);
			registry.byAppId.mockImplementation(async (_db, id) =>
				[provider.descopeAppId, ...provider.descopeAppAliases].includes(id)
					? provider
					: undefined,
			);
			vi.mocked(fetchConnectionTokenByScopes).mockResolvedValue({
				accessToken: "opaque",
			} as never);
			expect(
				await resolveConnectionAvailability({
					...input,
					providerId,
					tokenScope: "user",
					scopes: ["calendar.write"],
				}),
			).toMatchObject({ connected: true, cause: "connected" });
			expect(fetchConnectionTokenByScopes).toHaveBeenCalledWith(
				{},
				expectedAppId,
				"owner",
				["calendar.write"],
			);
			expect(registry.byAppId).toHaveBeenCalledTimes(templateInput ? 0 : 1);
			expect(fetchTenantConnectionToken).not.toHaveBeenCalled();
		},
	);
	it("rejects an unregistered lookalike before any vault read", async () => {
		registry.byId.mockResolvedValue(undefined);
		registry.byAppId.mockResolvedValue(undefined);
		expect(
			await resolveConnectionAvailability({
				...input,
				providerId: "calendar-alias-lookalike",
			}),
		).toMatchObject({ connected: false, cause: "provider_unregistered" });
		expect(fetchConnectionToken).not.toHaveBeenCalled();
		expect(fetchConnectionTokenByScopes).not.toHaveBeenCalled();
		expect(fetchTenantConnectionToken).not.toHaveBeenCalled();
	});
	it("reports an exact registered app lookup failure without falling back to the primary app", async () => {
		registry.byId.mockResolvedValue(undefined);
		registry.byAppId.mockResolvedValue({
			id: "template",
			descopeAppId: "primary",
			descopeAppAliases: ["alias"],
		});
		vi.mocked(fetchConnectionToken).mockRejectedValue(
			Error("lookup unavailable"),
		);
		expect(
			await resolveConnectionAvailability({
				...input,
				providerId: "alias",
				tokenScope: "user",
			}),
		).toMatchObject({ connected: false, cause: "verification_failed" });
		expect(fetchConnectionToken).toHaveBeenCalledExactlyOnceWith(
			{},
			"alias",
			"owner",
		);
	});
	it("reports consent required when a registered alias has no credential instead of substituting another grant", async () => {
		registry.byId.mockResolvedValue(undefined);
		registry.byAppId.mockResolvedValue({
			id: "template",
			descopeAppId: "primary",
			descopeAppAliases: ["alias"],
		});
		vi.mocked(fetchConnectionToken).mockResolvedValue(null);
		expect(
			await resolveConnectionAvailability({
				...input,
				providerId: "alias",
				tokenScope: "user",
			}),
		).toMatchObject({ connected: false, cause: "no_token" });
		expect(fetchConnectionToken).toHaveBeenCalledExactlyOnceWith(
			{},
			"alias",
			"owner",
		);
	});
	it.each([true, false])(
		"keeps a valid authorized fallback (tenant failure=%s)",
		async (tenantFails) => {
			vi.mocked(fetchTenantConnectionToken)[
				tenantFails ? "mockRejectedValue" : "mockResolvedValue"
			](tenantFails ? Error("lookup unavailable") : { accessToken: "opaque" });
			vi.mocked(fetchConnectionToken)[
				tenantFails ? "mockResolvedValue" : "mockRejectedValue"
			](tenantFails ? { accessToken: "opaque" } : Error("lookup unavailable"));
			expect(await resolveConnectionAvailability(input)).toMatchObject({
				connected: true,
				cause: "connected",
			});
		},
	);
	it("does not label a failed lookup plus absent fallback as missing", async () => {
		vi.mocked(fetchTenantConnectionToken).mockRejectedValue(
			Error("lookup unavailable"),
		);
		vi.mocked(fetchConnectionToken).mockResolvedValue(null);
		expect(await resolveConnectionAvailability(input)).toMatchObject({
			connected: false,
			cause: "verification_failed",
		});
	});
	it("keeps truly absent credentials repairable through consent", async () => {
		vi.mocked(fetchTenantConnectionToken).mockResolvedValue(null);
		vi.mocked(fetchConnectionToken).mockResolvedValue(null);
		expect(await resolveConnectionAvailability(input)).toMatchObject({
			connected: false,
			cause: "no_token",
		});
	});
});
