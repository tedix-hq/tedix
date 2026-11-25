import {
	and,
	desc,
	eq,
	gt,
	gte,
	isNull,
	isNotNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	alias as sqliteAlias,
	type AnySQLiteColumn,
	type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { alias as pgAlias, type PgTable } from "drizzle-orm/pg-core";
import { coreTable } from "../../core-store/client";
import { anyIds, coreStore, jsonRead } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	learningImprovementProposals as d1LearningImprovementProposals,
	learningInteractionEvents as d1LearningInteractionEvents,
} from "../../schema/learning-feedback";
import {
	anyOsGadgetExecution,
	osGadgetExecutions as d1OsGadgetExecutions,
	osWorkspaceProjects as d1OsWorkspaceProjects,
} from "../../schema/os-workspaces";
import { platformCronCheckpoints as d1PlatformCronCheckpoints } from "../../schema/platform-cron-executions";
import {
	anyTediTask,
	tediTasks as d1TediTasks,
} from "../../schema/tedi-objectives";
import {
	anyWorkAgentSessionReport,
	workAgentSessions as d1WorkAgentSessions,
} from "../../schema/work-agent-sessions";
import {
	workInteractionAttention as d1WorkInteractionAttention,
	workInteractions as d1WorkInteractions,
} from "../../schema/work-factory";
import { workItems as d1WorkItems } from "../../schema/work-items";

export const CONTINUITY_SCOPE_BATCH_SIZE = 100;

export interface ContinuityScope {
	key: string;
	id: string;
	orgId: string;
	kind: "project" | "objective";
	name: string;
	policy: string | null;
	createdAt: string;
	tediId: string | null;
	slug: string | null;
	hasOwner: number;
	lastActivityAt: string;
	pendingCount: number;
	failedCount: number;
}

/**
 * How much one inventory statement may read. A statement that walked a whole
 * page of 100 scopes and all their Work read about 127,000 rows and held the
 * main database for about 1.5 s (query insights, 15 to 16 Nov 2026). Each
 * statement now covers at most this many scopes and this many Work Items, so
 * the first read of a scope takes WORK_ITEMS / SCOPES of its Work Items.
 * Agent sessions, gadget executions and tedi tasks have no per-statement
 * limit; `readContinuityHistory` reads them in a statement of their own.
 */
export const CONTINUITY_SCOPES_PER_STATEMENT = 10;
export const CONTINUITY_WORK_ITEMS_PER_STATEMENT = 2_000;

/** One statement's rows: the public scope plus where its Work slice ended. */
type ContinuityScopeSlice = ContinuityScope & {
	workEnd: number | string | null;
	/** The objective whose tedi tasks count as this scope's activity. */
	objectiveId: string | null;
};

interface ContinuitySliceParams {
	after: string;
	orgId: string | undefined;
	environment: string;
	scopeLimit: number;
	/** Read only this scope, to continue its Work past `workAfter`. */
	only?: string;
	/** D1 uses rowids; Postgres uses text IDs. Null starts from the first. */
	workAfter: number | string | null;
	workLimit: number;
	/** Cron can omit empty, unconfigured scopes; interactive inventory cannot. */
	recoveryOnly?: boolean;
}

/**
 * Materialize a bounded scope page and a bounded slice of its Work once.
 * Correlated history scans per scope saturated D1 when Attention polling
 * repeated this inventory. CROSS JOIN keeps the page outside indexed history
 * lookups; SQLite must not scan runtime history to build an automatic index.
 * Joins retain tenant scope.
 *
 * `workEnd` is the rowid of the last Work Item this statement may read for the
 * scope, or NULL when the slice reaches the scope's end. The two Work indexes
 * are named because both end in the rowid, which lets SQLite walk one scope's
 * Work in rowid order and stop at the limit; any other index would read the
 * whole scope for every slice.
 *
 * The Attempt index is named too. `uniq_work_attempt_number` and
 * `idx_work_attempt_org_item_started` both start with the organization and the
 * Work Item, so SQLite rates them equal for this read and its pick would
 * otherwise follow index creation order and statistics.
 */
// Raw: needs AS MATERIALIZED CTEs and CROSS JOIN join-order pinning, which Drizzle cannot emit.
function readContinuityScopeSlice(
	db: DbQueryClient,
	{
		after,
		orgId,
		environment,
		scopeLimit,
		only,
		workAfter,
		workLimit,
		recoveryOnly = false,
	}: ContinuitySliceParams,
): Promise<ContinuityScopeSlice[]> {
	if (coreStore(db) === "postgres")
		return readContinuityScopeSlicePostgres(db, {
			after,
			orgId,
			environment,
			scopeLimit,
			only,
			workAfter,
			workLimit,
			recoveryOnly,
		});
	const onlyProject = only?.startsWith("project:") ? only.slice(8) : undefined;
	const onlyObjective = only?.startsWith("objective:")
		? only.slice(10)
		: undefined;
	const pastWorkAfter = (column: string) =>
		workAfter === null
			? sql``
			: sql`AND ${sql.identifier(column)}.rowid > ${workAfter}`;
	return db.all<ContinuityScopeSlice>(sql`
 WITH project_page AS MATERIALIZED (
 SELECT 'project:' || p.id AS key, p.id, p.org_id AS orgId, 'project' AS kind, p.name,
 CASE WHEN json_type(p.metadata, '$.continuity') = 'object' THEN json_extract(p.metadata, '$.continuity') END AS policy, p.created_at AS createdAt,
 coalesce(p.lead_tedi_id, o.tedi_id) AS owner, p.objective_id AS objectiveId
 FROM projects p LEFT JOIN tedi_objectives o ON o.id = p.objective_id AND o.org_id = p.org_id AND o.status = 'active'
  WHERE p.status = 'active'
  ${
		recoveryOnly
			? sql`AND (json_type(p.metadata, '$.continuity') = 'object' OR EXISTS (
  SELECT 1 FROM work_items w WHERE w.org_id = p.org_id AND w.project_id = p.id AND w.disposition IN ('proposed','accepted')
  ))`
			: sql``
	}
 AND p.id > ${after.startsWith("project:") ? after.slice(8) : ""}
 ${after && !after.startsWith("project:") && after > "project:" ? sql`AND p.id < ${""}` : sql``}
 ${only === undefined ? sql`` : onlyProject === undefined ? sql`AND p.id < ${""}` : sql`AND p.id = ${onlyProject}`}
 ${orgId !== undefined ? sql`AND p.org_id = ${orgId}` : sql``}
 ORDER BY p.id LIMIT ${scopeLimit}
 ), objective_page AS MATERIALIZED (
 SELECT 'objective:' || o.id, o.id, o.org_id, 'objective', o.title,
 CASE WHEN json_type(o.gate_config, '$.continuity') = 'object' THEN json_extract(o.gate_config, '$.continuity') END, o.created_at,
 o.tedi_id, o.id
  FROM tedi_objectives o WHERE o.status = 'active'
  ${
		recoveryOnly
			? sql`AND (json_type(o.gate_config, '$.continuity') = 'object' OR EXISTS (
  SELECT 1 FROM work_items w WHERE w.org_id = o.org_id AND w.objective_id = o.id AND w.disposition IN ('proposed','accepted')
  ))`
			: sql``
	}
 AND o.id > ${after.startsWith("objective:") ? after.slice(10) : ""}
 ${after && !after.startsWith("objective:") && after > "objective:" ? sql`AND o.id < ${""}` : sql``}
 ${only === undefined ? sql`` : onlyObjective === undefined ? sql`AND o.id < ${""}` : sql`AND o.id = ${onlyObjective}`}
 ${orgId !== undefined ? sql`AND o.org_id = ${orgId}` : sql``}
 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.org_id AND p.objective_id = o.id AND p.status = 'active')
 ORDER BY o.id LIMIT ${scopeLimit}
 ), scopes AS (
 SELECT * FROM project_page UNION ALL SELECT * FROM objective_page
 ), scope_page AS MATERIALIZED (
 SELECT * FROM scopes ORDER BY key LIMIT ${scopeLimit}
 ), page AS MATERIALIZED (
 SELECT s.*, CASE s.kind
 WHEN 'project' THEN (SELECT x.rowid FROM work_items x INDEXED BY idx_work_items_project
 WHERE x.project_id = s.id ${pastWorkAfter("x")} ORDER BY x.rowid LIMIT 1 OFFSET ${workLimit - 1})
 ELSE (SELECT x.rowid FROM work_items x INDEXED BY idx_work_items_org_objective
 WHERE x.org_id = s.orgId AND x.objective_id = s.id ${pastWorkAfter("x")} ORDER BY x.rowid LIMIT 1 OFFSET ${workLimit - 1})
 END AS workEnd
 FROM scope_page s
 ), scope_work AS MATERIALIZED (
 SELECT s.key, w.id AS workItemId, w.org_id AS orgId, w.disposition
 FROM page s CROSS JOIN work_items w INDEXED BY idx_work_items_project
 ON w.project_id = s.id ${pastWorkAfter("w")} AND w.rowid <= coalesce(s.workEnd, 9223372036854775807) AND w.org_id = s.orgId
 WHERE s.kind = 'project'
 UNION ALL
 SELECT s.key, w.id, w.org_id, w.disposition
 FROM page s CROSS JOIN work_items w INDEXED BY idx_work_items_org_objective
 ON w.org_id = s.orgId AND w.objective_id = s.id ${pastWorkAfter("w")} AND w.rowid <= coalesce(s.workEnd, 9223372036854775807)
 WHERE s.kind = 'objective'
 ), work_counts AS (
 SELECT key, sum(disposition IN ('proposed','accepted')) AS pendingCount FROM scope_work GROUP BY key
 ), attempt_activity AS MATERIALIZED (
 SELECT w.key, max(julianday(coalesce(a.finished_at, a.heartbeat_at, a.started_at))) AS activity,
 sum(a.outcome = 'failed' AND w.disposition NOT IN ('completed','cancelled')) AS failedCount
 FROM scope_work w CROSS JOIN work_attempts a INDEXED BY uniq_work_attempt_number ON a.work_item_id = w.workItemId AND a.org_id = w.orgId GROUP BY w.key
 ), activity AS (
 SELECT key, activity FROM attempt_activity
 UNION ALL
 SELECT w.key, max(julianday(CASE WHEN r.status IN ('completed','failed','canceled') THEN coalesce(r.completed_at, r.started_at) ELSE coalesce(r.last_reconciled_at, r.started_at) END))
 FROM scope_work w CROSS JOIN skill_runs r ON r.work_item_id = w.workItemId AND r.organization_id = w.orgId
 WHERE r.runtime_environment = ${environment} GROUP BY w.key
 ), latest_activity AS (
 SELECT key, max(activity) AS activity FROM activity GROUP BY key
 )
 SELECT s.key, s.id, s.orgId, s.kind, s.name, s.policy, strftime('%Y-%m-%dT%H:%M:%fZ', s.createdAt) AS createdAt,
 coalesce(t.id, c.id) AS tediId, coalesce(t.slug, c.slug) AS slug, (t.id IS NOT NULL) AS hasOwner,
 strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(s.createdAt), coalesce(l.activity, julianday(s.createdAt)))) AS lastActivityAt,
 coalesce(w.pendingCount, 0) AS pendingCount, coalesce(a.failedCount, 0) AS failedCount, s.workEnd, s.objectiveId
 FROM page s LEFT JOIN tedis t ON t.id = s.owner AND t.organization_id = s.orgId AND t.status = 'active'
 LEFT JOIN tedis c ON c.id = json_extract(s.policy, '$.coordinatorTediId') AND c.organization_id = s.orgId AND c.status = 'active'
 LEFT JOIN latest_activity l ON l.key = s.key
 LEFT JOIN work_counts w ON w.key = s.key
 LEFT JOIN attempt_activity a ON a.key = s.key
 ORDER BY s.key
 `);
}

/** Latest activity that does not hang off Work Items, in the inventory's timestamp text. */
interface ContinuityHistoryRow {
	source: "session" | "link" | "workspace" | "objective";
	/** Scope key, on `session` and `link` rows. */
	key: string | null;
	orgId: string | null;
	/** Workspace id on `link` and `workspace` rows, objective id on `objective` rows. */
	id: string | null;
	/** Latest session report, execution completion or task update. */
	activity: string | null;
	/** Latest start among executions not completed, or tasks never updated. */
	startedActivity: string | null;
}

/** The later of two inventory timestamps, either of which may be missing. */
const laterActivity = (a: string | null, b: string | null) =>
	a === null ? b : b === null || a > b ? a : b;

/** Shared history already read for this page: owner to its latest activity. */
type ContinuityHistorySeen = Map<string, string | null>;

/** The owner of shared history, as the JSON pair the statement compares against. */
const historyOwner = (orgId: string, id: string) => JSON.stringify([orgId, id]);

/**
 * The latest time in one timestamp column among the rows `scope` selects, as
 * a Julian day, or NULL when there is none: what `max(julianday(column))` over
 * all of those rows returns, read from the end of an index on the scope's
 * columns followed by this one.
 *
 * The end of the index is the latest timestamp as text. That is the latest
 * time only among timestamps of one shape, and these columns hold two:
 * `2026-11-17T09:00:00.000Z` from the API and `2026-11-17 09:00:00` from SQL
 * defaults. Both begin with the UTC date, so the last text names the last day,
 * and the latest timestamp of each format on that day is compared as a time.
 */
function latestInIndex<
	Column extends string,
	Table extends Record<Column, AnySQLiteColumn> & SQLiteTable,
>(
	db: DbQueryClient,
	table: Table,
	name: string,
	column: Column,
	/** The index's own condition, which a read must state to be given it. */
	indexed: SQL,
	scope: (table: Table) => SQL | undefined,
): SQL {
	// The aliases differ from `table` in name only.
	const rows = stallAlias(db, table, name) as unknown as Table;
	const top = stallAlias(db, table, `${name}_top`) as unknown as Table;
	const lastDay = db
		.select({ day: sql`substr(${top[column]}, 1, 10)`.as("day") })
		.from(top as SQLiteTable)
		.where(
			and(
				scope(top),
				coreStore(db) === "d1" ? indexed : isNotNull(top[column]),
			),
		)
		.orderBy(desc(top[column]))
		.limit(1);
	// Aggregating the whole last day can still read hundreds of thousands of
	// rows. Each format sorts chronologically, so seek its last row instead.
	const latest = (separator: string, end: string) =>
		db
			.select({ value: rows[column] })
			.from(rows as SQLiteTable)
			.where(
				and(
					scope(rows),
					coreStore(db) === "d1" ? indexed : undefined,
					gte(rows[column], sql`(${lastDay}) || ${separator}`),
					lt(rows[column], sql`(${lastDay}) || ${end}`),
				),
			)
			.orderBy(desc(rows[column]))
			.limit(1);
	return coreStore(db) === "d1"
		? sql`(SELECT max(julianday(value)) FROM (
  SELECT (${latest("T", "U")}) AS value UNION ALL SELECT (${latest(" ", "!")}) AS value
 ))`
		: sql`(SELECT max(${continuityPgTime(sql`value`)}) FROM (
  SELECT (${latest("T", "U")}) AS value UNION ALL SELECT (${latest(" ", "!")}) AS value
 ) history_times)`;
}

/**
 * Agent sessions, gadget executions and tedi tasks of a few scopes, in a
 * statement apart from their Work. A workspace linked to several projects, or
 * an objective several projects share, is read once: `seenWorkspaces` and
 * `seenObjectives` name the ones an earlier statement of the same page already
 * read; this statement skips them.
 *
 * Only the latest activity is wanted, so each history is read from the end of
 * an index that ends in its timestamp (see `latestInIndex`), not row by row.
 *
 * The scopes travel as one JSON array, `[key, orgId, kind, id, objectiveId]`
 * each.
 */
function readContinuityHistory(
	db: DbQueryClient,
	scopes: ContinuityScopeSlice[],
	environment: string,
	seenWorkspaces: ContinuityHistorySeen,
	seenObjectives: ContinuityHistorySeen,
): Promise<ContinuityHistoryRow[]> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const osWorkspaceProjects = coreTable(db, d1OsWorkspaceProjects);
	const tediTasks = coreTable(db, d1TediTasks);
	const workAgentSessions = coreTable(db, d1WorkAgentSessions);
	const page = JSON.stringify(
		scopes.map((scope) => [
			scope.key,
			scope.orgId,
			scope.kind,
			scope.id,
			scope.objectiveId,
		]),
	);
	const scopePage = () =>
		coreStore(db) === "d1"
			? sql`json_each(${page}) AS s`
			: sql`jsonb_array_elements(${page}::jsonb) AS s`;
	const key = sql<string>`${coreStore(db) === "d1" ? sql`json_extract(s.value, '$[0]')` : sql`s.value ->> 0`}`;
	const orgId = sql<string>`${coreStore(db) === "d1" ? sql`json_extract(s.value, '$[1]')` : sql`s.value ->> 1`}`;
	const isProject = sql`${coreStore(db) === "d1" ? sql`json_extract(s.value, '$[2]')` : sql`s.value ->> 2`} = 'project'`;
	const id = sql<string>`${coreStore(db) === "d1" ? sql`json_extract(s.value, '$[3]')` : sql`s.value ->> 3`}`;
	const objectiveId = sql<
		string | null
	>`${coreStore(db) === "d1" ? sql`json_extract(s.value, '$[4]')` : sql`s.value ->> 4`}`;
	const unseen = (owners: ContinuityHistorySeen, org: SQL, owner: SQL) =>
		coreStore(db) === "d1"
			? sql`NOT EXISTS (SELECT 1 FROM json_each(${`[${[...owners.keys()].join(",")}]`}) AS v
 WHERE json_extract(v.value, '$[0]') = ${org} AND json_extract(v.value, '$[1]') = ${owner})`
			: sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${`[${[...owners.keys()].join(",")}]`}::jsonb) AS v WHERE v.value ->> 0 = ${org} AND v.value ->> 1 = ${owner})`;
	const none = () => sql<string | null>`NULL`;
	const timestamp = (julian: SQL) =>
		coreStore(db) === "d1"
			? sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${julian})`
			: continuityPgTimestamp(julian);

	const p = stallAlias(db, osWorkspaceProjects, "p");
	const linked = and(
		isProject,
		eq(p.organizationId, orgId),
		eq(p.projectId, id),
		eq(p.status, "active"),
	);
	const workspaces = db
		.selectDistinct({
			orgId: p.organizationId,
			workspaceId: p.workspaceId,
		})
		.from(scopePage())
		.crossJoin(p)
		.where(
			and(
				linked,
				unseen(seenWorkspaces, sql`${p.organizationId}`, sql`${p.workspaceId}`),
			),
		)
		.as("u");
	const objectives = db
		.selectDistinct({
			orgId: orgId.as("orgId"),
			objectiveId: objectiveId.as("objectiveId"),
		})
		.from(scopePage())
		.where(
			and(
				sql`${objectiveId} IS NOT NULL`,
				unseen(seenObjectives, orgId, objectiveId),
			),
		)
		.as("q");

	// An execution counts at its completion, or at its start while it has none.
	const ofWorkspace = (g: typeof osGadgetExecutions) =>
		and(
			eq(g.organizationId, workspaces.orgId),
			eq(g.workspaceId, workspaces.workspaceId),
			eq(g.runtimeEnvironment, environment),
		);
	// A task counts at its last update, or at its creation while it has none.
	const ofObjective = (k: typeof tediTasks) =>
		and(
			eq(k.orgId, objectives.orgId),
			eq(k.objectiveId, objectives.objectiveId),
		);

	// Every scope, workspace and objective read returns a row; one with no
	// history has no activity in it.
	return db
		.select({
			source: sql<ContinuityHistoryRow["source"]>`'session'`.as("source"),
			key: sql<string | null>`${key}`.as("key"),
			orgId: none().as("orgId"),
			id: none().as("id"),
			activity: timestamp(
				latestInIndex(
					db,
					workAgentSessions,
					"l",
					"lastEventAt",
					anyWorkAgentSessionReport,
					(l) => and(eq(l.organizationId, orgId), eq(l.projectId, id)),
				),
			).as("activity"),
			startedActivity: none().as("startedActivity"),
		})
		.from(scopePage())
		.where(isProject)
		.unionAll(
			db
				.select({
					source: sql<ContinuityHistoryRow["source"]>`'link'`.as("source"),
					key: sql<string | null>`${key}`.as("key"),
					orgId: sql<string | null>`${p.organizationId}`.as("orgId"),
					id: sql<string | null>`${p.workspaceId}`.as("id"),
					activity: none().as("activity"),
					startedActivity: none().as("startedActivity"),
				})
				.from(scopePage())
				.crossJoin(p)
				.where(linked),
		)
		.unionAll(
			db
				.select({
					source: sql<ContinuityHistoryRow["source"]>`'workspace'`.as("source"),
					key: none().as("key"),
					orgId: sql<string | null>`${workspaces.orgId}`.as("orgId"),
					id: sql<string | null>`${workspaces.workspaceId}`.as("id"),
					activity: timestamp(
						latestInIndex(
							db,
							osGadgetExecutions,
							"g",
							"completedAt",
							anyOsGadgetExecution,
							ofWorkspace,
						),
					).as("activity"),
					startedActivity: timestamp(
						latestInIndex(
							db,
							osGadgetExecutions,
							"o",
							"createdAt",
							anyOsGadgetExecution,
							(o) => and(ofWorkspace(o), isNull(o.completedAt)),
						),
					).as("startedActivity"),
				})
				.from(workspaces),
		)
		.unionAll(
			db
				.select({
					source: sql<ContinuityHistoryRow["source"]>`'objective'`.as("source"),
					key: none().as("key"),
					orgId: sql<string | null>`${objectives.orgId}`.as("orgId"),
					id: sql<string | null>`${objectives.objectiveId}`.as("id"),
					activity: timestamp(
						latestInIndex(
							db,
							tediTasks,
							"k",
							"updatedAt",
							anyTediTask,
							ofObjective,
						),
					).as("activity"),
					startedActivity: timestamp(
						latestInIndex(db, tediTasks, "n", "createdAt", anyTediTask, (n) =>
							and(ofObjective(n), isNull(n.updatedAt)),
						),
					).as("startedActivity"),
				})
				.from(objectives),
		);
}

/**
 * One page of up to CONTINUITY_SCOPE_BATCH_SIZE scopes after `after`, in key
 * order, with each scope's counts and latest activity over all of its history.
 *
 * The page is read in several short statements instead of one long one: a few
 * scopes at a time, and a scope with more Work than one statement may read is
 * continued in rowid order until its last Work Item. Every Work Item is read
 * exactly once, counts add up and the latest activity is the latest of the
 * slices (the timestamps share one fixed-width format, so the later text is
 * the later time). History that does not hang off Work Items (agent sessions,
 * gadget executions, tedi tasks) is read by one more statement per few scopes;
 * the gadget executions of a workspace and the tedi tasks of an objective are
 * read once per page, however many of the page's projects share them. The
 * result is what the single statement returned; only the statements are no
 * longer one snapshot, as two pages never were.
 */
export async function listContinuityScopes(
	db: DbQueryClient,
	after = "",
	orgId?: string,
	environment = "production",
): Promise<ContinuityScope[]> {
	const scopes: ContinuityScope[] = [];
	const workspaceActivity: ContinuityHistorySeen = new Map();
	const objectiveActivity: ContinuityHistorySeen = new Map();
	let cursor = after;
	while (scopes.length < CONTINUITY_SCOPE_BATCH_SIZE) {
		const scopeLimit = Math.min(
			CONTINUITY_SCOPES_PER_STATEMENT,
			CONTINUITY_SCOPE_BATCH_SIZE - scopes.length,
		);
		const slices = await readContinuityScopeSlice(db, {
			after: cursor,
			orgId,
			environment,
			scopeLimit,
			workAfter: null,
			workLimit: Math.floor(
				CONTINUITY_WORK_ITEMS_PER_STATEMENT / CONTINUITY_SCOPES_PER_STATEMENT,
			),
		});
		if (slices.length === 0) break;

		// Latest activity outside Work, per scope key.
		const history = new Map<string, Array<string | null>>();
		const note = (key: string, activity: string | null) =>
			history.set(key, [...(history.get(key) ?? []), activity]);
		const links: Array<{ key: string; owner: string }> = [];
		for (const row of await readContinuityHistory(
			db,
			slices,
			environment,
			workspaceActivity,
			objectiveActivity,
		)) {
			if (row.source === "session") note(row.key!, row.activity);
			else if (row.source === "link")
				links.push({ key: row.key!, owner: historyOwner(row.orgId!, row.id!) });
			else
				(row.source === "workspace"
					? workspaceActivity
					: objectiveActivity
				).set(
					historyOwner(row.orgId!, row.id!),
					laterActivity(row.activity, row.startedActivity),
				);
		}
		// A workspace or objective is not read again for this page, whether or
		// not it had history.
		for (const { key, owner } of links) {
			if (!workspaceActivity.has(owner)) workspaceActivity.set(owner, null);
			note(key, workspaceActivity.get(owner)!);
		}
		if (coreStore(db) === "postgres") {
			const byKey = new Map(slices.map((scope) => [scope.key, scope]));
			let pending = slices.filter((scope) => scope.workEnd !== null);
			while (pending.length) {
				const more = await readContinuityScopeSlicePostgres(db, {
					after: "",
					orgId,
					environment,
					scopeLimit: pending.length,
					workAfter: null,
					workLimit: Math.floor(
						CONTINUITY_WORK_ITEMS_PER_STATEMENT / pending.length,
					),
					continuations: pending,
				});
				const active = new Set(more.map((scope) => scope.key));
				for (const scope of pending)
					if (!active.has(scope.key)) byKey.get(scope.key)!.workEnd = null;
				for (const next of more) {
					const scope = byKey.get(next.key)!;
					scope.pendingCount += next.pendingCount;
					scope.failedCount += next.failedCount;
					scope.lastActivityAt = laterActivity(
						scope.lastActivityAt,
						next.lastActivityAt,
					)!;
					scope.workEnd = next.workEnd;
				}
				pending = more.filter((scope) => scope.workEnd !== null);
			}
		}
		for (const { workEnd, objectiveId, ...scope } of slices) {
			if (objectiveId !== null) {
				const owner = historyOwner(scope.orgId, objectiveId);
				if (!objectiveActivity.has(owner)) objectiveActivity.set(owner, null);
				note(scope.key, objectiveActivity.get(owner)!);
			}
			for (const activity of history.get(scope.key) ?? [])
				if (activity !== null && activity > scope.lastActivityAt)
					scope.lastActivityAt = activity;
			let workAfter = workEnd;
			while (workAfter !== null) {
				const [more] = await readContinuityScopeSlice(db, {
					after: "",
					orgId,
					environment,
					scopeLimit: 1,
					only: scope.key,
					workAfter,
					workLimit: CONTINUITY_WORK_ITEMS_PER_STATEMENT,
				});
				// The scope stopped being active between statements; keep what was read.
				if (!more) break;
				scope.pendingCount += more.pendingCount;
				scope.failedCount += more.failedCount;
				if (more.lastActivityAt > scope.lastActivityAt)
					scope.lastActivityAt = more.lastActivityAt;
				workAfter = more.workEnd;
			}
			scopes.push(scope);
		}
		if (slices.length < scopeLimit) break;
		cursor = slices.at(-1)!.key;
	}
	return scopes;
}

export interface StallRecoveryCursor {
	after: string;
	pending?: ContinuityScopeSlice[];
	atEnd?: boolean;
}

const STALL_RECOVERY_SCOPES_PER_TICK = 5;

/**
 * One cron tick reads at most 1,000 Work Items, rather than draining every
 * continuation of a 100-scope page in the same invocation. Partial counts
 * stay in the durable checkpoint; only complete scopes may trigger recovery.
 * At most five scopes reach history assessment or wake delivery in a tick.
 */
export async function readStallRecoveryPage(
	db: DbQueryClient,
	cursor: StallRecoveryCursor,
	environment: string,
): Promise<StallRecoveryCursor & { scopes: ContinuityScope[] }> {
	const workBudget = 1_000;
	let slices: ContinuityScopeSlice[];
	let after = cursor.after;
	let atEnd = cursor.atEnd ?? false;
	if (cursor.pending?.[0]?.workEnd === null) {
		slices = cursor.pending;
	} else if (cursor.pending?.length) {
		const [partial, ...rest] = cursor.pending;
		const [more] = await readContinuityScopeSlice(db, {
			after: "",
			orgId: undefined,
			environment,
			scopeLimit: 1,
			only: partial!.key,
			workAfter: partial!.workEnd,
			workLimit: workBudget,
		});
		slices = more
			? [
					...rest,
					{
						...more,
						pendingCount: partial!.pendingCount + more.pendingCount,
						failedCount: partial!.failedCount + more.failedCount,
						lastActivityAt: laterActivity(
							partial!.lastActivityAt,
							more.lastActivityAt,
						)!,
					},
				]
			: rest;
	} else {
		slices = await readContinuityScopeSlice(db, {
			after,
			orgId: undefined,
			environment,
			scopeLimit: STALL_RECOVERY_SCOPES_PER_TICK,
			workAfter: null,
			workLimit: workBudget / STALL_RECOVERY_SCOPES_PER_TICK,
			recoveryOnly: true,
		});
		after = slices.at(-1)?.key ?? "";
		atEnd = slices.length < STALL_RECOVERY_SCOPES_PER_TICK;
	}
	// Older checkpoints can contain a 100-scope page. Drain those without
	// exceeding the new assessment budget or discarding any continuation.
	const complete = slices
		.filter((scope) => scope.workEnd === null)
		.slice(0, STALL_RECOVERY_SCOPES_PER_TICK);
	const completed = new Set(complete.map((scope) => scope.key));
	const pending = slices.filter((scope) => !completed.has(scope.key));
	const workspaces: ContinuityHistorySeen = new Map();
	const objectives: ContinuityHistorySeen = new Map();
	const sessions = new Map<string, string | null>();
	const links: Array<{ key: string; owner: string }> = [];
	if (complete.length) {
		for (const row of await readContinuityHistory(
			db,
			complete,
			environment,
			workspaces,
			objectives,
		)) {
			if (row.source === "session") sessions.set(row.key!, row.activity);
			else if (row.source === "link")
				links.push({ key: row.key!, owner: historyOwner(row.orgId!, row.id!) });
			else
				(row.source === "workspace" ? workspaces : objectives).set(
					historyOwner(row.orgId!, row.id!),
					laterActivity(row.activity, row.startedActivity),
				);
		}
	}
	const activity = new Map(sessions);
	for (const link of links)
		activity.set(
			link.key,
			laterActivity(
				activity.get(link.key) ?? null,
				workspaces.get(link.owner) ?? null,
			),
		);
	const scopes = complete.map(
		({ workEnd: _workEnd, objectiveId, ...scope }) => ({
			...scope,
			lastActivityAt: laterActivity(
				scope.lastActivityAt,
				laterActivity(
					activity.get(scope.key) ?? null,
					objectiveId === null
						? null
						: (objectives.get(historyOwner(scope.orgId, objectiveId)) ?? null),
				),
			)!,
		}),
	);
	return {
		after: atEnd && !pending.length ? "" : after,
		...(pending.length ? { pending, atEnd } : {}),
		scopes,
	};
}

/** Environment-specific progress survives isolate recycling and cron receipt retention. */
export async function getStallRecoveryCheckpoint(
	db: DbQueryClient,
	environment: string,
) {
	const platformCronCheckpoints = coreTable(db, d1PlatformCronCheckpoints);
	const [row] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(
			eq(
				platformCronCheckpoints.scheduleId,
				stallCheckpointKey(db, environment),
			),
		)
		.limit(1);
	return row?.through ?? null;
}

/** A delayed tick cannot overwrite a checkpoint advanced by another invocation. */
export async function advanceStallRecoveryCheckpoint(
	db: DbQueryClient,
	environment: string,
	previous: string | null,
	next: string,
) {
	const platformCronCheckpoints = coreTable(db, d1PlatformCronCheckpoints);
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: stallCheckpointKey(db, environment), through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? coreStore(db) === "d1"
						? sql`0`
						: sql`false`
					: eq(platformCronCheckpoints.through, previous),
		});
}

/** Count canonical completed Work, not model turns or heartbeat traffic. */
export async function countContinuityResults(
	db: DbQueryClient,
	scope: ContinuityScope,
	start: string,
	end: string,
): Promise<number> {
	const workItems = coreTable(db, d1WorkItems);
	const [row] = await db
		.select({ count: sql<number>`count(*)`.as("count") })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, scope.orgId),
				eq(workItems.disposition, "completed"),
				gte(workItems.completedAt, start),
				lt(workItems.completedAt, end),
				or(
					and(
						sql`${scope.kind} = 'project'`,
						eq(workItems.projectId, scope.id),
					),
					and(
						sql`${scope.kind} = 'objective'`,
						eq(workItems.objectiveId, scope.id),
					),
				),
			),
		);
	return Number(row?.count ?? 0);
}

export async function getStallReceipt(
	db: DbQueryClient,
	orgId: string,
	clientEventId: string,
) {
	const learningInteractionEvents = coreTable(db, d1LearningInteractionEvents);
	const [row] = await db
		.select({ occurredAt: learningInteractionEvents.occurredAt })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, orgId),
				eq(learningInteractionEvents.clientEventId, clientEventId),
				eq(learningInteractionEvents.surface, "stall_recovery"),
				eq(learningInteractionEvents.eventKind, "delivered"),
				eq(learningInteractionEvents.actorType, "service"),
				eq(learningInteractionEvents.actorId, "stall-recovery"),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Latest accepted recovery per scope, with one bound candidate set. */
export async function listStallReceipts(
	db: DbQueryClient,
	orgId: string,
	keys: string[],
	environment: string,
) {
	const learningInteractionEvents = coreTable(db, d1LearningInteractionEvents);
	if (!keys.length) return [];

	const target = sql<string>`${learningInteractionEvents.targetType} || ':' || ${learningInteractionEvents.targetId}`;
	const receipts = db.$with("receipts").as(
		db
			.select({
				key: target.as("key"),
				requestKey: sql<string>`${learningInteractionEvents.clientEventId}`.as(
					"requestKey",
				),
				tediId: sql<string | null>`${learningInteractionEvents.tediId}`.as(
					"tediId",
				),
				occurredAt: sql<string>`${learningInteractionEvents.occurredAt}`.as(
					"occurredAt",
				),
				position:
					sql<number>`row_number() OVER (PARTITION BY ${learningInteractionEvents.targetType}, ${learningInteractionEvents.targetId} ORDER BY ${learningInteractionEvents.occurredAt} DESC, ${learningInteractionEvents.id} DESC)`.as(
						"position",
					),
			})
			.from(learningInteractionEvents)
			.where(
				and(
					eq(learningInteractionEvents.organizationId, orgId),
					eq(learningInteractionEvents.surface, "stall_recovery"),
					eq(learningInteractionEvents.eventKind, "delivered"),
					sql`${jsonRead(db, learningInteractionEvents.metadata, ["environment"])} = ${environment}`,
					eq(learningInteractionEvents.actorType, "service"),
					eq(learningInteractionEvents.actorId, "stall-recovery"),
					anyIds(db, target, keys),
				),
			),
	);
	return db
		.with(receipts)
		.select({
			key: receipts.key,
			requestKey: receipts.requestKey,
			tediId: receipts.tediId,
			occurredAt: receipts.occurredAt,
		})
		.from(receipts)
		.where(eq(receipts.position, 1));
}

export async function hasContinuityFix(
	db: DbQueryClient,
	orgId: string,
	issueKey: string,
) {
	const learningImprovementProposals = coreTable(
		db,
		d1LearningImprovementProposals,
	);
	const [row] = await db
		.select({ id: learningImprovementProposals.id })
		.from(learningImprovementProposals)
		.where(
			and(
				eq(learningImprovementProposals.organizationId, orgId),
				eq(learningImprovementProposals.clientProposalId, issueKey),
			),
		)
		.limit(1);
	return !!row;
}

/** Only the viewer's explicit open decisions; never another person's session capture. */
export async function listContinuityHumanAsks(
	db: DbQueryClient,
	orgId: string,
	userId: string,
	now: string,
) {
	const workInteractionAttention = coreTable(db, d1WorkInteractionAttention);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const workItems = coreTable(db, d1WorkItems);
	const i = stallAlias(db, workInteractions, "i");
	const w = stallAlias(db, workItems, "w");
	const a = stallAlias(db, workInteractionAttention, "a");
	return db
		.select({
			id: i.id,
			need: sql<string>`coalesce(${a.need}, ${jsonRead(db, i.metadata, ["reason"])}, ${i.subject})`.as(
				"need",
			),
			projectId: sql<
				string | null
			>`coalesce(${i.projectId}, ${w.projectId})`.as("projectId"),
			objectiveId: sql<string | null>`${w.objectiveId}`.as("objectiveId"),
			creatorId: sql<string>`${i.creatorId}`.as("creatorId"),
		})
		.from(i)
		.leftJoin(w, and(eq(w.id, i.workItemId), eq(w.orgId, i.orgId)))
		.leftJoin(a, and(eq(a.orgId, i.orgId), eq(a.interactionId, i.id)))
		.where(
			and(
				eq(i.orgId, orgId),
				eq(i.targetType, "user"),
				eq(i.targetId, userId),
				eq(i.status, "open"),
				or(isNull(i.expiresAt), gt(i.expiresAt, now)),
				eq(i.creatorType, "tedi"),
				coreStore(db) === "d1"
					? sql`${a.kind} IS NOT 'fyi'`
					: sql`${a.kind} IS DISTINCT FROM 'fyi'`,
				or(
					ne(i.kind, "coordination"),
					and(eq(a.kind, "needs_you"), sql`length(trim(${a.need})) > 0`),
				),
			),
		)
		.orderBy(i.createdAt, i.id)
		.limit(200);
}

/** Native detector incidents, independent of user/tedi feedback on the same issue. */
export async function listStallIncidents(
	db: DbQueryClient,
	orgId: string,
	issueKey: string,
) {
	const learningInteractionEvents = coreTable(db, d1LearningInteractionEvents);
	return db
		.select({ id: learningInteractionEvents.id })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, orgId),
				eq(learningInteractionEvents.issueKey, issueKey),
				eq(learningInteractionEvents.surface, "stall_recovery"),
				eq(learningInteractionEvents.eventKind, "retried"),
				eq(learningInteractionEvents.actorType, "service"),
				eq(learningInteractionEvents.actorId, "stall-recovery"),
			),
		)
		.orderBy(
			desc(learningInteractionEvents.occurredAt),
			desc(learningInteractionEvents.id),
		)
		.limit(3);
}

function stallAlias<T extends SQLiteTable>(
	db: object,
	table: T,
	name: string,
): T {
	return (coreStore(db) === "d1"
		? sqliteAlias(table, name)
		: pgAlias(table as unknown as PgTable, name)) as unknown as T;
}

function stallCheckpointKey(db: object, environment: string) {
	// A D1 rowid continuation cannot resume a Postgres text-ID scan.
	return coreStore(db) === "d1"
		? `stall-recovery:${environment}`
		: `stall-recovery:postgres:${environment}`;
}

function continuityPgTime(value: SQL): SQL {
	return sql`CASE WHEN pg_input_is_valid(${value}::text, 'timestamp with time zone') THEN
 CASE WHEN ${value}::text ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN ${value}::timestamptz ELSE ${value}::timestamp AT TIME ZONE 'UTC' END END`;
}
function continuityPgTimestamp(value: SQL) {
	return sql<
		string | null
	>`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function readContinuityScopeSlicePostgres(
	db: DbQueryClient,
	{
		after,
		orgId,
		environment,
		scopeLimit,
		only,
		workAfter,
		workLimit,
		recoveryOnly = false,
		continuations,
	}: ContinuitySliceParams & { continuations?: ContinuityScopeSlice[] },
): Promise<ContinuityScopeSlice[]> {
	const onlyProject = only?.startsWith("project:") ? only.slice(8) : undefined;
	const onlyObjective = only?.startsWith("objective:")
		? only.slice(10)
		: undefined;
	const pastWork = (name: string) =>
		sql`AND (s."workAfter" IS NULL OR ${sql.identifier(name)}.id > s."workAfter")`;
	const continuationPage = continuations
		? JSON.stringify(
				continuations.map((scope) => ({
					key: scope.key,
					id: scope.id,
					orgId: scope.orgId,
					kind: scope.kind,
					name: scope.name,
					policy: scope.policy,
					createdAt: scope.createdAt,
					owner: scope.hasOwner ? scope.tediId : null,
					objectiveId: scope.objectiveId,
					workAfter: scope.workEnd,
				})),
			)
		: null;
	return db.all<ContinuityScopeSlice>(sql`
 WITH project_page AS MATERIALIZED (
  SELECT 'project:' || p.id AS key,p.id,p.org_id AS "orgId",'project' AS kind,p.name,
   CASE WHEN jsonb_typeof(p.metadata->'continuity')='object' THEN (p.metadata->'continuity')::text END AS policy,
   p.created_at AS "createdAt",coalesce(p.lead_tedi_id,o.tedi_id) AS owner,p.objective_id AS "objectiveId"
  FROM projects p LEFT JOIN tedi_objectives o ON o.id=p.objective_id AND o.org_id=p.org_id AND o.status='active'
  WHERE p.status='active'
  ${recoveryOnly ? sql`AND (jsonb_typeof(p.metadata->'continuity')='object' OR EXISTS(SELECT 1 FROM work_items w WHERE w.org_id=p.org_id AND w.project_id=p.id AND w.disposition IN ('proposed','accepted')))` : sql``}
  AND p.id > ${after.startsWith("project:") ? after.slice(8) : ""}
  ${after && !after.startsWith("project:") && after > "project:" ? sql`AND p.id < ${""}` : sql``}
  ${only === undefined ? sql`` : onlyProject === undefined ? sql`AND p.id < ${""}` : sql`AND p.id=${onlyProject}`}
  ${orgId === undefined ? sql`` : sql`AND p.org_id=${orgId}`}
  ORDER BY p.id LIMIT ${scopeLimit}
 ), objective_page AS MATERIALIZED (
  SELECT 'objective:' || o.id,o.id,o.org_id,'objective',o.title,
   CASE WHEN jsonb_typeof(o.gate_config->'continuity')='object' THEN (o.gate_config->'continuity')::text END,
   o.created_at,o.tedi_id,o.id
  FROM tedi_objectives o WHERE o.status='active'
  ${recoveryOnly ? sql`AND (jsonb_typeof(o.gate_config->'continuity')='object' OR EXISTS(SELECT 1 FROM work_items w WHERE w.org_id=o.org_id AND w.objective_id=o.id AND w.disposition IN ('proposed','accepted')))` : sql``}
  AND o.id > ${after.startsWith("objective:") ? after.slice(10) : ""}
  ${after && !after.startsWith("objective:") && after > "objective:" ? sql`AND o.id < ${""}` : sql``}
  ${only === undefined ? sql`` : onlyObjective === undefined ? sql`AND o.id < ${""}` : sql`AND o.id=${onlyObjective}`}
  ${orgId === undefined ? sql`` : sql`AND o.org_id=${orgId}`}
  AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.org_id=o.org_id AND p.objective_id=o.id AND p.status='active')
  ORDER BY o.id LIMIT ${scopeLimit}
 ), scopes AS (
  SELECT * FROM project_page UNION ALL SELECT * FROM objective_page
 ), scope_page AS MATERIALIZED (
 ${
		continuationPage === null
			? sql`SELECT *, ${workAfter === null ? null : String(workAfter)}::text AS "workAfter" FROM scopes ORDER BY key LIMIT ${scopeLimit}`
			: sql`SELECT * FROM jsonb_to_recordset(${continuationPage}::jsonb) AS s(key text,id text,"orgId" text,kind text,name text,policy text,"createdAt" text,owner text,"objectiveId" text,"workAfter" text)
 WHERE (s.kind='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=s.id AND p.org_id=s."orgId" AND p.status='active'))
 OR (s.kind='objective' AND EXISTS(SELECT 1 FROM tedi_objectives o WHERE o.id=s.id AND o.org_id=s."orgId" AND o.status='active') AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.org_id=s."orgId" AND p.objective_id=s.id AND p.status='active'))
 ORDER BY key LIMIT ${scopeLimit}`
 }
 ), page AS MATERIALIZED (
  SELECT s.*,CASE s.kind
   WHEN 'project' THEN (SELECT x.id FROM work_items x WHERE x.org_id=s."orgId" AND x.project_id=s.id ${pastWork("x")} ORDER BY x.id LIMIT 1 OFFSET ${workLimit - 1})
   ELSE (SELECT x.id FROM work_items x WHERE x.org_id=s."orgId" AND x.objective_id=s.id ${pastWork("x")} ORDER BY x.id LIMIT 1 OFFSET ${workLimit - 1})
   END AS "workEnd"
  FROM scope_page s
 ), scope_work AS MATERIALIZED (
  SELECT s.key,w.id AS "workItemId",w.org_id AS "orgId",w.disposition
  FROM page s JOIN work_items w ON w.org_id=s."orgId" AND w.project_id=s.id ${pastWork("w")} AND (s."workEnd" IS NULL OR w.id<=s."workEnd") WHERE s.kind='project'
  UNION ALL
  SELECT s.key,w.id,w.org_id,w.disposition
  FROM page s JOIN work_items w ON w.org_id=s."orgId" AND w.objective_id=s.id ${pastWork("w")} AND (s."workEnd" IS NULL OR w.id<=s."workEnd") WHERE s.kind='objective'
 ), work_counts AS (
  SELECT key,sum(CASE WHEN disposition IN ('proposed','accepted') THEN 1 ELSE 0 END)::integer AS "pendingCount" FROM scope_work GROUP BY key
 ), attempt_activity AS MATERIALIZED (
  SELECT w.key,max(${continuityPgTime(sql`coalesce(a.finished_at,a.heartbeat_at,a.started_at)`)}) AS activity,
   sum(CASE WHEN a.outcome='failed' AND w.disposition NOT IN ('completed','cancelled') THEN 1 ELSE 0 END)::integer AS "failedCount"
  FROM scope_work w JOIN work_attempts a ON a.org_id=w."orgId" AND a.work_item_id=w."workItemId" GROUP BY w.key
 ), activity AS (
  SELECT key,activity FROM attempt_activity
  UNION ALL
  SELECT w.key,max(${continuityPgTime(sql`CASE WHEN r.status IN ('completed','failed','canceled') THEN coalesce(r.completed_at,r.started_at) ELSE coalesce(r.last_reconciled_at,r.started_at) END`)})
  FROM scope_work w JOIN skill_runs r ON r.organization_id=w."orgId" AND r.work_item_id=w."workItemId" WHERE r.runtime_environment=${environment} GROUP BY w.key
 ), latest_activity AS (
  SELECT key,max(activity) AS activity FROM activity GROUP BY key
 )
 SELECT s.key,s.id,s."orgId",s.kind,s.name,s.policy,${continuityPgTimestamp(continuityPgTime(sql`s."createdAt"`))} AS "createdAt",
 coalesce(t.id,c.id) AS "tediId",coalesce(t.slug,c.slug) AS slug,(t.id IS NOT NULL)::integer AS "hasOwner",
 ${continuityPgTimestamp(sql`greatest(${continuityPgTime(sql`s."createdAt"`)},l.activity)`)} AS "lastActivityAt",
 coalesce(w."pendingCount",0) AS "pendingCount",coalesce(a."failedCount",0) AS "failedCount",s."workEnd",s."objectiveId"
 FROM page s LEFT JOIN tedis t ON t.id=s.owner AND t.organization_id=s."orgId" AND t.status='active'
 LEFT JOIN tedis c ON c.id=s.policy::jsonb->>'coordinatorTediId' AND c.organization_id=s."orgId" AND c.status='active'
 LEFT JOIN latest_activity l ON l.key=s.key LEFT JOIN work_counts w ON w.key=s.key LEFT JOIN attempt_activity a ON a.key=s.key
 ORDER BY s.key`);
}
