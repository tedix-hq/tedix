/**
 * Org-level reads over the workspace change projections. Nothing here
 * touches a workspace object or the workspace-scoped source tables.
 */

import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { osWorkspaces } from "../../schema/os-workspaces";
import {
	type WorkspaceActivityRow,
	type WorkspaceChangeKind,
	type WorkspaceOutputIndexRow,
	type WorkspaceWorkLinkRow,
	workspaceActivity,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "../../schema/workspace-feed";
import { prefixedColumns } from "../../utils/select";
import {
	type OsWorkspaceViewer,
	osWorkspaceChildVisibleToPredicate,
} from "../os-workspaces/workspaces";

export interface WorkspaceActivityCursor {
	occurredAt: string;
	seq: number;
}

export interface ListWorkspaceActivityOptions {
	workspaceId?: string;
	kinds?: readonly WorkspaceChangeKind[];
	limit?: number;
	/** Return rows strictly older than this keyset position. */
	before?: WorkspaceActivityCursor;
}

export async function listWorkspaceActivity(
	db: DbQueryClient,
	params: { organizationId: string; viewer: OsWorkspaceViewer },
	options: ListWorkspaceActivityOptions = {},
): Promise<WorkspaceActivityRow[]> {
	const conditions = [
		eq(workspaceActivity.organizationId, params.organizationId),
		osWorkspaceChildVisibleToPredicate(
			db,
			params.organizationId,
			workspaceActivity.workspaceId,
			params.viewer,
		),
	];
	if (options.workspaceId)
		conditions.push(eq(workspaceActivity.workspaceId, options.workspaceId));
	if (options.kinds && options.kinds.length > 0)
		// bound-params: at most the five WORKSPACE_CHANGE_KINDS values
		conditions.push(inArray(workspaceActivity.kind, [...options.kinds]));
	if (options.before) {
		conditions.push(
			or(
				lt(workspaceActivity.occurredAt, options.before.occurredAt),
				and(
					eq(workspaceActivity.occurredAt, options.before.occurredAt),
					lt(workspaceActivity.seq, options.before.seq),
				),
			)!,
		);
	}
	return db
		.select()
		.from(workspaceActivity)
		.where(and(...conditions))
		.orderBy(desc(workspaceActivity.occurredAt), desc(workspaceActivity.seq))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 500));
}

export interface WorkspaceOutputLibraryRow {
	index: WorkspaceOutputIndexRow;
	workspace: { id: string; name: string; status: string } | null;
}

export interface ListWorkspaceOutputLibraryOptions {
	workspaceId?: string;
	kind?: WorkspaceOutputIndexRow["outputKind"];
	status?: WorkspaceOutputIndexRow["status"];
	/** Case-insensitive substring match on title and indexed excerpt. */
	search?: string;
	limit?: number;
}

/** D1 caps LIKE patterns; longer terms are cut, never rejected. */
const LIKE_TERM_MAX = 20;

function likePattern(term: string): string {
	const escaped = term
		.toLowerCase()
		.slice(0, LIKE_TERM_MAX)
		.replace(/[\\%_]/g, (char) => `\\${char}`);
	return `%${escaped}%`;
}

/**
 * Current-revision rows for the output library and search, newest change
 * first. The workspace join only decorates the card; an output whose
 * workspace is archived stays listed.
 */
export async function listWorkspaceOutputLibrary(
	db: DbQueryClient,
	params: { organizationId: string; viewer: OsWorkspaceViewer },
	options: ListWorkspaceOutputLibraryOptions = {},
): Promise<WorkspaceOutputLibraryRow[]> {
	const conditions = [
		eq(workspaceOutputIndex.organizationId, params.organizationId),
		eq(workspaceOutputIndex.isCurrent, 1),
		osWorkspaceChildVisibleToPredicate(
			db,
			params.organizationId,
			workspaceOutputIndex.workspaceId,
			params.viewer,
		),
	];
	if (options.workspaceId)
		conditions.push(eq(workspaceOutputIndex.workspaceId, options.workspaceId));
	if (options.kind)
		conditions.push(eq(workspaceOutputIndex.outputKind, options.kind));
	if (options.status)
		conditions.push(eq(workspaceOutputIndex.status, options.status));
	const term = options.search?.trim();
	if (term) {
		const pattern = likePattern(term);
		conditions.push(
			or(
				like(sql`lower(${workspaceOutputIndex.title})`, pattern),
				like(workspaceOutputIndex.searchText, pattern),
			)!,
		);
	}
	const rows = await db
		.select({
			index: prefixedColumns(workspaceOutputIndex, "index"),
			workspaceId: sql<string | null>`${osWorkspaces.id}`.as("ws_id"),
			workspaceName: sql<string | null>`${osWorkspaces.name}`.as("ws_name"),
			workspaceStatus: sql<string | null>`${osWorkspaces.status}`.as(
				"ws_status",
			),
		})
		.from(workspaceOutputIndex)
		.leftJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.id, workspaceOutputIndex.workspaceId),
				eq(osWorkspaces.organizationId, params.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(
			desc(workspaceOutputIndex.updatedAt),
			desc(workspaceOutputIndex.id),
		)
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
	return rows.map((row) => ({
		index: row.index as WorkspaceOutputIndexRow,
		workspace:
			row.workspaceId && row.workspaceName && row.workspaceStatus
				? {
						id: row.workspaceId,
						name: row.workspaceName,
						status: row.workspaceStatus,
					}
				: null,
	}));
}

export async function getWorkspaceOutputIndexCurrent(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string },
): Promise<WorkspaceOutputIndexRow | undefined> {
	const [row] = await db
		.select()
		.from(workspaceOutputIndex)
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.outputId, params.outputId),
				eq(workspaceOutputIndex.isCurrent, 1),
			),
		)
		.limit(1);
	return row;
}

export async function getWorkspaceOutputIndexRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<WorkspaceOutputIndexRow | undefined> {
	const [row] = await db
		.select()
		.from(workspaceOutputIndex)
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.revisionId, params.revisionId),
			),
		)
		.limit(1);
	return row;
}

export async function retireWorkspaceOutputIndex(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string },
): Promise<void> {
	await db
		.update(workspaceOutputIndex)
		.set({ isCurrent: 0 })
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.outputId, params.outputId),
			),
		);
}

/** Active links from a Work Item to outputs, newest confirmation first. */
export async function listWorkspaceWorkLinksForWorkItem(
	db: DbQueryClient,
	params: { organizationId: string; workItemId: string },
): Promise<WorkspaceWorkLinkRow[]> {
	return db
		.select()
		.from(workspaceWorkLinks)
		.where(
			and(
				eq(workspaceWorkLinks.organizationId, params.organizationId),
				eq(workspaceWorkLinks.workItemId, params.workItemId),
				sql`${workspaceWorkLinks.unlinkedAt} IS NULL`,
			),
		)
		.orderBy(desc(workspaceWorkLinks.linkedAt));
}

/** Active links from an output to Work Items. */
export async function listWorkspaceWorkLinksForOutput(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string },
): Promise<WorkspaceWorkLinkRow[]> {
	return db
		.select()
		.from(workspaceWorkLinks)
		.where(
			and(
				eq(workspaceWorkLinks.organizationId, params.organizationId),
				eq(workspaceWorkLinks.outputId, params.outputId),
				sql`${workspaceWorkLinks.unlinkedAt} IS NULL`,
			),
		)
		.orderBy(desc(workspaceWorkLinks.linkedAt));
}
