/**
 * Query helpers for Projects.
 *
 * A project is an org-scoped standing area of work or a dated engagement.
 * Epics (`work_cases`) group Work Items toward one outcome. Work Items stay the
 * canonical coordination object; a project just groups them (via
 * `work_items.projectId`) and provides a rollup. Soft-archive preserves audit
 * history (status=archived + archivedAt), mirroring the capability-map pattern.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gte,
	inArray,
	isNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import {
	type NewProject,
	type Project,
	type ProjectStatus,
	projects as schemaProjects,
} from "../schema/projects";
import { alias } from "drizzle-orm/sqlite-core";
import { coreTable } from "../core-store/client";
import { coreStore, jsonParameter } from "../core-store/dialect";
import {
	anyWorkAgentSessionReport,
	workAgentSessions as schemaWorkAgentSessions,
} from "../schema/work-agent-sessions";
import { workProjectHealthJudgments as schemaWorkProjectHealthJudgments } from "../schema/work-factory";
import { tedis as schemaTedis } from "../schema/tedis";
import { withTransientD1ReadRetry } from "../utils/d1-retry";
import {
	type WorkItemDisposition,
	type WorkItemKind,
	workAttempts as schemaWorkAttempts,
	workItems as schemaWorkItems,
} from "../schema/work-items";
import {
	computeWorkItemRollupTotals,
	type WorkItemRollupTotals,
} from "./work-items/hierarchy";

export interface CreateProjectParams {
	id: string;
	orgId: string;
	key: string;
	name: string;
	description?: string;
	status?: ProjectStatus;
	leadTediId?: string | null;
	ownerUserId?: string | null;
	objectiveId?: string | null;
	targetDate?: string | null;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
}

export interface ListProjectsOptions {
	orgId: string;
	excludeProjectId?: string;
	status?: ProjectStatus;
	search?: string;
	limit?: number;
	offset?: number;
}

export interface UpdateProjectParams {
	name?: string;
	description?: string | null;
	status?: ProjectStatus;
	leadTediId?: string | null;
	ownerUserId?: string | null;
	objectiveId?: string | null;
	targetDate?: string | null;
	metadata?: Record<string, JsonValue>;
	updatedAt: string;
}

/** Purpose-bearing projects cannot silently invalidate already-linked work. */
export class ProjectPurposeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectPurposeError";
	}
}

/** Top-tier work items directly grouped under a project. */
export interface ProjectTopLevelItem {
	id: string;
	workKind: WorkItemKind;
	title: string;
	status: WorkItemDisposition;
}

export interface ProjectRollup extends WorkItemRollupTotals {
	projectId: string;
	/** project/epic tier items grouped under this project. */
	topLevelItems: ProjectTopLevelItem[];
	/** True when the item cap stopped the scan before every row was counted. */
	truncated: boolean;
}

/**
 * Hard cap on work items scanned per project rollup. `work_items` is the busiest
 * table, and `getProjectRollup` is the one hierarchy read with no natural depth
 * bound (it flat-scans every row for a `projectId`), so the cap keeps a huge
 * project inside the 10s D1 gateway budget. Mirrors the subtree node cap
 * (WORK_ITEM_SUBTREE_NODE_CAP, queries/work-items.ts).
 */
const PROJECT_ROLLUP_ITEM_CAP = 2000;

function projectTables(db: object) {
	return {
		projects: coreTable(db, schemaProjects),
		workItems: coreTable(db, schemaWorkItems),
		workAttempts: coreTable(db, schemaWorkAttempts),
		workAgentSessions: coreTable(db, schemaWorkAgentSessions),
		workProjectHealthJudgments: coreTable(db, schemaWorkProjectHealthJudgments),
		tedis: coreTable(db, schemaTedis),
	};
}

export async function createProject(
	db: DbClient,
	params: CreateProjectParams,
): Promise<Project> {
	const { projects } = projectTables(db);
	const values: NewProject = {
		id: params.id,
		orgId: params.orgId,
		key: params.key,
		name: params.name,
		description: params.description ?? null,
		status: params.status ?? "active",
		leadTediId: params.leadTediId ?? null,
		ownerUserId: params.ownerUserId ?? null,
		objectiveId: params.objectiveId ?? null,
		targetDate: params.targetDate ?? null,
		metadata: params.metadata ?? {},
		createdAt: params.createdAt,
	};
	const rows = await db.insert(projects).values(values).returning();
	return rows[0]!;
}

export async function getProjectById(
	db: DbClient,
	id: string,
): Promise<Project | undefined> {
	const { projects } = projectTables(db);
	const rows = await db.select().from(projects).where(eq(projects.id, id));
	return rows[0];
}

/** Projects, across organizations, that declare recurring Work in metadata. */
export async function listProjectsWithRecurringWork(
	db: DbQueryClient,
	limit = 500,
): Promise<Project[]> {
	const { projects } = projectTables(db);
	return db
		.select()
		.from(projects)
		.where(
			and(
				isNull(projects.archivedAt),
				coreStore(db) === "postgres"
					? sql`CASE WHEN jsonb_typeof(${projects.metadata} -> 'recurringWork') = 'array' THEN jsonb_array_length(${projects.metadata} -> 'recurringWork') ELSE 0 END > 0`
					: sql`json_array_length(json_extract(${projects.metadata}, '$.recurringWork')) > 0`,
			),
		)
		.orderBy(asc(projects.id))
		.limit(limit);
}

export async function getProjectByKey(
	db: DbClient,
	orgId: string,
	key: string,
): Promise<Project | undefined> {
	const { projects } = projectTables(db);
	const rows = await db
		.select()
		.from(projects)
		.where(and(eq(projects.orgId, orgId), eq(projects.key, key)));
	return rows[0];
}

export async function listProjects(
	db: DbClient,
	options: ListProjectsOptions,
): Promise<{ data: Project[]; total: number }> {
	const { projects } = projectTables(db);
	const { limit = 50, offset = 0 } = options;
	const conditions = [eq(projects.orgId, options.orgId)];
	if (options.excludeProjectId)
		conditions.push(ne(projects.id, options.excludeProjectId));
	if (options.status) conditions.push(eq(projects.status, options.status));
	const search = options.search?.trim();
	if (search) {
		const postgres = coreStore(db) === "postgres";
		const position = postgres ? sql`strpos` : sql`instr`;
		const needle = postgres
			? sql`lower(${search}::text)`
			: sql`lower(${search})`;
		conditions.push(
			or(
				...[
					projects.name,
					projects.key,
					projects.status,
					projects.ownerUserId,
					projects.leadTediId,
				].map((column) => sql`${position}(lower(${column}), ${needle}) > 0`),
			)!,
		);
	}
	const whereClause = and(...conditions);
	const data = await db
		.select()
		.from(projects)
		.where(whereClause)
		.orderBy(asc(projects.key))
		.limit(limit)
		.offset(offset);
	const total = await db.$count(projects, whereClause);
	return { data, total };
}

export async function updateProject(
	db: DbClient,
	id: string,
	params: UpdateProjectParams,
): Promise<Project | undefined> {
	const { projects, workItems } = projectTables(db);
	const existing = await getProjectById(db, id);
	if (!existing) return undefined;
	const objectiveChanges =
		params.objectiveId !== undefined &&
		params.objectiveId !== existing.objectiveId;
	// A project's first objective classifies its Work; only re-purposing is locked.
	const firstObjective =
		objectiveChanges &&
		existing.objectiveId === null &&
		typeof params.objectiveId === "string";
	if (objectiveChanges && !firstObjective) {
		const linked = await db
			.select({ id: workItems.id })
			.from(workItems)
			.where(eq(workItems.projectId, id))
			.limit(1);
		if (linked[0]) {
			throw new ProjectPurposeError(
				"PROJECT_PURPOSE_CONFLICT: objective context is immutable after Work Items link to the project",
			);
		}
	}
	const set: Record<string, unknown> = { updatedAt: params.updatedAt };
	if (params.name !== undefined) set.name = params.name;
	if (params.description !== undefined) set.description = params.description;
	if (params.status !== undefined) set.status = params.status;
	if (params.status === "archived") {
		set.archivedFromStatus = sql`case when ${projects.status} <> 'archived' then ${projects.status} else ${projects.archivedFromStatus} end`;
		set.archivedAt = sql`coalesce(${projects.archivedAt}, ${params.updatedAt})`;
	}
	if (params.leadTediId !== undefined) set.leadTediId = params.leadTediId;
	if (params.ownerUserId !== undefined) set.ownerUserId = params.ownerUserId;
	if (params.objectiveId !== undefined) set.objectiveId = params.objectiveId;
	if (params.targetDate !== undefined) set.targetDate = params.targetDate;
	if (params.metadata !== undefined) {
		const metadata = jsonParameter(db, params.metadata);
		set.metadata =
			coreStore(db) === "postgres"
				? sql`CASE WHEN (${projects.metadata} -> 'repositoryObserver') IS NOT NULL
			THEN (${metadata} - 'repositoryObserver') || jsonb_build_object('repositoryObserver', ${projects.metadata} -> 'repositoryObserver')
			ELSE ${metadata} - 'repositoryObserver' END`
				: sql`CASE WHEN json_type(${projects.metadata}, '$.repositoryObserver') IS NOT NULL
			THEN json_set(json_remove(json(${metadata}), '$.repositoryObserver'), '$.repositoryObserver', json_extract(${projects.metadata}, '$.repositoryObserver'))
			ELSE json_remove(json(${metadata}), '$.repositoryObserver') END`;
	}

	const updateRow = db
		.update(projects)
		.set(set)
		.where(
			and(
				eq(projects.id, id),
				existing.updatedAt === null
					? isNull(projects.updatedAt)
					: eq(projects.updatedAt, existing.updatedAt),
			),
		)
		.returning();
	let rows: Project[];
	if (firstObjective) {
		// Unclassified Work inherits the objective; bounded exceptions keep their class.
		[rows] = await db.batch([
			updateRow,
			db
				.update(workItems)
				.set({ objectiveId: params.objectiveId, workClass: "objective" })
				.where(
					and(
						eq(workItems.projectId, id),
						isNull(workItems.objectiveId),
						or(
							isNull(workItems.workClass),
							eq(workItems.workClass, "objective"),
						),
						exists(
							db
								.select({ id: projects.id })
								.from(projects)
								.where(
									and(
										eq(projects.id, id),
										eq(projects.objectiveId, params.objectiveId as string),
									),
								),
						),
					),
				),
		]);
	} else {
		rows = await updateRow;
	}
	if (!rows[0]) {
		throw new ProjectPurposeError(
			"PROJECT_CONTEXT_CONFLICT: project changed concurrently; reload and retry",
		);
	}
	return rows[0];
}

/**
 * Soft-archive: status=archived + archivedAt stamped (audit-preserving). Work
 * Items keep their `projectId`; the rollup and project list can still surface
 * archived history. Returns the archived row, or undefined if it was missing.
 */
export async function archiveProject(
	db: DbClient,
	id: string,
	archivedAt: string,
): Promise<Project | undefined> {
	const { projects } = projectTables(db);
	const rows = await db
		.update(projects)
		.set({
			status: "archived",
			archivedAt,
			updatedAt: archivedAt,
			archivedFromStatus: sql`case when ${projects.status} <> 'archived' then ${projects.status} else ${projects.archivedFromStatus} end`,
		})
		.where(eq(projects.id, id))
		.returning();
	return rows[0];
}

export async function restoreProject(
	db: DbClient,
	params: { orgId: string; id: string; updatedAt: string },
): Promise<Project | undefined> {
	const { projects } = projectTables(db);
	const [row] = await db
		.update(projects)
		.set({
			status: sql`${projects.archivedFromStatus}`,
			archivedAt: null,
			archivedFromStatus: null,
			updatedAt: params.updatedAt,
		})
		.where(
			and(
				eq(projects.orgId, params.orgId),
				eq(projects.id, params.id),
				sql`${projects.archivedFromStatus} is not null`,
				sql`(${projects.status} = 'archived' or ${projects.archivedAt} is not null)`,
			),
		)
		.returning();
	return row;
}

/**
 * Rollup across the work items grouped under a project (all statuses), plus the
 * project/epic-tier headline items. Flat, index-backed (`idx_work_items_project`)
 * scan — no BFS. Capped at {@link PROJECT_ROLLUP_ITEM_CAP}: one extra row is read
 * (LIMIT cap+1) purely to detect overflow, and `truncated` is set when the
 * project has more items than the cap so callers know the totals are partial.
 */
export async function getProjectRollup(
	db: DbClient,
	params: { orgId: string; projectId: string },
): Promise<ProjectRollup> {
	const { workItems } = projectTables(db);
	const rows = await db
		.select({
			id: workItems.id,
			workKind: workItems.workKind,
			title: workItems.title,
			disposition: workItems.disposition,
			parentWorkItemId: workItems.parentWorkItemId,
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.projectId, params.projectId),
			),
		)
		.orderBy(asc(workItems.createdAt))
		.limit(PROJECT_ROLLUP_ITEM_CAP + 1);

	const truncated = rows.length > PROJECT_ROLLUP_ITEM_CAP;
	const scanned = truncated ? rows.slice(0, PROJECT_ROLLUP_ITEM_CAP) : rows;

	const totals = computeWorkItemRollupTotals(scanned);
	const topLevelItems: ProjectTopLevelItem[] = scanned
		.filter((row) => row.parentWorkItemId === null)
		.map((row) => ({
			id: row.id,
			workKind: row.workKind,
			title: row.title,
			status: row.disposition,
		}));

	return { projectId: params.projectId, ...totals, topLevelItems, truncated };
}

/** One Portfolio card: the project plus its counts, next item, health and activity. */
export interface ProjectPortfolioEntry {
	project: Project;
	leadTediName: string | null;
	total: number;
	byDisposition: Record<string, number>;
	/** Oldest accepted top-level item, else the oldest proposed one. */
	next: { id: string; title: string } | null;
	health:
		| (typeof schemaWorkProjectHealthJudgments.$inferSelect)["status"]
		| null;
	/** Newest heartbeat from recent Attempts (since yesterday UTC), or session report. */
	lastActivityAt: string | null;
}

/**
 * The whole Portfolio in one D1 round trip: projects ordered by key, each with
 * what its card shows. Work aggregates join through `projects`; heartbeat
 * activity reads recent Attempts rather than the organization's entire history.
 */
export async function listProjectPortfolio(
	db: DbQueryClient,
	params: {
		orgId: string;
		limit: number;
		excludeProjectId?: string;
		now?: Date;
	},
): Promise<{ data: ProjectPortfolioEntry[] }> {
	const {
		projects,
		workItems,
		workAttempts,
		workAgentSessions,
		workProjectHealthJudgments,
		tedis,
	} = projectTables(db);
	const since = new Date(
		(params.now ?? new Date()).getTime() - 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10);
	const projectScope = and(
		eq(projects.orgId, params.orgId),
		params.excludeProjectId
			? ne(projects.id, params.excludeProjectId)
			: undefined,
	);
	const orgProject = and(eq(projects.id, workItems.projectId), projectScope);
	// Each project seeks its own next item, health and latest report from an
	// index; grouping over the organization read every open item, judgment and
	// session on every Activity open.
	const postgres = coreStore(db) === "postgres";
	const nextRow = alias(workItems, "next_row");
	const judged = alias(workProjectHealthJudgments, "judged");
	const report = alias(workAgentSessions, "report");
	const next = sql<string | null>`(${db
		.select({
			value: postgres
				? sql`json_build_object('id', ${nextRow.id}, 'title', ${nextRow.title})::text`
				: sql`json_object('id', ${nextRow.id}, 'title', ${nextRow.title})`,
		})
		.from(nextRow)
		.where(
			and(
				eq(nextRow.orgId, projects.orgId),
				eq(nextRow.projectId, projects.id),
				inArray(nextRow.disposition, ["accepted", "proposed"]),
				// Unary plus: with production statistics the planner otherwise seeks
				// every top-level item in the database through idx_work_items_parent.
				postgres
					? sql`${nextRow.parentWorkItemId} IS NULL`
					: sql`+${nextRow.parentWorkItemId} IS NULL`,
			),
		)
		.orderBy(
			desc(sql`${nextRow.disposition} = 'accepted'`),
			asc(nextRow.createdAt),
			asc(nextRow.id),
		)
		.limit(1)})`.as("next_item");
	const health = sql<ProjectPortfolioEntry["health"]>`(${db
		.select({ value: judged.status })
		.from(judged)
		.where(
			and(eq(judged.orgId, projects.orgId), eq(judged.projectId, projects.id)),
		)
		.orderBy(desc(judged.observedAt), desc(judged.id))
		.limit(1)})`.as("health_status");
	// The partial index's own condition, stated so the read is given it.
	const reportAt = sql<string | null>`(${db
		.select({ value: report.lastEventAt })
		.from(report)
		.where(
			and(
				eq(report.organizationId, projects.orgId),
				eq(report.projectId, projects.id),
				postgres ? sql`${report.lastEventAt} >= ''` : anyWorkAgentSessionReport,
			),
		)
		.orderBy(desc(report.lastEventAt))
		.limit(1)})`.as("report_at");

	const [projectRows, countRows, attemptRows] = await db.batch([
		db
			.select({
				project: projects,
				leadTediName: sql<
					string | null
				>`coalesce(nullif(${tedis.displayName}, ''), ${tedis.name})`.as(
					"lead_tedi_name",
				),
				next,
				health,
				reportAt,
			})
			.from(projects)
			.leftJoin(
				tedis,
				and(
					eq(tedis.id, projects.leadTediId),
					eq(tedis.organizationId, projects.orgId),
				),
			)
			.where(projectScope)
			.orderBy(asc(projects.key))
			.limit(params.limit),
		db
			.select({
				projectId: sql<string>`${workItems.projectId}`.as("count_project_id"),
				disposition: workItems.disposition,
				count: sql<number>`count(*)`.as("item_count"),
			})
			.from(workItems)
			.innerJoin(projects, orgProject)
			.where(eq(workItems.orgId, params.orgId))
			.groupBy(workItems.projectId, workItems.disposition),
		db
			.select({
				projectId: sql<string>`${workItems.projectId}`.as("attempt_project_id"),
				at: sql<string | null>`max(${workAttempts.heartbeatAt})`.as(
					"attempt_at",
				),
			})
			.from(workAttempts)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, workAttempts.orgId),
					eq(workItems.id, workAttempts.workItemId),
				),
			)
			.innerJoin(projects, orgProject)
			.where(
				and(
					eq(workAttempts.orgId, params.orgId),
					gte(workAttempts.startedAt, since),
				),
			)
			.groupBy(workItems.projectId),
	]);

	const counts = new Map<string, Record<string, number>>();
	for (const row of countRows) {
		const byDisposition = counts.get(row.projectId) ?? {};
		byDisposition[row.disposition] = Number(row.count);
		counts.set(row.projectId, byDisposition);
	}
	const attemptAt = new Map(attemptRows.map((row) => [row.projectId, row.at]));
	return {
		data: projectRows.map(
			({ project, leadTediName, next, health, reportAt }) => {
				const byDisposition = counts.get(project.id) ?? {};
				const attempt = attemptAt.get(project.id) ?? null;
				return {
					project,
					leadTediName: leadTediName ?? null,
					total: Object.values(byDisposition).reduce((sum, n) => sum + n, 0),
					byDisposition,
					next: next
						? (JSON.parse(next) as { id: string; title: string })
						: null,
					health: health ?? null,
					lastActivityAt:
						attempt && (!reportAt || attempt > reportAt)
							? attempt
							: (reportAt ?? null),
				};
			},
		),
	};
}

export async function getProjectByIdForOrganization(
	db: DbQueryClient,
	orgId: string,
	id: string,
): Promise<Project | undefined> {
	const { projects } = projectTables(db);
	return withTransientD1ReadRetry(
		"projects.getProjectByIdForOrganization",
		async () =>
			(
				await db
					.select()
					.from(projects)
					.where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
					.limit(1)
			)[0],
	);
}

/** The organization's active projects by key, for choosing where work goes. */
export async function listActiveProjectsForOrganization(
	db: DbQueryClient,
	orgId: string,
): Promise<Project[]> {
	const { projects } = projectTables(db);
	return db
		.select()
		.from(projects)
		.where(and(eq(projects.orgId, orgId), eq(projects.status, "active")))
		.orderBy(asc(projects.key))
		.limit(500);
}

/**
 * The project a request already points at, or null when it names none. Tried
 * in order: the one active project serving the request's objective, the one
 * active project the named tedi leads, the requester's own default project,
 * then the organization's only active project. Two candidates for a step is
 * no answer; with none left the work waits in triage for a person to pick.
 */
export async function findRequestContextProjectId(
	db: DbQueryClient,
	params: {
		orgId: string;
		objectiveId?: string | null;
		leadTediId?: string | null;
		defaultProjectId?: string | null;
	},
): Promise<string | null> {
	const { projects } = projectTables(db);
	const only = async (
		condition?: ReturnType<typeof eq>,
	): Promise<string | null> => {
		const rows = await db
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(
					eq(projects.orgId, params.orgId),
					eq(projects.status, "active"),
					condition,
				),
			)
			.limit(2);
		return rows.length === 1 ? rows[0]!.id : null;
	};
	return (
		(params.objectiveId
			? await only(eq(projects.objectiveId, params.objectiveId))
			: null) ??
		(params.leadTediId
			? await only(eq(projects.leadTediId, params.leadTediId))
			: null) ??
		(params.defaultProjectId
			? await only(eq(projects.id, params.defaultProjectId))
			: null) ??
		(await only())
	);
}
