import { eq, sql } from "drizzle-orm";
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
