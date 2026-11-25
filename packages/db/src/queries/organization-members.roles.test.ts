import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countActiveOwners,
	getMemberById,
	updateMemberRole,
} from "./organization-members";

const ORG = "org-roles";
let sqlite: DatabaseSync;

async function setup() {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{ id: ORG, name: "Role test", slug: "role-test" },
		{ id: "other-org", name: "Other organization", slug: "other-organization" },
	]);
	await db.insert(organizationMembers).values(
		["first", "second"].map((id) => ({
			id,
			organizationId: ORG,
			descopeUserId: id,
			email: `${id}@example.com`,
			role: "owner" as const,
			status: "active" as const,
		})),
	);
	return db;
}

afterEach(() => sqlite?.close());

describe("updateMemberRole", () => {
	it("refuses exactly one concurrent demotion of the last two owners", async () => {
		const db = await setup();
		// Both requests observe two owners before either writes.
		expect(
			await Promise.all([
				countActiveOwners(db, ORG),
				countActiveOwners(db, ORG),
			]),
		).toEqual([2, 2]);

		const results = await Promise.all([
			updateMemberRole(db, ORG, "second", "admin"),
			updateMemberRole(db, ORG, "first", "admin"),
		]);

		expect(results.filter((result) => result === undefined)).toHaveLength(1);
		expect(results.filter((result) => result?.role === "admin")).toHaveLength(
			1,
		);
		expect(await countActiveOwners(db, ORG)).toBe(1);
	});

	it("does not count inactive or foreign owners and preserves ordinary role changes", async () => {
		const db = await setup();
		await db
			.update(organizationMembers)
			.set({ status: "deactivated" })
			.where(eq(organizationMembers.id, "second"));
		await db.insert(organizationMembers).values({
			id: "foreign-owner",
			organizationId: "other-org",
			descopeUserId: "foreign-owner",
			email: "foreign@example.com",
			role: "owner",
			status: "active",
		});

		expect(await updateMemberRole(db, ORG, "first", "viewer")).toBeUndefined();
		expect((await getMemberById(db, "first"))?.role).toBe("owner");
		expect(
			await updateMemberRole(db, ORG, "foreign-owner", "admin"),
		).toBeUndefined();
		expect((await getMemberById(db, "foreign-owner"))?.role).toBe("owner");
		expect((await updateMemberRole(db, ORG, "first", "owner"))?.role).toBe(
			"owner",
		);
		await db.insert(organizationMembers).values({
			id: "member",
			organizationId: ORG,
			descopeUserId: "member",
			email: "member@example.com",
			role: "member",
		});
		expect((await updateMemberRole(db, ORG, "member", "admin"))?.role).toBe(
			"admin",
		);
		expect((await updateMemberRole(db, ORG, "member", "owner"))?.role).toBe(
			"owner",
		);
		expect(await countActiveOwners(db, ORG)).toBe(2);
	});
});
