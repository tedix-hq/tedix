import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { MEMORY_FACT_ORG_COUNT_TRIGGERS } from "../schema/memory-graph";
import { WORK_ITEM_ORG_COUNT_TRIGGERS } from "../schema/work-items";
import { tenantStoreMigrations } from "../tenant-store/migrations";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { getMigratedSqliteTemplate } from "../test/migrated-sqlite-template";
import { getGraphProjectionCanonicalManagedCounts } from "./graph-projection-health";
import { listWorkItemsPage } from "./work-items/crud";

const MIGRATION = "_maintained_work_and_fact_org_totals";
const AT = "2026-11-17T12:00:00.000Z";

// Prepare the unchanged historical prefix outside the timed backfill test.
getMigratedSqliteTemplate({
	beforeMigration: `20261117143707${MIGRATION}`,
});

const workItem = (id: string, org: string, disposition = "accepted") =>
	`INSERT INTO work_items (id, org_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES ('${id}', '${org}', 'Example ${id}', '${disposition}', 'spec-example', '${AT}', '${AT}');`;
const fact = (id: string, org: string) =>
	`INSERT INTO memory_facts (id, organization_id, content, fact_type) VALUES ('${id}', '${org}', 'Example ${id}', 'technical');`;

/** Rows that exist before the migration runs, for its backfill to count. */
const BEFORE = `INSERT INTO organizations (id, name, slug) VALUES
		('org-a', 'Orchard', 'orchard'), ('org-b', 'Forest', 'forest'), ('org-empty', 'Meadow', 'meadow');
	${workItem("a-1", "org-a")}${workItem("a-2", "org-a", "completed")}${workItem("a-3", "org-a", "proposed")}
	${workItem("b-1", "org-b")}
	${fact("fa-1", "org-a")}${fact("fa-2", "org-a")}
	${fact("fb-1", "org-b")}${fact("fb-2", "org-b")}${fact("fb-3", "org-b")}`;

function fixture() {
	const sqlite = createMigratedSqlite({
		transformMigration: (sql, name) =>
			name.endsWith(MIGRATION) ? `${BEFORE}\n${sql}` : sql,
	});
	const statements: string[] = [];
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				statements.push(query);
			},
		}),
	);
	return { sqlite, db, statements };
}

/** What the reads returned before the totals were maintained. */
const counted = (sqlite: DatabaseSync, table: string, column: string) =>
	Object.fromEntries(
		(
			sqlite
				.prepare(
					`SELECT o.id AS org, (SELECT count(*) FROM ${table} t WHERE t.${column} = o.id) AS total FROM organizations o ORDER BY o.id`,
				)
				.all() as Array<{ org: string; total: number }>
		).map((row) => [row.org, Number(row.total)]),
	);
const stored = (sqlite: DatabaseSync, table: string, column: string) =>
	Object.fromEntries(
		(
			sqlite
				.prepare(`SELECT ${column} AS org, total FROM ${table}`)
				.all() as Array<{ org: string; total: number }>
		).map((row) => [row.org, Number(row.total)]),
	);

const explain = (sqlite: DatabaseSync, query: string) =>
	sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail));

describe("maintained Work Item totals", () => {
	it("backfills, then follows inserts, ignored duplicates, updates, moves and deletes", async () => {
		const { sqlite, db } = fixture();
		const total = async (orgId: string) =>
			(await listWorkItemsPage(db, { orgId, limit: 1 })).total;
		/** The list total equals a count of the rows, organization by organization. */
		const exact = async () => {
			const counts = counted(sqlite, "work_items", "org_id");
			for (const [org, rows] of Object.entries(counts))
				expect(await total(org), org).toBe(rows);
			expect(await total("org-unknown")).toBe(0);
			return counts;
		};
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 1, "org-empty": 0 });
		// The backfill wrote no row for an organization without Work.
		expect(stored(sqlite, "work_item_org_counts", "org_id")).toEqual({
			"org-a": 3,
			"org-b": 1,
		});

		sqlite.exec(workItem("a-4", "org-a") + workItem("e-1", "org-empty"));
		sqlite.exec(workItem("a-4", "org-a").replace("INSERT", "INSERT OR IGNORE"));
		expect(await exact()).toEqual({ "org-a": 4, "org-b": 1, "org-empty": 1 });

		sqlite.exec(
			"UPDATE work_items SET disposition = 'completed', title = 'Renamed' WHERE id = 'a-1'",
		);
		expect(await exact()).toEqual({ "org-a": 4, "org-b": 1, "org-empty": 1 });

		// A move between organizations leaves one total and joins the other.
		sqlite.exec("UPDATE work_items SET org_id = 'org-b' WHERE id = 'a-4'");
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 2, "org-empty": 1 });
		sqlite.exec("UPDATE work_items SET org_id = 'org-b' WHERE id = 'a-4'");
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 2, "org-empty": 1 });

		sqlite.exec("DELETE FROM work_items WHERE id IN ('a-2', 'e-1')");
		expect(await exact()).toEqual({ "org-a": 2, "org-b": 2, "org-empty": 0 });

		// Deleting an organization removes its Work by cascade and its total.
		sqlite.exec("DELETE FROM organizations WHERE id = 'org-b'");
		expect(await exact()).toEqual({ "org-a": 2, "org-empty": 0 });
		expect(stored(sqlite, "work_item_org_counts", "org_id")).toEqual({
			"org-a": 2,
			"org-empty": 0,
		});
	});

	it("reads one row for the unfiltered list and still counts a filtered one", async () => {
		const { sqlite, db, statements } = fixture();
		statements.length = 0;
		expect(
			(await listWorkItemsPage(db, { orgId: "org-a", limit: 2 })).total,
		).toBe(3);
		// The page, then its total: two statements, one of them on Work Items.
		expect(statements).toHaveLength(2);
		expect(
			statements.filter((query) => query.includes('from "work_items"')),
		).toHaveLength(1);
		expect(explain(sqlite, statements[1]!)).toEqual([
			"SEARCH work_item_org_counts USING INDEX sqlite_autoindex_work_item_org_counts_1 (org_id=?)",
		]);

		// Every filter keeps its exact count over the filtered rows.
		for (const [options, rows] of [
			[{ disposition: "accepted" }, 1],
			[{ excludeDisposition: "completed" }, 2],
			[{ titleContains: "A-3" }, 1],
			[{ idPrefix: "a-" }, 3],
			[{ projectId: null }, 3],
			[{ objectiveLinked: false }, 3],
			[{ accountableOwnerId: "nobody" }, 0],
		] as const) {
			statements.length = 0;
			expect(
				(await listWorkItemsPage(db, { orgId: "org-a", ...options })).total,
				JSON.stringify(options),
			).toBe(rows);
			expect(
				statements.filter((query) => query.includes("work_item_org_counts")),
				JSON.stringify(options),
			).toEqual([]);
			expect(
				statements.some((query) =>
					query.startsWith('select count(*) from "work_items"'),
				),
				JSON.stringify(options),
			).toBe(true);
		}
	});
});

describe("maintained memory fact totals", () => {
	it("backfills, then follows inserts, ignored duplicates, updates and deletes", async () => {
		const { sqlite, db, statements } = fixture();
		const total = async (orgId: string) =>
			(await getGraphProjectionCanonicalManagedCounts(db, orgId)).facts;
		const exact = async () => {
			const counts = counted(sqlite, "memory_facts", "organization_id");
			for (const [org, rows] of Object.entries(counts))
				expect(await total(org), org).toBe(rows);
			expect(await total("org-unknown")).toBe(0);
			return counts;
		};
		expect(await exact()).toEqual({ "org-a": 2, "org-b": 3, "org-empty": 0 });

		sqlite.exec(fact("fa-3", "org-a") + fact("fe-1", "org-empty"));
		sqlite.exec(fact("fa-3", "org-a").replace("INSERT", "INSERT OR IGNORE"));
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 3, "org-empty": 1 });

		sqlite.exec(
			"UPDATE memory_facts SET content = 'Changed', archived_at = '2026-11-17' WHERE id = 'fa-1'",
		);
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 3, "org-empty": 1 });

		sqlite.exec("DELETE FROM memory_facts WHERE id IN ('fb-1', 'fe-1')");
		expect(await exact()).toEqual({ "org-a": 3, "org-b": 2, "org-empty": 0 });

		sqlite.exec("DELETE FROM organizations WHERE id = 'org-b'");
		expect(await exact()).toEqual({ "org-a": 3, "org-empty": 0 });
		expect(stored(sqlite, "memory_fact_org_counts", "organization_id")).toEqual(
			{ "org-a": 3, "org-empty": 0 },
		);

		// The check reads the total's one row and never the facts themselves.
		const reads = statements.filter((query) =>
			query.includes('"memory_fact_org_counts"'),
		);
		expect(explain(sqlite, reads[0]!)).toEqual([
			"SEARCH memory_fact_org_counts USING INDEX sqlite_autoindex_memory_fact_org_counts_1 (organization_id=?)",
		]);
		expect(
			statements.filter((query) =>
				/^select count\(\*\) from "memory_facts" where "memory_facts"\."organization_id" = \?$/.test(
					query,
				),
			),
		).toEqual([]);
	});
});

describe("maintained memory fact totals in a workspace store", () => {
	it("backfills the store's facts and follows inserts and deletes", () => {
		const store = new DatabaseSync(":memory:");
		store.exec("PRAGMA foreign_keys=ON");
		const names = Object.keys(tenantStoreMigrations);
		const totals = names.findIndex((name) =>
			name.endsWith("_memory_fact_org_totals"),
		);
		expect(totals).toBeGreaterThan(0);
		const apply = (from: number, to: number) => {
			for (const name of names.slice(from, to))
				store.exec((tenantStoreMigrations as Record<string, string>)[name]!);
		};
		const total = () =>
			stored(store, "memory_fact_org_counts", "organization_id");
		// A store that already holds facts when the migration reaches it.
		apply(0, totals);
		store.exec(
			"INSERT INTO memory_store_identity VALUES (1,'org-a','organization','org-a','2026-11-08')",
		);
		store.exec(fact("fa-1", "org-a") + fact("fa-2", "org-a"));
		apply(totals, names.length);
		expect(total()).toEqual({ "org-a": 2 });
		store.exec(fact("fa-3", "org-a"));
		store.exec(fact("fa-3", "org-a").replace("INSERT", "INSERT OR IGNORE"));
		store.exec("UPDATE memory_facts SET content = 'Changed' WHERE id = 'fa-1'");
		expect(total()).toEqual({ "org-a": 3 });
		store.exec("DELETE FROM memory_facts WHERE id IN ('fa-1', 'fa-2')");
		expect(total()).toEqual({ "org-a": 1 });
		expect(
			(
				store.prepare("SELECT count(*) AS n FROM memory_facts").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		store.close();
	});
});

describe("maintained total triggers", () => {
	it("are in the migrated database as the schema states them", () => {
		const sqlite = createMigratedSqlite();
		const normalize = (sql: string) =>
			sql.replace(/\s+/g, " ").replace(/;$/, "").trim();
		const migrated = (table: string) =>
			(
				sqlite
					.prepare(
						"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
					)
					.all(`${table}_%`) as Array<{ sql: string }>
			).map((row) => normalize(row.sql));
		for (const [table, triggers] of [
			["work_item_org_counts", WORK_ITEM_ORG_COUNT_TRIGGERS],
			["memory_fact_org_counts", MEMORY_FACT_ORG_COUNT_TRIGGERS],
		] as const)
			expect(migrated(table), table).toEqual(
				triggers.map(normalize).toSorted(),
			);
	});
});
