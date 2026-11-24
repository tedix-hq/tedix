import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { schemaDdl } from "../../test/schema-ddl";
import { workAgentSessions } from "../../schema/work-agent-sessions";
import {
	osGadgetExecutions,
	osWorkspaceProjects,
} from "../../schema/os-workspaces";
import { tediTasks } from "../../schema/tedi-objectives";
import {
	CONTINUITY_SCOPE_BATCH_SIZE,
	CONTINUITY_SCOPES_PER_STATEMENT,
	CONTINUITY_WORK_ITEMS_PER_STATEMENT,
	listContinuityScopes,
	readStallRecoveryPage,
	type StallRecoveryCursor,
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
	// History shared between scopes. One workspace is linked to projects in
	// all three statements of the page (p-07, then p-09 and p-12, then p-20);
	// p-12 has a second workspace of its own; p-13's link was removed. Another
	// organization has a workspace of the same id.
	const link = sqlite.prepare(
		"INSERT INTO os_workspace_projects(id,organization_id,workspace_id,project_id,status,created_by_kind,created_by_id) VALUES (?,?,?,?,?,'user','ada')",
	);
	for (const [org, workspace, projectId, status] of [
		[ORG, "ws-shared", "p-07", "active"],
		[ORG, "ws-shared", "p-09", "active"],
		[ORG, "ws-shared", "p-12", "active"],
		[ORG, "ws-own", "p-12", "active"],
		[ORG, "ws-shared", "p-13", "removed"],
		[ORG, "ws-shared", "p-20", "active"],
		[OTHER_ORG, "ws-shared", "p-other", "active"],
	] as const)
		link.run(
			`${org}-${workspace}-${projectId}`,
			org,
			workspace,
			projectId,
			status,
		);
	const execution = sqlite.prepare(
		"INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,created_by_kind,created_by_id,runtime_environment,created_at,completed_at) VALUES (?,?,?,'gadget-example','completed','[]','{}','user','ada',?,?,?)",
	);
	for (const [id, org, workspace, environment, createdAt, completedAt] of [
		[
			"e-1",
			ORG,
			"ws-shared",
			"production",
			"2026-11-14T06:00:00.000Z",
			"2026-11-14T12:00:00.000Z",
		],
		["e-2", ORG, "ws-shared", "production", "2026-11-14T09:00:00.000Z", null],
		// Another environment's executions are not this environment's activity.
		["e-3", ORG, "ws-shared", "staging", "2026-12-25T00:00:00.000Z", null],
		[
			"e-4",
			ORG,
			"ws-own",
			"production",
			"2026-11-15T01:00:00.000Z",
			"2026-11-15T07:00:00.000Z",
		],
		[
			"e-5",
			OTHER_ORG,
			"ws-shared",
			"production",
			"2026-11-16T01:00:00.000Z",
			null,
		],
	] as const)
		execution.run(id, org, workspace, environment, createdAt, completedAt);
	// One objective is shared by projects in two statements of the page
	// (p-15 and p-16, then p-21), so it is not a scope of its own.
	sqlite.exec(
		`INSERT INTO tedi_objectives(id,org_id,tedi_id,title,created_at) VALUES ('o-shared','${ORG}','river','Shared objective','${CREATED}');
		 UPDATE projects SET objective_id = 'o-shared' WHERE org_id = '${ORG}' AND id IN ('p-15','p-16','p-21');
		 INSERT INTO tedi_tasks(id,org_id,tedi_id,objective_id,title,created_at,updated_at) VALUES
			('t-1','${ORG}','river','o-shared','Example','2026-11-01T00:00:00.000Z','2026-11-17T09:00:00.000Z'),
			('t-2','${ORG}','river','o-shared','Example','2026-11-02T00:00:00.000Z',NULL),
			('t-3','${ORG}','river','o-small','Example','2026-11-18T10:00:00.000Z',NULL),
			('t-4','${OTHER_ORG}','river','o-shared','Example','2026-12-24T00:00:00.000Z',NULL);`,
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
				('work_attempts','idx_work_attempt_org_item_started','80000 800 2 1 1'),
				('skill_runs','idx_skill_runs_org_work_environment','11000 110 3 3'),
				('skill_runs','idx_skill_runs_org_status','11000 110 30'),
				('projects','idx_projects_status_id','300 150 1'),
				('projects','idx_projects_org_status_id','300 3 2 1'),
				('tedi_objectives','idx_objectives_status_id','200 100 1'),
				('tedi_objectives','idx_objectives_org_status_id','200 2 2 1');
			ANALYZE sqlite_schema;`);
	const statements: string[] = [];
	// The values each statement was bound with, in the order of `statements`.
	const bound: unknown[][] = [];
	const d1 = createD1Facade(sqlite, {
		onPrepare(query) {
			statements.push(query);
		},
	});
	const db = createDbQueryClient(
		new Proxy(d1, {
			get(target, property, receiver) {
				if (property !== "prepare")
					return Reflect.get(target, property, receiver);
				return (query: string) => {
					const statement = target.prepare(query);
					const bind = statement.bind.bind(statement);
					statement.bind = (...values: unknown[]) => {
						bound.push(values);
						return bind(...values);
					};
					return statement;
				};
			},
		}),
	);
	return { sqlite, db, statements, bound };
}

/** The statement that reads sessions, gadget executions and tedi tasks. */
const isHistory = (query: string) => query.includes("os_gadget_executions");

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
	const { gadgets } = one(
		`SELECT max(coalesce(g.completed_at, g.created_at)) AS gadgets FROM os_workspace_projects p
		 JOIN os_gadget_executions g ON g.organization_id = p.organization_id AND g.workspace_id = p.workspace_id
		 WHERE p.organization_id = ? AND p.project_id = ? AND p.status = 'active' AND g.runtime_environment = 'production' AND 'project' = '${scope.kind}'`,
	);
	const { tasks } = one(
		`SELECT max(coalesce(k.updated_at, k.created_at)) AS tasks FROM tedi_tasks k WHERE k.org_id = ?1 AND k.objective_id = ${
			scope.kind === "project"
				? "(SELECT objective_id FROM projects WHERE org_id = ?1 AND id = ?2)"
				: "?2"
		}`,
	);
	// Every fixture timestamp is the same ISO text shape, so text order is time order.
	const lastActivityAt = [CREATED, attempts, runs, sessions, gadgets, tasks]
		.filter((value): value is string => typeof value === "string")
		.sort()
		.at(-1);
	return {
		pendingCount: Number(pending),
		failedCount: Number(failed),
		lastActivityAt,
	};
}

/**
 * A scope's latest activity as the inventory computed it before it read index
 * ends: the latest of every timestamp of its whole history, compared as times.
 */
function latestByTime(sqlite: DatabaseSync, scope: ContinuityScope) {
	const column = scope.kind === "project" ? "project_id" : "objective_id";
	const objective =
		scope.kind === "project"
			? "(SELECT objective_id FROM projects WHERE org_id = ?1 AND id = ?2)"
			: "?2";
	const { latest } = sqlite
		.prepare(
			`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(at))) AS latest FROM (
			 SELECT ?3 AS at
			 UNION ALL SELECT coalesce(a.finished_at, a.heartbeat_at, a.started_at) FROM work_items w
				JOIN work_attempts a ON a.work_item_id = w.id AND a.org_id = w.org_id WHERE w.org_id = ?1 AND w.${column} = ?2
			 UNION ALL SELECT coalesce(r.completed_at, r.started_at) FROM work_items w
				JOIN skill_runs r ON r.work_item_id = w.id AND r.organization_id = w.org_id WHERE w.org_id = ?1 AND w.${column} = ?2
			 UNION ALL SELECT last_event_at FROM work_agent_sessions WHERE organization_id = ?1 AND project_id = ?2 AND 'project' = '${scope.kind}'
			 UNION ALL SELECT coalesce(g.completed_at, g.created_at) FROM os_workspace_projects p
				JOIN os_gadget_executions g ON g.organization_id = p.organization_id AND g.workspace_id = p.workspace_id
				WHERE p.organization_id = ?1 AND p.project_id = ?2 AND p.status = 'active' AND g.runtime_environment = 'production' AND 'project' = '${scope.kind}'
			 UNION ALL SELECT coalesce(k.updated_at, k.created_at) FROM tedi_tasks k WHERE k.org_id = ?1 AND k.objective_id = ${objective})`,
		)
		.get(scope.orgId, scope.id, CREATED) as { latest: string };
	return latest;
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
		// Gadget executions reach every project linked to the workspace, and
		// tedi tasks every project of the objective, in whichever statement of
		// the page the project sits.
		for (const key of ["project:p-07", "project:p-09", "project:p-20"])
			expect(byKey.get(key)!.lastActivityAt, key).toBe(
				"2026-11-14T12:00:00.000Z",
			);
		expect(byKey.get("project:p-12")!.lastActivityAt).toBe(
			"2026-11-15T07:00:00.000Z",
		);
		expect(byKey.get("project:p-13")!.lastActivityAt).toBe(CREATED);
		for (const key of ["project:p-15", "project:p-16", "project:p-21"])
			expect(byKey.get(key)!.lastActivityAt, key).toBe(
				"2026-11-17T09:00:00.000Z",
			);
		expect(byKey.get("objective:o-small")!.lastActivityAt).toBe(
			"2026-11-18T10:00:00.000Z",
		);
		// 25 scopes in three statements of at most 10, then one statement per
		// further slice: p-03 three, p-04 two (the second finds nothing left),
		// p-05 one (nothing left), o-big one.
		expect(statements.filter((query) => !isHistory(query))).toHaveLength(
			3 + 3 + 2 + 1 + 1,
		);
		// One more statement per 10 scopes for the history outside Work.
		expect(statements.filter(isHistory)).toHaveLength(3);
		// No extra columns leak to callers.
		expect(Object.keys(scopes[0]!)).not.toContain("workEnd");
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
		// History that does not hang off Work Items is not read with the Work...
		for (const plan of [first, continued])
			for (const table of ["SEARCH g ", "SEARCH k ", "SEARCH l USING INDEX"])
				expect(plan.join("\n")).not.toContain(table);
		// ...but by a statement of its own, which reads only the end of an
		// index per history: first the last day that has a timestamp, then
		// the last timestamp of each format. These are covering index reads.
		const history = explain(sqlite, statements.find(isHistory)!);
		const sessions =
			"USING COVERING INDEX idx_work_agent_sessions_org_project_last_event (organization_id=? AND project_id=?";
		const executions =
			"USING COVERING INDEX idx_os_gadget_executions_org_workspace_environment_latest (organization_id=? AND workspace_id=? AND runtime_environment=?";
		const tasks =
			"USING COVERING INDEX idx_tasks_org_objective_latest (org_id=? AND objective_id=?";
		expect(
			history.filter((line) => /^SEARCH (?:l|g|o|k|n)(?:_top)? /.test(line)),
		).toEqual(
			[
				["l", sessions, "last_event_at", ""],
				["g", executions, "completed_at", ""],
				["o", executions, "created_at", " AND completed_at=?"],
				["k", tasks, "updated_at", ""],
				["n", tasks, "created_at", " AND updated_at=?"],
			].flatMap(([name, index, column, extra]) =>
				Array.from({ length: 2 }, () => [
					`SEARCH ${name} ${index}${extra} AND ${column}>? AND ${column}<?)`,
					`SEARCH ${name}_top ${index}${extra})`,
					`SEARCH ${name}_top ${index}${extra})`,
				]).flat(),
			),
		);
		expect(history).toContain(
			"SEARCH p USING INDEX os_workspace_projects_org_project_status_idx (organization_id=? AND project_id=? AND status=?)",
		);
		expect(history.join("\n")).not.toMatch(
			/SCAN (?:p|l|g|o|k|n)\b|TEMP B-TREE FOR ORDER BY/,
		);
		expect(history.join("\n")).not.toMatch(
			/work_items|work_attempts|skill_runs/,
		);
	});

	it("reads a shared workspace and a shared objective once per page", async () => {
		const { sqlite, db, statements, bound } = fixture(productionLike);
		await listAll(db, ORG);
		const shared: string[] = [];
		const linked: string[] = [];
		for (const [index, query] of statements.entries()) {
			if (!isHistory(query)) continue;
			const rows = sqlite
				.prepare(query)
				.all(...(bound[index] as string[])) as Array<{
				source: string;
				key: string | null;
				id: string | null;
			}>;
			for (const row of rows) {
				if (row.source === "link") linked.push(`${row.key} ${row.id}`);
				if (row.source === "workspace" || row.source === "objective")
					shared.push(`${row.source} ${row.id}`);
			}
		}
		// Every link is still reported, in all three statements...
		expect(linked.sort()).toEqual([
			"project:p-07 ws-shared",
			"project:p-09 ws-shared",
			"project:p-12 ws-own",
			"project:p-12 ws-shared",
			"project:p-20 ws-shared",
		]);
		// ...but the executions of ws-shared and the tasks of o-shared are
		// aggregated by the first statement that meets them and by no later one.
		// o-big has no tasks; it is read once and returns a row with no activity.
		expect(shared.sort()).toEqual([
			"objective o-big",
			"objective o-shared",
			"objective o-small",
			"workspace ws-own",
			"workspace ws-shared",
		]);
	});
});

describe("continuity inventory results", () => {
	it("resumes a bounded cron slice without assessing partial counts or losing scopes", async () => {
		const { db, sqlite, statements } = fixture(true);
		const expected = await listContinuityScopes(db);
		statements.length = 0;
		let cursor: StallRecoveryCursor = { after: "" };
		const observed: ContinuityScope[] = [];
		let ticks = 0;
		do {
			const start = statements.length;
			const { scopes, ...next } = await readStallRecoveryPage(
				db,
				JSON.parse(JSON.stringify(cursor)),
				"production",
			);
			expect(statements.slice(start).filter((q) => !isHistory(q))).toHaveLength(
				1,
			);
			for (const scope of scopes)
				expect(next.pending?.some((p) => p.key === scope.key) ?? false).toBe(
					false,
				);
			observed.push(...scopes);
			cursor = next;
			ticks++;
			expect(ticks).toBeLessThan(30);
		} while (cursor.after || cursor.pending?.length);
		expect(ticks).toBeGreaterThan(2);
		expect(observed.sort((a, b) => a.key.localeCompare(b.key))).toEqual(
			expected.sort((a, b) => a.key.localeCompare(b.key)),
		);
		sqlite.close();
	});
	it("compares only the two latest timestamps even with 203k reports on the last day", async () => {
		const { db, statements, bound } = fixture(true);
		await listAll(db, ORG);
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(
				schemaDdl(
					workAgentSessions,
					osWorkspaceProjects,
					osGadgetExecutions,
					tediTasks,
				),
			);
			sqlite.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<203000)
				INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,created_at,updated_at,last_event_at)
				SELECT 's-'||i, '${ORG}', 'ada', 'codex', 's-'||i, 'p-06', 'working', '${CREATED}', '${CREATED}', '${CREATED}',
				CASE WHEN i%2=0 THEN '2026-11-13 23:30:00' ELSE '2026-11-13T11:00:00.000Z' END FROM n`);
			let timestampsCompared = 0;
			sqlite.function("julianday", (value) => {
				if (typeof value !== "string") return null;
				timestampsCompared++;
				return (
					Date.parse(
						value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
					) /
						86400000 +
					2440587.5
				);
			});
			const index = statements.findIndex(isHistory);
			sqlite
				.prepare(`SELECT max(julianday(last_event_at)) FROM work_agent_sessions
				WHERE organization_id=? AND project_id=? AND +last_event_at >= '' AND last_event_at >=
				(SELECT substr(last_event_at,1,10) FROM work_agent_sessions WHERE organization_id=? AND project_id=? AND +last_event_at >= '' ORDER BY last_event_at DESC LIMIT 1)`)
				.get(ORG, "p-06", ORG, "p-06");
			expect(timestampsCompared).toBe(203000);
			timestampsCompared = 0;
			const rows = sqlite
				.prepare(statements[index]!)
				.all(...(bound[index] as string[]));
			expect(rows.find((row) => row.key === "project:p-06")).toMatchObject({
				activity: "2026-11-13T23:30:00.000Z",
			});
			expect(timestampsCompared).toBe(2);
		} finally {
			sqlite.close();
		}
	});

	it("returns the same scopes with or without an organization filter", async () => {
		const { db } = fixture(true);
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

	it("finds the latest time among timestamps of both stored shapes", async () => {
		const { sqlite, db } = fixture(true);
		// SQL defaults write `2026-11-13 23:30:00`, the API writes
		// `2026-11-13T11:00:00.000Z`. Within one day the second shape is the
		// later text whatever its time, so the end of an index is not always
		// the latest time.
		sqlite.exec(
			`INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES
				('lane-sql','${ORG}','ada','codex','session-sql','p-06','working','${CREATED}','2026-11-13 23:30:00','${CREATED}','${CREATED}'),
				('lane-old','${ORG}','ada','codex','session-old','p-06','working','${CREATED}','2026-11-12T23:59:59.999Z','${CREATED}','${CREATED}'),
				('lane-a','${ORG}','ada','codex','session-a','p-08','working','${CREATED}','2026-11-13T08:00:00.000Z','${CREATED}','${CREATED}'),
				('lane-b','${ORG}','ada','codex','session-b','p-08','working','${CREATED}','2026-11-13 09:00:00','${CREATED}','${CREATED}'),
				('lane-c','${ORG}','ada','codex','session-c','p-10','working','${CREATED}','2026-11-13 09:00:00','${CREATED}','${CREATED}'),
				('lane-unbound','${ORG}','ada','codex','session-unbound',NULL,'working','${CREATED}','2026-12-30T00:00:00.000Z','${CREATED}','${CREATED}'),
				('lane-foreign','${OTHER_ORG}','ada','codex','session-foreign','p-08','working','${CREATED}','2026-12-30T00:00:00.000Z','${CREATED}','${CREATED}');
			 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,created_by_kind,created_by_id,runtime_environment,created_at,completed_at) VALUES
				('e-open-own','${ORG}','ws-own','gadget-example','running','[]','{}','user','ada','production','2026-11-15 08:00:00',NULL),
				('e-open-old','${ORG}','ws-own','gadget-example','running','[]','{}','user','ada','production','2026-11-15T06:00:00.000Z',NULL),
				('e-done-sql','${ORG}','ws-shared','gadget-example','completed','[]','{}','user','ada','production','2026-11-14 01:00:00','2026-11-14 12:30:00'),
				('e-started-late','${ORG}','ws-shared','gadget-example','completed','[]','{}','user','ada','production','2026-12-20T00:00:00.000Z','2026-11-13T00:00:00.000Z'),
				('e-no-environment','${ORG}','ws-shared','gadget-example','completed','[]','{}','user','ada',NULL,'2026-12-21T00:00:00.000Z',NULL);
			 INSERT INTO tedi_tasks(id,org_id,tedi_id,objective_id,title,created_at,updated_at) VALUES
				('t-sql','${ORG}','river','o-shared','Example','2026-11-01 00:00:00','2026-11-17 09:30:00'),
				('t-new','${ORG}','river','o-small','Example','2026-11-18 10:30:00',NULL),
				('t-created-late','${ORG}','river','o-small','Example','2026-12-19T00:00:00.000Z','2026-11-03T00:00:00.000Z'),
				('t-only','${ORG}','river','o-big','Example','2026-11-19 00:00:00',NULL),
				('t-ad-hoc','${ORG}','river',NULL,'Example','2026-12-22T00:00:00.000Z',NULL);`,
		);
		const scopes = await listAll(db, ORG);
		expect(scopes).toHaveLength(25);
		for (const scope of scopes)
			expect
				.soft(scope.lastActivityAt, scope.key)
				.toBe(latestByTime(sqlite, scope));
		const byKey = new Map(scopes.map((scope) => [scope.key, scope]));
		expect(byKey.get("project:p-06")!.lastActivityAt).toBe(
			"2026-11-13T23:30:00.000Z",
		);
		expect(byKey.get("project:p-08")!.lastActivityAt).toBe(
			"2026-11-13T09:00:00.000Z",
		);
		// An execution that started after its completion time, or a task
		// created after its update, counts at the completion or the update.
		expect(byKey.get("project:p-12")!.lastActivityAt).toBe(
			"2026-11-15T08:00:00.000Z",
		);
		expect(byKey.get("project:p-07")!.lastActivityAt).toBe(
			"2026-11-14T12:30:00.000Z",
		);
		expect(byKey.get("project:p-15")!.lastActivityAt).toBe(
			"2026-11-17T09:30:00.000Z",
		);
		expect(byKey.get("objective:o-small")!.lastActivityAt).toBe(
			"2026-11-18T10:30:00.000Z",
		);
		expect(byKey.get("objective:o-big")!.lastActivityAt).toBe(
			"2026-11-19T00:00:00.000Z",
		);
	});
});
