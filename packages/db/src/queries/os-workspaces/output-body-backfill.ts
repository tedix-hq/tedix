import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { osOutputRevisions } from "../../schema/os-workspaces";

const rowid = sql<number>`${osOutputRevisions}.rowid`;

/** Include already-pointed rows so replay after a crash verifies them again. */
export async function listOutputBodyBackfillPage(
	db: DbQueryClient,
	params: {
		organizationId: string;
		after: number;
		through: number;
		limit: number;
	} & TenantScope,
) {
	params = { ...params, ...normalizeTenantScope(params) };
	if (
		![params.after, params.through, params.limit].every(Number.isSafeInteger) ||
		params.after < 0 ||
		params.through < params.after ||
		params.limit < 1 ||
		params.limit > 25
	)
		throw new Error("Invalid output body backfill bounds");
	return db
		.select({
			rowid: rowid.as("revision_rowid"),
			id: osOutputRevisions.id,
			content: osOutputRevisions.content,
			bodyR2Key: osOutputRevisions.bodyR2Key,
			contentSha256: osOutputRevisions.contentSha256,
			contentBytes: osOutputRevisions.contentBytes,
		})
		.from(osOutputRevisions)
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				sql`${rowid} > ${params.after} AND ${rowid} <= ${params.through}`,
			),
		)
		.orderBy(rowid)
		.limit(params.limit);
}

export async function getOutputBodyBackfillSummary(
	db: DbQueryClient,
	tenantScope: TenantScope,
) {
	const { organizationId } = normalizeTenantScope(tenantScope);
	const [row] = await db
		.select({
			through: sql<number>`coalesce(max(${rowid}), 0)`.as("through_rowid"),
			rows: sql<number>`count(*)`.as("revision_rows"),
			missing:
				sql<number>`coalesce(sum(CASE WHEN ${osOutputRevisions.bodyR2Key} IS NULL THEN 1 ELSE 0 END), 0)`.as(
					"missing_rows",
				),
			distinctHashes:
				sql<number>`count(distinct ${osOutputRevisions.contentSha256})`.as(
					"distinct_hashes",
				),
			bytes:
				sql<number>`coalesce(sum(${osOutputRevisions.contentBytes}), 0)`.as(
					"body_bytes",
				),
		})
		.from(osOutputRevisions)
		.where(eq(osOutputRevisions.organizationId, organizationId));
	return row!;
}

/** CAS preserves inline bytes and refuses to replace a concurrent pointer. */
export async function setBackfilledOutputBody(
	db: DbQueryClient,
	params: {
		organizationId: string;
		id: string;
		rowid: number;
		content: string;
		bodyR2Key: string;
		contentSha256: string;
		contentBytes: number;
	} & TenantScope,
) {
	params = { ...params, ...normalizeTenantScope(params) };
	return db
		.update(osOutputRevisions)
		.set({
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		})
		.where(
			and(
				eq(osOutputRevisions.organizationId, params.organizationId),
				eq(osOutputRevisions.id, params.id),
				sql`${rowid} = ${params.rowid}`,
				eq(osOutputRevisions.content, params.content),
				isNull(osOutputRevisions.bodyR2Key),
			),
		)
		.returning({ id: osOutputRevisions.id });
}
