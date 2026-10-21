/**
 * Large audit metadata goes to R2, not D1. An audit row's metadata is usually
 * a few hundred bytes of identifiers; a tool result or argument echo can be
 * tens of kilobytes. Above `AUDIT_METADATA_INLINE_BYTES` the full metadata
 * is written to the private tedi bucket under `audit-bodies/v1/` and the row
 * keeps the scalar fields (the keys analytics and search filter on) plus a
 * pointer: `{ bodyKey, bodyBytes, bodyKeys }`.
 *
 * Without a bucket the metadata is stored as given, exactly as before.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";

export const AUDIT_METADATA_INLINE_BYTES = 4 * 1024;
export const AUDIT_BODY_PREFIX = "audit-bodies/v1/";

const utf8 = new TextEncoder();

export interface SplitAuditMetadata {
	/** What the audit row stores. */
	inline: Record<string, JsonValue>;
	/** The full metadata to store in R2, or null when it fits inline. */
	body: string | null;
}

export function auditBodyKey(organizationId: string, auditId: string): string {
	return `${AUDIT_BODY_PREFIX}${organizationId}/${auditId}.json`;
}

/**
 * Keep short scalars inline; move everything else behind a pointer when the
 * serialized metadata exceeds `maxBytes`.
 */
export function splitAuditMetadata(
	metadata: Record<string, JsonValue>,
	bodyKey: string,
	maxBytes = AUDIT_METADATA_INLINE_BYTES,
): SplitAuditMetadata {
	const serialized = JSON.stringify(metadata);
	const bytes = utf8.encode(serialized).byteLength;
	if (bytes <= maxBytes) return { inline: metadata, body: null };
	const inline: Record<string, JsonValue> = {};
	const spilled: string[] = [];
	for (const [key, value] of Object.entries(metadata)) {
		const scalar =
			value === null ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			(typeof value === "string" && value.length <= 256);
		if (scalar) inline[key] = value;
		else spilled.push(key);
	}
	inline.bodyKey = bodyKey;
	inline.bodyBytes = bytes;
	inline.bodyKeys = spilled;
	return { inline, body: serialized };
}

/**
 * Store oversized metadata in the bucket and return what the row keeps. The
 * body is written before the row, so a pointer never dangles; a failed write
 * leaves the metadata inline rather than losing it.
 */
export async function spillAuditMetadata(
	metadata: Record<string, JsonValue>,
	input: { bucket?: R2Bucket; organizationId: string; auditId: string },
): Promise<Record<string, JsonValue>> {
	if (!input.bucket) return metadata;
	const key = auditBodyKey(input.organizationId, input.auditId);
	const split = splitAuditMetadata(metadata, key);
	if (split.body === null) return metadata;
	try {
		await input.bucket.put(key, split.body, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: {
				organizationId: input.organizationId,
				auditId: input.auditId,
			},
		});
	} catch (error) {
		console.warn(
			JSON.stringify({
				signal: "audit.metadata.spill_failed",
				auditId: input.auditId,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return metadata;
	}
	return split.inline;
}
