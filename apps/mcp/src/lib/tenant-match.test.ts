import { describe, expect, it, vi } from "vite-plus/test";

const orgTenants = new Map<string, string | null>();
const failingOrgs = new Set<string>();

vi.mock("./api-client", () => ({
	getApiClient: () => ({
		organizations: {
			get: async ({ organizationId }: { organizationId: string }) => {
				if (failingOrgs.has(organizationId)) {
					throw new Error("service binding unavailable");
				}
				return {
					descopeTenantId: orgTenants.get(organizationId) ?? null,
				};
			},
		},
	}),
}));

import { extractJwtTenantId, jwtTenantMatchesApp } from "./tenant-match";

function createD1Mock(row: Record<string, unknown> | null) {
	return {
		prepare: () => ({
			bind() {
				return this;
			},
			first: async <T = unknown>() => row as T | null,
			raw: async () => (row ? [Object.keys(row).map((key) => row[key])] : []),
		}),
	};
}

describe("tenant-match", () => {
	it("extracts the tenant from dct", () => {
		expect(extractJwtTenantId({ dct: "tenant_current" })).toBe(
			"tenant_current",
		);
	});

	it("returns null when dct is absent", () => {
		expect(extractJwtTenantId({})).toBeNull();
		expect(extractJwtTenantId(null)).toBeNull();
	});

	it("rejects OAuth payloads without tenant context", async () => {
		await expect(jwtTenantMatchesApp({}, "org_no_tenant", {})).resolves.toEqual(
			{
				ok: false,
				reason: "JWT has no tenant context",
			},
		);
	});

	it("accepts a resource-bound AIH user access token through signed tenant membership", async () => {
		orgTenants.set("org_aih_member", "tenant_aih");
		await expect(
			jwtTenantMatchesApp(
				{
					azp: "https://client.example/.well-known/oauth-client.json",
					tenants: { tenant_aih: { roles: ["member"] } },
					token_type: "access_token",
				},
				"org_aih_member",
				{},
			),
		).resolves.toEqual({ ok: true });
	});

	it("rejects an AIH access token that is not a member of the app tenant", async () => {
		orgTenants.set("org_aih_other", "tenant_expected");
		await expect(
			jwtTenantMatchesApp(
				{
					azp: "https://client.example/.well-known/oauth-client.json",
					tenants: { tenant_other: {} },
					token_type: "access_token",
				},
				"org_aih_other",
				{},
			),
		).resolves.toEqual({
			ok: false,
			reason:
				'JWT has no active tenant and is not a member of app tenant "tenant_expected"',
		});
	});

	it("never lets membership override a mismatched active tenant", async () => {
		orgTenants.set("org_aih_mismatch", "tenant_expected_active");
		await expect(
			jwtTenantMatchesApp(
				{
					azp: "client",
					dct: "tenant_wrong_active",
					tenants: { tenant_expected_active: {} },
					token_type: "access_token",
				},
				"org_aih_mismatch",
				{},
			),
		).resolves.toEqual({
			ok: false,
			reason:
				'JWT tenant "tenant_wrong_active" does not match app\'s tenant "tenant_expected_active"',
		});
	});

	it("rejects when the app organization has no Descope tenant id", async () => {
		orgTenants.set("org_missing", null);

		await expect(
			jwtTenantMatchesApp({ dct: "tenant_acme" }, "org_missing", {}),
		).resolves.toEqual({
			ok: false,
			reason: 'App organization "org_missing" has no Descope tenant id',
		});
	});

	it("rejects mismatched tenants", async () => {
		orgTenants.set("org_acme_mismatch", "tenant_acme");

		await expect(
			jwtTenantMatchesApp({ dct: "tenant_tedix" }, "org_acme_mismatch", {}),
		).resolves.toEqual({
			ok: false,
			reason:
				'JWT tenant "tenant_tedix" does not match app\'s tenant "tenant_acme"',
		});
	});

	it("accepts matching tenants", async () => {
		orgTenants.set("org_acme_match", "tenant_acme");

		await expect(
			jwtTenantMatchesApp({ dct: "tenant_acme" }, "org_acme_match", {}),
		).resolves.toEqual({ ok: true });
	});

	it("rejects a failed lookup with a transient reason, then recovers without waiting out the cache TTL", async () => {
		failingOrgs.add("org_flaky");
		orgTenants.set("org_flaky", "tenant_flaky");

		await expect(
			jwtTenantMatchesApp({ dct: "tenant_flaky" }, "org_flaky", {}),
		).resolves.toEqual({
			ok: false,
			reason:
				'Tenant lookup for app organization "org_flaky" failed; retry shortly',
		});

		// Lookup succeeds again → the earlier failure must not have been cached.
		failingOrgs.delete("org_flaky");
		await expect(
			jwtTenantMatchesApp({ dct: "tenant_flaky" }, "org_flaky", {}),
		).resolves.toEqual({
			ok: true,
		});
	});

	it("uses the direct D1 organization tenant mapping before API fallback", async () => {
		orgTenants.set("org_tedix_d1", null);

		await expect(
			jwtTenantMatchesApp({ dct: "org_tedix" }, "org_tedix_d1", {
				DB: createD1Mock({ descopeTenantId: "org_tedix" }),
			}),
		).resolves.toEqual({ ok: true });
	});
});
