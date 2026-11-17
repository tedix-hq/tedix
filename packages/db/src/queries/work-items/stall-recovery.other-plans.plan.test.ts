import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listFactoryScoreboard } from "../factory-scoreboard";
import {
	getOsGadgetExecution,
	getOsGadgetExecutionByRunId,
	listOsGadgetExecutions,
} from "../os-workspaces/executions";
import { hasLiveGadgetStateFence } from "../os-workspaces/gadget-state";
import { listProjectPortfolio } from "../projects";
import { getActiveTasks, listTasks } from "../tedi-objectives";
import {
	getWorkAgentSession,
	listTediLaneSources,
	listWorkAgentSessions,
	listWorkProjectContributorSources,
	reportWorkAgentSessionStatus,
} from "../work-agent-sessions";
import { readAttentionFactoryLinks } from "../work-attention";
import { listCommitmentChanges } from "./commitment-changes";
import { readWorkMapSnapshot } from "./map";
import { listContinuityScopes } from "./stall-recovery";

/**
 * The three indexes the stalled-work inventory reads its latest activity from
 * are partial on a condition that is true for every row, so SQLite offers them
 * only to a statement that states that condition, and only the inventory does.
 * This file runs the other statements on those tables and compares each plan
 * with the plan it has in a database without the three indexes.
 */
const NEW_INDEXES = [
	"idx_work_agent_sessions_org_project_last_event",
	"idx_os_gadget_executions_org_workspace_environment_latest",
	"idx_tasks_org_objective_latest",
];
const TABLES = /work_agent_sessions|os_gadget_executions|tedi_tasks/;
const ORG = "fictional-orchard";
const NOW = "2026-11-17T12:00:00.000Z";
const SINCE = "2026-11-10T12:00:00.000Z";

/**
 * Shapes of the size the main database had in November 2026: tens of
 * thousands of sessions and executions, fewer tasks. A new index has no
 * statistics row until the database is analyzed again, so none is given one.
 */
const PRODUCTION_LIKE_STATISTICS = `ANALYZE;
	DELETE FROM sqlite_stat1;
	INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
		('work_agent_sessions','uniq_work_agent_sessions_org_user_harness_session','25000 500 250 120 1'),
		('work_agent_sessions','idx_work_agent_sessions_org_user_last_event','25000 500 250 1'),
		('work_agent_sessions','idx_work_agent_sessions_org_user_session','25000 500 250 1'),
		('work_agent_sessions','idx_work_agent_sessions_org_project','25000 500 80'),
		('os_gadget_executions','idx_os_gadget_executions_completed','20000 1'),
		('os_gadget_executions','idx_os_gadget_executions_run','20000 400 1 1'),
		('os_gadget_executions','os_gadget_executions_org_workspace_environment_idx','20000 400 60 60'),
		('os_gadget_executions','os_gadget_executions_org_idx','20000 400'),
		('os_gadget_executions','os_gadget_executions_gadget_idx','20000 40 1'),
		('tedi_tasks','idx_tasks_objective','5000 25'),
		('tedi_tasks','idx_tasks_tedi_status','5000 50 10'),
		('work_items','uniq_work_items_org_id','50000 500 1'),
		('work_items','idx_work_items_project','50000 400'),
		('work_attempts','uniq_work_attempt_number','80000 800 2 1'),
		('skill_runs','idx_skill_runs_org_status','11000 110 30');
	ANALYZE sqlite_schema;`;

function database(productionLike: boolean, withNewIndexes: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	if (!withNewIndexes)
		for (const name of NEW_INDEXES) sqlite.exec(`DROP INDEX ${name}`);
	if (productionLike) sqlite.exec(PRODUCTION_LIKE_STATISTICS);
	return sqlite;
}

function explain(sqlite: DatabaseSync, query: string) {
	return sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail));
}

/** Every statement the other readers and writers of the three tables run. */
async function otherStatements() {
	const statements: string[] = [];
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(
		`INSERT INTO projects(id,org_id,key,name,created_at) VALUES ('p-1','${ORG}','P1','Project','${NOW}');`,
	);
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				statements.push(query);
			},
		}),
	);
	const session = {
		organizationId: ORG,
		userId: "ada",
		harness: "codex" as const,
		sessionKey: "session",
	};
	await reportWorkAgentSessionStatus(db, {
		...session,
		replacesSessionKey: "session-before",
		state: "working",
		summary: "",
		label: "",
		projectId: "p-1",
		now: NOW,
	});
	await getWorkAgentSession(db, session);
	for (const includeEnded of [false, true])
		await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: "ada",
			includeEnded,
			now: NOW,
		});
	await listWorkProjectContributorSources(db, {
		organizationId: ORG,
		projectId: "p-1",
	});
	await listTediLaneSources(db, ORG, SINCE);
	await listProjectPortfolio(db, { orgId: ORG, limit: 50 });
	await listProjectPortfolio(db, {
		orgId: ORG,
		limit: 50,
		excludeProjectId: "p-1",
	});
	await readWorkMapSnapshot(db, { orgId: ORG, now: NOW });

	await readAttentionFactoryLinks(db, ORG, "ada", SINCE);
	await listFactoryScoreboard(db, { orgId: ORG, now: new Date(NOW) });
	await getOsGadgetExecution(db, { organizationId: ORG, executionId: "e-1" });
	await getOsGadgetExecutionByRunId(db, { organizationId: ORG, runId: "r-1" });
	await getOsGadgetExecutionByRunId(db, {
		organizationId: ORG,
		tediId: "river",
		runId: "r-1",
	});
	await listOsGadgetExecutions(db, { organizationId: ORG, gadgetId: "g-1" });
	await listOsGadgetExecutions(
		db,
		{ organizationId: ORG, gadgetId: "g-1" },
		{ status: "completed" },
	);
	await hasLiveGadgetStateFence(db, {
		organizationId: ORG,
		workspaceId: "ws-1",
		gadgetId: "g-1",
		executionId: "e-1",
		executionEpoch: 0,
		tediId: "river",
		revisionId: "rev-1",
		runtimeEnvironment: "production",
		capability: "state.write",
	});
	await listCommitmentChanges(db, SINCE, NOW, "production");

	await listTasks(db, { orgId: ORG });
	await listTasks(db, { orgId: ORG, objectiveId: "o-1" });
	await listTasks(db, { objectiveId: "o-1", status: "pending" });
	await listTasks(db, { tediId: "river", objectiveId: "o-1" });
	await getActiveTasks(db, "river");

	// The inventory's own history statement is the one meant to change.
	await listContinuityScopes(db, "", ORG);
	const history = statements.filter((query) => query.includes('"l_top"'));
	return {
		history,
		others: [...new Set(statements)].filter(
			(query) => TABLES.test(query) && !history.includes(query),
		),
	};
}

describe.each([
	{ statistics: "no statistics", productionLike: false },
	{ statistics: "production-like statistics", productionLike: true },
])("stalled-work history indexes with $statistics", ({ productionLike }) => {
	it("leave every other statement on the three tables on its plan", async () => {
		const { history, others } = await otherStatements();
		expect(history).toHaveLength(1);
		// Sessions, executions and tasks are each read and written here.
		expect(others.length).toBeGreaterThanOrEqual(20);
		for (const table of [
			"work_agent_sessions",
			"os_gadget_executions",
			"tedi_tasks",
		])
			expect(
				others.filter((query) => query.includes(table)).length,
				table,
			).toBeGreaterThanOrEqual(4);
		const before = database(productionLike, false);
		const after = database(productionLike, true);
		for (const query of others) {
			const plan = explain(after, query);
			expect.soft(plan, query).toEqual(explain(before, query));
			for (const name of NEW_INDEXES)
				expect.soft(plan.join("\n"), query).not.toContain(name);
		}
		// The comparison can tell: the inventory's own statement does change.
		expect(explain(after, history[0]!)).not.toEqual(
			explain(before, history[0]!),
		);
	});

	it("hold every row and are refused to a statement that does not state their condition", () => {
		const sqlite = database(productionLike, true);
		sqlite.exec(
			`INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at) VALUES
				('lane-bound','${ORG}','ada','codex','bound','p-1','working','${NOW}','${NOW}'),
				('lane-unbound','${ORG}','ada','codex','unbound',NULL,'working','${NOW}','');
			 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,created_by_kind,created_by_id,runtime_environment,completed_at) VALUES
				('e-default','${ORG}','ws-1','g-1','running','[]','{}','user','ada','production',NULL),
				('e-no-environment','${ORG}','ws-1','g-1','completed','[]','{}','user','ada',NULL,'${NOW}');
			 INSERT INTO tedi_tasks(id,org_id,tedi_id,objective_id,title,created_at,updated_at) VALUES
				('t-objective','${ORG}','river','o-1','Example','${NOW}',NULL),
				('t-ad-hoc','${ORG}','river',NULL,'Example','','${NOW}');`,
		);
		for (const [table, index, condition, scope] of [
			[
				"work_agent_sessions",
				"idx_work_agent_sessions_org_project_last_event",
				"+last_event_at >= ''",
				"organization_id = ? AND project_id = ?",
			],
			[
				"os_gadget_executions",
				"idx_os_gadget_executions_org_workspace_environment_latest",
				"+created_at >= ''",
				"organization_id = ? AND workspace_id = ? AND runtime_environment = ?",
			],
			[
				"tedi_tasks",
				"idx_tasks_org_objective_latest",
				"+created_at >= ''",
				"org_id = ? AND objective_id = ?",
			],
		] as const) {
			const count = (query: string) =>
				(sqlite.prepare(query).get() as { rows: number }).rows;
			expect(
				count(
					`SELECT count(*) AS rows FROM ${table} INDEXED BY ${index} WHERE ${condition}`,
				),
				table,
			).toBe(count(`SELECT count(*) AS rows FROM ${table} NOT INDEXED`));
			expect(count(`SELECT count(*) AS rows FROM ${table} NOT INDEXED`)).toBe(
				2,
			);
			// Naming every leading column is not enough without the condition.
			expect(
				() =>
					sqlite.prepare(
						`SELECT count(*) FROM ${table} INDEXED BY ${index} WHERE ${scope}`,
					),
				table,
			).toThrow(/no query solution/);
			expect(
				explain(
					sqlite,
					`SELECT count(*) FROM ${table} WHERE ${scope} AND ${condition}`,
				).join("\n"),
			).toContain(index);
		}
	});
});
