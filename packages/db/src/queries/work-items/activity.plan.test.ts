import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkActivity } from "./activity";

it("reads a project's feed newest first and stops at the page, not every project event", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const old = "2026-10-01T12:00:00.000Z";
	const item = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, project_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES (?, 'org-example', ?, 'Example', 'accepted', 'spec-example', ?, ?)",
	);
	item.run("busy", "project-busy", old, old);
	item.run("quiet", "project-quiet", old, old);
	const event = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, 'org-example', ?, 'comment', 'system', 'tedix', '{}', ?)",
	);
	for (let i = 0; i < 3000; i++)
		event.run(
			`busy-${i}`,
			"busy",
			`2026-10-${String(2 + (i % 20)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
		);
	event.run("quiet-1", "quiet", "2026-10-30T00:00:00.000Z");
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"work_events"."sequence"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	const page = await listWorkActivity(db as never, {
		orgId: "org-example",
		projectId: "project-busy",
		limit: 50,
	});
	expect(page.events).toHaveLength(50);
	expect(page.truncated).toBe(true);
	expect(plans, plans.join("\n")).not.toHaveLength(0);
	expect(plans[0], plans.join("\n")).toMatch(
		/^SEARCH work_events USING INDEX idx_work_events_org_occurred \(org_id=\?\)/,
	);
	expect(plans.join("\n")).not.toContain("TEMP B-TREE");
});
