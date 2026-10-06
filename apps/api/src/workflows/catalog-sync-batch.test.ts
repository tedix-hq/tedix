import { describe, expect, it, vi } from "vite-plus/test";
import { runCatalogSyncBatch } from "./catalog-sync-batch";

const items = [
	{ name: "One", source: "chatgpt", sourceAppId: "one" },
	{ name: "Two", source: "claude", sourceAppId: "two" },
];

describe("runCatalogSyncBatch", () => {
	it("normalizes once and reports per-item sync errors as failures", async () => {
		const normalize = vi.fn(async (input: typeof items) => input);
		const sync = vi.fn(async () => ({
			inserted: 1,
			updated: 0,
			errors: ["Two failed"],
		}));

		await expect(
			runCatalogSyncBatch(items, { normalize, sync }),
		).resolves.toEqual({
			inserted: 1,
			updated: 0,
			failed: 1,
			errors: ["Two failed"],
		});
		expect(normalize).toHaveBeenCalledOnce();
		expect(sync).toHaveBeenCalledWith(items);
	});

	it("falls back to isolated idempotent upserts after a batch-level failure", async () => {
		const sync = vi
			.fn()
			.mockRejectedValueOnce(new Error("D1 batch failed"))
			.mockResolvedValueOnce({ inserted: 1, updated: 0, errors: [] })
			.mockResolvedValueOnce({ inserted: 0, updated: 0, errors: ["bad row"] });

		await expect(
			runCatalogSyncBatch(items, {
				normalize: async (input) => input,
				sync,
			}),
		).resolves.toEqual({
			inserted: 1,
			updated: 0,
			failed: 1,
			errors: [
				"Catalog batch failed; retrying per item: D1 batch failed",
				"bad row",
			],
		});
		expect(sync).toHaveBeenCalledTimes(3);
	});
});
