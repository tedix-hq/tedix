import { OrganizationPermissionSchema } from "@tedix/api-contract/schemas/user-settings";
import { describe, expect, it } from "vite-plus/test";
import {
	ALL_PERMISSIONS,
	ASSIGNABLE_ROLES,
	describeRolePermissions,
	hasPermission,
	PERMISSION_GROUPS,
	PERMISSION_METADATA,
	type Role,
	roleImpliesPermission,
	ROLE_METADATA,
	ROLE_PERMISSION_GRANTS,
} from "./rbac";
import type { JWTPayload } from "./types";

function makeJwtUser(
	tenantId: string,
	roles: string[],
	permissions: string[],
): JWTPayload {
	return {
		sub: "user-123",
		iat: 0,
		exp: 9999999999,
		iss: "https://api.descope.com/P1",
		aud: "P1",
		dct: tenantId,
		roles,
		permissions,
	};
}

function makePlainUser(roles: string[], permissions: string[]) {
	return { roles, permissions };
}

describe("hasPermission", () => {
	it("grants via explicit permission (JWT format)", () => {
		const user = makeJwtUser("org-1", ["member"], ["apps:read"]);
		expect(hasPermission(user, "apps:read")).toBe(true);
	});

	it("denies missing permission (JWT format)", () => {
		const user = makeJwtUser("org-1", ["member"], ["apps:read"]);
		expect(hasPermission(user, "apps:delete")).toBe(false);
	});

	it("grants via explicit permission (plain format)", () => {
		expect(
			hasPermission(makePlainUser([], ["apps:create"]), "apps:create"),
		).toBe(true);
	});

	it("denies missing permission (plain format)", () => {
		expect(hasPermission(makePlainUser(["member"], []), "apps:delete")).toBe(
			false,
		);
	});

	describe("role-based grants", () => {
		it("owner grants org permissions without becoming a platform wildcard", () => {
			const user = makeJwtUser("org-1", ["owner"], []);
			expect(hasPermission(user, "apps:delete")).toBe(true);
			expect(hasPermission(user, "billing:manage")).toBe(true);
			expect(hasPermission(user, "secrets:manage")).toBe(true);
			expect(hasPermission(user, "platform:admin")).toBe(false);
			expect(hasPermission(user, "catalog:manage")).toBe(false);
		});

		it("admin grants org write permissions without billing or platform admin", () => {
			const user = makeJwtUser("org-1", ["admin"], []);
			expect(hasPermission(user, "apps:delete")).toBe(true);
			expect(hasPermission(user, "settings:manage")).toBe(true);
			expect(hasPermission(user, "billing:manage")).toBe(false);
			expect(hasPermission(user, "platform:admin")).toBe(false);
		});

		it("admin grants org-local admin permissions only", () => {
			const user = makeJwtUser("org-1", ["admin"], []);
			expect(hasPermission(user, "apps:delete")).toBe(true);
			expect(hasPermission(user, "settings:manage")).toBe(true);
			expect(hasPermission(user, "billing:manage")).toBe(false);
			expect(hasPermission(user, "platform:admin")).toBe(false);
			expect(hasPermission(user, "catalog:manage")).toBe(false);
		});

		it("tedi holds no human RBAC permissions (authorized via scopes + FGA)", () => {
			const user = makeJwtUser("org-1", ["tedi"], []);
			expect(hasPermission(user, "apps:read")).toBe(false);
			expect(hasPermission(user, "apps:delete")).toBe(false);
			expect(hasPermission(user, "platform:admin")).toBe(false);
		});

		it("platform-admin grants platform and OS permissions, not tenant CRUD", () => {
			const user = makeJwtUser("org-1", ["platform-admin"], []);
			expect(hasPermission(user, "platform:admin")).toBe(true);
			expect(hasPermission(user, "catalog:manage")).toBe(true);
			// platform-admin has no settings:manage, so the OS verbs are its only
			// route into the Tedix OS (Descope grants the same six).
			expect(hasPermission(user, "os:read")).toBe(true);
			expect(hasPermission(user, "os:admin")).toBe(true);
			expect(hasPermission(user, "apps:delete")).toBe(false);
			expect(hasPermission(user, "settings:manage")).toBe(false);
		});

		it("admin-grade roles hold every OS verb explicitly, not only via settings:manage", () => {
			for (const role of ["owner", "admin", "admin", "admin"]) {
				const user = makeJwtUser("org-1", [role], []);
				for (const permission of [
					"os:read",
					"os:author",
					"os:run",
					"os:publish",
					"os:approve",
					"os:admin",
				] as const) {
					expect(
						roleImpliesPermission([role], permission),
						`${role} should imply ${permission}`,
					).toBe(true);
					expect(hasPermission(user, permission)).toBe(true);
				}
			}
		});

		it("catalog-operator and tedi hold no OS verbs", () => {
			for (const role of ["catalog-operator", "tedi"]) {
				expect(roleImpliesPermission([role], "os:read")).toBe(false);
				expect(roleImpliesPermission([role], "os:admin")).toBe(false);
			}
		});

		it("member and viewer hold only the everyday OS verbs", () => {
			expect(roleImpliesPermission(["member"], "os:run")).toBe(true);
			expect(roleImpliesPermission(["member"], "os:approve")).toBe(false);
			expect(roleImpliesPermission(["member"], "os:admin")).toBe(false);
			expect(roleImpliesPermission(["viewer"], "os:read")).toBe(true);
			expect(roleImpliesPermission(["viewer"], "os:author")).toBe(false);
		});

		it("member does NOT bypass", () => {
			const user = makeJwtUser("org-1", ["member"], []);
			expect(hasPermission(user, "apps:delete")).toBe(false);
		});

		it("viewer does NOT bypass", () => {
			const user = makeJwtUser("org-1", ["viewer"], []);
			expect(hasPermission(user, "apps:read")).toBe(true);
			expect(hasPermission(user, "apps:delete")).toBe(false);
		});
	});

	describe("Current-Tenant-Only JWT", () => {
		it("reads roles/permissions already flattened to dct's tenant", () => {
			const user: JWTPayload = {
				sub: "u1",
				iat: 0,
				exp: 9999999999,
				iss: "https://api.descope.com/P1",
				aud: "P1",
				dct: "org-2",
				roles: ["member"],
				permissions: ["apps:read"],
			};
			expect(hasPermission(user, "apps:read")).toBe(true);
			expect(hasPermission(user, "apps:delete")).toBe(false);
		});

		it("honors an explicitly emitted platform-admin role alongside dct grants", () => {
			const user: JWTPayload = {
				sub: "u1",
				iat: 0,
				exp: 9999999999,
				iss: "https://api.descope.com/P1",
				aud: "P1",
				dct: "org-2",
				roles: ["member", "platform-admin"],
				permissions: ["apps:read"],
			};
			expect(hasPermission(user, "platform:admin")).toBe(true);
		});
	});
});

describe("ALL_PERMISSIONS", () => {
	// `@tedix/api-contract` cannot import this package (the dependency runs the
	// other way), so `OrganizationPermissionSchema` hand-mirrors this list. That
	// mirror is what every operator projection of caller authority renders from:
	// a permission added here but not there would be silently dropped from the
	// wire — the projection would under-report real authority and nothing would
	// fail. This asserts set equality in BOTH directions so neither side can
	// drift alone.
	it("matches the contract's mirror enum exactly", () => {
		const contractPermissions = new Set<string>(
			OrganizationPermissionSchema.options,
		);
		const authPermissions = new Set<string>(ALL_PERMISSIONS);
		expect([...authPermissions].sort()).toEqual(
			[...contractPermissions].sort(),
		);
	});

	it("holds every permission any role grants", () => {
		const granted = new Set<string>(
			Object.values(ROLE_PERMISSION_GRANTS).flat(),
		);
		const listed = new Set<string>(ALL_PERMISSIONS);
		for (const permission of granted) {
			expect(listed.has(permission), `${permission} is ungrantable`).toBe(true);
		}
	});

	it("has no duplicate entries", () => {
		expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
	});
});

/**
 * The catalog exists so a product surface can describe authority WITHOUT
 * inventing its own model — the failure this whole epic starts from is the
 * Dashboard rendering an unrelated 8-boolean capability list that no guard ever
 * evaluated. That only holds if the catalog stays exhaustive in both
 * directions: a permission with no metadata would render blank, and a metadata
 * entry for a permission that no longer exists would advertise access nothing
 * grants.
 */
describe("RBAC presentation catalog", () => {
	it("describes every permission and nothing else", () => {
		expect(Object.keys(PERMISSION_METADATA).sort()).toEqual(
			[...ALL_PERMISSIONS].sort(),
		);
	});

	it("describes every role and nothing else", () => {
		expect(Object.keys(ROLE_METADATA).sort()).toEqual(
			Object.keys(ROLE_PERMISSION_GRANTS).sort(),
		);
	});

	it("files every permission under a real group", () => {
		for (const [permission, meta] of Object.entries(PERMISSION_METADATA)) {
			expect(
				PERMISSION_GROUPS.includes(meta.group),
				`${permission} has unknown group ${meta.group}`,
			).toBe(true);
		}
	});

	it("keeps labels and descriptions renderable", () => {
		for (const [permission, meta] of Object.entries(PERMISSION_METADATA)) {
			expect(meta.label.length, `${permission} label`).toBeGreaterThan(0);
			expect(
				meta.description.endsWith("."),
				`${permission} description must be a sentence`,
			).toBe(true);
		}
		for (const [role, meta] of Object.entries(ROLE_METADATA)) {
			expect(meta.label.length, `${role} label`).toBeGreaterThan(0);
			expect(
				meta.responsibility.length,
				`${role} responsibility`,
			).toBeGreaterThan(0);
		}
	});

	it("lists exactly the roles marked assignable", () => {
		const marked = Object.entries(ROLE_METADATA)
			.filter(([, meta]) => meta.assignable)
			.map(([role]) => role)
			.sort();
		expect([...ASSIGNABLE_ROLES].sort()).toEqual(marked);
	});

	it("never marks a platform or machine role assignable", () => {
		// A tenant admin must not be able to hand out platform authority from a
		// role picker. `platform-admin` is the one role that grants
		// `platform:admin`, so this is the seam that keeps it out of the product.
		for (const role of ASSIGNABLE_ROLES) {
			expect(
				ROLE_PERMISSION_GRANTS[role].includes("platform:admin"),
				`${role} must not grant platform:admin`,
			).toBe(false);
		}
		expect(ROLE_METADATA["platform-admin"].assignable).toBe(false);
		expect(ROLE_METADATA.tedi.assignable).toBe(false);
	});

	it("describes exactly the permissions a role grants, grouped in order", () => {
		for (const role of Object.keys(ROLE_PERMISSION_GRANTS) as Role[]) {
			const described = describeRolePermissions(role);
			expect(described.map((entry) => entry.permission).sort()).toEqual(
				[...ROLE_PERMISSION_GRANTS[role]].sort(),
			);
			const groupOrder = described.map((entry) =>
				PERMISSION_GROUPS.indexOf(entry.group),
			);
			expect(
				groupOrder.every((value, index) =>
					index === 0 ? true : value >= (groupOrder[index - 1] ?? 0),
				),
				`${role} permissions are not group-ordered`,
			).toBe(true);
		}
	});

	it("returns an empty description set for a role that grants nothing", () => {
		// `tedi` is authorized by capability scopes and FGA, not by this model.
		expect(describeRolePermissions("tedi")).toEqual([]);
	});
});
