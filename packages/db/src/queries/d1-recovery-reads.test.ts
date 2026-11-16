import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { findOrphanRuns } from "./cognitive-runtime";
import { sweepStaleFailedDelegationWorkItems } from "./work-items/stale-delegation-sweep";

const migration = "20261116000545_d1_recovery_read_indexes";
const now = new Date("2026-11-16T00:00:00.000Z");
const startedAt = "2026-11-15T23:00:00.000Z";

function insertEvent(sqlite: ReturnType<typeof createMigratedSqlite>) {
	const statement = sqlite.prepare(`INSERT INTO tedi_runtime_events
		(id,organization_id,tedi_id,run_id,kind,runtime_backend,created_at)
		VALUES (?,?,?,?,?,'cloudflare-agents',?)`);
	return (
		id: string,
		run: string | null,
		kind = "run.started",
		org = "org-1",
		tedi = "tedi-1",
	) => statement.run(id, org, tedi, run, kind, startedAt);
}

it("backfills only starts with a terminal receipt for the same tenant, tedi and run", () => {
	const sqlite = createMigratedSqlite({
		foreignKeys: false,
		beforeMigration: migration,
	});
	const event = insertEvent(sqlite);
	event("done-start", "done");
	event("done-end", "done", "run.completed");
	event("open-start", "open");
	event("other-org", "open", "run.failed", "org-2");
	event("other-tedi", "open", "run.canceled", "org-1", "tedi-2");
	event("null-start", null);
	sqlite.exec(
		readFileSync(
			new URL(`../../drizzle/${migration}/migration.sql`, import.meta.url),
			"utf8",
		),
	);
	expect(
		sqlite
			.prepare(
				"SELECT id,terminal_seen FROM tedi_runtime_events WHERE kind='run.started' ORDER BY id",
			)
			.all(),
	).toEqual([
		{ id: "done-start", terminal_seen: 1 },
		{ id: "null-start", terminal_seen: 0 },
		{ id: "open-start", terminal_seen: 0 },
	]);
});

it.each(["run.completed", "run.failed", "run.canceled"])(
	"marks both arrival orders for %s and preserves the marker after log rotation",
	(kind) => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const event = insertEvent(sqlite);
		event("start-first", "first");
		event("end-second", "first", kind);
		event("end-first", "second", kind);
		event("start-second", "second");
		event("duplicate-start", "second");
		event("other-org-start", "first", "run.started", "org-2");
		event("other-tedi-start", "first", "run.started", "org-1", "tedi-2");
		sqlite.exec("DELETE FROM tedi_runtime_events WHERE kind <> 'run.started'");
		expect(
			sqlite
				.prepare("SELECT id,terminal_seen FROM tedi_runtime_events ORDER BY id")
				.all(),
		).toEqual([
			{ id: "duplicate-start", terminal_seen: 1 },
			{ id: "other-org-start", terminal_seen: 0 },
			{ id: "other-tedi-start", terminal_seen: 0 },
			{ id: "start-first", terminal_seen: 1 },
			{ id: "start-second", terminal_seen: 1 },
		]);
	},
);

it.each([undefined, "org-1"])(
	"visits only unfinished starts among 2,000 completed runs (scope %s)",
	async (organizationId) => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const event = insertEvent(sqlite);
		for (let i = 0; i < 2000; i++) {
			event(`start-${i}`, `run-${i}`);
			event(`end-${i}`, `run-${i}`, "run.completed");
		}
		event("pending-1", "pending-1");
		event("pending-2", "pending-2");
		let visits = 0;
		sqlite.function("visit_candidate", (value) => {
			visits++;
			return value;
		});
		let plan = "";
		const db = createDbClient(
			createD1Facade({
				prepare(query) {
					if (!query.startsWith("select")) return sqlite.prepare(query);
					plan = sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => row.detail)
						.join("\n");
					const instrumented = query.replace(
						'"tedi_runtime_events"."run_id" is not null',
						'visit_candidate("tedi_runtime_events"."run_id") is not null',
					);
					expect(instrumented).not.toBe(query);
					return sqlite.prepare(instrumented);
				},
				exec: (query) => sqlite.exec(query),
			}),
		);
		expect(
			(await findOrphanRuns(db, { now, organizationId })).map(
				(row) => row.runId,
			),
		).toEqual(["pending-1", "pending-2"]);
		expect(visits).toBe(2);
		expect(plan).toContain(
			`SEARCH tedi_runtime_events USING INDEX idx_tedi_runtime_events_${organizationId ? "org_" : ""}unfinished`,
		);
		expect(plan).not.toMatch(
			/SCAN (?:tedi_runtime_events|term|act|own|ar|res|ok|mapped_term|mapped_act)\b/,
		);
	},
);

it("seeks stale delegation candidates by disposition and age, with indexed Attempt probes", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	let plan = "";
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				if (query.startsWith("select") && query.includes('from "work_items"'))
					plan = sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => row.detail)
						.join("\n");
			},
		}),
	);
	await sweepStaleFailedDelegationWorkItems(db, { now: now.toISOString() });
	expect(plan).toMatch(
		/SEARCH work_items USING INDEX idx_work_items_stale_delegation \(disposition=\? AND <expr><\?\)/,
	);
	expect(plan).not.toMatch(
		/SCAN (?:work_items|active_attempt|latest_attempt|any_attempt)\b/,
	);
});
