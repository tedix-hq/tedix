import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { notifyStoppedLanes } from "./lane-lifecycle";

it("reads stopped lanes from the partial index, not once per agent principal", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission fencing is not under test; these fixtures only need Attempts.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const at = "2026-10-17T12:00:00.000Z";
	sqlite
		.prepare(
			"INSERT INTO work_items (id, org_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES ('item', 'org-example', 'Example', 'accepted', 'spec-example', ?, ?)",
		)
		.run(at, at);
	const principal = sqlite.prepare(
		"INSERT INTO external_agent_principals (id, organization_id, key, display_name, credential_binding_type, credential_binding_id, created_by_type, created_by_id, created_at, updated_at) VALUES (?, 'org-example', ?, 'Worker', 'owner_user', ?, 'user', 'user-example', ?, ?)",
	);
	for (let i = 0; i < 300; i++)
		principal.run(`agent-${i}`, `agent-${i}`, `user-${i}`, at, at);
	sqlite
		.prepare(
			"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, executor_session_id, started_at, heartbeat_at, expires_at, metadata) VALUES ('attempt', 'org-example', 'item', 1, 'external_agent', 'agent-0', 'session-example', ?, ?, ?, '{\"lane\":true}')",
		)
		.run(at, at, at);
	const event = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, attempt_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, 'org-example', 'item', 'attempt', ?, 'system', 'tedix', ?, ?)",
	);
	for (let i = 0; i < 2000; i++) event.run(`noise-${i}`, "comment", "{}", at);
	event.run("stopped", "attempt.expired", "{}", at);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("repair_target_type"))
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
	await notifyStoppedLanes(db, at);
	expect(plans[0]).toMatch(
		/^SCAN work_events USING INDEX idx_work_events_stopped_lane_sequence/,
	);
	expect(
		plans.some((plan) => plan.startsWith("SCAN external_agent_principals")),
	).toBe(false);
	sqlite.close();
});
