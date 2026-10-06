import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getMembershipsByDescopeTenants } from "./organization-members";

const NOW = "2026-10-06T00:00:00.000Z";

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	const db = createDbClient(createD1Facade(sqlite));
	const org = (id: string, tenant: string, metadata?: unknown) => ({
		id,
		name: id,
		slug: id,
		descopeTenantId: tenant,
		...(metadata ? { metadata } : {}),
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db
		.insert(organizations)
		.values([
			org("org-a", "T_a"),
			org("org-b", "T_b"),
			org("org-retired", "T_retired", { retiredAt: NOW }),
			org("org-other", "T_other"),
		]);
	const member = (
		id: string,
		organizationId: string,
		user: string,
		status: "active" | "deactivated",
	) => ({
		id,
		organizationId,
		descopeUserId: user,
		email: `${id}@example.test`,
		status,
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db
		.insert(organizationMembers)
		.values([
			member("m-a", "org-a", "U1", "active"),
			member("m-b", "org-b", "U1", "deactivated"),
			member("m-retired", "org-retired", "U1", "active"),
			member("m-other-user", "org-other", "U2", "active"),
		]);
	return db;
}

describe("getMembershipsByDescopeTenants", () => {
	it("returns the user's rows for selected live tenants in one query", async () => {
		const db = await setup();

		const rows = await getMembershipsByDescopeTenants(
			db,
			["T_a", "T_b", "T_retired", "T_other", "T_missing"],
			"U1",
		);

		expect(
			rows.sort((left, right) =>
				left.descopeTenantId.localeCompare(right.descopeTenantId),
			),
		).toEqual([
			{ organizationId: "org-a", descopeTenantId: "T_a", status: "active" },
			{
				organizationId: "org-b",
				descopeTenantId: "T_b",
				status: "deactivated",
			},
		]);
	});

	it("returns nothing for an empty selection", async () => {
		const db = await setup();
		expect(await getMembershipsByDescopeTenants(db, [], "U1")).toEqual([]);
	});
});
