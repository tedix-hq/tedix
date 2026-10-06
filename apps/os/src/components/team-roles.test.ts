import type { MemberRole } from "@tedix/api-contract/schemas/organization";
import {
	describeRolePermissions,
	PERMISSION_METADATA,
	ROLE_PERMISSION_GRANTS,
} from "@tedix/auth/rbac";
import { describe, expect, it } from "vite-plus/test";
import { CANONICAL_ROLE_ORDER } from "./team-roles";

const getRoleCapabilityLabels = (role: MemberRole): string[] =>
	describeRolePermissions(role).map((entry) => entry.label);

describe("organization role permissions matrix", () => {
	it("exposes only the canonical organization roles", () => {
		expect(CANONICAL_ROLE_ORDER).toEqual([
			"owner",
			"admin",
			"member",
			"viewer",
		]);
		expect(CANONICAL_ROLE_ORDER).not.toContain("platform-admin");
	});

	it("keeps billing authority exclusive to owners", () => {
		expect(getRoleCapabilityLabels("owner")).toContain("Manage billing");
		expect(getRoleCapabilityLabels("admin")).not.toContain("Manage billing");
		expect(getRoleCapabilityLabels("member")).not.toContain("Manage billing");
		expect(getRoleCapabilityLabels("viewer")).not.toContain("Manage billing");
	});

	it("keeps team administration out of member and viewer roles", () => {
		expect(getRoleCapabilityLabels("owner")).toContain("Manage team");
		expect(getRoleCapabilityLabels("admin")).toContain("Manage team");
		expect(getRoleCapabilityLabels("member")).not.toContain("Manage team");
		expect(getRoleCapabilityLabels("viewer")).not.toContain("Manage team");
	});

	/**
	 * The defect this guards against: rendering an 8-boolean
	 * `MemberPermissions` model from the API contract that no guard evaluates,
	 * which could advertise access the API denies. These assertions tie the
	 * rendered labels to `ROLE_PERMISSION_GRANTS`, the map the guards read, so
	 * reintroducing any parallel model fails here.
	 */
	it("renders exactly what the canonical grants say, for every role", () => {
		for (const role of CANONICAL_ROLE_ORDER) {
			const expected = ROLE_PERMISSION_GRANTS[role]
				.map((permission) => PERMISSION_METADATA[permission].label)
				.sort();
			expect(getRoleCapabilityLabels(role).sort()).toEqual(expected);
		}
	});

	it("never advertises a capability a role does not hold", () => {
		// `member` is the role the old boolean model over-promised on.
		const memberLabels = getRoleCapabilityLabels("member");
		for (const permission of [
			"apps:create",
			"apps:update",
			"tedis:create",
		] as const) {
			expect(ROLE_PERMISSION_GRANTS.member).not.toContain(permission);
			expect(memberLabels).not.toContain(PERMISSION_METADATA[permission].label);
		}
	});
});
