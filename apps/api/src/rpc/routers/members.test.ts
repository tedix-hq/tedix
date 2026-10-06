import { createRouterClient } from "@orpc/server";
import {
	ASSIGNABLE_ROLES,
	ROLE_PERMISSION_GRANTS,
	TENANT_GRANTABLE_PERMISSIONS,
} from "@tedix/auth/rbac";
import { CAPABILITY_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import { describe, expect, it, vi } from "vite-plus/test";
import { membersContractRouter } from "./members";
import {
	assertCanAssignRole,
	assertCanManageTarget,
	effectiveMemberRole,
	memberRoleRank,
} from "./members";
import type { BaseContext } from "../orpc";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({ getOrganizationById: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));

function ctx(over: Partial<BaseContext>): BaseContext {
	return over as BaseContext;
}

function readerContext(organizationId = ORG_ID): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {} as CloudflareEnv,
		headers: new Headers(),
		organizationId,
		userRole: "owner",
		url: new URL("https://api.tedix.test/rpc/members"),
		user: { sub: "owner-user", roles: ["owner"], permissions: ["team:read"] },
	} as BaseContext;
}

describe("member authority catalog", () => {
	it("returns only assignable roles and tenant-grantable permissions", async () => {
		mocks.getOrganizationById.mockResolvedValue({ id: ORG_ID });
		const client = createRouterClient(membersContractRouter, {
			context: () => readerContext(),
		});
		const [roles, permissions, scopes] = await Promise.all([
			client.listRoles({ organizationId: ORG_ID }),
			client.listPermissions({ organizationId: ORG_ID }),
			client.listCapabilityScopes({ organizationId: ORG_ID }),
		]);
		expect(roles.data.map((entry) => entry.role)).toEqual(ASSIGNABLE_ROLES);
		for (const entry of roles.data) {
			expect(entry.permissions).toEqual(ROLE_PERMISSION_GRANTS[entry.role]);
		}
		expect(permissions.data.map((entry) => entry.permission)).toEqual(
			TENANT_GRANTABLE_PERMISSIONS,
		);
		expect(permissions.data.map((entry) => entry.permission)).not.toContain(
			"platform:admin",
		);
		expect(scopes.data.map((entry) => entry.scope)).toEqual(CAPABILITY_SCOPES);
		expect(
			scopes.data.find((entry) => entry.scope === "mcp:settings.admin")
				?.humanOnly,
		).toBe(true);
	});

	it("refuses a different tenant even when the caller has team:read", async () => {
		mocks.getOrganizationById.mockResolvedValue({ id: OTHER_ORG_ID });
		const client = createRouterClient(membersContractRouter, {
			context: () => readerContext(),
		});
		await expect(
			client.listRoles({ organizationId: OTHER_ORG_ID }),
		).rejects.toThrow(/Organization access denied/);
		await expect(
			client.listPermissions({ organizationId: OTHER_ORG_ID }),
		).rejects.toThrow(/Organization access denied/);
		await expect(
			client.listCapabilityScopes({ organizationId: OTHER_ORG_ID }),
		).rejects.toThrow(/Organization access denied/);
	});
});

describe("effectiveMemberRole", () => {
	it("uses a human's own member role", () => {
		expect(effectiveMemberRole(ctx({ userRole: "owner" }))).toBe("owner");
		expect(effectiveMemberRole(ctx({ userRole: "admin" }))).toBe("admin");
		expect(effectiveMemberRole(ctx({ userRole: "member" }))).toBe("member");
	});

	// An org_admin operator tedi manages its OWN org's team (own-org is enforced
	// separately by requireOrganizationAccess). It holds mcp:settings only via the
	// org_admin capability profile, and is capped at admin — never owner.
	it("treats an org_admin tedi (mcp:settings.admin) as admin-equivalent", () => {
		expect(
			effectiveMemberRole(
				ctx({
					tediId: "t1",
					tediScopes: ["mcp:tedis.read", "mcp:settings.admin"],
				}),
			),
		).toBe("admin");
	});

	it("does NOT elevate a standard tedi (no mcp:settings)", () => {
		expect(
			effectiveMemberRole(
				ctx({ tediId: "t1", tediScopes: ["mcp:tedis", "mcp:apps"] }),
			),
		).toBe(null);
	});

	it("does not elevate a bare service binding or unknown caller", () => {
		expect(effectiveMemberRole(ctx({ authType: "service-binding" }))).toBe(
			null,
		);
		expect(effectiveMemberRole(ctx({}))).toBe(null);
	});
});

describe("platform membership administration", () => {
	it("keeps platform authority separate from tenant role rank", async () => {
		const { isPlatformPrincipal } = await import("@tedix/auth/types");
		const platformOwner = ctx({
			authType: "user",
			user: {
				sub: "platform-owner",
				roles: ["platform-admin"],
			},
		});

		expect(isPlatformPrincipal(platformOwner)).toBe(true);
		expect(effectiveMemberRole(platformOwner)).toBe(null);
	});
});

describe("member RBAC caps for an org_admin tedi", () => {
	const operator = ctx({
		tediId: "t1",
		tediScopes: ["mcp:settings.admin"],
	});

	it("can assign admin/member/viewer but NOT owner", () => {
		expect(() => assertCanAssignRole(operator, "admin")).not.toThrow();
		expect(() => assertCanAssignRole(operator, "member")).not.toThrow();
		expect(() => assertCanAssignRole(operator, "viewer")).not.toThrow();
		expect(() => assertCanAssignRole(operator, "owner")).toThrow(/outranks/);
	});

	it("cannot manage/remove an owner", () => {
		expect(() => assertCanManageTarget(operator, "admin")).not.toThrow();
		expect(() => assertCanManageTarget(operator, "owner")).toThrow(/outranks/);
	});

	it("a non-operator tedi is blocked from assigning any role", () => {
		const plain = ctx({ tediId: "t2", tediScopes: ["mcp:apps"] });
		// effectiveMemberRole=null → rank -1 → even viewer (rank 0) outranks it.
		expect(() => assertCanAssignRole(plain, "viewer")).toThrow(/outranks/);
	});

	it("memberRoleRank orders roles owner>admin>member>viewer>unknown", () => {
		expect(memberRoleRank("owner")).toBeGreaterThan(memberRoleRank("admin"));
		expect(memberRoleRank("admin")).toBeGreaterThan(memberRoleRank("member"));
		expect(memberRoleRank("viewer")).toBeGreaterThan(memberRoleRank(null));
	});
});
