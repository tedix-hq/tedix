import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkActivity } from "./activity";

for (const scope of ["project", "objective"] as const) {
	for (const sparse of [true, false]) {
		it(`seeks ${sparse ? "sparse" : "dense"} ${scope} history and polling pages without sorting`, async () => {
			const sqlite = createMigratedSqlite({ foreignKeys: false });
			const old = "2026-10-01T12:00:00.000Z";
			const item = sqlite.prepare(
				"INSERT INTO work_items (id, org_id, project_id, objective_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'Example', 'accepted', 'spec-example', ?, ?)",
			);
			item.run(
				"target",
				"org-example",
				"project-target",
				"objective-target",
				old,
				old,
			);
			item.run(
				"busy",
				"org-example",
				"project-busy",
				"objective-busy",
				old,
				old,
			);
			item.run(
				"foreign",
				"org-foreign",
				"project-target",
				"objective-target",
				old,
				old,
			);
			const event = sqlite.prepare(
				"INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, ?, ?, 'comment', 'system', 'tedix', '{}', ?)",
			);
			const count = sparse ? 130 : 3000;
			for (let i = 0; i < count; i++)
				event.run(
					`target-${String(i).padStart(5, "0")}`,
					"org-example",
					"target",
					old,
				);
			// Every unrelated event is newer, so an org-first scan must walk them all.
			for (let i = 0; i < 6000; i++)
				event.run(
					`busy-${i}`,
					"org-example",
					"busy",
					"2026-10-30T00:00:00.000Z",
				);
			event.run(
				"foreign-event",
				"org-foreign",
				"foreign",
				"2026-10-31T00:00:00.000Z",
			);
			const plans: string[][] = [];
			const db = createDbQueryClient(
				createD1Facade({
					prepare(query) {
						if (query.includes('"work_events"."sequence"'))
							plans.push(
								sqlite
									.prepare(`EXPLAIN QUERY PLAN ${query}`)
									.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
									.map((row) => String(row.detail)),
							);
						return sqlite.prepare(query);
					},
					exec: (query) => sqlite.exec(query),
				}) as never,
			);
			const params = {
				orgId: "org-example",
				...(scope === "project"
					? { projectId: "project-target" }
					: { objectiveId: "objective-target" }),
				limit: 50,
			};
			const first = await listWorkActivity(db as never, params);
			const second = await listWorkActivity(db as never, {
				...params,
				cursor: first.nextCursor!,
			});
			expect(first.events).toHaveLength(50);
			expect(second.events).toHaveLength(50);
			expect(first.events[0]?.id).toBe(
				`target-${String(count - 1).padStart(5, "0")}`,
			);
			expect(second.events[0]?.id).toBe(
				`target-${String(count - 51).padStart(5, "0")}`,
			);
			expect(
				new Set([...first.events, ...second.events].map((e) => e.id)).size,
			).toBe(100);
			const forward = await listWorkActivity(db as never, {
				...params,
				afterSequence: count - 60,
			});
			expect(forward.events).toHaveLength(50);
			expect(forward.nextSequence).toBe(count - 10);
			expect(plans).toHaveLength(3);
			for (const [i, plan] of plans.entries()) {
				expect(plan[0], plan.join("\n")).toContain(
					`SEARCH work_events USING INDEX idx_work_events_${scope}_${i === 2 ? "sequence" : "occurred"} (org_id=? AND ${scope}_id=?`,
				);
				expect(plan.join("\n")).not.toContain("TEMP B-TREE");
			}
			// Continuations must seek time/sequence too, not restart at the scope head.
			expect(plans[1]?.[0]).toContain("(occurred_at,id)<(?,?)");
			expect(plans[2]?.[0]).toContain("sequence>?");
		});
	}
}
