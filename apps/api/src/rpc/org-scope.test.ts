import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vite-plus/test";
import { requireOrgId, requireOrgIdOrInput } from "./org-scope";
import type { BaseContext } from "./orpc";

const ctx = (organizationId?: string) =>
	({ organizationId }) as unknown as BaseContext;

// oRPC v2's ORPCError carries no `status` — the HTTP status is resolved by the
// handler codec from the code — so assert the code, which is what actually
// pins the 403 behaviour.
function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof ORPCError) return error.code;
		throw error;
	}
	throw new Error("expected a throw");
}

describe("requireOrgId", () => {
	it("returns the scope when the credential has one", () => {
		expect(requireOrgId(ctx("org_1"))).toBe("org_1");
	});

	// 31 copies of this guard disagreed on the code for the same condition:
	// 17 threw UNAUTHORIZED, 10 FORBIDDEN, 6 BAD_REQUEST. FORBIDDEN is canonical
	// because withAuth has already run — the caller is authenticated and merely
	// unscoped. It also matters that this is NOT 401: browser clients treat that
	// as a sign-in failure, so a 401 here would bounce users with a valid session.
	it("rejects a missing scope with FORBIDDEN (403), never UNAUTHORIZED", () => {
		expect(codeOf(() => requireOrgId(ctx()))).toBe("FORBIDDEN");
	});

	it("names the resource when given a detail", () => {
		try {
			requireOrgId(ctx(), "project access");
			throw new Error("expected a throw");
		} catch (error) {
			expect((error as ORPCError<string, unknown>).message).toBe(
				"Organization scope is required for project access",
			);
		}
	});
});

describe("requireOrgIdOrInput", () => {
	it("falls back to the input organization when the credential is unscoped", () => {
		expect(requireOrgIdOrInput(ctx(), "org_from_input")).toBe("org_from_input");
	});

	// A scoped credential must not be widened by passing a different org in the
	// body — context always wins.
	it("ignores the input when the credential is already scoped", () => {
		expect(requireOrgIdOrInput(ctx("org_ctx"), "org_other")).toBe("org_ctx");
	});

	it("rejects with FORBIDDEN when neither is present", () => {
		expect(codeOf(() => requireOrgIdOrInput(ctx(), undefined))).toBe(
			"FORBIDDEN",
		);
	});
});
