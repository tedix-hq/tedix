import { createRouterClient } from "@orpc/server";
import {
	API_KEY_SCOPE_METADATA,
	ApiKeyScopeSchema,
	PLATFORM_ONLY_API_KEY_SCOPES,
	TENANT_DELEGABLE_API_KEY_SCOPES,
} from "@tedix/api-contract/schemas/organization";
import {
	isTenantGrantablePermission,
	ROLE_PERMISSION_GRANTS,
	TENANT_GRANTABLE_PERMISSIONS,
} from "@tedix/auth/rbac";
import { describe, expect, it } from "vite-plus/test";
import { userHoldsPermission } from "../orpc";
import type { BaseContext } from "../orpc";
import {
	__organizationsTest,
	organizationsContractRouter,
} from "./organizations";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

function userContext(
	permissions: string[],
	options: { roles?: string[]; userRole?: BaseContext["userRole"] } = {},
): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: options.roles ?? [],
			sub: "user-1",
		},
		userRole: options.userRole,
	} as BaseContext;
}

function apiKeyContext(scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: ORGANIZATION_ID,
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/organizations"),
	} as BaseContext;
}

describe("organizations authorization-plane composition", () => {
	it("rejects ordinary users from the cross-organization inventory", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(["apps:read"]),
		});

		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:read machine scope for organization-bound reads", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(
			client.get({ organizationId: ORGANIZATION_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.getFeatures({ organizationId: ORGANIZATION_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("does not let ordinary application scopes administer organizations", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: apiKeyContext(["apps:read", "apps:write"]),
		});

		await expect(
			client.create({ name: "Unauthorized machine org" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.listApiKeys({ organizationId: ORGANIZATION_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client.configureSso({
				organizationId: ORGANIZATION_ID,
				settings: { enabled: true },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("organizations privilege invariants", () => {
	it("reports the actual local gateway without replacing Cloud or custom endpoints", () => {
		const gateway = { slug: "acme-unified", customMcpDomain: null };
		expect(
			__organizationsTest.gatewayUrl(
				gateway,
				"development",
				"http://localhost:3000",
			),
		).toBe("http://acme-unified.localhost:3000/mcp");
		expect(
			__organizationsTest.gatewayUrl(
				gateway,
				"production",
				"http://localhost:3000",
			),
		).toBe("https://acme-unified.mcp.tedix.dev/mcp");
		for (const origin of [
			"invalid",
			"http://localhost.attacker.example:3000",
			"https://mcp.tedix.tech",
		]) {
			expect(
				__organizationsTest.gatewayUrl(gateway, "development", origin),
			).toBe("https://acme-unified.mcp.tedix.tech/mcp");
		}
		expect(
			__organizationsTest.gatewayUrl(
				{ ...gateway, customMcpDomain: "agents.example.com" },
				"development",
				"http://localhost:3000",
			),
		).toBe("https://agents.example.com/mcp");
	});
	it("builds first-run CLI gateway URLs without exposing tenant identifiers", () => {
		expect(
			__organizationsTest.gatewayUrl(
				{ slug: "acme-unified", customMcpDomain: null },
				"production",
			),
		).toBe("https://acme-unified.mcp.tedix.dev/mcp");
		expect(
			__organizationsTest.gatewayUrl(
				{
					slug: "ignored",
					customMcpDomain: "agents.example.com",
				},
				"production",
			),
		).toBe("https://agents.example.com/mcp");
	});

	it("reserves force-delete for platform authority", () => {
		const ordinaryOwner = userContext(["settings:manage"], {
			userRole: "owner",
		});
		const platformAdmin = userContext([], { roles: ["platform-admin"] });

		expect(() =>
			__organizationsTest.requireForceDeleteAuthority(ordinaryOwner, true),
		).toThrowError(/platform-admin authority/);
		expect(() =>
			__organizationsTest.requireForceDeleteAuthority(ordinaryOwner, false),
		).not.toThrow();
		expect(() =>
			__organizationsTest.requireForceDeleteAuthority(platformAdmin, true),
		).not.toThrow();
	});

	it("reserves fleet-runner key minting for platform authority", () => {
		const ordinaryOwner = userContext(["api_keys:manage"], {
			userRole: "owner",
		});
		const platformAdmin = userContext([], { roles: ["platform-admin"] });

		expect(() =>
			__organizationsTest.assertDelegatableApiKeyScopes(ordinaryOwner, [
				"os:fleet-run",
			]),
		).toThrowError(/Platform authority/);
		expect(() =>
			__organizationsTest.assertDelegatableApiKeyScopes(platformAdmin, [
				"os:fleet-run",
			]),
		).not.toThrow();
	});

	/**
	 * The OS admin picker builds itself by subtracting
	 * `PLATFORM_ONLY_API_KEY_SCOPES` from the contract enum, and this guard
	 * refuses exactly that list. If the two ever diverge the product breaks in
	 * one of two ways: it offers a scope the API rejects (which is what shipped
	 * — the dialog hardcoded `["*"]`, so no ordinary tenant admin could create a
	 * key at all), or it hides a scope a tenant is entitled to.
	 */
	it("lets a tenant admin delegate every scope the picker offers", () => {
		const ordinaryOwner = userContext(["api_keys:manage"], {
			userRole: "owner",
		});
		expect(TENANT_DELEGABLE_API_KEY_SCOPES.length).toBeGreaterThan(0);
		for (const scope of TENANT_DELEGABLE_API_KEY_SCOPES) {
			expect(() =>
				__organizationsTest.assertDelegatableApiKeyScopes(ordinaryOwner, [
					scope,
				]),
			).not.toThrow();
		}
		// And the whole offered set at once, which is what "select all" sends.
		expect(() =>
			__organizationsTest.assertDelegatableApiKeyScopes(ordinaryOwner, [
				...TENANT_DELEGABLE_API_KEY_SCOPES,
			]),
		).not.toThrow();
	});

	it("refuses every platform-only scope from a tenant admin", () => {
		const ordinaryOwner = userContext(["api_keys:manage"], {
			userRole: "owner",
		});
		const platformAdmin = userContext([], { roles: ["platform-admin"] });
		for (const scope of PLATFORM_ONLY_API_KEY_SCOPES) {
			expect(() =>
				__organizationsTest.assertDelegatableApiKeyScopes(ordinaryOwner, [
					scope,
				]),
			).toThrowError(/Platform authority/);
			expect(() =>
				__organizationsTest.assertDelegatableApiKeyScopes(platformAdmin, [
					scope,
				]),
			).not.toThrow();
		}
	});

	it("names the offending scope so the caller can fix the request", () => {
		const ordinaryOwner = userContext(["api_keys:manage"], {
			userRole: "owner",
		});
		expect(() =>
			__organizationsTest.assertDelegatableApiKeyScopes(ordinaryOwner, [
				"apps:read",
				"*",
			]),
		).toThrowError(/\*/);
	});

	it("partitions the scope enum with no overlap and no gap", () => {
		const delegable = new Set<string>(TENANT_DELEGABLE_API_KEY_SCOPES);
		const platformOnly = new Set<string>(PLATFORM_ONLY_API_KEY_SCOPES);
		for (const scope of platformOnly) {
			expect(delegable.has(scope), `${scope} must not be delegable`).toBe(
				false,
			);
		}
		expect(delegable.size + platformOnly.size).toBe(
			ApiKeyScopeSchema.options.length,
		);
		// Every scope must be describable, or the picker renders a blank row.
		for (const scope of ApiKeyScopeSchema.options) {
			expect(API_KEY_SCOPE_METADATA[scope]?.label ?? "").not.toBe("");
		}
	});
});

/**
 * Per-member permission overrides.
 *
 * Overrides are a SECOND source of authority a tenant administrator controls,
 * so the only thing standing between them and platform escalation is
 * `TENANT_GRANTABLE_PERMISSIONS` — defined as exactly what the `owner` role
 * holds. These assertions pin that boundary and the additive-only semantics.
 */
describe("member permission overrides", () => {
	it("never lets an override reach beyond the owner role", () => {
		for (const permission of ["platform:admin", "catalog:manage"] as const) {
			expect(
				isTenantGrantablePermission(permission),
				`${permission} must not be grantable by a tenant admin`,
			).toBe(false);
		}
		expect(TENANT_GRANTABLE_PERMISSIONS).toEqual(ROLE_PERMISSION_GRANTS.owner);
	});

	it("grants an overridden permission the role does not carry", () => {
		const viewer = {
			user: { sub: "u1" } as never,
			userRole: "viewer",
			userPermissionOverrides: ["team:manage"],
		};
		expect(userHoldsPermission(viewer, "team:manage")).toBe(true);
		// And nothing else leaks in.
		expect(userHoldsPermission(viewer, "billing:manage")).toBe(false);
	});

	it("ignores an override carrying platform authority", () => {
		// Fail closed on READ too: a row written by any path that bypasses the
		// API must stay inert rather than becoming authority.
		const viewer = {
			user: { sub: "u1" } as never,
			userRole: "viewer",
			userPermissionOverrides: ["platform:admin", "catalog:manage"],
		};
		expect(userHoldsPermission(viewer, "platform:admin")).toBe(false);
		expect(userHoldsPermission(viewer, "catalog:manage")).toBe(false);
	});

	it("is additive only — an override cannot remove role authority", () => {
		const owner = {
			user: { sub: "u1" } as never,
			userRole: "owner",
			userPermissionOverrides: [],
		};
		expect(userHoldsPermission(owner, "billing:manage")).toBe(true);
	});

	it("still requires an authenticated user", () => {
		expect(
			userHoldsPermission(
				{ userRole: "viewer", userPermissionOverrides: ["team:manage"] },
				"team:manage",
			),
		).toBe(false);
	});
});
