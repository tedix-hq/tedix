import {
	deleteEvictedKernelToolResult,
	getKernelToolResultById,
	getReadableKernelToolResultBySource,
	getReadableKernelToolResult,
	insertKernelToolResultWithRetention,
	KERNEL_TOOL_RESULT_MAX_BYTES,
	listKernelToolResultsForCleanup,
	type EvictedKernelToolResult,
} from "@tedix/db/queries/kernel-tool-results";
import type { DbQueryClient } from "@tedix/db/query-client";

export const KERNEL_TOOL_RESULT_PREFIX = "home-tool-results/";
export const KERNEL_TOOL_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
export const KERNEL_TOOL_RESULT_PAGE_BYTES = 50 * 1024;
export const KERNEL_TOOL_RESULT_AUXILIARY_DEADLINE_MS = 1_500;
const textEncoder = new TextEncoder();

export interface KernelToolResultReference {
	id: string;
	sha256: string;
	byteSize: number;
	expiresAt: string;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return bytesToHex(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
	);
}

function serialize(value: unknown): Uint8Array | null {
	try {
		return new TextEncoder().encode(JSON.stringify(value ?? null));
	} catch {
		return null;
	}
}

async function deleteEvicted(
	db: DbQueryClient,
	bucket: R2Bucket,
	rows: EvictedKernelToolResult[],
): Promise<number> {
	let deleted = 0;
	for (const row of rows) {
		if (!row.evictedAt) continue;
		try {
			await bucket.delete(row.objectKey);
			if (
				await deleteEvictedKernelToolResult(db, {
					id: row.id,
					objectKey: row.objectKey,
					evictedAt: row.evictedAt,
				})
			)
				deleted++;
		} catch (error) {
			console.warn("[kernel-tool-result] exact-key cleanup failed", {
				id: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return deleted;
}

/** Retention is auxiliary: callers keep their original result if this returns null. */
async function retainKernelToolResultCore(input: {
	db: DbQueryClient;
	bucket: R2Bucket;
	organizationId: string;
	conversationId: string;
	runId?: string | null;
	sourceKind: "direct_read" | "approved_write";
	sourceId: string;
	value: unknown;
	now?: Date;
}): Promise<KernelToolResultReference | null> {
	const bytes = serialize(input.value);
	if (!bytes || bytes.byteLength > KERNEL_TOOL_RESULT_MAX_BYTES) return null;
	const now = input.now ?? new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(
		now.getTime() + KERNEL_TOOL_RESULT_TTL_MS,
	).toISOString();
	const id = crypto.randomUUID();
	const objectKey = `${KERNEL_TOOL_RESULT_PREFIX}${input.organizationId}/${input.conversationId}/${crypto.randomUUID()}`;
	const digest = await sha256(bytes);
	try {
		const existing = await getReadableKernelToolResultBySource(input.db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			now: createdAt,
		});
		if (existing)
			return {
				id: existing.id,
				sha256: existing.sha256,
				byteSize: existing.byteSize,
				expiresAt: existing.expiresAt,
			};
	} catch {
		// Continue to the create-only attempt. A later canonical read resolves an
		// ambiguous insert or duplicate source without deleting either R2 candidate.
	}
	try {
		const object = await input.bucket.put(objectKey, bytes, {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/json; charset=utf-8" },
			customMetadata: { resultId: id, sha256: digest, expiresAt },
		});
		if (!object) return null;
		try {
			const persisted = await insertKernelToolResultWithRetention(input.db, {
				id,
				organizationId: input.organizationId,
				conversationId: input.conversationId,
				runId: input.runId ?? null,
				sourceKind: input.sourceKind,
				sourceId: input.sourceId,
				objectKey,
				sha256: digest,
				byteSize: bytes.byteLength,
				contentType: "application/json; charset=utf-8",
				createdAt,
				expiresAt,
				now: createdAt,
			});
			await deleteEvicted(input.db, input.bucket, persisted.evicted);
			if (persisted.evicted.some((row) => row.id === id)) return null;
			return { id, sha256: digest, byteSize: bytes.byteLength, expiresAt };
		} catch (error) {
			// A timed-out D1 batch may have committed. Read the canonical row; never
			// delete this key on an absent/failed/mismatched read. The prefix lifecycle
			// is the bounded orphan backstop.
			try {
				const insertedRow = await getKernelToolResultById(input.db, {
					organizationId: input.organizationId,
					conversationId: input.conversationId,
					id,
				});
				if (
					insertedRow?.objectKey === objectKey &&
					insertedRow.sha256 === digest &&
					insertedRow.byteSize === bytes.byteLength &&
					!insertedRow.evictedAt
				)
					return { id, sha256: digest, byteSize: bytes.byteLength, expiresAt };
				const canonical = await getReadableKernelToolResultBySource(input.db, {
					organizationId: input.organizationId,
					conversationId: input.conversationId,
					sourceKind: input.sourceKind,
					sourceId: input.sourceId,
					now: createdAt,
				});
				if (canonical)
					return {
						id: canonical.id,
						sha256: canonical.sha256,
						byteSize: canonical.byteSize,
						expiresAt: canonical.expiresAt,
					};
			} catch {
				// Preserve the candidate; lifecycle cleanup is independent of D1.
			}
			console.warn("[kernel-tool-result] persistence not confirmed", {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	} catch (error) {
		console.warn("[kernel-tool-result] R2 upload failed", {
			id,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Auxiliary retention must never hold a successful provider result open. */
export async function retainKernelToolResult(
	input: Parameters<typeof retainKernelToolResultCore>[0],
): Promise<KernelToolResultReference | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		retainKernelToolResultCore(input),
		new Promise<null>((resolve) => {
			timer = setTimeout(
				() => resolve(null),
				KERNEL_TOOL_RESULT_AUXILIARY_DEADLINE_MS,
			);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export async function readKernelToolResult(input: {
	db: DbQueryClient;
	bucket: R2Bucket;
	organizationId: string;
	conversationId: string;
	id: string;
	sha256: string;
	now?: Date;
}): Promise<{ text: string; byteSize: number } | null> {
	const row = await getReadableKernelToolResult(input.db, {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		id: input.id,
		sha256: input.sha256,
		now: (input.now ?? new Date()).toISOString(),
	});
	if (!row) return null;
	const object = await input.bucket.get(row.objectKey);
	if (!object) throw new Error("Retained tool result bytes are unavailable");
	const bytes = new Uint8Array(await object.arrayBuffer());
	if (bytes.byteLength !== row.byteSize || (await sha256(bytes)) !== row.sha256)
		throw new Error("Retained tool result integrity check failed");
	return {
		text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		),
		byteSize: bytes.byteLength,
	};
}

export async function cleanupKernelToolResults(input: {
	db: DbQueryClient;
	bucket: R2Bucket;
	now: Date;
	limit?: number;
}): Promise<{ attempted: number; deleted: number }> {
	const rows = await listKernelToolResultsForCleanup(input.db, {
		now: input.now.toISOString(),
		limit: Math.min(50, Math.max(1, input.limit ?? 50)),
	});
	return {
		attempted: rows.length,
		deleted: await deleteEvicted(input.db, input.bucket, rows),
	};
}

export async function cleanupExactKernelToolResults(input: {
	db: DbQueryClient;
	bucket: R2Bucket;
	rows: EvictedKernelToolResult[];
}): Promise<number> {
	return deleteEvicted(input.db, input.bucket, input.rows);
}

export function utf8Page(
	text: string,
	offset: number,
	maxBytes = KERNEL_TOOL_RESULT_PAGE_BYTES,
): { content: string; nextOffset: number | null } {
	const points = Array.from(text);
	const safeOffset = Math.min(Math.max(0, offset), points.length);
	let used = 0;
	let end = safeOffset;
	for (; end < points.length; end++) {
		const size = textEncoder.encode(points[end]).byteLength;
		if (used + size > maxBytes) break;
		used += size;
	}
	return {
		content: points.slice(safeOffset, end).join(""),
		nextOffset: end < points.length ? end : null,
	};
}

export function literalSearch(
	text: string,
	query: string,
	fromOffset: number,
): { content: string; matchOffset: number | null; nextOffset: number | null } {
	const points = Array.from(text);
	const start = Math.min(Math.max(0, fromOffset), points.length);
	const utf16Start = points.slice(0, start).join("").length;
	const utf16Match = text.indexOf(query, utf16Start);
	if (utf16Match < 0)
		return { content: "", matchOffset: null, nextOffset: null };
	const match = Array.from(text.slice(0, utf16Match)).length;
	const page = utf8Page(points.slice(match).join(""), 0);
	return {
		content: page.content,
		matchOffset: match,
		nextOffset: page.nextOffset === null ? null : match + page.nextOffset,
	};
}
