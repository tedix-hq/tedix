/**
 * Retention for catalog import archives in R2 (`catalog/snapshots/<org>/<id>.json`).
 *
 * The snapshot import writes one archive per run and reads it back only while
 * that run's import is in flight, so a week covers every retry and replay.
 * Past that, an archive is only a stale copy of upstream listings, including
 * ones the catalog has since suppressed after a removal request.
 */

export const CATALOG_SNAPSHOT_PREFIX = "catalog/snapshots/";
export const CATALOG_SNAPSHOT_RETENTION_DAYS = 7;
/** R2 deletes at most 1,000 keys per call. */
const DELETE_BATCH = 1_000;

type SnapshotBucket = Pick<R2Bucket, "list" | "delete">;

export async function purgeOldCatalogSnapshots(input: {
	bucket: SnapshotBucket;
	now: Date;
	/** Most archives one run deletes; the next daily run continues. */
	limit?: number;
}): Promise<{ deleted: number }> {
	const cutoff =
		input.now.getTime() - CATALOG_SNAPSHOT_RETENTION_DAYS * 86_400_000;
	const limit = input.limit ?? 5_000;
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const page = await input.bucket.list({
			prefix: CATALOG_SNAPSHOT_PREFIX,
			limit: DELETE_BATCH,
			...(cursor ? { cursor } : {}),
		});
		const expired = page.objects
			.filter((object) => object.uploaded.getTime() < cutoff)
			.map((object) => object.key)
			.slice(0, limit - deleted);
		if (expired.length > 0) {
			await input.bucket.delete(expired);
			deleted += expired.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor && deleted < limit);
	return { deleted };
}
