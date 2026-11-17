import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { notifyStoppedLanes } from "./lane-lifecycle";

const ORG = "org-example";
const OTHER_ORG = "org-other";
const AT = "2026-10-17T12:00:00.000Z";
const LATER = "2026-10-17T12:10:00.000Z";

/**
 * The events the notifier chose before it kept a checkpoint: every stopped
 * lane event ever written that is due a notice, oldest first, 100 per call.
 */
const LEGACY = `SELECT e.id FROM work_events e
	JOIN work_attempts a ON a.org_id = e.org_id AND a.id = e.attempt_id
	JOIN work_items w ON w.org_id = e.org_id AND w.id = e.work_item_id
	WHERE e.event_type IN ('lane.stale', 'attempt.expired')
		AND EXISTS (SELECT 1 FROM external_agent_principals p WHERE p.organization_id = a.org_id AND p.id = a.executor_id AND p.status = 'active')
		AND json_extract(a.metadata, '$.lane') = 1
		AND w.disposition NOT IN ('completed','cancelled')
		AND NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = e.org_id AND i.id = e.id)
		AND NOT EXISTS (SELECT 1 FROM work_attempts n WHERE n.org_id = a.org_id AND n.work_item_id = a.work_item_id AND n.attempt_number > a.attempt_number)
		AND (e.event_type = 'attempt.expired' OR (json_extract(e.payload, '$.heartbeatAt') = a.heartbeat_at AND a.outcome IS NULL))
	ORDER BY e.sequence LIMIT 100`;

type Statistics = "none" | "production-sized";

function fixture(statistics: Statistics) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission fencing is not under test; these fixtures only need Attempts.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const item = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, title, disposition, admission_spec_revision, metadata, created_at, updated_at) VALUES (?, ?, 'Example', ?, 'spec-example', ?, ?, ?)",
	);
	const principal = sqlite.prepare(
		"INSERT INTO external_agent_principals (id, organization_id, key, display_name, status, credential_binding_type, credential_binding_id, created_by_type, created_by_id, created_at, updated_at) VALUES (?, ?, ?, 'Worker', ?, 'owner_user', ?, 'user', 'user-example', ?, ?)",
	);
	const attempt = sqlite.prepare(
		"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, executor_session_id, runtime_state, outcome, started_at, heartbeat_at, expires_at, finished_at, metadata) VALUES (?, ?, ?, ?, 'external_agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const event = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, attempt_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?, 'system', 'tedix', ?, ?)",
	);
	const notice = sqlite.prepare(
		"INSERT INTO work_interactions (id, org_id, work_item_id, kind, subject, prompt, creator_type, creator_id, target_type, target_id, created_at) VALUES (?, ?, ?, 'coordination', 'Lane failed', 'Example', 'system', 'tedix', 'external_agent', ?, ?)",
	);
	// Principal ids are unique across organizations.
	const agentOf = (org: string) => (org === ORG ? "agent" : "other-agent");
	for (let i = 0; i < 300; i++)
		for (const org of [ORG, OTHER_ORG])
			principal.run(
				`${agentOf(org)}-${i}`,
				org,
				`agent-${i}`,
				"active",
				`user-${i}`,
				AT,
				AT,
			);
	principal.run("agent-away", ORG, "agent-away", "suspended", "away", AT, AT);

	/** One Work Item with one stopped Attempt and the event that records it. */
	const lane = (
		id: string,
		row: {
			org?: string;
			kind?: "expired" | "stale";
			lane?: boolean;
			disposition?: string;
			agent?: string;
			noticed?: boolean;
			superseded?: boolean;
			/** The heartbeat the stale event recorded; differs after a recovery. */
			recordedHeartbeat?: string;
			maxAttempts?: number;
		} = {},
	) => {
		const org = row.org ?? ORG;
		const expired = (row.kind ?? "expired") === "expired";
		item.run(
			`item-${id}`,
			org,
			row.disposition ?? "accepted",
			JSON.stringify(
				row.maxAttempts
					? { laneExecution: { maxAttempts: row.maxAttempts } }
					: {},
			),
			AT,
			AT,
		);
		attempt.run(
			`attempt-${id}`,
			org,
			`item-${id}`,
			1,
			row.agent ?? `${agentOf(org)}-0`,
			`session-${id}`,
			expired ? "expired" : "running",
			expired ? "expired" : null,
			AT,
			AT,
			AT,
			expired ? AT : null,
			JSON.stringify(row.lane === false ? {} : { lane: true }),
		);
		if (row.superseded)
			attempt.run(
				`attempt-${id}-next`,
				org,
				`item-${id}`,
				2,
				row.agent ?? `${agentOf(org)}-0`,
				`session-${id}-next`,
				"finished",
				"succeeded",
				AT,
				AT,
				AT,
				AT,
				JSON.stringify({ lane: true }),
			);
		event.run(
			`event-${id}`,
			org,
			`item-${id}`,
			`attempt-${id}`,
			expired ? "attempt.expired" : "lane.stale",
			JSON.stringify(
				expired
					? { outcome: "expired" }
					: { heartbeatAt: row.recordedHeartbeat ?? AT },
			),
			AT,
		);
		if (row.noticed)
			notice.run(`event-${id}`, org, `item-${id}`, `${agentOf(org)}-0`, AT);
	};

	// History, as in production: almost every stopped lane was noticed long
	// ago, and most expiries are not lanes at all.
	for (let i = 0; i < 900; i++)
		lane(`noticed-${i}`, {
			org: i % 4 ? ORG : OTHER_ORG,
			kind: i % 3 ? "expired" : "stale",
			noticed: true,
		});
	for (let i = 0; i < 300; i++) lane(`not-a-lane-${i}`, { lane: false });
	for (let i = 0; i < 100; i++) lane(`superseded-${i}`, { superseded: true });
	for (let i = 0; i < 50; i++)
		lane(`closed-${i}`, { disposition: i % 2 ? "completed" : "cancelled" });
	lane("recovered", {
		kind: "stale",
		recordedHeartbeat: "2026-10-17T11:00:00.000Z",
	});
	// Written before the due ones: an agent that is not active, for now.
	lane("away-a", { agent: "agent-away" });
	lane("away-b", { agent: "agent-away", kind: "stale" });
	// Due a notice.
	lane("due-expired");
	lane("due-stale", { kind: "stale" });
	lane("due-other-org", { org: OTHER_ORG });
	lane("due-budget", { maxAttempts: 3 });
	lane("due-last", { kind: "stale" });
	const noise = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, attempt_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, ?, 'item-due-expired', 'attempt-due-expired', 'comment', 'system', 'tedix', '{}', ?)",
	);
	for (let i = 0; i < 2000; i++) noise.run(`noise-${i}`, ORG, AT);

	// The main database in November 2026: about a thousand stopped-lane
	// events among hundreds of thousands, tens of thousands of Attempts.
	if (statistics === "production-sized")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl IN ('work_events','work_attempts','work_items','work_interactions','external_agent_principals');
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_events','idx_work_events_stopped_lane_sequence','1500 1'),
				('work_events','idx_work_events_personal_outcome_sequence','200 1'),
				('work_events','idx_work_events_item','300000 6 1'),
				('work_attempts','uniq_work_attempt_number','80000 800 2 1'),
				('work_attempts','idx_work_attempt_org_started','80000 800 1'),
				('work_items','uniq_work_items_org_id','50000 500 1'),
				('work_items','idx_work_items_org_disposition','50000 500 70'),
				('work_interactions','idx_work_interactions_org_status','40000 400 100'),
				('external_agent_principals','idx_external_agent_principal_status','600 6 3');
			ANALYZE sqlite_schema;`);

	const statements: string[] = [];
	let failNotices = 0;
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				statements.push(query);
				if (failNotices > 0 && query.includes('into "work_interactions"')) {
					failNotices--;
					throw new Error("tick died before its notice was written");
				}
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	const ids = (query: string) =>
		(sqlite.prepare(query).all() as Array<{ id: string }>).map((row) => row.id);
	return {
		sqlite,
		db,
		lane,
		statements,
		failNextNotice: () => {
			failNotices = 1;
		},
		/** What the notifier without a checkpoint would notice now. */
		legacy: () => ids(LEGACY),
		/** The stopped-lane events that have a notice, apart from the history. */
		noticed: () =>
			ids(
				"SELECT i.id FROM work_interactions i JOIN work_events e ON e.org_id = i.org_id AND e.id = i.id WHERE i.id NOT LIKE 'event-noticed-%' ORDER BY e.sequence",
			),
		checkpoint: () =>
			(
				sqlite
					.prepare(
						"SELECT through FROM platform_cron_checkpoints WHERE schedule_id = 'stopped-lane-notices'",
					)
					.get() as { through: string } | undefined
			)?.through ?? null,
	};
}

const explain = (sqlite: DatabaseSync, query: string) =>
	sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail));

/** The read that chooses which stopped-lane events to notice. */
const isChoice = (query: string) => query.includes("repair_target_type");
const isNotice = (query: string) => query.includes('into "work_interactions"');

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-sized" },
])("stopped-lane notices with $statistics statistics", ({ statistics }) => {
	it("notices what the whole-ledger read noticed, tick after tick", async () => {
		const { db, lane, legacy, noticed, checkpoint, statements, sqlite } =
			fixture(statistics);
		const due = [
			"event-due-expired",
			"event-due-stale",
			"event-due-other-org",
			"event-due-budget",
			"event-due-last",
		];
		expect(legacy()).toEqual(due);
		expect(checkpoint()).toBeNull();
		expect(await notifyStoppedLanes(db, LATER)).toBe(due.length);
		expect(noticed()).toEqual(due);
		expect(legacy()).toEqual([]);
		const newest = () =>
			String(
				(
					sqlite
						.prepare(
							"SELECT max(sequence) AS s FROM work_events WHERE event_type IN ('lane.stale', 'attempt.expired')",
						)
						.get() as { s: number }
				).s,
			);
		expect(checkpoint()).toBe(newest());

		// Nothing stopped since: two single-row reads and no walk at all.
		statements.length = 0;
		expect(await notifyStoppedLanes(db, LATER)).toBe(0);
		expect(statements).toHaveLength(2);
		expect(statements.some(isChoice)).toBe(false);

		// New stops of every kind; only the due ones are noticed.
		lane("new-not-a-lane", { lane: false });
		lane("new-expired");
		lane("new-superseded", { superseded: true });
		lane("new-stale", { kind: "stale" });
		lane("new-closed", { disposition: "completed" });
		const next = legacy();
		expect(next).toEqual(["event-new-expired", "event-new-stale"]);
		expect(await notifyStoppedLanes(db, LATER)).toBe(2);
		expect(noticed()).toEqual([...due, ...next]);
		expect(legacy()).toEqual([]);
		expect(checkpoint()).toBe(newest());
	});

	it("drains more than one page of new stops in order", async () => {
		const { db, lane, legacy, noticed } = fixture(statistics);
		await notifyStoppedLanes(db, LATER);
		const before = noticed();
		for (let i = 0; i < 150; i++) {
			lane(`burst-${i}`, { kind: i % 2 ? "stale" : "expired" });
			if (i % 10 === 0) lane(`burst-skip-${i}`, { lane: false });
		}
		const first = legacy();
		expect(first).toHaveLength(100);
		expect(await notifyStoppedLanes(db, LATER)).toBe(100);
		expect(noticed()).toEqual([...before, ...first]);
		const second = legacy();
		expect(second).toHaveLength(50);
		expect(await notifyStoppedLanes(db, LATER)).toBe(50);
		expect(noticed()).toEqual([...before, ...first, ...second]);
		expect(await notifyStoppedLanes(db, LATER)).toBe(0);
		expect(legacy()).toEqual([]);
	});

	it("examines the same events again when a tick dies before its notices", async () => {
		const { db, legacy, noticed, checkpoint, failNextNotice } =
			fixture(statistics);
		const due = legacy();
		failNextNotice();
		await expect(notifyStoppedLanes(db, LATER)).rejects.toThrow();
		expect(checkpoint()).toBeNull();
		expect(noticed()).toEqual([]);
		expect(await notifyStoppedLanes(db, LATER)).toBe(due.length);
		expect(noticed()).toEqual(due);
	});

	it("leaves an event that became due later to the whole-ledger call", async () => {
		const { db, sqlite, lane, legacy, noticed, checkpoint } =
			fixture(statistics);
		await notifyStoppedLanes(db, LATER);
		const before = noticed();
		const position = checkpoint();
		// The agent is reactivated and a closed item reopened: three old
		// events are due that were not when written.
		sqlite.exec(
			`UPDATE external_agent_principals SET status = 'active' WHERE id = 'agent-away';
			 UPDATE work_items SET disposition = 'accepted' WHERE id = 'item-closed-0';`,
		);
		const late = legacy();
		expect(late).toEqual(["event-closed-0", "event-away-a", "event-away-b"]);
		lane("after", { kind: "stale" });
		expect(await notifyStoppedLanes(db, LATER)).toBe(1);
		expect(noticed()).toEqual([...before, "event-after"]);
		expect(legacy()).toEqual(late);
		const advanced = checkpoint();
		expect(Number(advanced)).toBeGreaterThan(Number(position));
		// The hourly call is the read as it always was.
		expect(await notifyStoppedLanes(db, LATER, { wholeLedger: true })).toBe(
			late.length,
		);
		expect(legacy()).toEqual([]);
		expect(
			(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM work_interactions WHERE id IN ('event-closed-0','event-away-a','event-away-b')",
					)
					.get() as { n: number }
			).n,
		).toBe(3);
		// Noticing old events does not move the position backwards.
		expect(checkpoint()).toBe(advanced);
	});

	it("seeks the new events and finds each notice's event by its id", async () => {
		const { db, sqlite, lane, statements } = fixture(statistics);
		await notifyStoppedLanes(db, LATER);
		lane("planned");
		statements.length = 0;
		expect(await notifyStoppedLanes(db, LATER)).toBe(1);
		const choice = explain(sqlite, statements.find(isChoice)!);
		expect(choice[0]).toBe(
			"SEARCH work_events USING INDEX idx_work_events_stopped_lane_sequence (sequence>?)",
		);
		// The newest stopped-lane event is the first entry from the index's end.
		expect(statements[1]).toMatch(
			/order by "work_events"."sequence" desc limit \?$/,
		);
		expect(explain(sqlite, statements[1]!)).toEqual([
			"SCAN work_events USING INDEX idx_work_events_stopped_lane_sequence",
		]);
		// Each notice finds its event by the event's unique id.
		const notice = explain(sqlite, statements.find(isNotice)!);
		expect(notice.filter((line) => line.includes(" work_events "))).toEqual([
			"SEARCH work_events USING INDEX sqlite_autoindex_work_events_1 (id=?)",
		]);
		for (const plan of [choice, notice]) {
			expect(plan.join("\n")).not.toMatch(
				/SCAN (?:work_events|work_attempts|work_items|external_agent_principals)\b/,
			);
		}
		sqlite.close();
	});
});
