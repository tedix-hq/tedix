import {
	and,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	alias,
	type AnySQLiteColumn,
	type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import type { DbQueryClient } from "../../query-client";
import {
	learningImprovementProposals,
	learningInteractionEvents,
} from "../../schema/learning-feedback";
import {
	anyOsGadgetExecution,
	osGadgetExecutions,
	osWorkspaceProjects,
} from "../../schema/os-workspaces";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import { anyTediTask, tediTasks } from "../../schema/tedi-objectives";
import {
	anyWorkAgentSessionReport,
	workAgentSessions,
} from "../../schema/work-agent-sessions";
import {
	workInteractionAttention,
	workInteractions,
} from "../../schema/work-factory";
import { workItems } from "../../schema/work-items";

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
	workEnd: number | null;
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
	/** Work Items are read in rowid order; null starts from the first. */
	workAfter: number | null;
	workLimit: number;
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
	}: ContinuitySliceParams,
): Promise<ContinuityScopeSlice[]> {
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
	const rows = alias(table, name) as unknown as Table;
	const top = alias(table, `${name}_top`) as unknown as Table;
	const lastDay = db
		.select({ day: sql`substr(${top[column]}, 1, 10)`.as("day") })
		.from(top as SQLiteTable)
		.where(and(scope(top), indexed))
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
					indexed,
					gte(rows[column], sql`(${lastDay}) || ${separator}`),
					lt(rows[column], sql`(${lastDay}) || ${end}`),
				),
			)
			.orderBy(desc(rows[column]))
			.limit(1);
	return sql`(SELECT max(julianday(value)) FROM (
		SELECT (${latest("T", "U")}) AS value
		UNION ALL SELECT (${latest(" ", "!")}) AS value
	))`;
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
	const page = JSON.stringify(
		scopes.map((scope) => [
			scope.key,
			scope.orgId,
			scope.kind,
			scope.id,
			scope.objectiveId,
		]),
	);
	const scopePage = () => sql`json_each(${page}) AS s`;
	const key = sql<string>`json_extract(s.value, '$[0]')`;
	const orgId = sql<string>`json_extract(s.value, '$[1]')`;
	const isProject = sql`json_extract(s.value, '$[2]') = 'project'`;
	const id = sql<string>`json_extract(s.value, '$[3]')`;
	const objectiveId = sql<string | null>`json_extract(s.value, '$[4]')`;
	const unseen = (owners: ContinuityHistorySeen, org: SQL, owner: SQL) =>
		sql`NOT EXISTS (SELECT 1 FROM json_each(${`[${[...owners.keys()].join(",")}]`}) AS v
			WHERE json_extract(v.value, '$[0]') = ${org} AND json_extract(v.value, '$[1]') = ${owner})`;
	const none = () => sql<string | null>`NULL`;
	const timestamp = (julian: SQL) =>
		sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${julian})`;

	const p = alias(osWorkspaceProjects, "p");
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

/** Environment-specific progress survives isolate recycling and cron receipt retention. */
export async function getStallRecoveryCheckpoint(
	db: DbQueryClient,
	environment: string,
) {
	const [row] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(
			eq(platformCronCheckpoints.scheduleId, `stall-recovery:${environment}`),
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
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: `stall-recovery:${environment}`, through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? sql`0`
					: eq(platformCronCheckpoints.through, previous),
		});
}

/** Count canonical completed Work, not model turns or heartbeat traffic. */
export async function countContinuityResults(
	db: DbClient,
	scope: ContinuityScope,
	start: string,
	end: string,
): Promise<number> {
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
	db: DbClient,
	orgId: string,
	clientEventId: string,
) {
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

/** Latest accepted recovery per scope, batched below D1's parameter limit. */
export async function listStallReceipts(
	db: DbClient,
	orgId: string,
	keys: string[],
	environment: string,
) {
	const rows: Array<{
		key: string;
		requestKey: string;
		tediId: string | null;
		occurredAt: string;
	}> = [];
	for (let at = 0; at < keys.length; at += 50) {
		const chunk = keys.slice(at, at + 50);
		const target = sql<string>`${learningInteractionEvents.targetType} || ':' || ${learningInteractionEvents.targetId}`;
		const receipts = db.$with("receipts").as(
			db
				.select({
					key: target.as("key"),
					requestKey:
						sql<string>`${learningInteractionEvents.clientEventId}`.as(
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
						sql`json_extract(${learningInteractionEvents.metadata}, '$.environment') = ${environment}`,
						eq(learningInteractionEvents.actorType, "service"),
						eq(learningInteractionEvents.actorId, "stall-recovery"),
						inArray(target, chunk),
					),
				),
		);
		rows.push(
			...(await db
				.with(receipts)
				.select({
					key: receipts.key,
					requestKey: receipts.requestKey,
					tediId: receipts.tediId,
					occurredAt: receipts.occurredAt,
				})
				.from(receipts)
				.where(eq(receipts.position, 1))),
		);
	}
	return rows;
}

export async function hasContinuityFix(
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
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
	db: DbClient,
	orgId: string,
	userId: string,
	now: string,
) {
	const i = alias(workInteractions, "i");
	const w = alias(workItems, "w");
	const a = alias(workInteractionAttention, "a");
	return db
		.select({
			id: i.id,
			need: sql<string>`coalesce(${a.need}, json_extract(${i.metadata}, '$.reason'), ${i.subject})`.as(
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
				sql`${a.kind} IS NOT 'fyi'`,
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
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
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
