import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const storage = vi.hoisted(() => ({
	upsert: vi.fn(async (_db: unknown, _appId: string, items: unknown[]) => ({
		inserted: items.length,
		updated: 0,
		errors: [],
	})),
	update: vi.fn(async () => undefined),
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: async () => ({
		id: "app",
		name: "Example",
		slug: "example",
		organizationId: "org",
		metadata: {
			extractionConfig: {
				fieldMappings: {
					title: ["product_name"],
					sku: ["product_id"],
					url: ["url"],
				},
			},
		},
	}),
	getAppMetadataJson: (app: { metadata: unknown }) => app.metadata,
	updateApp: storage.update,
}));
vi.mock("@tedix/db/queries/items", () => ({ upsertItems: storage.upsert }));
import { ImportWorkflow } from "./import-workflow";
afterEach(() => vi.restoreAllMocks());
describe("import workflow mappings", () => {
	it("preserves configured mapping through normalization and batched storage", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const workflow = new ImportWorkflow({} as never, { DB: {} } as never);
		const step = {
			do: async (
				_name: string,
				_options: unknown,
				callback: () => Promise<unknown>,
			) => callback(),
		};
		const result = await workflow.run(
			{
				payload: {
					appId: "app",
					vertical: "ecommerce",
					arrayKey: "products",
					sourceUrl: "https://feed.example/catalog.json",
					data: {
						products: [
							{
								title: "Raw title",
								product_name: "Mapped title",
								product_id: "sku-123",
								price: 10,
								url: "https://store.example/item/sku-123",
							},
							{
								title: "Raw feed-only title",
								product_name: "Feed-only item",
								product_id: "sku-456",
								price: 20,
							},
						],
					},
				},
			} as never,
			step as never,
		);
		expect(result.imported).toBe(2);
		expect(storage.upsert.mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({
				title: "Mapped title",
				externalId: "sku-123",
				metadata: expect.objectContaining({
					sourceUrl: "https://store.example/item/sku-123",
					importSourceUrl: "https://feed.example/catalog.json",
				}),
			}),
			expect.objectContaining({
				title: "Feed-only item",
				externalId: "sku-456",
				metadata: expect.objectContaining({
					sourceUrl: "https://feed.example/catalog.json",
					importSourceUrl: "https://feed.example/catalog.json",
				}),
			}),
		]);
		expect(storage.update).toHaveBeenCalled();
	});
});
