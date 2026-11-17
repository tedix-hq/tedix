import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { recordStaleLanes } from "./lane-lifecycle";

const ACTIVE = "uniq_work_attempt_active";
const ORG = "org-example";
const OTHER_ORG = "org-other";
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const at = (ago: number) => new Date(NOW - ago).toISOString();

/** The read as it was before it named the live run states. */
const LEGACY = `SELECT id FROM work_attempts
	WHERE executor_type = 'external_agent'
		AND json_extract(metadata, '$.lane') = 1
		AND outcome IS NULL
		AND julianday(?1) >= (julianday(heartbeat_at) + julianday(expires_at)) / 2
		AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id = work_attempts.org_id AND e.attempt_id = work_attempts.id AND e.event_type = 'lane.stale' AND json_extract(e.payload, '$.heartbeatAt') = work_attempts.heartbeat_at)
	ORDER BY heartbeat_at ASC, id ASC LIMIT 100`;

type Statistics = "none" | "production-sized" | "analysed";

function fixture(statistics: Statistics) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission fencing is not under test; these fixtures only need Attempts.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const item = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, title, disposition, admission_spec_revision, created_at, updated_at) VALUES (?, ?, 'Example', 'accepted', 'spec-example', ?, ?)",
	);
	const attempt = sqlite.prepare(
		"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, executor_session_id, external_session_key, runtime_state, outcome, started_at, heartbeat_at, expires_at, finished_at, metadata) VALUES (?, ?, ?, 1, ?, 'agent-example', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	let sequence = 0;
	const add = (
		id: string,
		row: {
			org?: string;
			executorType?: "external_agent" | "tedi";
			state?: string;
			outcome?: string | null;
			heartbeatAt?: string;
			expiresAt?: string | null;
			metadata?: Record<string, unknown>;
		} = {},
	) => {
		const org = row.org ?? ORG;
		const external = (row.executorType ?? "external_agent") !== "tedi";
		const outcome = row.outcome ?? null;
		const started = at(120 * MINUTE + sequence++ * 1000);
		item.run(`item-${id}`, org, started, started);
		attempt.run(
			id,
			org,
			`item-${id}`,
			external ? "external_agent" : "tedi",
			external ? `session-${id}` : null,
			external ? `codex:${id}` : null,
			row.state ?? (outcome ? "finished" : "running"),
			outcome,
			started,
			row.heartbeatAt ?? at(10 * MINUTE),
			row.expiresAt === undefined ? at(-5 * MINUTE) : row.expiresAt,
			outcome ? at(MINUTE) : null,
			JSON.stringify(row.metadata ?? { lane: true }),
		);
	};
	// History: almost every Attempt finished long ago, lanes included, and
	// their last heartbeat is far past the halfway mark of their lease.
	for (let i = 0; i < 3000; i++)
		add(`finished-${i}`, {
			org: i % 5 ? ORG : OTHER_ORG,
			executorType: i % 4 ? "external_agent" : "tedi",
			outcome: ["succeeded", "failed", "expired", "cancelled"][i % 4],
			state: ["finished", "failed", "expired", "cancelled"][i % 4],
			heartbeatAt: at(90 * MINUTE),
			expiresAt: at(80 * MINUTE),
			metadata: i % 2 ? { lane: true } : {},
		});

	// Lanes whose heartbeat stopped: past the midpoint of heartbeat and expiry.
	add("stale-running", { heartbeatAt: at(10 * MINUTE) });
	add("stale-other-org", { org: OTHER_ORG, heartbeatAt: at(12 * MINUTE) });
	add("stale-queued", { state: "queued", heartbeatAt: at(11 * MINUTE) });
	add("stale-waiting", { state: "waiting", heartbeatAt: at(9 * MINUTE) });
	add("stale-retrying", { state: "retrying", heartbeatAt: at(8 * MINUTE) });
	// Two heartbeats in the same instant: the id breaks the tie.
	add("stale-tie-b", { heartbeatAt: at(7 * MINUTE) });
	add("stale-tie-a", { heartbeatAt: at(7 * MINUTE) });
	add("stale-lease-passed", {
		heartbeatAt: at(30 * MINUTE),
		expiresAt: at(20 * MINUTE),
	});
	add("stale-lane-as-number", {
		heartbeatAt: at(6 * MINUTE),
		metadata: { lane: 1 },
	});
	// Recorded for an earlier heartbeat only: the new lapse counts again.
	add("stale-again", { heartbeatAt: at(13 * MINUTE) });
	// Not due, or not a lane this sweep watches.
	add("fresh", { heartbeatAt: at(MINUTE), expiresAt: at(-9 * MINUTE) });
	add("already-recorded", { heartbeatAt: at(14 * MINUTE) });
	add("no-lease", { heartbeatAt: at(40 * MINUTE), expiresAt: null });
	add("not-a-lane", { heartbeatAt: at(15 * MINUTE), metadata: {} });
	add("lane-false", {
		heartbeatAt: at(15 * MINUTE),
		metadata: { lane: false },
	});
	add("tedi-lane", { executorType: "tedi", heartbeatAt: at(15 * MINUTE) });
	const event = sqlite.prepare(
		"INSERT INTO work_events (id, org_id, work_item_id, attempt_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?, 'system', 'tedix', ?, ?)",
	);
	event.run(
		"event-recorded",
		ORG,
		"item-already-recorded",
		"already-recorded",
		"lane.stale",
		JSON.stringify({ heartbeatAt: at(14 * MINUTE) }),
		at(5 * MINUTE),
	);
	event.run(
		"event-earlier",
		ORG,
		"item-stale-again",
		"stale-again",
		"lane.stale",
		JSON.stringify({ heartbeatAt: at(50 * MINUTE) }),
		at(45 * MINUTE),
	);
	for (let i = 0; i < 500; i++)
		event.run(
			`noise-${i}`,
			ORG,
			`item-finished-${i}`,
			`finished-${i}`,
			"comment",
			"{}",
			at(60 * MINUTE),
		);

	// work_attempts held about 20,000 rows on 17 Nov 2026 (what this read
	// walked per call) and few of them live. The per-key figures are
	// estimates.
	if (statistics === "production-sized")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'work_attempts';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_attempts','sqlite_autoindex_work_attempts_1','20178 1'),
				('work_attempts','uniq_work_attempt_number','20178 215 1 1'),
				('work_attempts','uniq_work_attempt_admission','20178 1'),
				('work_attempts','uniq_work_attempt_active','60 2 1'),
				('work_attempts','idx_work_attempt_executor_state','20178 215 108 20 5'),
				('work_attempts','idx_work_attempt_expiry','20178 2500 1'),
				('work_attempts','idx_work_attempt_org_started','20178 215 1'),
				('work_attempts','idx_work_attempt_org_state_started','20178 215 30 1');
			ANALYZE sqlite_schema;`);
	else if (statistics === "analysed") sqlite.exec("ANALYZE");

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
				if (query.includes("work_attempts")) plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans, explain };
}

const ids = (sqlite: DatabaseSync, query: string, ...params: string[]) =>
	sqlite
		.prepare(query)
		.all(...params)
		.map((row) => String(row.id));

const recorded = (sqlite: DatabaseSync) =>
	sqlite
		.prepare(
			"SELECT attempt_id AS id, org_id, work_item_id, json_extract(payload, '$.heartbeatAt') AS heartbeat FROM work_events WHERE event_type = 'lane.stale' AND id NOT IN ('event-recorded', 'event-earlier') ORDER BY sequence",
		)
		.all();

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-sized" },
	{ statistics: "analysed" },
])("stale lane sweep, statistics: $statistics", ({ statistics }) => {
	it("reads only live Attempts and records the same lanes in the same order as before", async () => {
		const { sqlite, db, plans } = fixture(statistics);
		const now = at(0);
		const expected = ids(sqlite, LEGACY, now);
		expect(expected).toEqual([
			"stale-lease-passed",
			"stale-again",
			"stale-other-org",
			"stale-queued",
			"stale-running",
			"stale-waiting",
			"stale-retrying",
			"stale-tie-a",
			"stale-tie-b",
			"stale-lane-as-number",
		]);
		expect(await recordStaleLanes(db, now)).toBe(expected.length);
		expect(recorded(sqlite).map((row) => String(row.id))).toEqual(expected);
		expect(recorded(sqlite)[2]).toEqual({
			id: "stale-other-org",
			org_id: OTHER_ORG,
			work_item_id: "item-stale-other-org",
			heartbeat: at(12 * MINUTE),
		});
		// One read of the candidates, then one guarded insert per candidate.
		expect(plans).toHaveLength(1 + expected.length);
		// The read walks the live Attempts, through either index that holds
		// only those or seeks them; never the table or an index of all rows.
		expect(plans[0]).toMatch(
			/^(SCAN work_attempts USING INDEX uniq_work_attempt_active|SEARCH work_attempts USING INDEX idx_work_attempt_expiry \(runtime_state=\?\)) \|/,
		);
		for (const plan of plans) {
			expect(plan).not.toMatch(
				/SCAN work_attempts(?! USING INDEX uniq_work_attempt_active)/,
			);
			expect(plan).toContain("SEARCH e USING INDEX");
		}
		// Recorded once: nothing is due until a heartbeat changes.
		expect(ids(sqlite, LEGACY, now)).toEqual([]);
		expect(await recordStaleLanes(db, now)).toBe(0);
		expect(recorded(sqlite)).toHaveLength(expected.length);
	});

	it("is not yet due one millisecond before the midpoint", async () => {
		const { sqlite, db } = fixture(statistics);
		// Keep one lane: heartbeat 10 minutes ago, lease ends in 5.
		sqlite.exec(
			"DELETE FROM work_attempts WHERE outcome IS NULL AND id <> 'stale-running'",
		);
		const midpoint = NOW - 10 * MINUTE + (15 * MINUTE) / 2;
		const early = new Date(midpoint - 1000).toISOString();
		expect(ids(sqlite, LEGACY, early)).toEqual([]);
		expect(await recordStaleLanes(db, early)).toBe(0);
		const due = new Date(midpoint).toISOString();
		expect(ids(sqlite, LEGACY, due)).toEqual(["stale-running"]);
		expect(await recordStaleLanes(db, due)).toBe(1);
	});

	it("states the live-Attempt index's own condition", () => {
		const { explain } = fixture(statistics);
		// The index of live Attempts accepts the read's condition as written.
		expect(
			explain(
				`SELECT id FROM work_attempts INDEXED BY ${ACTIVE} WHERE "work_attempts"."runtime_state" IN ('queued', 'running', 'waiting', 'retrying') AND outcome IS NULL`,
			),
		).toContain(`USING INDEX ${ACTIVE}`);
		// SQLite refuses it to the old read, which did not name the states.
		expect(() =>
			explain(
				`SELECT id FROM work_attempts INDEXED BY ${ACTIVE} WHERE executor_type = ? AND json_extract(metadata, '$.lane') = 1 AND outcome IS NULL`,
			),
		).toThrow(/no query solution/);
	});
});

it("a live Attempt has no outcome and an Attempt without outcome is live", () => {
	// chk_work_attempt_terminal_state ties the two together, which is why
	// naming the live states leaves the sweep's result unchanged.
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const insert = (state: string, outcome: string | null) =>
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, executor_type, executor_id, executor_session_id, external_session_key, runtime_state, outcome, started_at, heartbeat_at, finished_at) VALUES (?, 'org-example', ?, 1, 'external_agent', 'agent-example', 'session-example', 'codex:example', ?, ?, '2026-11-17T12:00:00.000Z', '2026-11-17T12:00:00.000Z', ?)",
			)
			.run(
				`${state}-${outcome}`,
				`item-${state}-${outcome}`,
				state,
				outcome,
				outcome ? "2026-11-17T12:00:00.000Z" : null,
			);
	for (const state of ["failed", "expired", "finished", "cancelled"])
		expect(() => insert(state, null)).toThrow(
			/chk_work_attempt_terminal_state/,
		);
	for (const state of ["queued", "running", "waiting", "retrying"]) {
		expect(() => insert(state, "succeeded")).toThrow(
			/chk_work_attempt_terminal_state/,
		);
		insert(state, null);
	}
	insert("finished", "succeeded");
});
