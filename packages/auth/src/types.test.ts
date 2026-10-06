import { describe, expect, it } from "vite-plus/test";
import type { JWTPayload } from "./types";
import {
	extractJwtScopes,
	hasStepUpClaim,
	isPlatformPrincipal,
	resolveTenantOverride,
} from "./types";

describe("extractJwtScopes", () => {
	it("merges supported claims, normalizes whitespace, and deduplicates", () => {
		expect(
			extractJwtScopes({
				...basePayload,
				scope: "mcp:read\t mcp:write",
				scp: "mcp:write\nplatform:admin",
				scopes: ["mcp:read", "apps:read"],
			}),
		).toEqual(["mcp:read", "mcp:write", "platform:admin", "apps:read"]);
	});

	it("ignores malformed array entries instead of coercing them into scopes", () => {
		expect(
			extractJwtScopes({
				...basePayload,
				scopes: ["apps:read", 123, null] as unknown as string[],
			}),
		).toEqual(["apps:read"]);
	});
});

const basePayload = {
	sub: "user_123",
	iat: 1,
	exp: 2,
	iss: "https://auth.tedix.dev",
	aud: "project",
} satisfies JWTPayload;

describe("isPlatformPrincipal", () => {
	it("does not grant platform authority to service bindings", () => {
		expect(isPlatformPrincipal({ authType: "service-binding" })).toBe(false);
		expect(isPlatformPrincipal({ authType: "service" })).toBe(false);
	});

	it("grants platform authority to platform-admin users", () => {
		expect(
			isPlatformPrincipal({
				user: {
					...basePayload,
					dct: "org_123",
					roles: ["platform-admin"],
				},
				authType: "user",
			}),
		).toBe(true);
	});

	it("grants platform authority to OAuth users with the MCP admin scope", () => {
		expect(
			isPlatformPrincipal({
				user: {
					...basePayload,
					scope: "mcp:observe platform:admin",
				},
				authType: "user",
			}),
		).toBe(true);
		expect(
			isPlatformPrincipal({
				user: {
					...basePayload,
					scopes: ["platform:admin"],
				},
				authType: "user",
			}),
		).toBe(true);
	});

	it("grants platform authority to scoped API keys and service accounts", () => {
		expect(
			isPlatformPrincipal({
				apiKey: { scopes: ["platform:admin"] },
				authType: "apikey",
			}),
		).toBe(true);
		expect(
			isPlatformPrincipal({
				serviceAccount: { scope: "apps:read platform:admin" },
				authType: "m2m",
			}),
		).toBe(true);
	});

	// A tedi's Descope roles are absent from its JWT, so its authority rides on
	// the capability scopes the MCP edge resolves from D1
	// `tedis.mcp_capability_profile` and forwards over the service binding.
	it("grants platform authority to a platform_admin tedi via platform:admin scope", () => {
		expect(
			isPlatformPrincipal({
				tediScopes: ["mcp:tedis", "mcp:memory", "platform:admin"],
				authType: "service-binding",
			}),
		).toBe(true);
	});

	it("denies platform authority to a standard tedi", () => {
		// `standard` profile scopes — platform:admin/mcp:settings are withheld.
		expect(
			isPlatformPrincipal({
				tediScopes: ["mcp:tedis", "mcp:apps", "mcp:memory", "mcp:skills"],
				authType: "service-binding",
			}),
		).toBe(false);
	});

	it("still denies a service binding that carries no tedi scopes", () => {
		expect(
			isPlatformPrincipal({ tediScopes: [], authType: "service-binding" }),
		).toBe(false);
	});
});

describe("hasStepUpClaim", () => {
	it("only accepts a literal true `su` claim", () => {
		expect(hasStepUpClaim({ ...basePayload, su: true })).toBe(true);
		expect(hasStepUpClaim({ ...basePayload, su: false })).toBe(false);
		expect(hasStepUpClaim(basePayload)).toBe(false);
		expect(hasStepUpClaim(undefined)).toBe(false);
	});

	it("does not accept a truthy non-boolean claim", () => {
		// Descope emits a real boolean. A string "true" reaching here would mean
		// the claim came from somewhere else, so refuse it rather than coerce.
		expect(
			hasStepUpClaim({ ...basePayload, su: "true" } as unknown as JWTPayload),
		).toBe(false);
		expect(
			hasStepUpClaim({ ...basePayload, su: 1 } as unknown as JWTPayload),
		).toBe(false);
	});
});

describe("resolveTenantOverride", () => {
	const inTenant = { ...basePayload, dct: "org_a" } satisfies JWTPayload;

	it("uses the token's own tenant when no override is provided", () => {
		expect(resolveTenantOverride(inTenant, undefined)).toEqual({
			tenantId: "org_a",
			isCrossTenantOverride: false,
		});
		expect(resolveTenantOverride(inTenant, null)).toEqual({
			tenantId: "org_a",
			isCrossTenantOverride: false,
		});
	});

	it("does not flag an override that matches the token's own tenant", () => {
		expect(resolveTenantOverride(inTenant, "org_a")).toEqual({
			tenantId: "org_a",
			isCrossTenantOverride: false,
		});
		// Whitespace-only is treated as absent, not a foreign tenant.
		expect(resolveTenantOverride(inTenant, "   ")).toEqual({
			tenantId: "org_a",
			isCrossTenantOverride: false,
		});
	});

	it("flags an override addressing a different tenant", () => {
		expect(resolveTenantOverride(inTenant, "org_b")).toEqual({
			tenantId: "org_b",
			isCrossTenantOverride: true,
		});
	});

	it("flags an override even when the token has no own tenant", () => {
		expect(resolveTenantOverride(basePayload, "org_b")).toEqual({
			tenantId: "org_b",
			isCrossTenantOverride: true,
		});
	});
});
