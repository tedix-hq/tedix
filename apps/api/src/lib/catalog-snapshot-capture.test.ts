import { describe, expect, it } from "vite-plus/test";
import {
	assertSnapshotCaptureUrl,
	readSnapshotParts,
} from "./catalog-snapshot-capture";
import { SNAPSHOT_PART_SIZE } from "../workflows/catalog-snapshot-parts";

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
