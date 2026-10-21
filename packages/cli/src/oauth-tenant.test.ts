import { describe, expect, test } from "bun:test";
import { scopesBeyondGrant } from "./oauth-tenant";

describe("scopesBeyondGrant", () => {
	test.each([
		{
			name: "scope is narrower than scp",
			tokenClaims: { scope: "read", scp: ["read", "admin"] },
			expected: ["admin"],
		},
		{
			name: "scp is narrower than scope",
			tokenClaims: { scope: ["read", "write"], scp: "read" },
			expected: ["write"],
		},
		{
			name: "scope is empty while scp is wider",
			tokenClaims: { scope: "", scp: "read admin" },
			expected: ["admin"],
		},
		{
			name: "scp is empty while scope is wider",
			tokenClaims: { scope: ["read", "write"], scp: [] },
			expected: ["write"],
		},
	])(
		"checks both token claim forms when $name",
		({ tokenClaims, expected }) => {
			expect(scopesBeyondGrant("read", { tokenClaims })).toEqual([...expected]);
		},
	);

	test("combines the response and both claims with deterministic deduplication", () => {
		expect(
			scopesBeyondGrant("read", {
				responseScope: "read response-extra shared-extra",
				tokenClaims: {
					scope: "read scope-extra shared-extra",
					scp: ["read", "scp-extra", "scope-extra"],
				},
			}),
		).toEqual(["response-extra", "shared-extra", "scope-extra", "scp-extra"]);
	});

	test("preserves absent-grant semantics", () => {
		expect(
			scopesBeyondGrant(undefined, {
				responseScope: "response-extra",
				tokenClaims: { scope: "scope-extra", scp: ["scp-extra"] },
			}),
		).toEqual([]);
	});

	test("ignores unsupported claim types", () => {
		expect(
			scopesBeyondGrant("read", {
				tokenClaims: {
					scope: { authority: "admin" },
					scp: ["read", 42, "admin"],
					roles: ["admin"],
				},
			}),
		).toEqual([]);
	});
});
