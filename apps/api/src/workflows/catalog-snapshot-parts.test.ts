import { describe, expect, it } from "vite-plus/test";
import {
	SNAPSHOT_BATCH_SIZE,
	SNAPSHOT_PART_SIZE,
	locateSnapshotBatch,
	snapshotBatchCount,
	snapshotPartCount,
	snapshotPartKey,
} from "./catalog-snapshot-parts";

describe("catalog snapshot parts", () => {
	it("covers every listing exactly once, in order", () => {
		const itemCount = 12_413;
		const items = Array.from({ length: itemCount }, (_, i) => i);
		const parts = Array.from({ length: snapshotPartCount(itemCount) }, (_, p) =>
			items.slice(p * SNAPSHOT_PART_SIZE, (p + 1) * SNAPSHOT_PART_SIZE),
		);
		const seen: number[] = [];
		for (let index = 0; index < snapshotBatchCount(itemCount); index++) {
			const { part, start, end } = locateSnapshotBatch(index);
			const batch = parts[part]!.slice(start, end);
			expect(batch.length).toBeGreaterThan(0);
			expect(batch.length).toBeLessThanOrEqual(SNAPSHOT_BATCH_SIZE);
			seen.push(...batch);
		}
		expect(seen).toEqual(items);
	});

	it("plans no batches for an empty count and one for a single listing", () => {
		expect(snapshotBatchCount(0)).toBe(0);
		expect(snapshotPartCount(1)).toBe(1);
		expect(snapshotBatchCount(1)).toBe(1);
	});

	it("names part files next to the snapshot in sortable order", () => {
		expect(snapshotPartKey("catalog/snapshots/org/a.json", 7)).toBe(
			"catalog/snapshots/org/a.json.parts/00007.json",
		);
	});
});
