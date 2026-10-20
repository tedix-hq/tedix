import { describe, expect, it } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { assertEntityImageAuthorization } from "./images";

const { userContext, apiKeyContext } = bindTestContexts({
	url: "https://api.tedix.test/rpc/images",
});

describe("image entity authorization", () => {
	it("uses entity-specific user permissions", () => {
		expect(() =>
			assertEntityImageAuthorization(
				userContext({ permissions: ["apps:update"] }),
				"app",
			),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(
				userContext({ permissions: ["apps:update"] }),
				"tedi",
			),
		).toThrowError(/tedis:update/);
		expect(() =>
			assertEntityImageAuthorization(
				userContext({ permissions: ["tedis:update"] }),
				"organization",
			),
		).toThrowError(/settings:manage/);
	});

	it("honors the D1 role fallback for an authenticated user", () => {
		expect(() =>
			assertEntityImageAuthorization(
				userContext({ permissions: [], userRole: "admin" }),
				"organization",
			),
		).not.toThrow();
	});

	it("uses entity-specific machine scopes", () => {
		expect(() =>
			assertEntityImageAuthorization(
				apiKeyContext({ scopes: ["apps:write"] }),
				"app",
			),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(
				apiKeyContext({ scopes: ["apps:write"] }),
				"organization",
			),
		).not.toThrow();
		expect(() =>
			assertEntityImageAuthorization(
				apiKeyContext({ scopes: ["apps:write"] }),
				"tedi",
			),
		).toThrowError(/tedis:write/);
		expect(() =>
			assertEntityImageAuthorization(
				apiKeyContext({ scopes: ["tedis:write"] }),
				"tedi",
			),
		).not.toThrow();
	});

	it("allows platform administration across every entity type", () => {
		const context = apiKeyContext({ scopes: ["platform:admin"] });
		for (const entityType of ["organization", "app", "tedi"] as const) {
			expect(() =>
				assertEntityImageAuthorization(context, entityType),
			).not.toThrow();
		}
	});
});
