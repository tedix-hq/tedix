import { describe, expect, it } from "vite-plus/test";
import {
	hasCatalogOperatorAccess,
	hasTenantOpenApiImportAccess,
	requireCatalogOperatorAccess,
} from "./catalog-operator-access";

describe("catalog operator access", () => {
	it("allows service and service-binding callers", () => {
		expect(hasCatalogOperatorAccess({ authType: "service-binding" })).toBe(
			true,
		);
	});

	it("requires catalog scope for API-key and M2M callers", () => {
		expect(
			hasCatalogOperatorAccess({
				authType: "apikey",
				apiKey: {
					id: "key_1",
					organizationId: "org_1",
					name: "regular automation",
					scopes: ["apps:update"],
				},
			}),
		).toBe(false);
		expect(
			hasCatalogOperatorAccess({
				authType: "apikey",
				apiKey: {
					id: "key_1",
					organizationId: "org_1",
					name: "catalog automation",
					scopes: ["catalog:manage"],
				},
			}),
		).toBe(true);
		expect(
			hasCatalogOperatorAccess({
				authType: "m2m",
				serviceAccount: {
					clientId: "regular-worker",
					scope: "apps:update",
				},
			}),
		).toBe(false);
		expect(
			hasCatalogOperatorAccess({
				authType: "m2m",
				serviceAccount: {
					clientId: "catalog-worker",
					scope: "catalog:manage",
				},
			}),
		).toBe(true);
	});

	it("requires platform or explicit catalog authority for user JWT callers", () => {
		expect(
			hasCatalogOperatorAccess({
				authType: "user",
				user: {
					iss: "https://auth.tedix.dev",
					aud: "proj",
					iat: 1,
					exp: 2,
					dct: "tenant_1",
					roles: ["admin"],
					permissions: ["apps:update"],
				},
			}),
		).toBe(false);

		expect(
			hasCatalogOperatorAccess({
				authType: "user",
				user: {
					iss: "https://auth.tedix.dev",
					aud: "proj",
					iat: 1,
					exp: 2,
					dct: "tenant_1",
					roles: ["member"],
					permissions: ["catalog:manage"],
				},
			}),
		).toBe(true);

		expect(
			hasCatalogOperatorAccess({
				authType: "user",
				user: {
					iss: "https://auth.tedix.dev",
					aud: "proj",
					iat: 1,
					exp: 2,
					dct: "tenant_1",
					roles: ["catalog-operator"],
				},
			}),
		).toBe(true);

		expect(
			hasCatalogOperatorAccess({
				authType: "user",
				user: {
					iss: "https://auth.tedix.dev",
					aud: "proj",
					iat: 1,
					exp: 2,
					dct: "tenant_1",
					roles: ["platform-admin"],
				},
			}),
		).toBe(true);
	});

	it("fails closed for tedi JWT callers without platform authority", () => {
		expect(hasCatalogOperatorAccess({ authType: "tedi" })).toBe(false);
	});

	it("throws a forbidden error for non-platform user callers", () => {
		expect(() => requireCatalogOperatorAccess({ authType: "user" })).toThrow(
			"Platform catalog operator access required",
		);
	});
});

describe("tenant OpenAPI import access", () => {
	const tenantContext = {
		authType: "user" as const,
		organizationId: "org_1",
	};

	it("allows tenant callers to manage org-owned OpenAPI base apps", () => {
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{
					organizationId: "org_1",
					sourceAppId: null,
					catalogToolSource: "openapi",
				},
				{},
			),
		).toBe(true);

		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{
					organizationId: "org_1",
					sourceAppId: null,
					metadata: { mcpConfig: { openApiSync: { enabled: true } } },
				},
				{},
			),
		).toBe(true);
	});

	it("allows a tenant-owned base app to start an explicit OpenAPI import", () => {
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{ organizationId: "org_1", sourceAppId: null },
				{ specUrl: "https://example.com/openapi.yaml" },
			),
		).toBe(true);
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{ organizationId: "org_1", sourceAppId: null },
				{ spec: { openapi: "3.1.0" } },
			),
		).toBe(true);
	});

	it("blocks proxy apps, cross-org apps, and non-OpenAPI app reads", () => {
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{
					organizationId: "org_1",
					sourceAppId: "base_app_1",
					catalogToolSource: "openapi",
				},
				{},
			),
		).toBe(false);
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{
					organizationId: "org_2",
					sourceAppId: null,
					catalogToolSource: "openapi",
				},
				{},
			),
		).toBe(false);
		expect(
			hasTenantOpenApiImportAccess(
				tenantContext,
				{ organizationId: "org_1", sourceAppId: null },
				{},
			),
		).toBe(false);
	});
});
