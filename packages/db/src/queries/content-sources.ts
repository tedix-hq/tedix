/**
 * Content Sources Queries
 * CRUD operations for the content_sources table
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
	contentSourceDocuments,
	contentSources,
	type ContentSourceDocument,
	type ContentSource,
	type NewContentSourceDocument,
	type NewContentSource,
} from "../schema/content-sources";
import type { DbClient } from "../client";
import { chunkForBoundParams } from "../utils/batch";
import { getAffectedRows } from "../utils/d1-result";

/**
 * List all content sources for an app
 */
export async function listContentSources(
	db: DbClient,
	appId: string,
): Promise<ContentSource[]> {
	return db
		.select()
		.from(contentSources)
		.where(eq(contentSources.appId, appId))
		.orderBy(desc(contentSources.createdAt));
}

/**
 * Get a single content source by ID
 */
export async function getContentSource(
	db: DbClient,
	sourceId: string,
): Promise<ContentSource | undefined> {
	return db.query.contentSources.findFirst({ where: { id: sourceId } });
}

/**
 * Create a new content source
 */
export async function createContentSource(
	db: DbClient,
	source: NewContentSource,
): Promise<ContentSource> {
	const [result] = await db.insert(contentSources).values(source).returning();
	return result!;
}

/**
 * Delete a content source
 */
export async function deleteContentSource(
	db: DbClient,
	sourceId: string,
	appId: string,
): Promise<boolean> {
	const result = await db
		.delete(contentSources)
		.where(
			and(eq(contentSources.id, sourceId), eq(contentSources.appId, appId)),
		);
	return getAffectedRows(result) !== 0;
}

/**
 * Update ingestion status after a sync attempt
 */
export async function updateContentSourceIngestStatus(
	db: DbClient,
	sourceId: string,
	status: {
		lastIngestStatus: "pending" | "success" | "failed" | "stale";
		documentCount?: number;
		lastError?: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(contentSources)
		.set({
			lastIngestStatus: status.lastIngestStatus,
			...(status.documentCount !== undefined && {
				documentCount: status.documentCount,
			}),
			...(status.lastError !== undefined && { lastError: status.lastError }),
			...(status.lastIngestStatus === "success" && { lastIngestedAt: now }),
			updatedAt: now,
		})
		.where(eq(contentSources.id, sourceId));
}

export async function upsertContentSourceDocument(
	db: DbClient,
	document: NewContentSourceDocument,
): Promise<ContentSourceDocument> {
	const now = new Date().toISOString();
	await db
		.insert(contentSourceDocuments)
		.values(document)
		.onConflictDoUpdate({
			target: [
				contentSourceDocuments.appId,
				contentSourceDocuments.canonicalUrl,
			],
			set: {
				sourceId: document.sourceId,
				sourceRevision: document.sourceRevision,
				visibility: document.visibility,
				objectKey: document.objectKey,
				digest: document.digest,
				title: document.title,
				contentType: document.contentType,
				aiSearchItemId: null,
				aiSearchStatus: "pending",
				aiSearchError: null,
				updatedAt: now,
			},
		});

	const saved = await db.query.contentSourceDocuments.findFirst({
		where: { appId: document.appId, canonicalUrl: document.canonicalUrl },
	});
	if (!saved) throw new Error("Failed to upsert content source document");
	return saved;
}

export async function updateContentSourceDocumentProjection(
	db: DbClient,
	documentId: string,
	projection: {
		aiSearchItemId?: string | null;
		aiSearchStatus: "pending" | "completed" | "failed";
		aiSearchError?: string | null;
	},
): Promise<void> {
	await db
		.update(contentSourceDocuments)
		.set({ ...projection, updatedAt: new Date().toISOString() })
		.where(eq(contentSourceDocuments.id, documentId));
}

export async function listContentSourceDocumentsByObjectKeys(
	db: DbClient,
	appId: string,
	objectKeys: string[],
): Promise<ContentSourceDocument[]> {
	if (objectKeys.length === 0) return [];
	const rows: ContentSourceDocument[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the key IN() list.
	for (const chunk of chunkForBoundParams([...new Set(objectKeys)], 50)) {
		rows.push(
			...(await db
				.select()
				.from(contentSourceDocuments)
				.where(
					and(
						eq(contentSourceDocuments.appId, appId),
						inArray(contentSourceDocuments.objectKey, chunk),
					),
				)),
		);
	}
	return rows;
}
