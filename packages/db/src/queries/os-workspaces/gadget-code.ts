import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	osGadgetCode,
	osGadgetCodeBlobs,
	osGadgetRevisions,
} from "../../schema/os-workspaces";

/**
 * Runtime app source files are stored once per organization and content in
 * `os_gadget_code_blobs`. `os_gadget_code` keeps one small row per revision
 * that points at them. The same editor installed on a thousand outputs is one
 * copy of its files, not a thousand.
 */

export interface OsGadgetCodeFiles {
	/** JSON object: file name -> source text. */
	files: string;
	codeLength: number;
}

/** Hex SHA-256 of the files text as UTF-8; the blob's key. */
export async function osGadgetCodeSha256(files: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(files),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export interface OsGadgetCodeBlobParams extends OsGadgetCodeFiles {
	organizationId: string;
	sha256: string;
	createdAt: string;
}

/** Store the files unless this organization already has the same content. */
export function buildEnsureOsGadgetCodeBlobStatement(
	db: DbQueryClient,
	params: OsGadgetCodeBlobParams,
) {
	return db
		.insert(osGadgetCodeBlobs)
		.values({
			organizationId: params.organizationId,
			sha256: params.sha256,
			files: params.files,
			codeLength: params.codeLength,
			createdAt: params.createdAt,
		})
		.onConflictDoNothing();
}

/**
 * The two statements that record a revision's code inside a batch which also
 * writes that revision: the blob (skipped when the content exists) and the
 * pointer row. Both select from the revision just written, so neither lands
 * when a guarded revision insert earlier in the batch did not.
 */
export function buildOsGadgetRevisionCodeStatements(
	db: DbQueryClient,
	params: OsGadgetCodeFiles & {
		revisionId: string;
		sha256: string;
		createdAt: string;
	},
) {
	const fromRevision = eq(osGadgetRevisions.id, params.revisionId);
	return [
		db
			.insert(osGadgetCodeBlobs)
			.select(
				db
					.select({
						organizationId: osGadgetRevisions.organizationId,
						sha256: sql<string>`${params.sha256}`.as("sha256"),
						files: sql<string>`${params.files}`.as("files"),
						codeLength: sql<number>`${params.codeLength}`.as("code_length"),
						createdAt: sql<string>`${params.createdAt}`.as("created_at"),
					})
					.from(osGadgetRevisions)
					.where(fromRevision),
			)
			.onConflictDoNothing(),
		db.insert(osGadgetCode).select(
			db
				.select({
					revisionId: osGadgetRevisions.id,
					organizationId: osGadgetRevisions.organizationId,
					gadgetId: osGadgetRevisions.gadgetId,
					files: sql<string>`''`.as("files"),
					codeLength: sql<number>`${params.codeLength}`.as("code_length"),
					createdAt: sql<string>`${params.createdAt}`.as("created_at"),
					filesSha256: sql<string>`${params.sha256}`.as("files_sha256"),
				})
				.from(osGadgetRevisions)
				.where(fromRevision),
		),
	] as const;
}

/**
 * Turn a code row that carries its files into the blob and the pointer row
 * that replace it. Callers keep building rows with `files`; the writers in
 * this package call this before their batch.
 */
export async function splitOsGadgetCodeRow(
	row: typeof osGadgetCode.$inferInsert,
): Promise<{
	blob: OsGadgetCodeBlobParams;
	code: typeof osGadgetCode.$inferInsert;
}> {
	const sha256 = await osGadgetCodeSha256(row.files);
	return {
		blob: {
			organizationId: row.organizationId,
			sha256,
			files: row.files,
			codeLength: row.codeLength,
			createdAt: row.createdAt ?? new Date().toISOString(),
		},
		code: { ...row, files: "", filesSha256: sha256 },
	};
}

/*
 * Backfill of rows written before the split. A legacy row has no hash; the
 * sweep walks rowid windows and reads one row's files at a time. The
 * candidate filter looks only at `files_sha256`, which SQLite answers from
 * the record header without loading the files.
 */

const rowid = sql<number>`${osGadgetCode}.rowid`;

export const GADGET_CODE_BACKFILL_MAX_WINDOW = 5_000;
export const GADGET_CODE_BACKFILL_MAX_LIMIT = 200;

export async function getOsGadgetCodeMaxRowid(
	db: DbQueryClient,
): Promise<number> {
	const [row] = await db
		.select({
			maxRowid: sql<number>`coalesce(max(${rowid}), 0)`.as("max_rowid"),
		})
		.from(osGadgetCode);
	return row?.maxRowid ?? 0;
}

export interface LegacyOsGadgetCodeCandidate {
	rowid: number;
	revisionId: string;
	organizationId: string;
}

/** Rows in `(after, through]` that still carry their files inline, oldest first. */
export async function listLegacyOsGadgetCodeCandidates(
	db: DbQueryClient,
	params: { after: number; through: number; limit: number },
): Promise<LegacyOsGadgetCodeCandidate[]> {
	if (
		![params.after, params.through, params.limit].every(Number.isSafeInteger) ||
		params.after < 0 ||
		params.through < params.after ||
		params.through - params.after > GADGET_CODE_BACKFILL_MAX_WINDOW ||
		params.limit < 1 ||
		params.limit > GADGET_CODE_BACKFILL_MAX_LIMIT
	)
		throw new Error("Invalid gadget code backfill bounds");
	return db
		.select({
			rowid: rowid.as("code_rowid"),
			revisionId: osGadgetCode.revisionId,
			organizationId: osGadgetCode.organizationId,
		})
		.from(osGadgetCode)
		.where(
			sql`${rowid} > ${params.after} AND ${rowid} <= ${params.through} AND ${osGadgetCode.filesSha256} IS NULL`,
		)
		.orderBy(rowid)
		.limit(params.limit);
}

/** One legacy row's files, read on its own so a tick never holds many. */
export async function getLegacyOsGadgetCode(
	db: DbQueryClient,
	params: { rowid: number; revisionId: string },
): Promise<(OsGadgetCodeFiles & { organizationId: string }) | undefined> {
	const [row] = await db
		.select({
			organizationId: osGadgetCode.organizationId,
			files: osGadgetCode.files,
			codeLength: osGadgetCode.codeLength,
		})
		.from(osGadgetCode)
		.where(
			and(
				sql`${rowid} = ${params.rowid}`,
				eq(osGadgetCode.revisionId, params.revisionId),
				isNull(osGadgetCode.filesSha256),
			),
		)
		.limit(1);
	return row;
}

export async function osGadgetCodeBlobExists(
	db: DbQueryClient,
	params: { organizationId: string; sha256: string },
): Promise<boolean> {
	const [row] = await db
		.select({ sha256: osGadgetCodeBlobs.sha256 })
		.from(osGadgetCodeBlobs)
		.where(
			and(
				eq(osGadgetCodeBlobs.organizationId, params.organizationId),
				eq(osGadgetCodeBlobs.sha256, params.sha256),
			),
		)
		.limit(1);
	return row !== undefined;
}

export async function ensureOsGadgetCodeBlob(
	db: DbQueryClient,
	params: OsGadgetCodeBlobParams,
): Promise<void> {
	await buildEnsureOsGadgetCodeBlobStatement(db, params);
}

/**
 * Point a legacy row at its blob and drop the inline copy, in one statement.
 * It applies only while the row is still legacy and its inline files equal
 * the blob's, byte for byte, so the files are never cleared without an
 * identical copy in place. Returns whether the row changed.
 */
export async function referenceOsGadgetCodeBlob(
	db: DbQueryClient,
	params: { revisionId: string; organizationId: string; sha256: string },
): Promise<boolean> {
	const changed = await db
		.update(osGadgetCode)
		.set({ filesSha256: params.sha256, files: "" })
		.where(
			and(
				eq(osGadgetCode.revisionId, params.revisionId),
				eq(osGadgetCode.organizationId, params.organizationId),
				isNull(osGadgetCode.filesSha256),
				sql`${osGadgetCode.files} = (select ${osGadgetCodeBlobs.files} from ${osGadgetCodeBlobs} where ${osGadgetCodeBlobs.organizationId} = ${params.organizationId} and ${osGadgetCodeBlobs.sha256} = ${params.sha256})`,
			),
		)
		.returning({ revisionId: osGadgetCode.revisionId });
	return changed.length === 1;
}
