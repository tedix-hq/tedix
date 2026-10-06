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
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type NewProject,
	type Project,
	type ProjectStatus,
	projects,
} from "../schema/projects";
import {
	type WorkItemDisposition,
	type WorkItemKind,
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
	if (params.metadata !== undefined) set.metadata = params.metadata;

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
