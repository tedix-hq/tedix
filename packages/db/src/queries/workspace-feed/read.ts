/**
 * Org-level reads over the workspace change projections. Nothing here
 * touches a workspace object or the workspace-scoped source tables.
 */

import { and, desc, eq, exists, inArray, lt, or, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { osWorkspaces as d1OsWorkspaces } from "../../schema/os-workspaces";
import {
	type WorkspaceActivityRow,
	type WorkspaceChangeKind,
	type WorkspaceOutputIndexRow,
	type WorkspaceWorkLinkRow,
	workspaceActivity as d1WorkspaceActivity,
	workspaceFeedLedger as d1WorkspaceFeedLedger,
	workspaceOutputIndex as d1WorkspaceOutputIndex,
	workspaceWorkLinks as d1WorkspaceWorkLinks,
} from "../../schema/workspace-feed";
import { prefixedColumns } from "../../utils/select";
import {
	type OsWorkspaceViewer,
	osWorkspaceChildVisibleToPredicate,
} from "../os-workspaces/workspaces";

export interface WorkspaceActivityCursor {
	occurredAt: string;
	seq: number;
	id: string;
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
	const workspaceActivity = coreTable(db, d1WorkspaceActivity);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const conditions = [
		eq(workspaceActivity.organizationId, params.organizationId),
		or(
			eq(workspaceActivity.workspaceId, `org:${params.organizationId}`),
			exists(
				db
					.select({ id: osWorkspaces.id })
					.from(osWorkspaces)
					.where(
						and(
							eq(osWorkspaces.organizationId, params.organizationId),
							eq(osWorkspaces.id, workspaceActivity.workspaceId),
						),
					),
			),
		)!,
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
					or(
						lt(workspaceActivity.seq, options.before.seq),
						and(
							eq(workspaceActivity.seq, options.before.seq),
							lt(workspaceActivity.id, options.before.id),
						),
					),
				),
			)!,
		);
	}
	return db
		.select()
		.from(workspaceActivity)
		.where(and(...conditions))
		.orderBy(
			desc(workspaceActivity.occurredAt),
			desc(workspaceActivity.seq),
			desc(workspaceActivity.id),
		)
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
	offset?: number;
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
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
		const title =
			coreStore(db) === "postgres"
				? sql`translate(${workspaceOutputIndex.title}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
				: sql`lower(${workspaceOutputIndex.title})`;
		conditions.push(
			or(
				sql`${title} LIKE ${pattern} ESCAPE '\\'`,
				sql`${workspaceOutputIndex.searchText} LIKE ${pattern} ESCAPE '\\'`,
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
			desc(workspaceOutputIndex.outputId),
		)
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500))
		.offset(options.offset ?? 0);
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

/** Metadata only: retired projections still locate deleted object-owned IDs. */
export async function getWorkspaceOutputLocation(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string },
) {
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	const [index] = await db
		.select({ workspaceId: workspaceOutputIndex.workspaceId })
		.from(workspaceOutputIndex)
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.outputId, params.outputId),
			),
		)
		.orderBy(
			desc(workspaceOutputIndex.isCurrent),
			desc(workspaceOutputIndex.revision),
		)
		.limit(1);
	return index;
}

export async function getWorkspaceOutputIndexCurrent(
	db: DbQueryClient,
	params: { organizationId: string; outputId: string },
): Promise<WorkspaceOutputIndexRow | undefined> {
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
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
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
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
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
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
	const workspaceWorkLinks = coreTable(db, d1WorkspaceWorkLinks);
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

/** Exact immutable source metadata; no event body leaves the query owner. */
export async function getWorkspaceActivitySource(
	db: DbQueryClient,
	params: {
		organizationId: string;
		workspaceId: string;
		seq: number;
		changeRecordId: string;
	},
) {
	const workspaceFeedLedger = coreTable(db, d1WorkspaceFeedLedger);
	const [row] = await db
		.select({ summary: workspaceFeedLedger.summary })
		.from(workspaceFeedLedger)
		.where(
			and(
				eq(workspaceFeedLedger.organizationId, params.organizationId),
				eq(workspaceFeedLedger.workspaceId, params.workspaceId),
				eq(workspaceFeedLedger.seq, params.seq),
				eq(workspaceFeedLedger.changeRecordId, params.changeRecordId),
			),
		)
		.limit(1);
	return row ?? null;
}
