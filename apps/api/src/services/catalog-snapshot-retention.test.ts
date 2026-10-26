import { describe, expect, it } from "vite-plus/test";
import {
	CATALOG_SNAPSHOT_RETENTION_DAYS,
	purgeOldCatalogSnapshots,
} from "./catalog-snapshot-retention";

const now = new Date("2026-10-26T03:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

function bucket(objects: Array<{ key: string; uploaded: Date }>, pageSize = 2) {
	const stored = new Map(objects.map((object) => [object.key, object]));
	const lists: Array<{ prefix?: string; cursor?: string }> = [];
	return {
		stored,
		lists,
		async list(options: { prefix?: string; cursor?: string; limit?: number }) {
			lists.push({ prefix: options.prefix, cursor: options.cursor });
			// Like R2, the cursor marks a position in key order, so deleting
			// listed keys does not shift the next page.
			const keys = [...stored.keys()]
				.filter((key) => key.startsWith(options.prefix ?? ""))
				.filter((key) => !options.cursor || key > options.cursor)
				.sort();
			const page = keys.slice(0, pageSize);
			const truncated = keys.length > pageSize;
			return {
				objects: page.map((key) => stored.get(key)!),
				truncated,
				...(truncated ? { cursor: page[page.length - 1] } : {}),
			};
		},
		async delete(keys: string | string[]) {
			for (const key of [keys].flat()) stored.delete(key);
		},
	};
}

describe("catalog snapshot retention", () => {
	it("deletes archives older than the retention window across pages", async () => {
		const fake = bucket([
			{ key: "catalog/snapshots/org-a/run-1.json", uploaded: daysAgo(30) },
			{ key: "catalog/snapshots/org-a/run-2.json", uploaded: daysAgo(10) },
			{ key: "catalog/snapshots/org-b/run-3.json", uploaded: daysAgo(2) },
			{ key: "catalog/snapshots/org-b/run-4.json", uploaded: daysAgo(40) },
			{ key: "other/keep.json", uploaded: daysAgo(400) },
		]);
		const result = await purgeOldCatalogSnapshots({
			bucket: fake as never,
			now,
		});
		expect(result.deleted).toBe(3);
		expect([...fake.stored.keys()].sort()).toEqual([
			"catalog/snapshots/org-b/run-3.json",
			"other/keep.json",
		]);
		expect(
			fake.lists.every((call) => call.prefix === "catalog/snapshots/"),
		).toBe(true);
	});

	it("keeps an archive inside the window and honours the run limit", async () => {
		const fake = bucket([
			{
				key: "catalog/snapshots/org-a/edge.json",
				uploaded: daysAgo(CATALOG_SNAPSHOT_RETENTION_DAYS - 0.5),
			},
			{ key: "catalog/snapshots/org-a/old-1.json", uploaded: daysAgo(20) },
			{ key: "catalog/snapshots/org-a/old-2.json", uploaded: daysAgo(20) },
		]);
		const result = await purgeOldCatalogSnapshots({
			bucket: fake as never,
			now,
			limit: 1,
		});
		expect(result.deleted).toBe(1);
		expect(fake.stored.has("catalog/snapshots/org-a/edge.json")).toBe(true);
		expect(fake.stored.size).toBe(2);
	});
});
