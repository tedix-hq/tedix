/**
 * Tenant-isolation guards for confirmed cross-tenant defects.
 *
 * 1. Control-plane get-by-id returned ANY org's runtime profile / policy pack /
 *    workspace template set, because the handlers asserted only that the CALLER
 *    had an organization — never that the RECORD belonged to it. The
 *    update/delete siblings were correctly guarded the whole time, which is what
 *    made the gap easy to miss.
 * 2. acceptInvitation let any authenticated caller accept any pending
 *    invitation, and linked whatever `descopeUserId` the body carried.
 * 3. organizations.getBySlug returned another tenant's organization when its
 *    public slug was known, because the result was never bound to the caller.
 *
 * Both guards return NOT_FOUND rather than FORBIDDEN where the answer would
 * otherwise confirm that a record exists in another tenant.
 */

import { describe, expect, test } from "vite-plus/test";
import {
	requireOrganizationAccess as requireScopedOrganizationAccess,
	requireTediRequestIdentity,
} from "../org-scope";
import type { BaseContext } from "../orpc";
import { assertReadableControlPlaneRecord } from "./control-plane";
import {
	assertInvitationAddressedToCaller,
	assertInvitationLinkTarget,
} from "./members";
import { requireBillingOrganization } from "./org-usage";
import { requireOrganizationAccess } from "./organizations";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

const tenantCtx = (organizationId: string): BaseContext =>
	({ organizationId }) as unknown as BaseContext;

const platformCtx = (): BaseContext =>
	({
		organizationId: ORG_A,
		tediScopes: ["platform:admin"],
		authType: "service-binding",
	}) as unknown as BaseContext;

const record = (scope: string, organizationId: string | null) => ({
	scope,
	organizationId,
});

describe("organization resource scoping", () => {
	test("a tenant cannot read another organization resolved by slug", () => {
		expect(() => requireOrganizationAccess(tenantCtx(ORG_A), ORG_B)).toThrow(
			/access denied/i,
		);
	});

	test("a tenant can read its own organization", () => {
		expect(() =>
			requireOrganizationAccess(tenantCtx(ORG_A), ORG_A),
		).not.toThrow();
	});
});

describe("caller-supplied tenant identifiers", () => {
	test("OS billing remains bound to the active workspace even for an owner", () => {
		expect(() =>
			requireBillingOrganization(tenantCtx(ORG_A), ORG_B, "billing usage"),
		).toThrow(/access denied/i);
		expect(
			requireBillingOrganization(tenantCtx(ORG_A), ORG_A, "billing usage"),
		).toBe(ORG_A);
	});

	test("OS billing rejects a caller without workspace scope", () => {
		expect(() =>
			requireBillingOrganization({} as BaseContext, ORG_A, "billing usage"),
		).toThrow(/organization scope is required/i);
	});

	test("an organization id in the body cannot widen tenant scope", () => {
		expect(() =>
			requireScopedOrganizationAccess(tenantCtx(ORG_A), ORG_B),
		).toThrow(/access denied/i);
	});

	test("a tedi JWT cannot request another tedi id", () => {
		const context = {
			authType: "tedi",
			tediId: "tedi-a",
			headers: new Headers(),
		} as unknown as BaseContext;
		expect(() => requireTediRequestIdentity(context, "tedi-b")).toThrow(
			/identity does not match/i,
		);
	});

	test("a service binding must bind its forwarded tedi header", () => {
		const context = {
			authType: "service-binding",
			headers: new Headers({ "X-Tedix-Tedi-Id": "tedi-a" }),
		} as unknown as BaseContext;
		expect(() => requireTediRequestIdentity(context, "tedi-a")).not.toThrow();
		expect(() => requireTediRequestIdentity(context, "tedi-b")).toThrow(
			/identity does not match/i,
		);
	});
});

describe("control-plane read scoping", () => {
	test("a tenant cannot read another tenant's record by id", () => {
		expect(() =>
			assertReadableControlPlaneRecord(
				tenantCtx(ORG_A),
				record("organization", ORG_B),
				"Runtime profile not found",
			),
		).toThrow(/not found/i);
	});

	test("a tenant can read its own record", () => {
		expect(() =>
			assertReadableControlPlaneRecord(
				tenantCtx(ORG_A),
				record("organization", ORG_A),
				"Runtime profile not found",
			),
		).not.toThrow();
	});

	test("system-scoped records stay readable by every tenant", () => {
		// Read visibility must mirror what list* returns (own org OR system).
		// Reusing the mutation guard here would have broken this case.
		expect(() =>
			assertReadableControlPlaneRecord(
				tenantCtx(ORG_A),
				record("system", null),
				"Policy pack not found",
			),
		).not.toThrow();
	});

	test("a platform principal may read across organizations", () => {
		expect(() =>
			assertReadableControlPlaneRecord(
				platformCtx(),
				record("organization", ORG_B),
				"Policy pack not found",
			),
		).not.toThrow();
	});

	test("a missing record is NOT_FOUND, not a crash", () => {
		expect(() =>
			assertReadableControlPlaneRecord(
				tenantCtx(ORG_A),
				null,
				"Workspace template set not found",
			),
		).toThrow(/not found/i);
	});
});

describe("invitation acceptance is bound to the authenticated caller", () => {
	const caller = (over: Partial<{ sub: string; email: string }> = {}) =>
		({
			user: {
				sub: over.sub ?? "descope-user-1",
				email: over.email ?? "invitee@example.com",
			},
		}) as unknown as BaseContext;

	test("rejects linking a THIRD PARTY's Descope account", () => {
		// The account-grafting hole: descopeUserId came straight from the body.
		expect(() =>
			assertInvitationLinkTarget(caller(), "descope-user-2"),
		).toThrow(/own account/i);
	});

	test("accepts linking the caller's own account", () => {
		expect(() =>
			assertInvitationLinkTarget(caller(), "descope-user-1"),
		).not.toThrow();
	});

	test("a principal with no user identity cannot accept at all", () => {
		expect(() =>
			assertInvitationLinkTarget({} as BaseContext, "descope-user-1"),
		).toThrow(/authenticated user identity/i);
	});

	test("rejects an invitation addressed to someone else", () => {
		// The org-join hole: knowing a pending memberId was previously enough.
		expect(() =>
			assertInvitationAddressedToCaller(caller(), "someone.else@example.com"),
		).toThrow(/not found/i);
	});

	test("accepts an invitation addressed to the caller, case/space insensitively", () => {
		expect(() =>
			assertInvitationAddressedToCaller(
				caller({ email: "Invitee@Example.com" }),
				"  invitee@example.com ",
			),
		).not.toThrow();
	});

	test("a token with no verified email fails closed", () => {
		// M2M / tedi principals carry no email claim and have no business
		// accepting a human's invitation.
		expect(() =>
			assertInvitationAddressedToCaller(
				{ descopeUserId: "tedi-1" } as unknown as BaseContext,
				"invitee@example.com",
			),
		).toThrow(/verified email/i);
	});
});
