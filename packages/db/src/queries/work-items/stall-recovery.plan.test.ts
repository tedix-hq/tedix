import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	CONTINUITY_SCOPE_BATCH_SIZE,
	CONTINUITY_SCOPES_PER_STATEMENT,
	CONTINUITY_WORK_ITEMS_PER_STATEMENT,
	listContinuityScopes,
	type ContinuityScope,
} from "./stall-recovery";

const ORG = "fictional-orchard";
const OTHER_ORG = "fictional-forest";
const CREATED = "2026-10-01T00:00:00.000Z";
const FIRST_SLICE =
	CONTINUITY_WORK_ITEMS_PER_STATEMENT / CONTINUITY_SCOPES_PER_STATEMENT;
const SLICE = CONTINUITY_WORK_ITEMS_PER_STATEMENT;

/** Work Items per scope; everything else has none. */
const WORK = {
	// Three continuation statements: 200, then 2,000, 2,000 and the last 250.
	"project:p-03": FIRST_SLICE + 2 * SLICE + 250,
	// Ends exactly on a slice boundary.
	"project:p-04": FIRST_SLICE + SLICE,
	// Exactly the first slice.
	"project:p-05": FIRST_SLICE,
	"project:p-06": 3,
	"objective:o-big": FIRST_SLICE + 250,
	"objective:o-small": 2,
} as const;

function fixture(productionLikeStatistics: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// The fixture writes Attempt history directly, without admissions.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	sqlite.exec(
		`INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('river','${ORG}','River','river','active');
		 INSERT INTO tedi_objectives(id,org_id,tedi_id,title,created_at) VALUES
			('o-big','${ORG}','river','Big objective','${CREATED}'),
			('o-small','${ORG}','river','Small objective','${CREATED}'),
			('o-other','${OTHER_ORG}','river','Foreign objective','${CREATED}');
		 INSERT INTO projects(id,org_id,key,name,created_at) VALUES ('p-other','${OTHER_ORG}','OTHER','Foreign project','${CREATED}');`,
	);
	const project = sqlite.prepare(
		"INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES (?,?,?,?,'river',?)",
	);
	for (let i = 0; i < 23; i++) {
		const id = `p-${String(i).padStart(2, "0")}`;
		project.run(id, ORG, id.toUpperCase(), `Project ${i}`, CREATED);
	}
	const work = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,project_id,objective_id,disposition,admission_spec_revision,created_at,updated_at) VALUES (?,?,'Example',?,?,?,'spec-example',?,?)",
	);
	const attempt = sqlite.prepare(
		"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,attempt_number,started_at,heartbeat_at,finished_at,runtime_state,outcome) VALUES (?,?,?,'tedi','river',?,?,?,?,?,?)",
	);
	const run = sqlite.prepare(
		"INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,work_item_id,status,runtime_environment,started_at,completed_at) VALUES (?1,?2,'skill-example','river',?1,?3,'completed','production',?4,?5)",
	);
	// Interleave the scopes so one scope's rowids are not one contiguous run.
	const longest = Math.max(...Object.values(WORK));
	for (let n = 0; n < longest; n++)
		for (const [key, total] of Object.entries(WORK)) {
			if (n >= total) continue;
			const [kind, scopeId] = key.split(":") as [string, string];
			const id = `${scopeId}-w${n}`;
			// Open Work sits in every slice, the last one included.
			const disposition =
				n % 97 === 0 || n === total - 1
					? "accepted"
					: n % 89 === 0
						? "proposed"
						: n % 83 === 0
							? "cancelled"
							: "completed";
			work.run(
				id,
				ORG,
				kind === "project" ? scopeId : null,
				kind === "objective" ? scopeId : null,
				disposition,
				CREATED,
				CREATED,
			);
			const day = String(1 + (n % 28)).padStart(2, "0");
			if (n % 3 === 0)
				attempt.run(
					`${id}-a1`,
					ORG,
					id,
					1,
					`2026-10-${day}T01:00:00.000Z`,
					`2026-10-${day}T02:00:00.000Z`,
					n % 2 ? `2026-10-${day}T03:00:00.000Z` : null,
					n % 2 ? (n % 7 === 0 ? "failed" : "finished") : "running",
					n % 2 ? (n % 7 === 0 ? "failed" : "succeeded") : null,
				);
			if (n % 50 === 0)
				run.run(
					`${id}-r`,
					ORG,
					id,
					`2026-10-${day}T04:00:00.000Z`,
					`2026-10-${day}T05:00:00.000Z`,
				);
			// Another organization's row that names the same project is not this scope's Work.
			if (n === 100 && kind === "project") {
				work.run(
					`${id}-foreign`,
					OTHER_ORG,
					scopeId,
					null,
					"accepted",
					CREATED,
					CREATED,
				);
				attempt.run(
					`${id}-foreign-a`,
					OTHER_ORG,
					`${id}-foreign`,
					1,
					"2026-12-01T00:00:00.000Z",
					"2026-12-01T00:00:00.000Z",
					"2026-12-01T00:00:00.000Z",
					"failed",
					"failed",
				);
			}
		}
	// The latest activity of each large scope sits in a different slice:
	// p-03 in its last slice (a failed Attempt on open Work), p-04 in a middle
	// slice (a skill run), o-big in the first slice.
	attempt.run(
		"p-03-latest",
		ORG,
		`p-03-w${WORK["project:p-03"] - 1}`,
		9,
		"2026-11-10T00:00:00.000Z",
		"2026-11-10T00:00:00.000Z",
		"2026-11-10T08:15:30.250Z",
		"failed",
		"failed",
	);
	run.run(
		"p-04-latest",
		ORG,
		"p-04-w1000",
		"2026-11-11T00:00:00.000Z",
		"2026-11-11T09:00:00.000Z",
	);
	attempt.run(
		"o-big-latest",
		ORG,
		"o-big-w5",
		9,
		"2026-11-12T00:00:00.000Z",
		"2026-11-12T10:00:00.000Z",
		null,
		"running",
		null,
	);
	sqlite.exec(
		`INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES ('lane','${ORG}','ada','codex','session','p-06','working','2026-11-13T00:00:00.000Z','2026-11-13T11:00:00.000Z','${CREATED}','${CREATED}');`,
	);
	// Shapes of the size the main database had in November 2026: tens of
	// thousands of Work Items and Attempts, a few hundred scopes.
	if (productionLikeStatistics)
		// Only these shapes: statistics taken from the small fixture tables
		// would describe nothing real.
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1;
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('work_items','idx_work_items_project','50000 400'),
				('work_items','idx_work_items_objective','50000 400'),
				('work_items','idx_work_items_org_objective','50000 500 400'),
				('work_items','idx_work_items_org_project_created','50000 500 400 1'),
				('work_items','idx_work_items_org_project_disposition','50000 500 400 60'),
				('work_items','uniq_work_items_org_id','50000 500 1'),
				('work_items','idx_work_items_org_disposition','50000 500 70'),
				('work_items','idx_work_items_org_created','50000 500 1'),
				('work_attempts','uniq_work_attempt_number','80000 800 2 1'),
				('work_attempts','idx_work_attempt_org_started','80000 800 1'),
				('skill_runs','idx_skill_runs_org_work_environment','11000 110 3 3'),
				('skill_runs','idx_skill_runs_org_status','11000 110 30'),
				('projects','idx_projects_status_id','300 150 1'),
				('projects','idx_projects_org_status_id','300 3 2 1'),
				('tedi_objectives','idx_objectives_status_id','200 100 1'),
				('tedi_objectives','idx_objectives_org_status_id','200 2 2 1');
			ANALYZE sqlite_schema;`);
	const statements: string[] = [];
	const db = createDbQueryClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				statements.push(query);
			},
		}),
	);
	return { sqlite, db, statements };
}

function explain(sqlite: DatabaseSync, query: string) {
	return sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail));
}

/** The same numbers, one scope at a time, with no paging at all. */
function expected(sqlite: DatabaseSync, scope: ContinuityScope) {
	const column = scope.kind === "project" ? "project_id" : "objective_id";
	const one = (query: string) =>
		sqlite.prepare(query).get(scope.orgId, scope.id) as Record<string, unknown>;
	const { pending } = one(
		`SELECT count(*) AS pending FROM work_items WHERE org_id = ? AND ${column} = ? AND disposition IN ('proposed','accepted')`,
	);
	const { failed } = one(
		`SELECT count(*) AS failed FROM work_items w JOIN work_attempts a ON a.work_item_id = w.id AND a.org_id = w.org_id
		 WHERE w.org_id = ? AND w.${column} = ? AND a.outcome = 'failed' AND w.disposition NOT IN ('completed','cancelled')`,
	);
	const { attempts } = one(
		`SELECT max(coalesce(a.finished_at, a.heartbeat_at, a.started_at)) AS attempts FROM work_items w
		 JOIN work_attempts a ON a.work_item_id = w.id AND a.org_id = w.org_id WHERE w.org_id = ? AND w.${column} = ?`,
	);
	const { runs } = one(
		`SELECT max(coalesce(r.completed_at, r.started_at)) AS runs FROM work_items w
		 JOIN skill_runs r ON r.work_item_id = w.id AND r.organization_id = w.org_id WHERE w.org_id = ? AND w.${column} = ?`,
	);
	const { sessions } = one(
		`SELECT max(last_event_at) AS sessions FROM work_agent_sessions WHERE organization_id = ? AND project_id = ? AND 'project' = '${scope.kind}'`,
	);
	// Every fixture timestamp is the same ISO text shape, so text order is time order.
	const lastActivityAt = [CREATED, attempts, runs, sessions]
		.filter((value): value is string => typeof value === "string")
		.sort()
		.at(-1);
	return {
		pendingCount: Number(pending),
		failedCount: Number(failed),
		lastActivityAt,
	};
}

async function listAll(
	db: ReturnType<typeof fixture>["db"],
	orgId?: string,
): Promise<ContinuityScope[]> {
	const all: ContinuityScope[] = [];
	for (let after = ""; ;) {
		const page = await listContinuityScopes(db, after, orgId);
		all.push(...page);
		if (page.length < CONTINUITY_SCOPE_BATCH_SIZE) return all;
		after = page.at(-1)!.key;
	}
}

describe.each([
	{ statistics: "no statistics", productionLike: false },
	{ statistics: "production-like statistics", productionLike: true },
])("continuity inventory slices with $statistics", ({ productionLike }) => {
	it("returns every scope's whole history, however many statements it took", async () => {
		const { sqlite, db, statements } = fixture(productionLike);
		const scopes = await listAll(db, ORG);
		expect(scopes.map((scope) => scope.key)).toEqual(
			[
				"objective:o-big",
				"objective:o-small",
				...Array.from(
					{ length: 23 },
					(_, i) => `project:p-${String(i).padStart(2, "0")}`,
				),
			].sort(),
		);
		for (const scope of scopes)
			expect
				.soft(
					{
						key: scope.key,
						pendingCount: scope.pendingCount,
						failedCount: scope.failedCount,
						lastActivityAt: scope.lastActivityAt,
					},
					scope.key,
				)
				.toEqual({ key: scope.key, ...expected(sqlite, scope) });
		const byKey = new Map(scopes.map((scope) => [scope.key, scope]));
		expect(byKey.get("project:p-03")).toMatchObject({
			lastActivityAt: "2026-11-10T08:15:30.250Z",
			hasOwner: 1,
			tediId: "river",
		});
		expect(byKey.get("project:p-04")!.lastActivityAt).toBe(
			"2026-11-11T09:00:00.000Z",
		);
		expect(byKey.get("objective:o-big")!.lastActivityAt).toBe(
			"2026-11-12T10:00:00.000Z",
		);
		expect(byKey.get("project:p-06")!.lastActivityAt).toBe(
			"2026-11-13T11:00:00.000Z",
		);
		expect(byKey.get("project:p-00")).toMatchObject({
			pendingCount: 0,
			failedCount: 0,
			lastActivityAt: CREATED,
		});
		// 25 scopes in three statements of at most 10, then one statement per
		// further slice: p-03 three, p-04 two (the second finds nothing left),
		// p-05 one (nothing left), o-big one.
		expect(statements).toHaveLength(3 + 3 + 2 + 1 + 1);
		// No extra columns leak to callers.
		expect(Object.keys(scopes[0]!)).not.toContain("workEnd");
	});

	it("returns the same scopes with or without an organization filter", async () => {
		const { db } = fixture(productionLike);
		const mine = await listAll(db, ORG);
		const everyone = await listAll(db);
		expect(everyone.filter((scope) => scope.orgId === ORG)).toEqual(mine);
		expect(
			everyone
				.filter((scope) => scope.orgId !== ORG)
				.map((scope) => [scope.key, scope.pendingCount, scope.failedCount]),
		).toEqual([
			["objective:o-other", 0, 0],
			["project:p-other", 0, 0],
		]);
	});

	it("walks each scope's Work in rowid order between two bounds", async () => {
		const { sqlite, db, statements } = fixture(productionLike);
		await listAll(db, ORG);
		const first = explain(sqlite, statements[0]!);
		const continued = explain(
			sqlite,
			statements.find((query) => query.includes('"w".rowid >'))!,
		);
		const reads = (plan: string[], alias: string) =>
			plan.filter((line) => line.startsWith(`SEARCH ${alias} `));
		// Finding where the slice ends reads the index alone, in rowid order...
		expect(reads(first, "x")).toEqual([
			"SEARCH x USING COVERING INDEX idx_work_items_project (project_id=?)",
			"SEARCH x USING COVERING INDEX idx_work_items_org_objective (org_id=? AND objective_id=?)",
		]);
		expect(reads(continued, "x")).toEqual([
			"SEARCH x USING COVERING INDEX idx_work_items_project (project_id=? AND rowid>?)",
			"SEARCH x USING COVERING INDEX idx_work_items_org_objective (org_id=? AND objective_id=? AND rowid>?)",
		]);
		// ...and the Work rows are read only up to that end. The last two lines
		// are the per-scope totals joined back by key, not the Work table.
		const totals = [
			"SEARCH w USING AUTOMATIC COVERING INDEX (key=?) LEFT-JOIN",
		];
		expect(reads(first, "w")).toEqual([
			"SEARCH w USING INDEX idx_work_items_project (project_id=? AND rowid<?)",
			"SEARCH w USING INDEX idx_work_items_org_objective (org_id=? AND objective_id=? AND rowid<?)",
			...totals,
		]);
		expect(reads(continued, "w")).toEqual([
			"SEARCH w USING INDEX idx_work_items_project (project_id=? AND rowid>? AND rowid<?)",
			"SEARCH w USING INDEX idx_work_items_org_objective (org_id=? AND objective_id=? AND rowid>? AND rowid<?)",
			...totals,
		]);
		for (const plan of [first, continued]) {
			const details = plan.join("\n");
			expect(details).not.toMatch(/SCAN (?:p|o|r|g|k|t|c|x|a|l)\b/);
			// Only the materialized slice is ever scanned under the name `w`.
			expect(plan.filter((line) => line === "SCAN w")).toHaveLength(2);
			expect(details).toContain(
				"SEARCH a USING INDEX uniq_work_attempt_number (org_id=? AND work_item_id=?)",
			);
			expect(details).toContain(
				"SEARCH r USING INDEX idx_skill_runs_org_work_environment (organization_id=? AND work_item_id=? AND runtime_environment=?)",
			);
		}
		// History that does not hang off Work Items is read once, with the first slice.
		expect(first.join("\n")).toContain("os_gadget_executions");
		for (const table of ["SEARCH g ", "SEARCH k ", "SEARCH l USING INDEX"])
			expect(continued.join("\n")).not.toContain(table);
	});
});
