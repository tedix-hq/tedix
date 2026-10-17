/**
 * Query helpers for Projects (work hierarchy v1).
 *
 * A project is the org-scoped anchor at the top of the work hierarchy
 * project → epic → feature → story → work_item → task. Work Items stay the
 * canonical coordination object; a project just groups them (via
 * `work_items.projectId`) and provides a rollup. Soft-archive preserves audit
 * history (status=archived + archivedAt), mirroring the capability-map pattern.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { workProjectHealthJudgments } from "../schema/work-factory";
import {
	type NewProject,
	type Project,
	type ProjectStatus,
	projects,
} from "../schema/projects";
import { tedis } from "../schema/tedis";
import {
	type WorkItemDisposition,
	type WorkItemKind,
	workAttempts,
	workItems,
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

export async function createProject(
	db: DbClient,
	params: CreateProjectParams,
): Promise<Project> {
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
	const rows = await db.select().from(projects).where(eq(projects.id, id));
	return rows[0];
}

export async function getProjectByKey(
	db: DbClient,
	orgId: string,
	key: string,
): Promise<Project | undefined> {
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
	const { limit = 50, offset = 0 } = options;
	const conditions = [eq(projects.orgId, options.orgId)];
	if (options.excludeProjectId)
		conditions.push(ne(projects.id, options.excludeProjectId));
	if (options.status) conditions.push(eq(projects.status, options.status));
	const search = options.search?.trim();
	if (search) {
		conditions.push(
			or(
				sql`instr(lower(${projects.name}), lower(${search})) > 0`,
				sql`instr(lower(${projects.key}), lower(${search})) > 0`,
				sql`instr(lower(${projects.status}), lower(${search})) > 0`,
				sql`instr(lower(${projects.ownerUserId}), lower(${search})) > 0`,
				sql`instr(lower(${projects.leadTediId}), lower(${search})) > 0`,
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
	const existing = await getProjectById(db, id);
	if (!existing) return undefined;
	const objectiveChanges =
		params.objectiveId !== undefined &&
		params.objectiveId !== existing.objectiveId;
	if (objectiveChanges) {
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
	if (params.leadTediId !== undefined) set.leadTediId = params.leadTediId;
	if (params.ownerUserId !== undefined) set.ownerUserId = params.ownerUserId;
	if (params.objectiveId !== undefined) set.objectiveId = params.objectiveId;
	if (params.targetDate !== undefined) set.targetDate = params.targetDate;
	if (params.metadata !== undefined) {
		const metadata = JSON.stringify(params.metadata);
		set.metadata = sql`CASE WHEN json_type(${projects.metadata}, '$.repositoryObserver') IS NOT NULL
			THEN json_set(json_remove(json(${metadata}), '$.repositoryObserver'), '$.repositoryObserver', json_extract(${projects.metadata}, '$.repositoryObserver'))
			ELSE json_remove(json(${metadata}), '$.repositoryObserver') END`;
	}

	const rows = await db
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
	const rows = await db
		.update(projects)
		.set({ status: "archived", archivedAt, updatedAt: archivedAt })
		.where(eq(projects.id, id))
		.returning();
	return rows[0];
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
	health: (typeof workProjectHealthJudgments.$inferSelect)["status"] | null;
	/** Newest attempt heartbeat or agent-session report on the project. */
	lastActivityAt: string | null;
}

/**
 * The whole Portfolio in one D1 round trip: projects ordered by key, each with
 * what its card shows. Aggregates join through `projects` so every statement
 * walks the per-project indexes instead of the organization's whole Work table.
 */
export async function listProjectPortfolio(
	db: DbQueryClient,
	params: { orgId: string; limit: number },
): Promise<{ data: ProjectPortfolioEntry[] }> {
	const orgProject = and(
		eq(projects.id, workItems.projectId),
		eq(projects.orgId, params.orgId),
	);
	const nextRanked = db
		.select({
			projectId: sql<string>`${workItems.projectId}`.as("next_project_id"),
			id: sql<string>`${workItems.id}`.as("next_id"),
			title: sql<string>`${workItems.title}`.as("next_title"),
			rank: sql<number>`row_number() OVER (PARTITION BY ${workItems.projectId} ORDER BY (${workItems.disposition} = 'accepted') DESC, ${workItems.createdAt} ASC, ${workItems.id} ASC)`.as(
				"next_rank",
			),
		})
		.from(workItems)
		.innerJoin(projects, orgProject)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				isNull(workItems.parentWorkItemId),
				inArray(workItems.disposition, ["accepted", "proposed"]),
			),
		)
		.as("portfolio_next");
	const healthRanked = db
		.select({
			projectId: sql<string>`${workProjectHealthJudgments.projectId}`.as(
				"health_project_id",
			),
			status: sql<
				ProjectPortfolioEntry["health"]
			>`${workProjectHealthJudgments.status}`.as("health_status"),
			rank: sql<number>`row_number() OVER (PARTITION BY ${workProjectHealthJudgments.projectId} ORDER BY ${workProjectHealthJudgments.observedAt} DESC, ${workProjectHealthJudgments.id} DESC)`.as(
				"health_rank",
			),
		})
		.from(workProjectHealthJudgments)
		.where(eq(workProjectHealthJudgments.orgId, params.orgId))
		.as("portfolio_health");

	const [
		projectRows,
		countRows,
		nextRows,
		healthRows,
		attemptRows,
		reportRows,
	] = await db.batch([
		db
			.select({
				project: projects,
				leadTediName: sql<
					string | null
				>`coalesce(nullif(${tedis.displayName}, ''), ${tedis.name})`.as(
					"lead_tedi_name",
				),
			})
			.from(projects)
			.leftJoin(
				tedis,
				and(
					eq(tedis.id, projects.leadTediId),
					eq(tedis.organizationId, projects.orgId),
				),
			)
			.where(eq(projects.orgId, params.orgId))
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
				projectId: nextRanked.projectId,
				id: nextRanked.id,
				title: nextRanked.title,
			})
			.from(nextRanked)
			.where(eq(nextRanked.rank, 1)),
		db
			.select({
				projectId: healthRanked.projectId,
				status: healthRanked.status,
			})
			.from(healthRanked)
			.where(eq(healthRanked.rank, 1)),
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
			.where(eq(workAttempts.orgId, params.orgId))
			.groupBy(workItems.projectId),
		db
			.select({
				projectId: sql<string>`${workAgentSessions.projectId}`.as(
					"report_project_id",
				),
				at: sql<string | null>`max(${workAgentSessions.lastEventAt})`.as(
					"report_at",
				),
			})
			.from(workAgentSessions)
			.where(
				and(
					eq(workAgentSessions.organizationId, params.orgId),
					sql`${workAgentSessions.projectId} IS NOT NULL`,
				),
			)
			.groupBy(workAgentSessions.projectId),
	]);

	const counts = new Map<string, Record<string, number>>();
	for (const row of countRows) {
		const byDisposition = counts.get(row.projectId) ?? {};
		byDisposition[row.disposition] = Number(row.count);
		counts.set(row.projectId, byDisposition);
	}
	const next = new Map(
		nextRows.map((row) => [row.projectId, { id: row.id, title: row.title }]),
	);
	const health = new Map(healthRows.map((row) => [row.projectId, row.status]));
	const activity = new Map<string, string>();
	for (const row of [...attemptRows, ...reportRows]) {
		const current = activity.get(row.projectId);
		if (row.at && (!current || row.at > current))
			activity.set(row.projectId, row.at);
	}
	return {
		data: projectRows.map(({ project, leadTediName }) => {
			const byDisposition = counts.get(project.id) ?? {};
			return {
				project,
				leadTediName: leadTediName ?? null,
				total: Object.values(byDisposition).reduce((sum, n) => sum + n, 0),
				byDisposition,
				next: next.get(project.id) ?? null,
				health: health.get(project.id) ?? null,
				lastActivityAt: activity.get(project.id) ?? null,
			};
		}),
	};
}

export async function getProjectByIdForOrganization(
	db: DbQueryClient,
	orgId: string,
	id: string,
): Promise<Project | undefined> {
	return (
		await db
			.select()
			.from(projects)
			.where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
			.limit(1)
	)[0];
}
