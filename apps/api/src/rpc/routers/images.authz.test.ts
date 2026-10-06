import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { assertEntityImageAuthorization } from "./images";

function userContext(permissions: string[], userRole?: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/images"),
		userRole,
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: "org-1",
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/images"),
	} as BaseContext;
}

describe("image entity authorization", () => {
	it("uses entity-specific user permissions", () => {
		expect(() =>
			assertEntityImageAuthorization(userContext(["apps:update"]), "app"),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(userContext(["apps:update"]), "tedi"),
		).toThrowError(/tedis:update/);
		expect(() =>
			assertEntityImageAuthorization(
				userContext(["tedis:update"]),
				"organization",
			),
		).toThrowError(/settings:manage/);
	});

	it("honors the D1 role fallback for an authenticated user", () => {
		expect(() =>
			assertEntityImageAuthorization(userContext([], "admin"), "organization"),
		).not.toThrow();
	});

	it("uses entity-specific machine scopes", () => {
		expect(() =>
			assertEntityImageAuthorization(apiKeyContext(["apps:write"]), "app"),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(
				apiKeyContext(["apps:write"]),
				"organization",
			),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(apiKeyContext(["apps:write"]), "tedi"),
		).toThrowError(/tedis:write/);
		expect(() =>
			assertEntityImageAuthorization(apiKeyContext(["tedis:write"]), "tedi"),
		).not.toThrow();
	});

	it("allows platform administration across every entity type", () => {
		const context = apiKeyContext(["platform:admin"]);
		for (const entityType of ["organization", "app", "tedi"] as const) {
			expect(() =>
				assertEntityImageAuthorization(context, entityType),
			).not.toThrow();
		}
	});
});
