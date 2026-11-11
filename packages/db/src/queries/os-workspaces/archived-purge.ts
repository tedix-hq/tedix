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
	eq,
	gt,
	notExists,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type OsWorkspaceRow,
	osOutputs,
	osWorkspaces,
} from "../../schema/os-workspaces";
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

/**
 * Outputs stored in D1 carry their status on `os_outputs`; outputs a workspace
 * object owns are found through the current row of the output index. Both are
 * read, so the caller must confirm each candidate against its storage owner.
 */
function legacyOutputFilter(params: ArchivedPurgePageParams) {
	return and(
		eq(osOutputs.organizationId, params.organizationId),
		eq(osOutputs.status, "archived"),
		params.afterId === undefined ? undefined : gt(osOutputs.id, params.afterId),
		before(osOutputs.updatedAt, params.archivedBefore),
	);
}

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
	const [legacy, indexed] = await db.batch([
		db
			.select({ id: osOutputs.id })
			.from(osOutputs)
			.where(legacyOutputFilter(params))
			.orderBy(asc(osOutputs.id))
			.limit(params.limit),
		db
			.select({ id: workspaceOutputIndex.outputId })
			.from(workspaceOutputIndex)
			.where(indexedOutputFilter(params))
			.orderBy(asc(workspaceOutputIndex.outputId))
			.limit(params.limit),
	]);
	return [...new Set([...legacy, ...indexed].map((row) => row.id))]
		.sort()
		.slice(0, params.limit);
}

export async function countArchivedOsOutputPurgeCandidates(
	db: DbQueryClient,
	params: ArchivedPurgePageParams,
): Promise<number> {
	const [[legacy], [indexed]] = await db.batch([
		db
			.select({ legacyTotal: count() })
			.from(osOutputs)
			.where(legacyOutputFilter(params)),
		// An output in both places is counted once, through os_outputs.
		db
			.select({ indexedTotal: count() })
			.from(workspaceOutputIndex)
			.where(
				and(
					indexedOutputFilter(params),
					notExists(
						db
							.select({ id: osOutputs.id })
							.from(osOutputs)
							.where(
								and(
									legacyOutputFilter(params),
									eq(osOutputs.id, workspaceOutputIndex.outputId),
								),
							),
					),
				),
			),
	]);
	return (legacy?.legacyTotal ?? 0) + (indexed?.indexedTotal ?? 0);
}
