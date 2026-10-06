import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { acceptInvite, inviteMember } from "./organization-members";

const ORG = "org-invites";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	const db = createDbClient(createD1Facade(sqlite));
	return { db, sqlite };
}

async function seedOrganization(db: ReturnType<typeof setup>["db"]) {
	await db.insert(organizations).values({
		id: ORG,
		name: "Invitation test organization",
		slug: "invitation-test-organization",
		createdAt: "2026-08-21T00:00:00.000Z",
		updatedAt: "2026-08-21T00:00:00.000Z",
	});
}

describe("inviteMember", () => {
	it("creates independent pending identities for different invitees", async () => {
		const { db } = setup();
		await seedOrganization(db);

		const first = await inviteMember(db, ORG, "first@example.com");
		const second = await inviteMember(db, ORG, "second@example.com");

		expect(first.status).toBe("invited");
		expect(second.status).toBe("invited");
		expect(first.descopeUserId).toBe(`pending:${first.id}`);
		expect(second.descopeUserId).toBe(`pending:${second.id}`);
		expect(second.descopeUserId).not.toBe(first.descopeUserId);
	});

	it("replaces the pending identity with the verified provider subject on acceptance", async () => {
		const { db } = setup();
		await seedOrganization(db);

		const invitation = await inviteMember(db, ORG, "accept@example.com");
		const accepted = await acceptInvite(
			db,
			invitation.id,
			"U-verified-subject",
		);

		expect(accepted.status).toBe("active");
		expect(accepted.descopeUserId).toBe("U-verified-subject");
	});
});
