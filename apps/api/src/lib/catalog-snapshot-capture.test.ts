import { describe, expect, it } from "vite-plus/test";
import {
	assertSnapshotCaptureUrl,
	readSnapshotParts,
} from "./catalog-snapshot-capture";
import {
	SNAPSHOT_BATCH_SIZE,
	SNAPSHOT_PART_SIZE,
	locateSnapshotBatch,
	snapshotBatchCount,
	snapshotPartCount,
	snapshotPartKey,
} from "../workflows/catalog-snapshot-parts";

const item = {
	source: "chatgpt",
	sourceAppId: "a",
	name: "A",
	connectorType: "MCP",
	developerType: "THIRD_PARTY",
};

/** Stand-in for the browser page: holds a snapshot and answers the two kinds of read. */
function page(snapshot: {
	expectedSourceCount: number;
	capturedSourceCount: number;
	items: unknown[];
}) {
	return async (script: string) => {
		const slice = script.match(/\.slice\((\d+), (\d+)\)$/);
		if (slice) return snapshot.items.slice(Number(slice[1]), Number(slice[2]));
		return {
			expectedSourceCount: snapshot.expectedSourceCount,
			capturedSourceCount: snapshot.capturedSourceCount,
			itemCount: snapshot.items.length,
		};
	};
}

async function read(snapshot: Parameters<typeof page>[0]) {
	const parts: unknown[][] = [];
	const manifest = await readSnapshotParts(
		page(snapshot),
		"snapshot()",
		async (part, items) => {
			parts[part] = items;
		},
	);
	return { manifest, parts };
}

describe("supplier snapshot boundary", () => {
	it("rejects an incomplete capture before any part is stored", async () => {
		await expect(
			read({
				expectedSourceCount: 200,
				capturedSourceCount: 20,
				items: [item],
			}),
		).rejects.toThrow("incomplete");
	});
	it("rejects duplicate store identities, permits a cross-store match", async () => {
		await expect(
			read({
				expectedSourceCount: 2,
				capturedSourceCount: 2,
				items: [item, item],
			}),
		).rejects.toThrow("Duplicate");
		const { manifest } = await read({
			expectedSourceCount: 1,
			capturedSourceCount: 1,
			items: [item, { ...item, source: "claude" }],
		});
		expect(manifest.itemCount).toBe(2);
	});
	it("rejects empty snapshots and unknown normalized fields", async () => {
		await expect(
			read({ expectedSourceCount: 0, capturedSourceCount: 0, items: [] }),
		).rejects.toThrow();
		await expect(
			read({
				expectedSourceCount: 1,
				capturedSourceCount: 1,
				items: [{ ...item, admin: true }],
			}),
		).rejects.toThrow("part 0");
	});
	it("hands a large directory over in bounded parts, every listing once", async () => {
		const items = Array.from(
			{ length: 2 * SNAPSHOT_PART_SIZE + 7 },
			(_, i) => ({
				...item,
				sourceAppId: `app-${i}`,
			}),
		);
		const { manifest, parts } = await read({
			expectedSourceCount: items.length,
			capturedSourceCount: items.length,
			items,
		});
		expect(manifest.itemCount).toBe(items.length);
		expect(parts.map((part) => part.length)).toEqual([
			SNAPSHOT_PART_SIZE,
			SNAPSHOT_PART_SIZE,
			7,
		]);
		expect(parts.flat()).toEqual(items);
	});
	it("rejects credentialed, private and platform origins", () => {
		for (const url of [
			"http://example.com",
			"https://127.1/",
			"https://169.254.169.254",
			"https://api.tedix.dev",
			"https://user:password@example.com",
		])
			expect(() => assertSnapshotCaptureUrl(url)).toThrow();
		expect(assertSnapshotCaptureUrl("https://example.com/path")).toBe(
			"https://example.com",
		);
	});
});

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
