/**
 * Guards the duplicate-output-column hazard on D1.
 *
 * A no-argument `.select()` across a join emits both tables' raw column names,
 * so every name the two tables share appears twice in the result set. D1 returns
 * one object per row and Drizzle rebuilds the positional array with
 * `Object.keys(row).map((k) => row[k])` — `d1ToRawMapping` in the D1 driver,
 * which carries an upstream comment warning about this exact case. Duplicate
 * keys collapse, every subsequent column shifts left, and rows decode into the
 * wrong fields with no error anywhere.
 *
 * `getPersonalOrganization` used to return an organization whose `id` was the
 * membership row's id and whose `name` was the member's display name. It is
 * called from the oRPC organization-resolution path, so the corrupted id flowed
 * into org-scoped authorization.
 *
 * The first test pins the underlying mechanism so the hazard stays visible; the
 * rest pin the two call sites that had it.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getPersonalOrganization } from "./organizations";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("duplicate output columns across a join", () => {
	it("collapses duplicate column names, which is why star selects are unsafe", () => {
		// The primitive behind the bug: SQLite — like D1 — returns one object per
		// row, so two columns named `id` cannot both survive.
		const sqlite = new DatabaseSync(":memory:");
		const row = sqlite
			.prepare("SELECT 1 AS id, 'a' AS name, 2 AS id, 'b' AS name")
			.get() as Record<string, unknown>;

		expect(Object.keys(row)).toEqual(["id", "name"]);
		expect(row.id).toBe(2);
		expect(row.name).toBe("b");
	});

	it("getPersonalOrganization returns the organization, not the membership row", async () => {
		const { db } = setup();

		await db.insert(organizations).values({
			id: "org-real-id",
			name: "Real Org Name",
			slug: "real-org",
			type: "personal",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await db.insert(organizationMembers).values({
			id: "member-row-id",
			organizationId: "org-real-id",
			descopeUserId: "U-ada",
			email: "member@example.com",
			name: "Member Display Name",
			role: "owner",
			createdAt: LATER,
			updatedAt: LATER,
		});

		const org = await getPersonalOrganization(db, "U-ada");

		// Every one of these four fields decoded from the wrong table before the
		// fix: `organizations` and `organization_members` share all of them.
		expect(org?.id).toBe("org-real-id");
		expect(org?.name).toBe("Real Org Name");
		expect(org?.createdAt).toBe(NOW);
		expect(org?.updatedAt).toBe(NOW);
		expect(org?.slug).toBe("real-org");
	});

	it("does not match a personal organization the user is not a member of", async () => {
		const { db } = setup();

		await db.insert(organizations).values({
			id: "org-other",
			name: "Someone Else",
			slug: "someone-else",
			type: "personal",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await db.insert(organizationMembers).values({
			id: "member-other",
			organizationId: "org-other",
			descopeUserId: "U-other",
			email: "other@example.com",
			name: "Other",
			role: "owner",
			createdAt: NOW,
			updatedAt: NOW,
		});

		expect(await getPersonalOrganization(db, "U-ada")).toBeUndefined();
	});

	it("does not match a non-personal organization the user belongs to", async () => {
		const { db } = setup();

		await db.insert(organizations).values({
			id: "org-team",
			name: "Team Org",
			slug: "team-org",
			type: "team",
			createdAt: NOW,
			updatedAt: NOW,
		});
		await db.insert(organizationMembers).values({
			id: "member-team",
			organizationId: "org-team",
			descopeUserId: "U-ada",
			email: "ada@example.com",
			name: "Ada",
			role: "owner",
			createdAt: NOW,
			updatedAt: NOW,
		});

		expect(await getPersonalOrganization(db, "U-ada")).toBeUndefined();
	});
});
