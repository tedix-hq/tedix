/**
 * A supplier snapshot holds every listing of a store. It is too large for one
 * browser message or to keep in memory for a long run, so the capture stores
 * it as part files and each Workflow batch step reads only the part it needs.
 */
export const SNAPSHOT_PART_SIZE = 500;
export const SNAPSHOT_BATCH_SIZE = 10;

export function snapshotPartKey(snapshotKey: string, part: number): string {
	return `${snapshotKey}.parts/${String(part).padStart(5, "0")}.json`;
}

export function snapshotPartCount(itemCount: number): number {
	return Math.ceil(itemCount / SNAPSHOT_PART_SIZE);
}

export function snapshotBatchCount(itemCount: number): number {
	return Math.ceil(itemCount / SNAPSHOT_BATCH_SIZE);
}

/** Where batch `index` lives: which part file, and the slice inside it. */
export function locateSnapshotBatch(index: number): {
	part: number;
	start: number;
	end: number;
} {
	const offset = index * SNAPSHOT_BATCH_SIZE;
	const start = offset % SNAPSHOT_PART_SIZE;
	return {
		part: Math.floor(offset / SNAPSHOT_PART_SIZE),
		start,
		end: start + SNAPSHOT_BATCH_SIZE,
	};
}
