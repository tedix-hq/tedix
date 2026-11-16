import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkItemsPage } from "./crud";

it("lists one owner's Work newest first without reading the organization's other items", async () => {
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
	] as const)
		insert.run(id, org, disposition, type, owner, at, at);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('from "work_items"'))
					plans.push(
						sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail))
							.join(" | "),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);

	const page = await listWorkItemsPage(db, {
		orgId: "org-example",
		disposition: "accepted",
		accountableOwnerId: "ada",
		limit: 50,
	});

	// Either owner type, this organization and disposition only, id breaks ties.
	expect(page.data.map((row) => row.id)).toEqual(["tie-b", "tie-a", "old"]);
	expect(page.total).toBe(3);
	// The page walks the owner's rows in order; the count reads the index alone.
	expect(plans).toEqual([
		"SEARCH work_items USING INDEX idx_work_items_org_owner_disposition_created (org_id=? AND accountable_owner_id=? AND disposition=?)",
		"SEARCH work_items USING COVERING INDEX idx_work_items_org_owner_disposition_created (org_id=? AND accountable_owner_id=? AND disposition=?)",
	]);
});
