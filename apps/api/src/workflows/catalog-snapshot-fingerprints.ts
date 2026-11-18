import type { CatalogSnapshotItem } from "@tedix/api-contract/schemas/catalog-snapshot";

/**
 * A store directory changes little from one night to the next. The import
 * keeps a fingerprint of every listing as the supplier sent it, and on the next
 * run writes only the listings whose fingerprint differs. Unchanged listings
 * are only marked as seen, so they are not delisted as stale.
 */

/** Raise this to make the next import write every listing again. */
export const FINGERPRINT_VERSION = 1;

/** Unchanged listings are marked as seen this many at a time. */
export const SEEN_PART_SIZE = 2000;

export type ListingFingerprints = Record<string, string>;
export type SeenListing = [source: string, sourceAppId: string];

export function listingKey(item: {
	source: string;
	sourceAppId: string;
}): string {
	return `${item.source}:${item.sourceAppId}`;
}

export async function fingerprintListing(
	item: CatalogSnapshotItem,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(item)),
		),
	);
	return Array.from(digest.subarray(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** The fingerprints of the last import of this feed that finished. */
export function feedFingerprintsKey(owner: string, feed: string): string {
	return `catalog/fingerprints/${owner}/${feed}.json`;
}

/** This run's fingerprints, kept beside its snapshot until the run finishes. */
export function pendingFingerprintsKey(snapshotKey: string): string {
	return `${snapshotKey}.fingerprints.json`;
}

export function seenPartKey(snapshotKey: string, part: number): string {
	return `${snapshotKey}.seen/${String(part).padStart(5, "0")}.json`;
}

export function seenPartCount(unchangedCount: number): number {
	return Math.ceil(unchangedCount / SEEN_PART_SIZE);
}

export function packFingerprints(
	provenanceKey: string,
	fingerprints: ListingFingerprints,
): string {
	return JSON.stringify({
		version: FINGERPRINT_VERSION,
		provenanceKey,
		fingerprints,
	});
}

/**
 * Fingerprints a run may compare against. Anything written by another version
 * of this code or for another feed marker counts as absent, so every listing
 * is written again rather than wrongly skipped.
 */
export function usableFingerprints(
	stored: unknown,
	provenanceKey: string,
): ListingFingerprints {
	if (!stored || typeof stored !== "object") return {};
	const {
		version,
		provenanceKey: storedKey,
		fingerprints,
	} = stored as Record<string, unknown>;
	if (version !== FINGERPRINT_VERSION || storedKey !== provenanceKey) return {};
	if (!fingerprints || typeof fingerprints !== "object") return {};
	return fingerprints as ListingFingerprints;
}
