import type { Source } from "@tedix/db/schema/catalog";
import { isDurableObjectResetError } from "../lib/durable-object-reset";

/** Detected source info from filename */
export interface DetectedSource {
	source: Source;
	filename: string;
	allowCreate?: boolean;
}

/**
 * Return stable offsets for a bounded file sync. A zero-record file still gets
 * one batch so the Workflow can persist an explicit empty-file result.
 */
export function planCatalogFileBatchOffsets(
	recordCount: number,
	batchSize: number,
): number[] {
	if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
		throw new Error("recordCount must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
		throw new Error("batchSize must be a positive safe integer");
	}

	const offsets: number[] = [];
	const boundedCount = Math.max(recordCount, 1);
	for (let offset = 0; offset < boundedCount; offset += batchSize) {
		offsets.push(offset);
	}
	return offsets;
}

/**
 * Cloudflare may replay an active Workflow after its backing Durable Object
 * resets — a code deploy, a storage timeout, or a lost connection to the
 * object. None of those is a terminal business failure, so classify on the
 * flags workerd attaches (`durableObjectReset`/`retryable`) rather than on any
 * one reset message: the storage-timeout reset carries a different message, and
 * every message is Cloudflare's to reword.
 */
export function isCatalogSyncDeployReset(error: unknown): boolean {
	return isDurableObjectResetError(error);
}

/**
 * Detect the active R2 source from its canonical filename.
 */
export function detectSourceFromFilename(
	filename: string,
): DetectedSource | null {
	const basename = filename.split("/").pop() || filename;

	// Claude Registry API files
	if (basename === "registry_servers.json") {
		return {
			source: "claude" as Source,
			filename,
			allowCreate: true,
		};
	}

	return null;
}
