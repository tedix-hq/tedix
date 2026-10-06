import { describe, expect, it, vi } from "vite-plus/test";
import {
	type CatalogAiSearchInstance,
	bulkUpsertCatalogApps,
	searchCatalogApps,
} from "./catalog-vector";

function clientWithSearch(
	search: CatalogAiSearchInstance["search"],
): CatalogAiSearchInstance {
	return {
		search,
		info: vi.fn(),
		update: vi.fn(),
		items: {
			upload: vi.fn(),
			uploadAndPoll: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(),
		},
	};
}

describe("searchCatalogApps", () => {
	it("uses hybrid retrieval with reranking and supported metadata filters", async () => {
		const search = vi.fn(async () => ({
			search_query: "email automation",
			chunks: [
				{
					id: "chunk-1",
					type: "text",
					score: 0.82,
					text: "Mail tools",
					item: {
						key: "catalog:app-1.txt",
						metadata: {
							id: "app-1",
							slug: "mail-tools",
							name: "Mail Tools",
							source: "official",
							connectorType: "MCP",
						},
					},
				},
			],
		}));
		const client = clientWithSearch(search);

		await expect(
			searchCatalogApps(client, "email automation", {
				connectorType: "MCP",
				source: "official",
				topK: 40,
			}),
		).resolves.toEqual([
			{
				id: "app-1",
				score: 0.82,
				metadata: {
					id: "app-1",
					slug: "mail-tools",
					name: "Mail Tools",
					source: "official",
					connectorType: "MCP",
				},
			},
		]);
		expect(search).toHaveBeenCalledWith({
			query: "email automation",
			ai_search_options: {
				retrieval: {
					max_num_results: 40,
					retrieval_type: "hybrid",
					filters: { source: "official", connectorType: "MCP" },
				},
				reranking: { enabled: true },
			},
		});
	});

	it("drops chunks without catalog metadata", async () => {
		const client = clientWithSearch(
			vi.fn(async () => ({
				search_query: "mail",
				chunks: [
					{
						id: "chunk-1",
						type: "text",
						score: 0.9,
						text: "orphan",
						item: { key: "orphan.txt" },
					},
				],
			})),
		);

		await expect(searchCatalogApps(client, "mail")).resolves.toEqual([]);
	});
});

describe("bulkUpsertCatalogApps", () => {
	it("recovers throttled uploads without replaying accepted items", async () => {
		vi.useFakeTimers();
		try {
			const client = clientWithSearch(vi.fn());
			vi.mocked(client.info).mockResolvedValue({ custom_metadata: [] });
			const accepted = { id: "item", key: "item", status: "queued" };
			vi.mocked(client.items.upload)
				.mockResolvedValueOnce(accepted)
				.mockRejectedValueOnce(new Error("You are being rate limited."))
				.mockResolvedValue(accepted);
			const pending = bulkUpsertCatalogApps(client, [
				{ id: "first", name: "First", connectorType: "MCP" },
				{ id: "second", name: "Second", connectorType: "MCP" },
			]);
			await vi.runAllTimersAsync();
			expect(await pending).toEqual({ upserted: 2, failed: 0 });
			expect(
				vi.mocked(client.items.upload).mock.calls.map((call) => call[0]),
			).toEqual([
				"catalog:first.txt",
				"catalog:second.txt",
				"catalog:second.txt",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("counts permanent upload failures without retrying them", async () => {
		vi.useFakeTimers();
		try {
			const client = clientWithSearch(vi.fn());
			vi.mocked(client.info).mockResolvedValue({ custom_metadata: [] });
			vi.mocked(client.items.upload).mockRejectedValue(
				new Error("Invalid document"),
			);
			const pending = bulkUpsertCatalogApps(client, [
				{ id: "bad", name: "Bad", connectorType: "MCP" },
			]);
			await vi.runAllTimersAsync();
			expect(await pending).toEqual({ upserted: 0, failed: 1 });
			expect(client.items.upload).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("ends a persistently throttled page after bounded retries", async () => {
		vi.useFakeTimers();
		try {
			const client = clientWithSearch(vi.fn());
			vi.mocked(client.info).mockResolvedValue({ custom_metadata: [] });
			vi.mocked(client.items.upload).mockRejectedValue(
				Object.assign(new Error("busy"), { status: 429 }),
			);
			const pending = expect(
				bulkUpsertCatalogApps(client, [
					{ id: "a", name: "A", connectorType: "MCP" },
				]),
			).rejects.toThrow("busy");
			await vi.runAllTimersAsync();
			await pending;
			expect(client.items.upload).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});
});
