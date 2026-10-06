/** Organization retirement against real SQLite with foreign keys enabled. */

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { apiKeys } from "../schema/api-keys";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { retireOrganization } from "./organizations";

const RETIRED_AT = "2026-08-20T04:20:00.000Z";

function setup(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			apiKeys,
			appCatalog,
			apps,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			memoryDomains,
			memoryFacts,
			tediRationaleRecords,
		),
	);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

async function seed(db: DbClient): Promise<void> {
	await db.insert(organizations).values({
		id: "org-1",
		name: "Acme",
		slug: "acme",
		features: { os: true },
	});
	await db.insert(organizationMembers).values({
		id: "member-1",
		organizationId: "org-1",
		descopeUserId: "user-1",
		email: "owner@example.com",
		role: "owner",
	});
	await db.insert(apiKeys).values({
		id: "key-1",
		organizationId: "org-1",
		name: "automation",
		keyHash: "hash-1",
		keyPreview: "preview1",
	});
	await db.insert(apps).values({
		id: "app-1",
		organizationId: "org-1",
		name: "Gateway",
		slug: "acme-gateway",
	});
	await db.insert(tedis).values({
		id: "tedi-1",
		organizationId: "org-1",
		name: "CTO",
		slug: "cto",
	});
	await db.insert(memoryFacts).values({
		id: "fact-1",
		organizationId: "org-1",
		tediId: "tedi-1",
		content: "Customer-specific durable knowledge",
		factType: "pattern",
	});
	await db.insert(tediRationaleRecords).values({
		id: "rationale-1",
		tediId: "tedi-1",
		orgId: "org-1",
		action: "retain",
		rationale: "Customer memory must survive offboarding.",
		createdAt: "2026-08-01T00:00:00.000Z",
	});
}

describe("retireOrganization", () => {
	it("retires access surfaces while preserving the organization and tedi memory", async () => {
		const { db } = setup();
		await seed(db);

		const retired = await retireOrganization(db, {
			id: "org-1",
			retiredAt: RETIRED_AT,
			retiredBy: "owner-1",
			features: { os: false },
			metadata: {
				retiredAt: RETIRED_AT,
				retiredSlug: "acme",
				memoryRetained: true,
			},
		});

		expect(retired).toMatchObject({
			slug: "acme-retired-org-1",
			metadata: {
				retiredAt: RETIRED_AT,
				retiredSlug: "acme",
				memoryRetained: true,
			},
		});
		expect(await db.select().from(organizations)).toHaveLength(1);
		expect(await db.select().from(tedis)).toMatchObject([
			{
				retiredAt: RETIRED_AT,
				retiredSlug: "cto",
				slug: "cto-retired-tedi-1",
				status: "paused",
				runtimeState: "archived",
			},
		]);
		expect(await db.select().from(memoryFacts)).toHaveLength(1);
		expect(await db.select().from(tediRationaleRecords)).toHaveLength(1);
		expect(await db.select().from(apiKeys)).toMatchObject([
			{ status: "revoked", revokeReason: "Organization retired" },
		]);
		expect(await db.select().from(apps)).toMatchObject([
			{ visibility: "disabled" },
		]);
		expect(await db.select().from(organizationMembers)).toMatchObject([
			{ status: "deactivated" },
		]);

		await expect(
			db.insert(organizations).values({
				id: "org-2",
				name: "Replacement Acme",
				slug: "acme",
			}),
		).resolves.toBeDefined();
	});

	it("proves the hard-delete cascade being replaced destroys tedi memory", async () => {
		const { db } = setup();
		await seed(db);

		await db.delete(organizations).where(eq(organizations.id, "org-1"));

		expect(await db.select().from(tedis)).toHaveLength(0);
		expect(await db.select().from(memoryFacts)).toHaveLength(0);
		expect(await db.select().from(tediRationaleRecords)).toHaveLength(0);
	});

	it("is compare-and-swap idempotent", async () => {
		const { db } = setup();
		await seed(db);
		const input = {
			id: "org-1",
			retiredAt: RETIRED_AT,
			retiredBy: "owner-1",
			features: { os: false },
			metadata: { retiredAt: RETIRED_AT, memoryRetained: true },
		} as const;

		expect(await retireOrganization(db, input)).toBeDefined();
		expect(await retireOrganization(db, input)).toBeUndefined();
	});
});
