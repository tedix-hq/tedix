import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { readOfficeCanonicalSources } from "./office-activity";

it("reads the Office timeline through the time window, not every org event per session", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission fencing is not under test; these fixtures only need Attempts.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const old = "2026-10-01T12:00:00.000Z";
	const since = "2026-10-17T00:00:00.000Z";
	const at = "2026-10-17T12:00:00.000Z";
	const item = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES (?, 'org-example', 'Example', 'accepted', 'spec-example', ?, ?)",
	);
	item.run("mine", old, old);
	item.run("theirs", old, old);
	const session = sqlite.prepare(
		"INSERT INTO work_agent_sessions (id, organization_id, user_id, harness, session_key, state, state_since, last_event_at) VALUES (?, 'org-example', ?, 'claude-code', ?, 'idle', ?, ?)",
	);
	for (let i = 0; i < 300; i++)
		session.run(`session-${i}`, "user-example", `key-${i}`, at, at);
	session.run("session-other", "user-other", "key-other", at, at);
	const attempt = sqlite.prepare(
		"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, executor_session_id, external_session_key, started_at, heartbeat_at, finished_at, runtime_state, outcome, summary) VALUES (?, 'org-example', ?, ?, 'external_agent', 'agent', 'executor-session', ?, ?, ?, ?, 'finished', 'succeeded', 'done')",
	);
	attempt.run("attempt-mine-1", "mine", 1, "key-299", old, old, old);
	attempt.run("attempt-mine-2", "mine", 2, "key-299", at, at, at);
	attempt.run("attempt-theirs", "theirs", 1, "key-other", at, at, at);
	const event = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, attempt_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, 'org-example', ?, ?, ?, 'system', 'tedix', '{}', ?)",
	);
	for (let i = 0; i < 2000; i++)
		event.run(`noise-${i}`, "theirs", "attempt-theirs", "attempt.settled", old);
	event.run("settled", "mine", "attempt-mine-2", "attempt.settled", at);
	event.run("completed", "mine", null, "work.completed", at);
	event.run("theirs", "theirs", "attempt-theirs", "attempt.settled", at);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("office_attempt_id"))
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
	const { events } = await readOfficeCanonicalSources(
		db,
		{
			organizationId: "org-example",
			userId: "user-example",
			descopeUserId: "descope-example",
		},
		since,
	);
	expect(events.map((row) => [row.id, row.attemptId, row.sessionKey])).toEqual([
		["settled", "attempt-mine-2", "key-299"],
		["completed", "attempt-mine-2", "key-299"],
	]);
	expect(events.every((row) => row.resultRecorded)).toBe(true);
	expect(plans[0]).toMatch(
		/^SEARCH work_events USING INDEX idx_work_events_org_type_occurred \(org_id=\? AND event_type=\? AND occurred_at>\?\)/,
	);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/^SEARCH s USING COVERING INDEX idx_work_agent_sessions_org_user_session \(organization_id=\? AND user_id=\? AND session_key=\?\)/,
		),
	);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/^SEARCH latest USING INDEX uniq_work_attempt_number \(org_id=\? AND work_item_id=\?\)/,
		),
	);
	expect(plans.some((plan) => plan.startsWith("SCAN"))).toBe(false);
	sqlite.close();
});
