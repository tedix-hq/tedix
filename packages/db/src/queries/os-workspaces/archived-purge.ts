/**
 * Candidate reads for the bulk purge of archived Tedix OS items. Each page is
 * keyed by id so a caller can walk the archive in bounded chunks; the rules
 * that decide whether a candidate may be deleted stay with the caller.
 */
import {
	type AnyColumn,
	and,
	asc,
	count,
	countDistinct,
	eq,
	gt,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { type OsWorkspaceRow, osWorkspaces } from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";

export interface ArchivedPurgePageParams {
	organizationId: string;
	/** Exclusive id cursor; omitted starts at the beginning. */
	afterId?: string;
	/** ISO-8601; only items last changed before it. */
	archivedBefore?: string;
}

function before(column: AnyColumn, cutoff?: string) {
	return cutoff === undefined
		? undefined
		: sql`datetime(${column}) < datetime(${cutoff})`;
}

function workspaceFilter(params: ArchivedPurgePageParams) {
	return and(
		eq(osWorkspaces.organizationId, params.organizationId),
		eq(osWorkspaces.status, "archived"),
		params.afterId === undefined
			? undefined
			: gt(osWorkspaces.id, params.afterId),
		before(osWorkspaces.updatedAt, params.archivedBefore),
	);
}

export async function listArchivedOsWorkspacePurgeCandidates(
	db: DbQueryClient,
	params: ArchivedPurgePageParams & { limit: number },
): Promise<OsWorkspaceRow[]> {
	return db
		.select()
		.from(osWorkspaces)
		.where(workspaceFilter(params))
		.orderBy(asc(osWorkspaces.id))
		.limit(params.limit);
}

export async function countArchivedOsWorkspacePurgeCandidates(
	db: DbQueryClient,
	params: ArchivedPurgePageParams,
): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(osWorkspaces)
		.where(workspaceFilter(params));
	return row?.total ?? 0;
}

/** The index supplies candidates only; the caller confirms the storage owner's row. */
function indexedOutputFilter(params: ArchivedPurgePageParams) {
	return and(
		eq(workspaceOutputIndex.organizationId, params.organizationId),
		eq(workspaceOutputIndex.isCurrent, 1),
		eq(workspaceOutputIndex.status, "archived"),
		params.afterId === undefined
			? undefined
			: gt(workspaceOutputIndex.outputId, params.afterId),
		before(workspaceOutputIndex.updatedAt, params.archivedBefore),
	);
}

export async function listArchivedOsOutputPurgeCandidateIds(
	db: DbQueryClient,
	params: ArchivedPurgePageParams & { limit: number },
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ id: workspaceOutputIndex.outputId })
		.from(workspaceOutputIndex)
		.where(indexedOutputFilter(params))
		.orderBy(asc(workspaceOutputIndex.outputId))
		.limit(params.limit);
	return rows.map((row) => row.id);
}

export async function countArchivedOsOutputPurgeCandidates(
	db: DbQueryClient,
	params: ArchivedPurgePageParams,
): Promise<number> {
	const [row] = await db
		.select({ total: countDistinct(workspaceOutputIndex.outputId) })
		.from(workspaceOutputIndex)
		.where(indexedOutputFilter(params));
	return row?.total ?? 0;
}
