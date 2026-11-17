import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { getWorkItemById, listWorkItemsPage } from "./crud";

const OWNER_LIST = "idx_work_items_owner_list";

function fixture(productionLikeStatistics: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, title, disposition, accountable_owner_type, accountable_owner_id, admission_spec_revision, created_at, updated_at) VALUES (?, ?, 'Example', ?, ?, ?, 'spec-example', ?, ?)",
	);
	// The organization's dominant owner holds almost every accepted item.
	for (let i = 0; i < 400; i++) {
		const at = `2026-11-0${1 + (i % 9)}T10:${String(i % 60).padStart(2, "0")}:00.000Z`;
		insert.run(
			`dominant-${i}`,
			"org-example",
			"accepted",
			"user",
			"grace",
			at,
			at,
		);
	}
	for (const [id, org, disposition, type, owner, at] of [
		["old", "org-example", "accepted", "user", "ada", "2026-10-01T00:00:00Z"],
		["tie-a", "org-example", "accepted", "user", "ada", "2026-10-02T00:00:00Z"],
		["tie-b", "org-example", "accepted", "tedi", "ada", "2026-10-02T00:00:00Z"],
		["done", "org-example", "completed", "user", "ada", "2026-10-03T00:00:00Z"],
		["foreign", "org-other", "accepted", "user", "ada", "2026-10-04T00:00:00Z"],
		["unowned", "org-example", "accepted", null, null, "2026-10-05T00:00:00Z"],
	] as const)
		insert.run(id, org, disposition, type, owner, at, at);
	// Production sqlite_stat1 for work_items on 23 Oct 2026, as in
	// apps/api commitment-wakes.test.ts. A new index has no row there until
	// the database is analysed again, which is the state the planner is in
	// right after the migration.
	if (productionLikeStatistics)
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'work_items';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_items','idx_work_items_org_objective','22796 94 94'),
				('work_items','uniq_work_items_org_id','22796 94 1'),
				('work_items','idx_work_items_org_disposition','22796 94 47'),
				('work_items','idx_work_items_accountable_owner','22796 94 63 63'),
				('work_items','idx_work_items_org_created','22796 94 1'),
				('work_approval_proposals','idx_work_approval_resolved','3000 1');
			ANALYZE sqlite_schema;`);
	const plans: string[] = [];
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail))
			.join(" | ");
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('from "work_items"')) plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { db, plans, explain };
}

describe.each([
	{ statistics: "no statistics", productionLike: false },
	{ statistics: "production-like statistics", productionLike: true },
])("owner-filtered Work list with $statistics", ({ productionLike }) => {
	it("lists one owner's Work newest first without reading the organization's other items", async () => {
		const { db, plans } = fixture(productionLike);
		const page = await listWorkItemsPage(db, {
			orgId: "org-example",
			disposition: "accepted",
			accountableOwnerId: "ada",
			limit: 50,
		});
		// Either owner type, this organization and disposition only, id breaks ties.
		expect(page.data.map((row) => row.id)).toEqual(["tie-b", "tie-a", "old"]);
		expect(page.total).toBe(3);
		// The page walks the owner's rows in order, with no sort; the count
		// reads the index alone.
		expect(plans).toEqual([
			`SEARCH work_items USING INDEX ${OWNER_LIST} (org_id=? AND accountable_owner_id=? AND disposition=?)`,
			`SEARCH work_items USING COVERING INDEX ${OWNER_LIST} (org_id=? AND accountable_owner_id=? AND disposition=?)`,
		]);
	});

	it("is not offered to lookups that do not name the owner", async () => {
		const { db, plans, explain } = fixture(productionLike);
		// The join that walked the organization when the same columns were
		// indexed without the WHERE: a Work Item by organization and id, read
		// for its disposition (the approvals branch of listCommitmentChanges).
		expect(
			explain(`SELECT p.id, w.disposition, w.accountable_owner_id, w.created_at
				FROM work_approval_proposals p
				JOIN work_items w ON w.id = p.work_item_id AND w.org_id = p.org_id
				WHERE p.resolved_at > ? AND p.resolved_at <= ?
					AND w.disposition NOT IN ('completed', 'cancelled')`),
		).toMatch(
			/SEARCH w USING INDEX uniq_work_items_org_id \(org_id=\? AND id=\?\)/,
		);
		// SQLite refuses a partial index whose condition the query does not
		// imply, so this cannot change with the statistics.
		expect(() =>
			explain(
				`SELECT disposition FROM work_items INDEXED BY ${OWNER_LIST} WHERE org_id = ? AND id = ?`,
			),
		).toThrow(/no query solution/);
		expect(() =>
			explain(
				`SELECT id FROM work_items INDEXED BY ${OWNER_LIST} WHERE org_id = ? AND disposition = ? ORDER BY created_at DESC`,
			),
		).toThrow(/no query solution/);

		// The same list without an owner, and one item by id, keep their plans.
		await listWorkItemsPage(db, {
			orgId: "org-example",
			disposition: "accepted",
			limit: 50,
		});
		await getWorkItemById(db, "old", "org-example");
		expect(plans.length).toBeGreaterThan(0);
		for (const plan of plans) expect(plan).not.toContain(OWNER_LIST);
	});
});
