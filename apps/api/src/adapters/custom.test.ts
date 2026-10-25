import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CustomAdapter } from "./custom";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CustomAdapter", () => {
	it("preserves caller cancellation instead of reporting a timeout", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValue(new DOMException("Caller cancelled", "AbortError"));
		vi.stubGlobal("fetch", fetcher);
		const controller = new AbortController();
		controller.abort();
		const adapter = new CustomAdapter({
			id: "adapter-1",
			appId: "app-1",
			name: "example",
			displayName: null,
			adapterType: "custom",
			config: {
				baseUrl: "https://example.com",
				endpoints: { search: "/search" },
			},
			fieldMappings: null,
			verticals: null,
			enabled: true,
			priority: 0,
			createdAt: null,
			updatedAt: null,
		});

		const result = await adapter.search(
			"example",
			{},
			{
				env: {},
				signal: controller.signal,
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "Caller cancelled",
			errorCode: "request_failed",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("maps overlapping fields through a null intermediate without failing the search", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					items: [
						{
							id: "product-1",
							title: "Example",
							pricing: { amount: null, currency: "EUR" },
							value: 12,
						},
					],
				}),
			),
		);
		const adapter = new CustomAdapter({
			id: "adapter-1",
			appId: "app-1",
			name: "example",
			displayName: null,
			adapterType: "custom",
			config: {
				baseUrl: "https://example.com",
				endpoints: { search: "/search" },
				itemsPath: "items",
			},
			fieldMappings: { price: "pricing", "price.amount.value": "value" },
			verticals: null,
			enabled: true,
			priority: 0,
			createdAt: null,
			updatedAt: null,
		});

		const result = await adapter.search("example", {}, { env: {} });

		expect(result.success).toBe(true);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe("product-1");
	});
});
