import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	cronDarknessSourceIntentId,
	type FleetCronExecutionRow,
	findDarkCognitiveCrons,
	findDarkCognitiveCronsFromLedger,
	upsertCronDarknessWorkItems,
} from "./flywheel/cron-darkness";
import { EXPECTED_COGNITIVE_CRONS } from "./flywheel/cron-executions";

/**
 * Flywheel WS5 chaos-test seam — the cron-darkness check over the WS0
 * execution ledger, against a REAL in-memory SQLite engine via the production
 * createDbClient path (work-items-blockers.test.ts pattern).
 *
 * Contract under test: a cognitive cron whose latest durable stamp is older
 * than 1.5× its expected interval is dark and must produce a finding; a
 * healthy ledger stays quiet; repeated dark checks converge on ONE alert work
 * item per tedi (deterministic sourceIntentId + uniq_work_items_org_source_intent).
 */

const REAL_DDL = `
CREATE TABLE tedis (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	policy_pack_id TEXT,
	runtime_overrides TEXT,
	runtime_state TEXT NOT NULL DEFAULT 'standby'
);
CREATE TABLE policy_packs (
	id TEXT PRIMARY KEY NOT NULL,
	definition TEXT NOT NULL
);
CREATE TABLE skill_entries (
	id TEXT PRIMARY KEY NOT NULL,
	slug TEXT
);
CREATE TABLE skill_schedules (
	id TEXT PRIMARY KEY NOT NULL,
	skill_id TEXT NOT NULL,
	tedi_id TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tedi_cron_executions (
	id TEXT PRIMARY KEY NOT NULL,
	tedi_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	cron_name TEXT NOT NULL,
	fire_key TEXT NOT NULL,
	run_id TEXT,
	status TEXT NOT NULL DEFAULT 'running',
	started_at TEXT NOT NULL,
	finished_at TEXT,
	transitions TEXT,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX idx_tedi_cron_executions_fire
	ON tedi_cron_executions (tedi_id, fire_key);
CREATE TABLE skill_runs (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	tedi_id TEXT NOT NULL,
	skill_slug TEXT,
	status TEXT NOT NULL,
	started_at TEXT,
	completed_at TEXT,
	created_by TEXT,
	work_item_id TEXT
);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX uniq_work_items_org_source_intent
	ON work_items (org_id, source_intent_id);
`;

function realDb(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const ORG = "org-1";
const TEDI = "tedi-1";
const NOW = new Date("2026-07-16T12:00:00.000Z").getTime();

const hoursAgo = (h: number) =>
	new Date(NOW - h * 60 * 60 * 1000).toISOString();

function ledgerRow(
	overrides: Partial<FleetCronExecutionRow> & {
		cronName: string;
		startedAt: string;
	},
): FleetCronExecutionRow {
	return {
		tediId: TEDI,
		orgId: ORG,
		tediSlug: "cto",
		status: "success",
		mechanism: "legacy_cron",
		// Participation clock defaults to the latest stamp (fresh tedi) unless
		// a test models a longer-participating tedi explicitly.
		firstStartedAt: overrides.firstStartedAt ?? overrides.startedAt,
		...overrides,
	};
}

/**
 * All six crons stamped comfortably inside their 1.5× grace windows.
 * `participationHours` back-dates each cron's FIRST stamp — a tedi that has
 * been participating in the cognitive tier for that long.
 */
function healthyLedger(participationHours?: number): FleetCronExecutionRow[] {
	return EXPECTED_COGNITIVE_CRONS.map((cron) =>
		ledgerRow({
			cronName: cron.name,
			startedAt: hoursAgo(cron.intervalHours * 0.5),
			...(participationHours !== undefined
				? { firstStartedAt: hoursAgo(participationHours) }
				: {}),
		}),
	);
}

describe("findDarkCognitiveCronsFromLedger", () => {
	it("flags a cron whose last stamp is older than 1.5x its interval (chaos: stamping killed)", () => {
		const rows = healthyLedger().map((row) =>
			// Kill brain-reflection's stamping: last stamp 13h ago vs 8h interval
			// (grace boundary 12h).
			row.cronName === "brain-reflection"
				? { ...row, startedAt: hoursAgo(13), status: "failure" }
				: row,
		);

		const dark = findDarkCognitiveCronsFromLedger(rows, NOW);

		expect(dark).toHaveLength(1);
		expect(dark[0]).toMatchObject({
			tediId: TEDI,
			orgId: ORG,
			cronName: "brain-reflection",
			expectedIntervalHours: 8,
			lastStartedAt: hoursAgo(13),
			lastStatus: "failure",
			hoursSinceLastExecution: 13,
		});
	});

	it("stays quiet on a healthy ledger, including exactly at the grace boundary", () => {
		const rows = healthyLedger().map((row) =>
			// objective-review exactly AT 1.5×4h = 6h: not yet dark (strict >).
			row.cronName === "objective-review"
				? { ...row, startedAt: hoursAgo(6) }
				: row,
		);

		expect(findDarkCognitiveCronsFromLedger(rows, NOW)).toEqual([]);
	});

	it("flags a never-stamped DAILY cron on a healthy tedi via the participation clock", () => {
		// The real dead-inference scenario: skill-development (24h, grace 36h)
		// silently dropped from the schedule while every sibling keeps stamping
		// FRESH (≤0.5× interval old). On a healthy tedi the latest sibling
		// stamps never exceed a daily cron's 36h grace, so a latest-stamp
		// reference clock could NEVER flag this. The reference must be the
		// tedi's participation clock — its oldest cognitive stamp (30 days ago).
		const rows = healthyLedger(720).filter(
			(row) => row.cronName !== "skill-development",
		);

		const dark = findDarkCognitiveCronsFromLedger(rows, NOW);

		expect(dark).toHaveLength(1);
		expect(dark[0]).toMatchObject({
			cronName: "skill-development",
			expectedIntervalHours: 24,
			lastStartedAt: null,
			lastStatus: null,
			hoursSinceLastExecution: 720,
		});
	});

	it("flags a never-stamped fast cron the same way", () => {
		// grounding-review (6h) never stamped; the tedi has participated for 48h.
		const rows = healthyLedger(48).filter(
			(row) => row.cronName !== "grounding-review",
		);

		const dark = findDarkCognitiveCronsFromLedger(rows, NOW);

		const groundingFindings = dark.filter(
			(cron) => cron.cronName === "grounding-review",
		);
		expect(groundingFindings).toHaveLength(1);
		expect(groundingFindings[0]).toMatchObject({
			lastStartedAt: null,
			lastStatus: null,
			hoursSinceLastExecution: 48,
		});
	});

	it("does not page a fresh tedi whose slower crons have not had time to fire", () => {
		// Tedi provisioned 2h ago: only objective-review (4h) has stamped. The
		// 24h crons must not page yet.
		const rows = [
			ledgerRow({ cronName: "objective-review", startedAt: hoursAgo(2) }),
		];

		expect(findDarkCognitiveCronsFromLedger(rows, NOW)).toEqual([]);
	});

	it("produces no findings for a tedi with zero cognitive stamps", () => {
		expect(findDarkCognitiveCronsFromLedger([], NOW)).toEqual([]);
	});

	it("does not flag loops explicitly disabled for a participating tedi", () => {
		const rows = healthyLedger(720).map((row) => ({
			...row,
			startedAt: hoursAgo(500),
		}));
		const enabledByTedi = new Map([[TEDI, new Set<string>()]]);

		expect(findDarkCognitiveCronsFromLedger(rows, NOW, enabledByTedi)).toEqual(
			[],
		);
	});
});

describe("findDarkCognitiveCrons (real SQLite)", () => {
	function seedTedi(
		sqlite: DatabaseSync,
		id: string,
		runtimeState: string,
		slug = id,
	) {
		sqlite
			.prepare(
				`INSERT INTO tedis (id, organization_id, slug, runtime_state) VALUES (?, ?, ?, ?)`,
			)
			.run(id, ORG, slug, runtimeState);
	}

	function seedExecution(
		sqlite: DatabaseSync,
		tediId: string,
		cronName: string,
		startedAt: string,
		status = "success",
	) {
		sqlite
			.prepare(
				`INSERT INTO tedi_cron_executions (id, tedi_id, org_id, cron_name, fire_key, status, started_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				crypto.randomUUID(),
				tediId,
				ORG,
				cronName,
				`cron:${cronName}:${startedAt}`,
				status,
				startedAt,
				startedAt,
			);
	}

	it("reads only the latest stamp per cron, ignores non-cognitive crons and non-active tedis", async () => {
		const { db, sqlite } = realDb();
		seedTedi(sqlite, TEDI, "active", "cto");
		seedTedi(sqlite, "tedi-archived", "archived");

		for (const cron of EXPECTED_COGNITIVE_CRONS) {
			// An old stale stamp AND a fresh one — MAX(started_at) must win.
			seedExecution(sqlite, TEDI, cron.name, hoursAgo(100), "failure");
			seedExecution(
				sqlite,
				TEDI,
				cron.name,
				hoursAgo(cron.intervalHours * 0.5),
			);
		}
		// Non-cognitive watcher cron gone stale: never a darkness finding.
		seedExecution(sqlite, TEDI, "deploy-reconciler", hoursAgo(500));
		// Archived tedi fully dark: excluded.
		seedExecution(sqlite, "tedi-archived", "brain-reflection", hoursAgo(500));

		expect(await findDarkCognitiveCrons(db, { now: NOW })).toEqual([]);
	});

	it("treats a fresh scheduled dogfood skill run as the active cognitive schedule", async () => {
		const { db, sqlite } = realDb();
		seedTedi(sqlite, TEDI, "active", "cto");
		for (const cron of EXPECTED_COGNITIVE_CRONS) {
			seedExecution(sqlite, TEDI, cron.name, hoursAgo(100), "failure");
			sqlite
				.prepare(
					`INSERT INTO skill_runs
						(id, organization_id, tedi_id, skill_slug, status, started_at, completed_at, created_by)
					 VALUES (?, ?, ?, ?, 'completed', ?, ?, 'schedule')`,
				)
				.run(
					crypto.randomUUID(),
					ORG,
					TEDI,
					`platform-${cron.name}-dogfood`,
					hoursAgo(cron.intervalHours * 0.5),
					hoursAgo(cron.intervalHours * 0.4),
				);
		}

		expect(await findDarkCognitiveCrons(db, { now: NOW })).toEqual([]);
	});

	it("flags the dark cron end-to-end from a fabricated stale ledger", async () => {
		const { db, sqlite } = realDb();
		seedTedi(sqlite, TEDI, "active", "cto");
		for (const cron of EXPECTED_COGNITIVE_CRONS) {
			seedExecution(
				sqlite,
				TEDI,
				cron.name,
				cron.name === "knowledge-freshness"
					? hoursAgo(40) // 24h interval, grace 36h → dark
					: hoursAgo(cron.intervalHours * 0.5),
			);
		}

		const dark = await findDarkCognitiveCrons(db, { now: NOW });

		expect(dark).toHaveLength(1);
		expect(dark[0]).toMatchObject({
			tediId: TEDI,
			tediSlug: "cto",
			cronName: "knowledge-freshness",
			expectedIntervalHours: 24,
			lastStartedAt: hoursAgo(40),
			hoursSinceLastExecution: 40,
		});
	});

	it("flags a never-scheduled daily cron end-to-end: fresh latest stamps, 20-day-old first stamps", async () => {
		// MIN(started_at) must ride out of the ledger as the participation
		// clock: every present cron has a FRESH latest stamp (inside grace) but
		// first stamped 480h ago; skill-development never stamped at all.
		const { db, sqlite } = realDb();
		seedTedi(sqlite, TEDI, "active", "cto");
		for (const cron of EXPECTED_COGNITIVE_CRONS) {
			if (cron.name === "skill-development") continue;
			seedExecution(sqlite, TEDI, cron.name, hoursAgo(480));
			seedExecution(
				sqlite,
				TEDI,
				cron.name,
				hoursAgo(cron.intervalHours * 0.5),
			);
		}

		const dark = await findDarkCognitiveCrons(db, { now: NOW });

		expect(dark).toHaveLength(1);
		expect(dark[0]).toMatchObject({
			tediId: TEDI,
			cronName: "skill-development",
			expectedIntervalHours: 24,
			lastStartedAt: null,
			lastStatus: null,
			hoursSinceLastExecution: 480,
		});
	});
});

describe("upsertCronDarknessWorkItems dedupe", () => {
	it("two consecutive dark checks produce ONE alert work item, refreshed not duplicated", async () => {
		const { db, sqlite } = realDb();

		const day1 = [
			{
				tediId: TEDI,
				orgId: ORG,
				tediSlug: "cto",
				cronName: "brain-reflection",
				expectedIntervalHours: 8,
				expectedCronCount: 6,
				lastStartedAt: hoursAgo(13),
				lastStatus: "failure",
				hoursSinceLastExecution: 13,
			},
		];
		await upsertCronDarknessWorkItems(db, day1, hoursAgo(0));

		// Next dark day: same tedi, worse — and a second cron now dark too.
		const day2 = [
			{ ...day1[0]!, hoursSinceLastExecution: 37 },
			{
				tediId: TEDI,
				orgId: ORG,
				tediSlug: "cto",
				cronName: "objective-review",
				expectedIntervalHours: 4,
				expectedCronCount: 6,
				lastStartedAt: hoursAgo(10),
				lastStatus: "success",
				hoursSinceLastExecution: 10,
			},
		];
		const second = await upsertCronDarknessWorkItems(
			db,
			day2,
			new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
		);

		expect(second.sourceIntentIds).toEqual([cronDarknessSourceIntentId(TEDI)]);
		const rows = sqlite
			.prepare(
				`SELECT title, description, disposition, priority, accountable_owner_type, source_intent_id
				 FROM work_items WHERE org_id = ?`,
			)
			.all(ORG) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			disposition: "proposed",
			priority: "high",
			accountable_owner_type: "system",
			source_intent_id: cronDarknessSourceIntentId(TEDI),
		});
		expect(rows[0]!.title).toContain("2/6 overdue");
		expect(String(rows[0]!.description)).toContain("objective-review");
		expect(String(rows[0]!.description)).toContain("dark for 37h");
	});

	it("does not reopen an item an operator already resolved", async () => {
		const { db, sqlite } = realDb();
		const dark = [
			{
				tediId: TEDI,
				orgId: ORG,
				tediSlug: "cto",
				cronName: "brain-reflection",
				expectedIntervalHours: 8,
				expectedCronCount: 6,
				lastStartedAt: hoursAgo(13),
				lastStatus: "failure" as string | null,
				hoursSinceLastExecution: 13,
			},
		];
		await upsertCronDarknessWorkItems(db, dark, hoursAgo(0));
		sqlite
			.prepare(
				`UPDATE work_items SET disposition = 'completed' WHERE org_id = ?`,
			)
			.run(ORG);

		await upsertCronDarknessWorkItems(db, dark, hoursAgo(0));

		const rows = sqlite
			.prepare(`SELECT disposition FROM work_items WHERE org_id = ?`)
			.all(ORG) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.disposition).toBe("completed");
	});
});
