import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { osOutputRevisions, osOutputs } from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";

/**
 * One-time rewrite of stored presentation and document bodies whose images
 * are still embedded. The sweep walks rowid windows over two tables: revision
 * rows this database owns, then index rows of revisions a workspace object
 * owns. A rewritten body gets a new digest and key; the revision row and its
 * index row move to the new body together.
 */

const revisionRowid = sql<number>`${osOutputRevisions}.rowid`;
const indexRowid = sql<number>`${workspaceOutputIndex}.rowid`;
/** Byte length, not the character count `length(text)` would return. */
const inlineBytes = sql<number>`length(CAST(${osOutputRevisions.content} AS BLOB))`;

export const OUTPUT_ASSET_MIGRATION_MAX_WINDOW = 5_000;
export const OUTPUT_ASSET_MIGRATION_MAX_LIMIT = 100;

interface WindowParams {
	after: number;
	through: number;
	limit: number;
}

function requireWindow(params: WindowParams) {
	if (
		![params.after, params.through, params.limit].every(Number.isSafeInteger) ||
		params.after < 0 ||
		params.through < params.after ||
		params.through - params.after > OUTPUT_ASSET_MIGRATION_MAX_WINDOW ||
		params.limit < 1 ||
		params.limit > OUTPUT_ASSET_MIGRATION_MAX_LIMIT
	)
		throw new Error("Invalid output asset migration bounds");
}

export async function getOutputAssetMigrationBounds(db: DbQueryClient) {
	const [[revisions], [index]] = await Promise.all([
		db
			.select({
				maxRowid: sql<number>`coalesce(max(${revisionRowid}), 0)`.as(
					"max_revision_rowid",
				),
			})
			.from(osOutputRevisions),
		db
			.select({
				maxRowid: sql<number>`coalesce(max(${indexRowid}), 0)`.as(
					"max_index_rowid",
				),
			})
			.from(workspaceOutputIndex),
	]);
	return {
		revisions: revisions?.maxRowid ?? 0,
		index: index?.maxRowid ?? 0,
	};
}

export interface OutputAssetMigrationCandidate {
	rowid: number;
	revisionId: string;
	organizationId: string;
	outputId: string;
	bodyR2Key: string | null;
	contentSha256: string | null;
	contentBytes: number | null;
}

/** Presentation and document revisions this database owns, in `(after, through]`. */
export async function listSharedOutputAssetCandidates(
	db: DbQueryClient,
	params: WindowParams,
): Promise<(OutputAssetMigrationCandidate & { inlineBytes: number })[]> {
	requireWindow(params);
	return db
		.select({
			rowid: revisionRowid.as("revision_rowid"),
			revisionId: osOutputRevisions.id,
			organizationId: osOutputRevisions.organizationId,
			outputId: osOutputRevisions.outputId,
			bodyR2Key: osOutputRevisions.bodyR2Key,
			contentSha256: osOutputRevisions.contentSha256,
			contentBytes: osOutputRevisions.contentBytes,
			inlineBytes: inlineBytes.as("inline_bytes"),
		})
		.from(osOutputRevisions)
		.innerJoin(
			osOutputs,
			and(
				eq(osOutputs.id, osOutputRevisions.outputId),
				eq(osOutputs.organizationId, osOutputRevisions.organizationId),
			),
		)
		.where(
			sql`${revisionRowid} > ${params.after} AND ${revisionRowid} <= ${params.through} AND ${osOutputs.kind} IN ('presentation', 'document')`,
		)
		.orderBy(revisionRowid)
		.limit(params.limit);
}

/**
 * Index rows in `(after, through]` for presentation and document revisions
 * that have a stored body and no revision row here: a workspace object owns
 * them.
 */
export async function listObjectOutputAssetCandidates(
	db: DbQueryClient,
	params: WindowParams,
): Promise<(OutputAssetMigrationCandidate & { workspaceId: string })[]> {
	requireWindow(params);
	return db
		.select({
			rowid: indexRowid.as("index_rowid"),
			revisionId: workspaceOutputIndex.revisionId,
			organizationId: workspaceOutputIndex.organizationId,
			outputId: workspaceOutputIndex.outputId,
			workspaceId: workspaceOutputIndex.workspaceId,
			bodyR2Key: workspaceOutputIndex.bodyR2Key,
			contentSha256: workspaceOutputIndex.contentSha256,
			contentBytes: workspaceOutputIndex.contentBytes,
		})
		.from(workspaceOutputIndex)
		.where(
			and(
				sql`${indexRowid} > ${params.after} AND ${indexRowid} <= ${params.through}`,
				sql`${workspaceOutputIndex.outputKind} IN ('presentation', 'document')`,
				isNotNull(workspaceOutputIndex.bodyR2Key),
				sql`NOT EXISTS (SELECT 1 FROM ${osOutputRevisions} WHERE ${osOutputRevisions.id} = ${workspaceOutputIndex.revisionId} AND ${osOutputRevisions.organizationId} = ${workspaceOutputIndex.organizationId})`,
			),
		)
		.orderBy(indexRowid)
		.limit(params.limit);
}

export interface RewrittenOutputBody {
	bodyR2Key: string;
	contentSha256: string;
	contentBytes: number;
}

function indexStatement(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string } & RewrittenOutputBody,
	guard: ReturnType<typeof sql>,
) {
	return db
		.update(workspaceOutputIndex)
		.set({
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		})
		.where(
			and(
				eq(workspaceOutputIndex.organizationId, params.organizationId),
				eq(workspaceOutputIndex.revisionId, params.revisionId),
				guard,
			),
		);
}

/**
 * Point a revision this database owns at its rewritten body and move its
 * index row with it, in one batch. The revision is fenced on the body it had:
 * the same digest and the same inline byte count. The index follows only
 * when the revision row carries the new digest, so a lost fence changes
 * nothing.
 */
export async function rewriteSharedOutputRevisionBody(
	db: DbQueryClient,
	params: {
		rowid: number;
		revisionId: string;
		previousSha256: string | null;
		previousInlineBytes: number;
	} & RewrittenOutputBody &
		TenantScope,
): Promise<boolean> {
	params = { ...params, ...normalizeTenantScope(params) };
	const [changed] = await db.batch([
		db
			.update(osOutputRevisions)
			.set({
				content: "",
				bodyR2Key: params.bodyR2Key,
				contentSha256: params.contentSha256,
				contentBytes: params.contentBytes,
			})
			.where(
				and(
					sql`${revisionRowid} = ${params.rowid}`,
					eq(osOutputRevisions.id, params.revisionId),
					eq(osOutputRevisions.organizationId, params.organizationId),
					sql`${inlineBytes} = ${params.previousInlineBytes}`,
					sql`coalesce(${osOutputRevisions.contentSha256}, '') = ${params.previousSha256 ?? ""}`,
				),
			)
			.returning({ id: osOutputRevisions.id }),
		indexStatement(
			db,
			params,
			sql`EXISTS (SELECT 1 FROM ${osOutputRevisions} WHERE ${osOutputRevisions.id} = ${params.revisionId} AND ${osOutputRevisions.organizationId} = ${params.organizationId} AND ${osOutputRevisions.contentSha256} = ${params.contentSha256})`,
		),
	]);
	return changed.length === 1;
}

/**
 * Move the index row of a revision a workspace object owns, after the object
 * has taken the rewritten body. Fenced on the digest the index row had.
 */
export async function rewriteObjectOutputIndexBody(
	db: DbQueryClient,
	params: {
		revisionId: string;
		previousSha256: string;
	} & RewrittenOutputBody &
		TenantScope,
) {
	params = { ...params, ...normalizeTenantScope(params) };
	await indexStatement(
		db,
		params,
		sql`${workspaceOutputIndex.contentSha256} = ${params.previousSha256}`,
	);
}
