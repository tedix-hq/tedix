import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { osOutputRevisions } from "../../schema/os-workspaces";

/**
 * Inline body offload: move `os_output_revisions.content` bytes that are still
 * stored in D1 into the R2 body store and leave an empty string behind.
 * `hydrateOutputRevision` reads `content = ''` plus a pointer from R2.
 *
 * The sweep walks rowid windows, so it never needs an index on the body
 * columns and reads each large row exactly once. Rows written with an empty
 * inline body are skipped by the candidate filter.
 */

const rowid = sql<number>`${osOutputRevisions}.rowid`;
/** Byte length, not the character count `length(text)` would return. */
const inlineBytes = sql<number>`length(CAST(${osOutputRevisions.content} AS BLOB))`;

export const OUTPUT_BODY_OFFLOAD_MAX_WINDOW = 5_000;
export const OUTPUT_BODY_OFFLOAD_MAX_LIMIT = 200;

export async function getOutputRevisionMaxRowid(
	db: DbQueryClient,
): Promise<number> {
	const [row] = await db
		.select({
			maxRowid: sql<number>`coalesce(max(${rowid}), 0)`.as("max_rowid"),
		})
		.from(osOutputRevisions);
	return row?.maxRowid ?? 0;
}

export interface InlineOutputBodyCandidate {
	rowid: number;
	id: string;
	organizationId: string;
	inlineBytes: number;
	bodyR2Key: string | null;
	contentSha256: string | null;
	contentBytes: number | null;
}

/** Rows in `(after, through]` that still carry an inline body, oldest first. */
export async function listInlineOutputBodyCandidates(
	db: DbQueryClient,
	params: { after: number; through: number; limit: number },
): Promise<InlineOutputBodyCandidate[]> {
	if (
		![params.after, params.through, params.limit].every(Number.isSafeInteger) ||
		params.after < 0 ||
		params.through < params.after ||
		params.through - params.after > OUTPUT_BODY_OFFLOAD_MAX_WINDOW ||
		params.limit < 1 ||
		params.limit > OUTPUT_BODY_OFFLOAD_MAX_LIMIT
	)
		throw new Error("Invalid output body offload bounds");
	return db
		.select({
			rowid: rowid.as("revision_rowid"),
			id: osOutputRevisions.id,
			organizationId: osOutputRevisions.organizationId,
			inlineBytes: inlineBytes.as("inline_bytes"),
			bodyR2Key: osOutputRevisions.bodyR2Key,
			contentSha256: osOutputRevisions.contentSha256,
			contentBytes: osOutputRevisions.contentBytes,
		})
		.from(osOutputRevisions)
		.where(
			sql`${rowid} > ${params.after} AND ${rowid} <= ${params.through} AND ${osOutputRevisions.content} <> ''`,
		)
		.orderBy(rowid)
		.limit(params.limit);
}

/** One row's inline body, read on its own so a tick never holds many bodies. */
export async function getInlineOutputBody(
	db: DbQueryClient,
	params: { rowid: number; id: string },
): Promise<{ organizationId: string; content: string } | undefined> {
	const [row] = await db
		.select({
			organizationId: osOutputRevisions.organizationId,
			content: osOutputRevisions.content,
		})
		.from(osOutputRevisions)
		.where(
			and(sql`${rowid} = ${params.rowid}`, eq(osOutputRevisions.id, params.id)),
		)
		.limit(1);
	return row;
}

/**
 * Replace the verified inline body with the empty-string sentinel and set the
 * pointer columns. The row is immutable, so the fence compares the byte
 * length and any pointer already present instead of binding the body again
 * (bodies above D1's bound-parameter size could not be bound).
 */
export async function clearOffloadedOutputBody(
	db: DbQueryClient,
	params: {
		rowid: number;
		id: string;
		organizationId: string;
		bodyR2Key: string;
		contentSha256: string;
		contentBytes: number;
	},
) {
	return db
		.update(osOutputRevisions)
		.set({
			content: "",
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		})
		.where(
			and(
				sql`${rowid} = ${params.rowid}`,
				eq(osOutputRevisions.id, params.id),
				eq(osOutputRevisions.organizationId, params.organizationId),
				sql`${inlineBytes} = ${params.contentBytes}`,
				or(
					isNull(osOutputRevisions.contentSha256),
					eq(osOutputRevisions.contentSha256, params.contentSha256),
				),
				or(
					isNull(osOutputRevisions.bodyR2Key),
					eq(osOutputRevisions.bodyR2Key, params.bodyR2Key),
				),
			),
		)
		.returning({ id: osOutputRevisions.id });
}

/** Full-table measurement; run only at pass boundaries, never per tick. */
export async function getInlineOutputBodySummary(db: DbQueryClient) {
	const [row] = await db
		.select({
			rows: sql<number>`count(*)`.as("revision_rows"),
			inlineRows:
				sql<number>`coalesce(sum(CASE WHEN ${osOutputRevisions.content} <> '' THEN 1 ELSE 0 END), 0)`.as(
					"inline_rows",
				),
			inlineBytes: sql<number>`coalesce(sum(${inlineBytes}), 0)`.as(
				"inline_body_bytes",
			),
			pointerMissing:
				sql<number>`coalesce(sum(CASE WHEN ${osOutputRevisions.bodyR2Key} IS NULL THEN 1 ELSE 0 END), 0)`.as(
					"pointer_missing_rows",
				),
		})
		.from(osOutputRevisions);
	return row!;
}
