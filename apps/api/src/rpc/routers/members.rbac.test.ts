import { describe, expect, test } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	assertCanAssignRole,
	assertCanManageTarget,
	memberRoleRank,
} from "./members";

const ctx = (role: string | null): BaseContext =>
	({ userRole: role }) as unknown as BaseContext;

describe("members RBAC invariants", () => {
	test("role rank is a strict owner > admin > member > viewer ordering", () => {
		expect(memberRoleRank("owner")).toBeGreaterThan(memberRoleRank("admin"));
		expect(memberRoleRank("admin")).toBeGreaterThan(memberRoleRank("member"));
		expect(memberRoleRank("member")).toBeGreaterThan(memberRoleRank("viewer"));
		// Unknown / missing roles rank below everything so they can never outrank.
		expect(memberRoleRank("nonsense")).toBe(-1);
		expect(memberRoleRank(null)).toBe(-1);
		expect(memberRoleRank(undefined)).toBe(-1);
	});

	test("assertCanAssignRole blocks granting a role above the caller's", () => {
		// The confirmed bug: an admin minting an owner.
		expect(() => assertCanAssignRole(ctx("admin"), "owner")).toThrow();
		// Same-rank and below are allowed.
		expect(() => assertCanAssignRole(ctx("admin"), "admin")).not.toThrow();
		expect(() => assertCanAssignRole(ctx("admin"), "member")).not.toThrow();
		expect(() => assertCanAssignRole(ctx("admin"), "viewer")).not.toThrow();
		// An owner may assign any role.
		expect(() => assertCanAssignRole(ctx("owner"), "owner")).not.toThrow();
		expect(() => assertCanAssignRole(ctx("owner"), "admin")).not.toThrow();
	});

	test("assertCanManageTarget blocks acting on a higher-ranked member", () => {
		// The confirmed bug: an admin demoting/removing an owner.
		expect(() => assertCanManageTarget(ctx("admin"), "owner")).toThrow();
		// An admin may manage peers and below.
		expect(() => assertCanManageTarget(ctx("admin"), "admin")).not.toThrow();
		expect(() => assertCanManageTarget(ctx("admin"), "member")).not.toThrow();
		// An owner may manage anyone (last-owner invariant is enforced separately).
		expect(() => assertCanManageTarget(ctx("owner"), "owner")).not.toThrow();
		// A null target role can never outrank the caller.
		expect(() => assertCanManageTarget(ctx("admin"), null)).not.toThrow();
	});
});
