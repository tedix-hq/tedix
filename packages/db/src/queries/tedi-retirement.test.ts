/**
 * Tedi retirement — real-SQLite lifecycle.
 *
 * `DELETE FROM tedis` cascades into 48 first-order tediId-scoped tables, which
 * includes every category the customer owns: memory
 * facts, rationale records, artifacts, skills, expertise, growth snapshots.
 * `retireTedi` is the non-destructive replacement on the ordinary delete path.
 *
 * These tests run against DDL derived from the production Drizzle tables
 * (`schemaDdl`) with `PRAGMA foreign_keys = ON`, so the cascade edges under
 * test are the real ones — a hand-written CREATE TABLE that forgot
 * `ON DELETE CASCADE` would make the central assertion vacuous.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { organizations } from "../schema/organizations";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	deleteTedi,
	getTediById,
	getTediByGlobalSlug,
	getTedisByOrganization,
	listRetiredTedisByOrganization,
	retireTedi,
} from "./tedis";

const RETIRED_AT = "2026-08-16T12:00:00.000Z";

function setup(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(
		schemaDdl(
			organizations,
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

async function seed(
	db: DbClient,
	options: { isolateAgentId?: string } = {},
): Promise<void> {
	await db.insert(organizations).values({
		id: "org-1",
		name: "Acme",
		slug: "acme",
	});
	await db.insert(tedis).values({
		id: "tedi-1",
		organizationId: "org-1",
		name: "CTO",
		slug: "cto",
		...(options.isolateAgentId === undefined
			? {}
			: { isolateAgentId: options.isolateAgentId }),
	});
	// Two memory rows: one tedi-scoped, one org-wide (tediId null). Both must
	// survive retirement; only the tedi-scoped one is at risk from the cascade.
	await db.insert(memoryFacts).values([
		{
			id: "fact-tedi",
			organizationId: "org-1",
			tediId: "tedi-1",
			content: "The invoice importer chokes on BOM-prefixed CSV.",
			factType: "pattern",
		},
		{
			id: "fact-org",
			organizationId: "org-1",
			tediId: null,
			content: "Acme bills in MXN.",
			factType: "strategic",
		},
	]);
	await db.insert(tediRationaleRecords).values({
		id: "rationale-1",
		tediId: "tedi-1",
		orgId: "org-1",
		action: "deploy",
		rationale: "Shipping the hotfix beat waiting for the nightly window.",
		// `schemaDdl` deliberately omits SQL-expression defaults, so NOT NULL
		// columns backed by CURRENT_TIMESTAMP must be supplied here.
		createdAt: "2026-08-01T00:00:00.000Z",
	});
}

describe("retireTedi — memory retention", () => {
	it("keeps tedi-scoped memory and rationale that a delete would cascade away", async () => {
		const { db } = setup();
		await seed(db);

		const retired = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});

		expect(retired?.retiredAt).toBe(RETIRED_AT);
		expect(await db.select().from(memoryFacts)).toHaveLength(2);
		expect(await db.select().from(tediRationaleRecords)).toHaveLength(1);
	});

	it("proves the cascade this replaces is real: deleteTedi still destroys both", async () => {
		// Without this, the assertion above could pass against a schema whose FKs
		// were never CASCADE, and the retirement would be protecting nothing.
		const { db } = setup();
		await seed(db);

		await deleteTedi(db, "tedi-1");

		const facts = await db.select().from(memoryFacts);
		expect(facts.map((fact) => fact.id)).toEqual(["fact-org"]);
		expect(await db.select().from(tediRationaleRecords)).toHaveLength(0);
	});
});

describe("retireTedi — identity handling", () => {
	it("frees the slug for a replacement worker and preserves the original", async () => {
		const { db } = setup();
		await seed(db);

		const retired = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});

		expect(retired?.retiredSlug).toBe("cto");
		expect(retired?.slug).toBe("cto-retired-tedi-1");

		// `uniq_tedi_slug` / `uniq_tedi_org_slug` are permanent, so this insert is
		// the real proof the name was released.
		await db.insert(tedis).values({
			id: "tedi-2",
			organizationId: "org-1",
			name: "CTO",
			slug: "cto",
		});
		expect((await getTediByGlobalSlug(db, "cto"))?.id).toBe("tedi-2");
	});

	it("pins the Durable Object instance name before renaming the slug", async () => {
		// `getTediAgentIdBySlug` derives the DO name as
		// coalesce(isolate_agent_id, slug). Renaming the slug without pinning
		// would silently repoint the retired worker at a different, empty DO.
		const { db } = setup();
		await seed(db);

		const retired = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});

		expect(retired?.isolateAgentId).toBe("cto");
	});

	it("does not overwrite an explicit isolateAgentId", async () => {
		const { db } = setup();
		await seed(db, { isolateAgentId: "explicit-agent" });

		const retired = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});

		expect(retired?.isolateAgentId).toBe("explicit-agent");
	});

	it("parks the runtime at the reversible decommission posture", async () => {
		const { db } = setup();
		await seed(db);

		const retired = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});

		expect(retired?.status).toBe("paused");
		expect(retired?.runtimeState).toBe("archived");
	});
});

describe("retireTedi — compare-and-swap", () => {
	it("returns undefined on a second retire instead of restamping or re-renaming", async () => {
		const { db } = setup();
		await seed(db);

		const first = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: RETIRED_AT,
		});
		const second = await retireTedi(db, {
			tediId: "tedi-1",
			retiredAt: "2026-09-09T09:09:09.000Z",
		});

		expect(first?.slug).toBe("cto-retired-tedi-1");
		expect(second).toBeUndefined();

		const row = await getTediById(db, "tedi-1");
		expect(row?.retiredAt).toBe(RETIRED_AT);
		expect(row?.retiredSlug).toBe("cto");
		expect(row?.slug).toBe("cto-retired-tedi-1");
	});

	it("returns undefined for an unknown tedi", async () => {
		const { db } = setup();
		await seed(db);

		expect(
			await retireTedi(db, { tediId: "missing", retiredAt: RETIRED_AT }),
		).toBeUndefined();
	});
});

describe("retired tedis are readable but not live", () => {
	it("drops out of the org's live list and into the retired list", async () => {
		const { db } = setup();
		await seed(db);
		await retireTedi(db, { tediId: "tedi-1", retiredAt: RETIRED_AT });

		expect(await getTedisByOrganization(db, "org-1")).toEqual([]);

		const retiredList = await listRetiredTedisByOrganization(db, "org-1");
		expect(retiredList.map((row) => row.id)).toEqual(["tedi-1"]);
		expect(retiredList[0]?.retiredSlug).toBe("cto");
	});

	it("stays in the live list when includeRetired is set", async () => {
		const { db } = setup();
		await seed(db);
		await retireTedi(db, { tediId: "tedi-1", retiredAt: RETIRED_AT });

		const all = await getTedisByOrganization(db, "org-1", {
			includeRetired: true,
		});
		expect(all.map((row) => row.id)).toEqual(["tedi-1"]);
	});

	it("still resolves by id, so its retained memory stays reachable", async () => {
		const { db } = setup();
		await seed(db);
		await retireTedi(db, { tediId: "tedi-1", retiredAt: RETIRED_AT });

		const row = await getTediById(db, "tedi-1");
		expect(row?.id).toBe("tedi-1");

		const facts = await db.select().from(memoryFacts);
		expect(facts.some((fact) => fact.tediId === "tedi-1")).toBe(true);
	});

	it("cannot be routed to by its renamed slug", async () => {
		const { db } = setup();
		await seed(db);
		await retireTedi(db, { tediId: "tedi-1", retiredAt: RETIRED_AT });

		expect(await getTediByGlobalSlug(db, "cto")).toBeUndefined();
		expect(await getTediByGlobalSlug(db, "cto-retired-tedi-1")).toBeUndefined();
	});

	it("orders the retired list newest retirement first", async () => {
		const { db } = setup();
		await seed(db);
		await db.insert(tedis).values({
			id: "tedi-2",
			organizationId: "org-1",
			name: "CFO",
			slug: "cfo",
		});

		await retireTedi(db, { tediId: "tedi-1", retiredAt: RETIRED_AT });
		await retireTedi(db, {
			tediId: "tedi-2",
			retiredAt: "2026-08-17T12:00:00.000Z",
		});

		expect(
			(await listRetiredTedisByOrganization(db, "org-1")).map((row) => row.id),
		).toEqual(["tedi-2", "tedi-1"]);
	});
});
