import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listTediLaneSources } from "./work-agent-sessions";

it("reads tedi lane costs by run instead of the tenant's whole cost history", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission fencing is not under test; this fixture only needs one tedi Attempt.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const now = "2026-10-10T10:00:00.000Z";
	sqlite
		.prepare(
			"INSERT INTO work_items (id, org_id, title, admission_spec_revision, created_at, updated_at) VALUES ('work', 'org-example', 'Example', 'spec-example', ?, ?)",
		)
		.run(now, now);
	sqlite
		.prepare(
			"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, run_id, started_at, heartbeat_at, expires_at) VALUES ('attempt', 'org-example', 'work', 1, 'tedi', 'tedi-example', 'run-example', ?, ?, ?)",
		)
		.run(now, now, now);
	const cost = sqlite.prepare(
		"INSERT INTO tedi_call_costs (id, tedi_id, org_id, gateway_log_id, gateway_id, model, snapshot_at, run_id) VALUES (?, 'tedi-example', 'org-example', ?, 'gateway', 'model', ?, ?)",
	);
	for (let i = 0; i < 4000; i++)
		cost.run(`noise-${i}`, `noise-${i}`, now, `other-${i % 40}`);
	for (let i = 0; i < 3; i++)
		cost.run(`call-${i}`, `call-${i}`, now, "run-example");
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"tedi_call_costs"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	const { costs } = await listTediLaneSources(
		db,
		"org-example",
		"2026-10-01T00:00:00.000Z",
	);
	expect(costs.map((row) => row.id).sort()).toEqual([
		"call-0",
		"call-1",
		"call-2",
	]);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/^SEARCH tedi_call_costs USING INDEX idx_call_costs_run/,
		),
	);
	sqlite.close();
});
