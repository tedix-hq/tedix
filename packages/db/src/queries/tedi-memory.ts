/**
 * A tedi's own memory: one core document and named notes, kept as versions.
 * Every statement is scoped to one organization and one tedi.
 */

import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type TediMemoryAuthorType,
	type TediMemoryDocumentKind,
	type TediMemoryDocumentRow,
	tediMemoryDocuments,
} from "../schema/tedi-memory";

/** The name the core document is stored under. */
export const TEDI_CORE_MEMORY_NAME = "core";

export interface TediMemoryDocumentParams {
	organizationId: string;
	tediId: string;
	kind: TediMemoryDocumentKind;
	name: string;
}

function documentScope(params: TediMemoryDocumentParams) {
	return and(
		eq(tediMemoryDocuments.organizationId, params.organizationId),
		eq(tediMemoryDocuments.tediId, params.tediId),
		eq(tediMemoryDocuments.kind, params.kind),
		eq(tediMemoryDocuments.name, params.name),
	);
}

/** The newest version of one document, or null when it was never written. */
export async function getCurrentTediMemoryDocument(
	db: DbQueryClient,
	params: TediMemoryDocumentParams,
): Promise<TediMemoryDocumentRow | null> {
	const [row] = await db
		.select()
		.from(tediMemoryDocuments)
		.where(documentScope(params))
		.orderBy(desc(tediMemoryDocuments.version))
		.limit(1);
	return row ?? null;
}

export async function getTediMemoryDocumentVersion(
	db: DbQueryClient,
	params: TediMemoryDocumentParams & { version: number },
): Promise<TediMemoryDocumentRow | null> {
	const [row] = await db
		.select()
		.from(tediMemoryDocuments)
		.where(
			and(
				documentScope(params),
				eq(tediMemoryDocuments.version, params.version),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Versions of one document, newest first. */
export async function listTediMemoryDocumentVersions(
	db: DbQueryClient,
	params: TediMemoryDocumentParams & { limit: number },
): Promise<TediMemoryDocumentRow[]> {
	return db
		.select()
		.from(tediMemoryDocuments)
		.where(documentScope(params))
		.orderBy(desc(tediMemoryDocuments.version))
		.limit(params.limit);
}

export interface AppendTediMemoryVersionParams extends TediMemoryDocumentParams {
	id: string;
	/** The version this change was made from; 0 for a document's first version. */
	baseVersion: number;
	sections?: Record<string, string> | null;
	description?: string | null;
	content?: string | null;
	removed?: boolean;
	charCount: number;
	authorType: TediMemoryAuthorType;
	authorId: string;
	changeSummary: string;
	createdAt: string;
	/** How many versions of this document to keep. */
	keepVersions: number;
}

/**
 * Adds the next version. Returns false when another change was stored from
 * the same base version first; the caller reads again and retries. Versions
 * older than `keepVersions` are dropped in the same batch.
 */
export async function appendTediMemoryDocumentVersion(
	db: DbQueryClient,
	params: AppendTediMemoryVersionParams,
): Promise<boolean> {
	const version = params.baseVersion + 1;
	const [inserted] = await db.batch([
		db
			.insert(tediMemoryDocuments)
			.values({
				id: params.id,
				organizationId: params.organizationId,
				tediId: params.tediId,
				kind: params.kind,
				name: params.name,
				version,
				sections: params.sections ?? null,
				description: params.description ?? null,
				content: params.content ?? null,
				removed: params.removed ?? false,
				charCount: params.charCount,
				authorType: params.authorType,
				authorId: params.authorId,
				changeSummary: params.changeSummary,
				createdAt: params.createdAt,
			})
			.onConflictDoNothing()
			.returning({ storedId: tediMemoryDocuments.id }),
		db
			.delete(tediMemoryDocuments)
			.where(
				and(
					documentScope(params),
					lte(tediMemoryDocuments.version, version - params.keepVersions),
				),
			),
	]);
	return inserted.length === 1;
}

export interface TediMemoryNoteSummary {
	name: string;
	description: string;
	version: number;
	charCount: number;
	updatedAt: string;
}

/** The tedi's notes as they are now, without their text, by name. */
export async function listCurrentTediMemoryNotes(
	db: DbQueryClient,
	params: { organizationId: string; tediId: string },
): Promise<TediMemoryNoteSummary[]> {
	const rows = await db
		.select({
			name: tediMemoryDocuments.name,
			description: tediMemoryDocuments.description,
			version: tediMemoryDocuments.version,
			charCount: tediMemoryDocuments.charCount,
			updatedAt: tediMemoryDocuments.createdAt,
			removed: tediMemoryDocuments.removed,
		})
		.from(tediMemoryDocuments)
		.where(
			and(
				eq(tediMemoryDocuments.organizationId, params.organizationId),
				eq(tediMemoryDocuments.tediId, params.tediId),
				eq(tediMemoryDocuments.kind, "note"),
				sql`${tediMemoryDocuments.version} = (
					SELECT MAX(newer.version) FROM tedi_memory_documents AS newer
					WHERE newer.organization_id = ${tediMemoryDocuments.organizationId}
						AND newer.tedi_id = ${tediMemoryDocuments.tediId}
						AND newer.kind = 'note'
						AND newer.name = ${tediMemoryDocuments.name}
				)`,
			),
		)
		.orderBy(tediMemoryDocuments.name);
	return rows
		.filter((row) => !row.removed)
		.map((row) => ({
			name: row.name,
			description: row.description ?? "",
			version: row.version,
			charCount: row.charCount,
			updatedAt: row.updatedAt,
		}));
}
