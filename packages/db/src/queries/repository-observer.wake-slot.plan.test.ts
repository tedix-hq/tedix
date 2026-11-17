import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	REPOSITORY_OBSERVER_WAKE_WINDOW_MINUTES,
	claimRepositoryObserverWake,
	deferRepositoryObserverWake,
	deferredRepositoryPushObservations,
	getRepositoryObservation,
	pendingRepositoryObservations,
	releaseRepositoryObserverWake,
} from "./repository-observer";

const WOKEN = "idx_work_items_woken_repository_observation";
const ORG = "org-example";
const OTHER_ORG = "org-other";
const PROJECT = "project-example";
const OTHER_PROJECT = "project-other";
const ADVISORY = "advisory push observation";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const at = (ago: number) => new Date(NOW - ago).toISOString();

/** The slot count as it was before it stated the index condition. */
const LEGACY_COUNT = `SELECT count(*) AS holders FROM work_items active
	WHERE active.org_id = ?1 AND active.project_id = ?2 AND active.id <> ?3
		AND json_extract(active.metadata, '$.repositoryObserver') = 1
		AND json_extract(active.metadata, '$.observerWokenAt') >= ?4
		AND json_extract(active.metadata, '$.report') IS NULL
		AND (active.disposition IN ('proposed','accepted') OR (active.disposition = 'cancelled' AND json_extract(active.metadata, '$.settleReason') = '${ADVISORY}'))`;

type Statistics =
	| "none"
	| "production-like"
	| "analysed before the index"
	| "analysed";

function fixture(statistics: Statistics, withIndex = true) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	if (!withIndex) sqlite.exec(`DROP INDEX ${WOKEN}`);
	const insert = sqlite.prepare(
		"INSERT INTO work_items (id, org_id, project_id, title, disposition, metadata, admission_spec_revision, created_at) VALUES (?, ?, ?, 'Example', ?, ?, 'spec-example', ?)",
	);
	let sequence = 0;
	const add = (
		id: string,
		row: {
			org?: string;
			project?: string;
			disposition?: string;
			metadata?: Record<string, unknown>;
		} = {},
	) =>
		insert.run(
			id,
			row.org ?? ORG,
			row.project ?? PROJECT,
			row.disposition ?? "cancelled",
			JSON.stringify(row.metadata ?? {}),
			at(30 * DAY + sequence++ * 1000),
		);
	const push = (extra: Record<string, unknown> = {}) => ({
		repositoryObserver: 1,
		event: { kind: "push", repository: "example/app", branch: "main" },
		...extra,
	});
	const settled = { settleReason: ADVISORY };
	const woken = (ago: number) => ({ observerWokenAt: at(ago) });

	// The project's ordinary Work: what the count used to read in full.
	for (let i = 0; i < 2000; i++)
		add(`ordinary-${i}`, {
			disposition: ["proposed", "accepted", "completed", "cancelled"][i % 4],
			metadata: i % 9 ? {} : { observerWokenAt: at(MINUTE), note: "not one" },
		});
	// Settled commit watches, the bulk of every observation ever recorded.
	for (let i = 0; i < 600; i++)
		add(`watch-${i}`, {
			metadata: push({
				...settled,
				// A third were woken days ago and never reported, a sixth reported.
				...(i % 3 === 0 ? woken(2 * DAY + i * MINUTE) : {}),
				...(i % 6 === 1
					? { ...woken(3 * DAY), report: { stillRed: false } }
					: {}),
			}),
		});
	// Hold a slot now: woken within the window, unreported, open or advisory.
	add("holder-open", {
		disposition: "accepted",
		metadata: push(woken(10 * MINUTE)),
	});
	add("holder-advisory", {
		metadata: push({ ...settled, ...woken(5 * MINUTE) }),
	});
	// Do not: woken too long ago, reported, completed, cancelled for another
	// reason, not an observation, another project, another organization.
	add("stale-open", {
		disposition: "proposed",
		metadata: push(
			woken((REPOSITORY_OBSERVER_WAKE_WINDOW_MINUTES + 1) * MINUTE),
		),
	});
	add("stale-advisory", { metadata: push({ ...settled, ...woken(DAY) }) });
	add("reported-open", {
		disposition: "accepted",
		metadata: push({ ...woken(MINUTE), report: { stillRed: true } }),
	});
	add("reported-advisory", {
		metadata: push({ ...settled, ...woken(MINUTE), report: {} }),
	});
	add("completed-woken", {
		disposition: "completed",
		metadata: push(woken(MINUTE)),
	});
	add("cancelled-other-reason", {
		metadata: push({ settleReason: "superseded", ...woken(MINUTE) }),
	});
	add("cancelled-no-reason", { metadata: push(woken(MINUTE)) });
	add("observer-flag-false", {
		disposition: "accepted",
		metadata: { ...push(woken(MINUTE)), repositoryObserver: 0 },
	});
	for (let i = 0; i < 4; i++) {
		add(`other-project-${i}`, {
			project: OTHER_PROJECT,
			disposition: "accepted",
			metadata: push(woken(MINUTE)),
		});
		add(`other-org-${i}`, {
			org: OTHER_ORG,
			disposition: "accepted",
			metadata: push(woken(MINUTE)),
		});
	}
	// Waiting to take a slot.
	for (const id of ["candidate-a", "candidate-b", "candidate-c", "candidate-d"])
		add(id, { disposition: "proposed", metadata: push() });
	add("candidate-advisory", { metadata: push(settled) });
	add("candidate-other-org", {
		org: OTHER_ORG,
		disposition: "proposed",
		metadata: push(),
	});

	// work_items in November 2026: tens of thousands of rows, a few hundred
	// per project and disposition. A new index has no statistics row.
	if (statistics === "production-like")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'work_items';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_items','uniq_work_items_org_id','50000 500 1'),
				('work_items','idx_work_items_project','50000 400'),
				('work_items','idx_work_items_org_project_created','50000 500 400 1'),
				('work_items','idx_work_items_org_project_disposition','50000 500 400 60'),
				('work_items','idx_work_items_org_disposition','50000 500 70'),
				('work_items','idx_work_items_org_created','50000 500 1'),
				('work_items','idx_work_items_open_repository_observation','40 1 1'),
				('work_items','idx_work_items_deferred_repository_wake','300 1 1');
			ANALYZE sqlite_schema;`);
	if (statistics === "analysed before the index")
		sqlite.exec(
			`ANALYZE; DELETE FROM sqlite_stat1 WHERE idx = '${WOKEN}'; ANALYZE sqlite_schema;`,
		);
	if (statistics === "analysed") sqlite.exec("ANALYZE");

	const statements: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				statements.push(query);
			},
		}),
	);
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail));
	const metadata = (id: string, org = ORG) =>
		JSON.parse(
			String(
				(
					sqlite
						.prepare(
							"SELECT metadata FROM work_items WHERE org_id = ? AND id = ?",
						)
						.get(org, id) as { metadata: string } | undefined
				)?.metadata ?? "null",
			),
		) as Record<string, unknown> | null;
	const snapshot = () =>
		JSON.stringify(
			sqlite
				.prepare("SELECT id, org_id, metadata FROM work_items ORDER BY rowid")
				.all(),
		);
	/** What the claim decided before the count stated the index condition. */
	const legacy = (p: {
		orgId: string;
		projectId: string;
		id: string;
		now: string;
		limit: number | null;
	}) => {
		const since = new Date(
			Date.parse(p.now) - REPOSITORY_OBSERVER_WAKE_WINDOW_MINUTES * MINUTE,
		).toISOString();
		const row = metadata(p.id, p.orgId);
		if (row?.repositoryObserver !== 1) return false;
		if (typeof row.observerWokenAt === "string" && row.observerWokenAt >= since)
			return true;
		if (p.limit === null) return true;
		const { holders } = sqlite
			.prepare(LEGACY_COUNT)
			.get(p.orgId, p.projectId, p.id, since) as { holders: number };
		return Number(holders) < p.limit;
	};
	return { sqlite, db, statements, explain, metadata, snapshot, legacy };
}

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-like" },
	{ statistics: "analysed before the index" },
	{ statistics: "analysed" },
])("taking a wake slot with $statistics statistics", ({ statistics }) => {
	it("decides every claim as the count over the whole project did", async () => {
		const { db, metadata, snapshot, legacy } = fixture(statistics);
		const now = at(0);
		const later = at(-20 * MINUTE);
		const muchLater = at(-45 * MINUTE);
		const claim = async (
			id: string,
			limit: number | null,
			when = now,
			orgId = ORG,
			projectId = PROJECT,
		) => {
			const params = { orgId, projectId, id, now: when, limit };
			const expected = legacy(params);
			const before = snapshot();
			const woken = metadata(id, orgId)?.observerWokenAt;
			const claimed = await claimRepositoryObserverWake(db, params);
			expect(claimed, `${id} limit ${limit} at ${when}`).toBe(expected);
			// A claim writes the wake time of its own row and nothing else.
			if (claimed) expect(metadata(id, orgId)?.observerWokenAt, id).toBe(when);
			else {
				expect(metadata(id, orgId)?.observerWokenAt, id).toBe(woken);
				expect(snapshot(), id).toBe(before);
			}
			return claimed;
		};
		// Two hold a slot. A limit of two is full, of three has one left.
		expect(await claim("candidate-a", 2)).toBe(false);
		expect(await claim("candidate-a", 1)).toBe(false);
		expect(await claim("candidate-a", 3)).toBe(true);
		expect(await claim("candidate-b", 3)).toBe(false);
		// A redelivery of a holder keeps its slot, whatever the limit.
		expect(await claim("candidate-a", 3)).toBe(true);
		expect(await claim("holder-open", 1)).toBe(true);
		expect(await claim("holder-advisory", 0)).toBe(true);
		// A holder is not counted against itself.
		expect(await claim("candidate-b", 4)).toBe(true);
		// Red incidents always take a slot, and count afterwards.
		expect(await claim("candidate-c", null)).toBe(true);
		expect(await claim("candidate-d", 5)).toBe(false);
		expect(await claim("candidate-d", 6)).toBe(true);
		// A settled advisory push can be woken and then holds a slot too.
		expect(await claim("candidate-advisory", 7)).toBe(true);
		// Not observations, not this organization, not there at all.
		expect(await claim("ordinary-9", 99)).toBe(false);
		expect(await claim("observer-flag-false", 99)).toBe(false);
		expect(await claim("candidate-a", 99, now, OTHER_ORG)).toBe(false);
		expect(await claim("missing", 99)).toBe(false);
		// Another organization's and another project's slots are their own.
		expect(await claim("candidate-other-org", 4, now, OTHER_ORG)).toBe(false);
		expect(await claim("candidate-other-org", 5, now, OTHER_ORG)).toBe(true);
		// Observations that held no slot can take one when there is room.
		for (const id of [
			"stale-open",
			"stale-advisory",
			"reported-open",
			"completed-woken",
			"cancelled-other-reason",
			"watch-0",
			"watch-1",
			"watch-2",
		]) {
			await claim(id, 3);
			await claim(id, 50);
		}
		// Later, the first wakes are outside the window and free their slots.
		for (const [id, limit] of [
			["candidate-b", 2],
			["stale-open", 1],
			["candidate-d", 12],
			["candidate-d", 13],
			["holder-open", 3],
		] as const) {
			await claim(id, limit, later);
			await claim(id, limit, muchLater);
		}
	});

	it("reads the claimed row by its key and the slot holders through their index", async () => {
		const { db, statements, explain } = fixture(statistics);
		await claimRepositoryObserverWake(db, {
			orgId: ORG,
			projectId: PROJECT,
			id: "candidate-a",
			now: at(0),
			limit: 3,
		});
		const update = statements.find((query) =>
			query.includes("observerWokenAt"),
		)!;
		const plan = explain(update);
		expect(plan.filter((line) => / work_items /.test(line))).toEqual([
			"SEARCH work_items USING INDEX uniq_work_items_org_id (org_id=? AND id=?)",
		]);
		expect(plan.filter((line) => / active /.test(line))).toEqual([
			`SEARCH active USING INDEX ${WOKEN} (org_id=? AND project_id=?)`,
		]);
		expect(plan.join("\n")).not.toMatch(/SCAN /);
		// A red incident's claim has no count at all.
		statements.length = 0;
		await claimRepositoryObserverWake(db, {
			orgId: ORG,
			projectId: PROJECT,
			id: "candidate-b",
			now: at(0),
			limit: null,
		});
		expect(explain(statements[0]!)).toEqual([
			"SEARCH work_items USING INDEX uniq_work_items_org_id (org_id=? AND id=?)",
		]);
	});

	it("is offered to no other read of Work Items", async () => {
		const { sqlite, db, statements, explain } = fixture(statistics);
		// The index holds the woken, unreported observations and nothing else.
		expect(
			(
				sqlite
					.prepare(
						`SELECT count(*) AS n FROM work_items INDEXED BY ${WOKEN} WHERE json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.observerWokenAt') IS NOT NULL AND json_extract(metadata, '$.report') IS NULL AND (disposition IN ('proposed','accepted') OR (disposition = 'cancelled' AND json_extract(metadata, '$.settleReason') = '${ADVISORY}'))`,
					)
					.get() as { n: number }
			).n,
		).toBe(200 + 2 + 2 + 8);
		await getRepositoryObservation(db, ORG, "holder-open");
		await pendingRepositoryObservations(db, ORG, PROJECT);
		await deferredRepositoryPushObservations(db, 50);
		await deferRepositoryObserverWake(db, {
			orgId: ORG,
			id: "candidate-a",
			now: at(0),
		});
		await releaseRepositoryObserverWake(db, {
			orgId: ORG,
			id: "holder-open",
			now: at(0),
		});
		expect(statements.length).toBeGreaterThanOrEqual(5);
		for (const query of statements)
			expect(explain(query).join("\n"), query).not.toContain(WOKEN);
		// SQLite refuses a partial index whose condition the query does not
		// state, so this cannot change with the statistics.
		for (const query of [
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ?`,
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND id = ?`,
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND disposition IN ('proposed','accepted')`,
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.report') IS NULL`,
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.observerWokenAt') >= ? AND disposition IN ('proposed','accepted')`,
			`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.observerWokenAt') IS NULL AND json_extract(metadata, '$.report') IS NULL AND disposition IN ('proposed','accepted')`,
		])
			expect(() => explain(query), query).toThrow(/no query solution/);
		// Only a read that names woken, unreported observations in a slot
		// disposition qualifies, even in narrower words: it means these rows.
		expect(
			explain(
				`SELECT id FROM work_items INDEXED BY ${WOKEN} WHERE org_id = ? AND project_id = ? AND json_extract(metadata, '$.repositoryObserver') = 1 AND json_extract(metadata, '$.observerWokenAt') >= ? AND json_extract(metadata, '$.report') IS NULL AND disposition IN ('proposed','accepted')`,
			),
		).toEqual([
			`SEARCH work_items USING INDEX ${WOKEN} (org_id=? AND project_id=?)`,
		]);
	});
});

it("decides the same on a database that does not have the index yet", async () => {
	const { db, legacy } = fixture("analysed", false);
	for (const [id, limit] of [
		["candidate-a", 2],
		["candidate-a", 3],
		["candidate-b", 3],
		["holder-open", 0],
		["candidate-c", null],
		["candidate-d", 4],
		["candidate-d", 5],
		["ordinary-9", 99],
	] as const) {
		const params = {
			orgId: ORG,
			projectId: PROJECT,
			id,
			now: at(0),
			limit,
		};
		const expected = legacy(params);
		expect(await claimRepositoryObserverWake(db, params), id).toBe(expected);
	}
});
