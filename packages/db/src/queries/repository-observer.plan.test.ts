import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	claimRepositoryObserverWake,
	deferredRepositoryPushObservations,
	getRepositoryObservation,
	overdueRepositoryObservations,
	pendingRepositoryObservations,
	settleAgedRepositoryPushObservations,
} from "./repository-observer";

const OPEN = "idx_work_items_open_repository_observation";
const DEFERRED = "idx_work_items_deferred_repository_wake";
const ORG = "org-example";
const OTHER_ORG = "org-other";
const PROJECT = "project-example";
const ADVISORY = "advisory push observation";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The three sweeps as they were before they stated an index condition. */
const LEGACY_DEFERRED = `SELECT id FROM work_items
	WHERE json_extract(metadata, '$.repositoryObserver') = 1
		AND json_extract(metadata, '$.event.kind') = 'push'
		AND json_extract(metadata, '$.observerWakeDeferredAt') IS NOT NULL
		AND json_extract(metadata, '$.observerWokenAt') IS NULL
		AND json_extract(metadata, '$.report') IS NULL
		AND (disposition IN ('proposed','accepted') OR (disposition = 'cancelled' AND json_extract(metadata, '$.settleReason') = '${ADVISORY}' AND julianday(created_at) >= julianday('now', '-24 hours')))
	ORDER BY created_at DESC, id DESC LIMIT ?`;
const LEGACY_OVERDUE = `SELECT id FROM work_items
	WHERE json_extract(metadata, '$.repositoryObserver') = 1
		AND json_extract(metadata, '$.event.kind') = 'ship_red'
		AND disposition NOT IN ('completed','cancelled')
		AND deadline <= ?1
		AND coalesce(json_extract(metadata, '$.latestReport.stillRed'), json_extract(metadata, '$.report.stillRed'), 1) = 1
		AND json_extract(metadata, '$.observerEscalatedAt') IS NULL
		AND coalesce(json_extract(metadata, '$.observerRetryAt'), '') <= ?1
		AND NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = work_items.org_id AND i.work_item_id = work_items.id AND i.kind = 'coordination' AND json_extract(i.metadata, '$.reason') = 'Red Ship needs a decision after diagnosis or the single repair attempt')
	ORDER BY coalesce(json_extract(metadata, '$.observerRetryAt'), ''), deadline, id LIMIT 5`;
const LEGACY_AGED = `SELECT id FROM work_items
	WHERE json_extract(metadata, '$.repositoryObserver') = 1
		AND disposition IN ('proposed','accepted')
		AND NOT EXISTS (SELECT 1 FROM work_attempts active_attempt WHERE active_attempt.org_id = work_items.org_id AND active_attempt.work_item_id = work_items.id AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ?1))
		AND json_extract(metadata, '$.event.kind') = 'push'
		AND NOT (EXISTS (SELECT 1 FROM json_each(metadata, '$.latestReport.lessons') lesson WHERE json_extract(lesson.value, '$.verdict') = 'not_applied'))
		AND julianday(created_at) < julianday(?2)
		AND coalesce(json_extract(metadata, '$.latestReport.stillRed'), json_extract(metadata, '$.report.stillRed'), 0) = 0
		AND NOT EXISTS (SELECT 1 FROM work_items red WHERE red.org_id = work_items.org_id AND red.project_id = work_items.project_id AND json_extract(red.metadata, '$.repositoryObserver') = 1 AND red.disposition IN ('proposed','accepted') AND json_extract(red.metadata, '$.event.kind') IN ('ship_red','ci_red') AND json_extract(red.metadata, '$.event.repository') = json_extract(work_items.metadata, '$.event.repository') AND json_extract(red.metadata, '$.event.branch') = json_extract(work_items.metadata, '$.event.branch') AND json_extract(red.metadata, '$.event.sha') = json_extract(work_items.metadata, '$.event.sha'))
	ORDER BY created_at, id LIMIT 100`;

type Statistics =
	| "none"
	| "production-like"
	| "analysed before the indexes"
	| "analysed";

function fixture(statistics: Statistics, withIndexes = true) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// The fixture writes Attempt history directly, without admissions.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	const now = Date.now();
	const at = (ago: number) => new Date(now - ago).toISOString();
	const insert = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, project_id, title, disposition, deadline, metadata, admission_spec_revision, created_at) VALUES (?, ?, ?, 'Example', ?, ?, ?, 'spec-example', ?)",
	);
	let sequence = 0;
	const add = (
		id: string,
		row: {
			org?: string;
			disposition?: string;
			deadline?: string | null;
			createdAt?: string;
			metadata?: Record<string, unknown>;
		},
	) =>
		insert.run(
			id,
			row.org ?? ORG,
			PROJECT,
			row.disposition ?? "cancelled",
			row.deadline ?? null,
			JSON.stringify(row.metadata ?? {}),
			row.createdAt ?? at(30 * DAY + sequence++ * 1000),
		);
	const push = (sha: string, extra: Record<string, unknown> = {}) => ({
		repositoryObserver: 1,
		event: { kind: "push", repository: "example/app", branch: "main", sha },
		...extra,
	});
	const settled = { settleReason: ADVISORY };
	const deferred = { observerWakeDeferredAt: at(HOUR) };

	// Ordinary Work, most of it with a deadline long past.
	for (let i = 0; i < 500; i++)
		add(`ordinary-${i}`, {
			org: i % 5 ? ORG : OTHER_ORG,
			disposition: ["proposed", "accepted", "completed", "cancelled"][i % 4],
			deadline: i % 3 ? at((i + 1) * DAY) : null,
		});
	// Settled commit watches, the bulk of every observation ever recorded.
	// Many were deferred long ago and never got a slot.
	for (let i = 0; i < 600; i++)
		add(`watch-${i}`, {
			org: i % 7 ? ORG : OTHER_ORG,
			metadata: push(`a${i}`, {
				...settled,
				...(i % 3 === 0 ? { report: {} } : i % 3 === 1 ? deferred : {}),
			}),
		});

	// Pushes waiting for a wake slot.
	for (const [id, ago, org] of [
		["deferred-1h", HOUR, ORG],
		["deferred-2h-other-org", 2 * HOUR, OTHER_ORG],
		["deferred-23h", 23 * HOUR, ORG],
		["deferred-25h", 25 * HOUR, ORG],
		["deferred-2d", 2 * DAY, ORG],
		["deferred-4d", 4 * DAY, ORG],
	] as const)
		add(id, {
			org,
			createdAt: at(ago),
			metadata: push(id, { ...settled, ...deferred }),
		});
	// Two rows created in the same instant: the id breaks the tie.
	const tie = at(3 * HOUR);
	for (const id of ["deferred-tie-a", "deferred-tie-b"])
		add(id, {
			createdAt: tie,
			metadata: push(id, { ...settled, ...deferred }),
		});
	// A creation time written without milliseconds.
	add("deferred-seconds-only", {
		createdAt: at(4 * HOUR).replace(/\.\d{3}Z$/, "Z"),
		metadata: push("seconds", { ...settled, ...deferred }),
	});
	add("deferred-woken", {
		createdAt: at(HOUR),
		metadata: push("woken", {
			...settled,
			...deferred,
			observerWokenAt: at(HOUR / 2),
		}),
	});
	add("deferred-reported", {
		createdAt: at(HOUR),
		metadata: push("reported", { ...settled, ...deferred, report: {} }),
	});
	add("deferred-owner-cancelled", {
		createdAt: at(HOUR),
		metadata: push("owner", { ...deferred, settleReason: "owner cancelled" }),
	});
	add("deferred-completed", {
		createdAt: at(HOUR),
		disposition: "completed",
		metadata: push("completed", { ...settled, ...deferred }),
	});
	add("deferred-red-incident", {
		createdAt: at(HOUR),
		disposition: "proposed",
		metadata: {
			...push("incident", deferred),
			event: { kind: "ship_red" },
		},
	});
	add("never-deferred", {
		createdAt: at(HOUR),
		metadata: push("never", settled),
	});
	// Open pushes stay pending whatever their age.
	add("open-deferred-1h", {
		createdAt: at(HOUR),
		disposition: "proposed",
		metadata: push("open-1h", deferred),
	});
	add("open-deferred-2d", {
		createdAt: at(2 * DAY),
		disposition: "accepted",
		metadata: push("open-2d", deferred),
	});
	add("open-deferred-10d", {
		createdAt: at(10 * DAY),
		disposition: "proposed",
		metadata: push("open-10d", deferred),
	});

	// Open pushes the retention sweep may or may not settle.
	for (let i = 0; i < 120; i++)
		add(`aged-${String(i).padStart(3, "0")}`, {
			org: i % 4 ? ORG : OTHER_ORG,
			createdAt: at(2 * DAY + i * 1000),
			disposition: i % 2 ? "proposed" : "accepted",
			metadata: push(`aged-${i}`, i % 3 ? {} : { report: {} }),
		});
	add("aged-too-young", {
		createdAt: at(23 * HOUR),
		disposition: "proposed",
		metadata: push("young"),
	});
	add("aged-still-red", {
		createdAt: at(3 * DAY),
		disposition: "proposed",
		metadata: push("still-red", { report: { stillRed: true } }),
	});
	add("aged-unapplied-lesson", {
		createdAt: at(3 * DAY),
		disposition: "proposed",
		metadata: push("lesson", {
			report: {},
			latestReport: { lessons: [{ lessonId: "l", verdict: "not_applied" }] },
		}),
	});
	add("aged-red-follow-up", {
		createdAt: at(3 * DAY),
		disposition: "proposed",
		metadata: push("followed"),
	});
	add("aged-active-attempt", {
		createdAt: at(3 * DAY),
		disposition: "accepted",
		metadata: push("active"),
	});
	sqlite
		.prepare(
			"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, runtime_state, started_at, heartbeat_at, executor_type, executor_id) VALUES ('attempt', ?, 'aged-active-attempt', 1, 'running', ?, ?, 'tedi', 'tedi-example')",
		)
		.run(ORG, at(HOUR), at(HOUR));

	// Red incidents the escalation sweep may or may not claim.
	const red = (kind: string, sha: string, extra = {}) => ({
		repositoryObserver: 1,
		event: { kind, repository: "example/app", branch: "main", sha },
		...extra,
	});
	for (let i = 0; i < 8; i++)
		add(`red-${i}`, {
			org: i % 3 ? ORG : OTHER_ORG,
			createdAt: at(5 * HOUR),
			disposition: i % 2 ? "proposed" : "accepted",
			deadline: at((i + 1) * HOUR),
			metadata: red("ship_red", `red-${i}`, i % 4 === 3 ? { report: {} } : {}),
		});
	add("red-follow-up", {
		createdAt: at(5 * HOUR),
		disposition: "proposed",
		deadline: at(HOUR),
		metadata: red("ci_red", "followed"),
	});
	add("red-not-due", {
		createdAt: at(HOUR),
		disposition: "proposed",
		deadline: at(-HOUR),
		metadata: red("ship_red", "not-due"),
	});
	add("red-escalated", {
		createdAt: at(5 * HOUR),
		disposition: "proposed",
		deadline: at(HOUR),
		metadata: red("ship_red", "escalated", { observerEscalatedAt: at(HOUR) }),
	});
	add("red-recovered", {
		createdAt: at(5 * HOUR),
		disposition: "proposed",
		deadline: at(HOUR),
		metadata: red("ship_red", "recovered", { report: { stillRed: false } }),
	});
	add("red-retry-later", {
		createdAt: at(5 * HOUR),
		disposition: "proposed",
		deadline: at(HOUR),
		metadata: red("ship_red", "retry", { observerRetryAt: at(-HOUR) }),
	});
	add("red-settled", {
		createdAt: at(5 * HOUR),
		disposition: "cancelled",
		deadline: at(HOUR),
		metadata: red("ship_red", "settled"),
	});
	add("red-completed", {
		createdAt: at(5 * HOUR),
		disposition: "completed",
		deadline: at(HOUR),
		metadata: red("ship_red", "done"),
	});

	if (!withIndexes) sqlite.exec(`DROP INDEX ${OPEN}; DROP INDEX ${DEFERRED};`);
	// Production sqlite_stat1 for work_items on 23 Oct 2026, as in
	// owner-list.plan.test.ts: a far larger table than this fixture and no
	// row for an index added since.
	if (statistics === "production-like")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'work_items';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_items','idx_work_items_org_objective','22796 94 94'),
				('work_items','uniq_work_items_org_id','22796 94 1'),
				('work_items','idx_work_items_org_disposition','22796 94 47'),
				('work_items','idx_work_items_accountable_owner','22796 94 63 63'),
				('work_items','idx_work_items_org_created','22796 94 1');
			ANALYZE sqlite_schema;`);
	else if (statistics !== "none") {
		sqlite.exec("ANALYZE");
		// The state right after the migration: statistics exist for everything
		// except the two new indexes.
		if (statistics === "analysed before the indexes")
			sqlite.exec(
				`DELETE FROM sqlite_stat1 WHERE idx IN ('${OPEN}', '${DEFERRED}'); ANALYZE sqlite_schema;`,
			);
	}

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
				if (query.includes("work_items")) plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans, explain, at };
}

const ids = (sqlite: DatabaseSync, query: string, ...params: string[]) =>
	sqlite
		.prepare(query)
		.all(...params)
		.map((row) => String(row.id));

const snapshot = (sqlite: DatabaseSync) =>
	new Map(
		sqlite
			.prepare(
				"SELECT id, disposition, cancelled_at, version, metadata FROM work_items",
			)
			.all()
			.map((row) => [String(row.id), JSON.stringify(row)]),
	);

function changed(before: Map<string, string>, after: Map<string, string>) {
	return [...after]
		.filter(([id, row]) => before.get(id) !== row)
		.map(([id]) => id)
		.sort();
}

/** A scan of the whole table or of a general index is what this replaces. */
function expectOnlyThroughNewIndexes(plans: string[]) {
	expect(plans.length).toBeGreaterThan(0);
	for (const plan of plans) {
		expect(plan).not.toMatch(
			/SCAN work_items(?! USING INDEX idx_work_items_(open_repository_observation|deferred_repository_wake))/,
		);
		expect(plan).not.toContain("idx_work_items_deadline");
		expect(plan).not.toContain("idx_work_items_org_disposition");
	}
}

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-like" },
	{ statistics: "analysed before the indexes" },
	{ statistics: "analysed" },
])("repository observer sweeps, statistics: $statistics", ({ statistics }) => {
	it("reads deferred pushes through the two partial indexes and returns what the table walk returned", async () => {
		const { sqlite, db, plans } = fixture(statistics);
		const all = ids(sqlite, LEGACY_DEFERRED, "500");
		// Recent settled pushes, open pushes of any age; nothing settled
		// longer than a day, woken, reported, owner-cancelled or not a push.
		expect(all).toEqual([
			"open-deferred-1h",
			"deferred-1h",
			"deferred-2h-other-org",
			"deferred-tie-b",
			"deferred-tie-a",
			"deferred-seconds-only",
			"deferred-23h",
			"open-deferred-2d",
			"open-deferred-10d",
		]);
		for (const limit of [1, 3, 5, 8, 20, 500]) {
			plans.length = 0;
			const rows = await deferredRepositoryPushObservations(db, limit);
			expect(rows.map((row) => row.id)).toEqual(all.slice(0, limit));
			expect(plans).toHaveLength(1);
			expect(plans[0]).toContain(
				`SEARCH work_items USING INDEX ${DEFERRED} (created_at>?)`,
			);
			expect(plans[0]).toContain(
				`SEARCH work_items USING INDEX ${OPEN} (created_at<?)`,
			);
			expectOnlyThroughNewIndexes(plans);
		}
		const [first] = await deferredRepositoryPushObservations(db, 1);
		expect(first).toEqual({
			id: "open-deferred-1h",
			orgId: ORG,
			projectId: PROJECT,
			metadata: expect.objectContaining({
				repositoryObserver: 1,
				event: expect.objectContaining({ kind: "push" }),
			}),
		});
	});

	it("claims overdue red incidents through the open-observation index, the same rows as before", async () => {
		const { sqlite, db, plans, at } = fixture(statistics);
		const now = at(0);
		for (let round = 0; round < 4; round++) {
			const expected = ids(sqlite, LEGACY_OVERDUE, now);
			const before = snapshot(sqlite);
			plans.length = 0;
			const claimed = await overdueRepositoryObservations(db, now);
			expect(claimed.map((row) => row.id).sort()).toEqual([...expected].sort());
			expect(changed(before, snapshot(sqlite))).toEqual([...expected].sort());
			expect(plans).toHaveLength(1);
			expect(plans[0]).toContain(`SCAN work_items USING INDEX ${OPEN}`);
			expectOnlyThroughNewIndexes(plans);
			// Five a tick; the eight due incidents drain in two.
			expect(expected).toHaveLength([5, 3, 0, 0][round]!);
		}
	});

	it("settles aged pushes through the open-observation index, the same rows as before", async () => {
		const { sqlite, db, plans, at } = fixture(statistics);
		const now = at(0);
		const cutoff = at(DAY);
		for (let round = 0; round < 3; round++) {
			const expected = ids(sqlite, LEGACY_AGED, now, cutoff);
			const before = snapshot(sqlite);
			plans.length = 0;
			const settled = await settleAgedRepositoryPushObservations(db, now);
			expect(settled.map((row) => row.id).sort()).toEqual([...expected].sort());
			expect(changed(before, snapshot(sqlite))).toEqual([...expected].sort());
			expect(plans).toHaveLength(1);
			expect(plans[0]).toContain(`SCAN work_items USING INDEX ${OPEN}`);
			expectOnlyThroughNewIndexes(plans);
			// 120 aged pushes and two old open deferred ones, 100 a tick.
			expect(expected).toHaveLength([100, 22, 0][round]!);
		}
		for (const id of [
			"aged-too-young",
			"aged-still-red",
			"aged-unapplied-lesson",
			"aged-red-follow-up",
			"aged-active-attempt",
			"open-deferred-1h",
		])
			expect(
				(await getRepositoryObservation(db, ORG, id))?.disposition,
			).not.toBe("cancelled");
	});

	it("leaves every other read of Work Items off the new indexes", async () => {
		const { db, plans, explain, at } = fixture(statistics);
		await getRepositoryObservation(db, ORG, "red-0");
		await pendingRepositoryObservations(db, ORG, PROJECT);
		await claimRepositoryObserverWake(db, {
			orgId: ORG,
			projectId: PROJECT,
			id: "deferred-1h",
			now: at(0),
			limit: 2,
		});
		expect(plans.length).toBeGreaterThanOrEqual(3);
		for (const plan of plans) {
			expect(plan).not.toContain(OPEN);
			expect(plan).not.toContain(DEFERRED);
		}
		// SQLite refuses a partial index whose condition the query does not
		// state, so this cannot change with the statistics.
		for (const query of [
			`SELECT id FROM work_items INDEXED BY ${OPEN} WHERE org_id = ? AND id = ?`,
			`SELECT id FROM work_items INDEXED BY ${OPEN} WHERE created_at > ? ORDER BY created_at`,
			`SELECT id FROM work_items INDEXED BY ${OPEN} WHERE disposition IN ('proposed','accepted') AND created_at > ?`,
			`SELECT id FROM work_items INDEXED BY ${OPEN} WHERE json_extract(metadata, '$.repositoryObserver') = 1 AND org_id = ? AND project_id = ?`,
			`SELECT id FROM work_items INDEXED BY ${DEFERRED} WHERE org_id = ? AND created_at > ?`,
			`SELECT id FROM work_items INDEXED BY ${DEFERRED} WHERE json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.report') IS NULL AND org_id = ? AND project_id = ?`,
		])
			expect(() => explain(query)).toThrow(/no query solution/);
	});
});

it("answers the same on a database that does not have the indexes yet", async () => {
	const { sqlite, db, at } = fixture("analysed", false);
	const now = at(0);
	expect(
		(await deferredRepositoryPushObservations(db, 500)).map((row) => row.id),
	).toEqual(ids(sqlite, LEGACY_DEFERRED, "500"));
	const overdue = ids(sqlite, LEGACY_OVERDUE, now);
	expect(
		(await overdueRepositoryObservations(db, now)).map((row) => row.id).sort(),
	).toEqual(overdue.sort());
	const aged = ids(sqlite, LEGACY_AGED, now, at(DAY));
	expect(
		(await settleAgedRepositoryPushObservations(db, now))
			.map((row) => row.id)
			.sort(),
	).toEqual(aged.sort());
});
