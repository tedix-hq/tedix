import { describe, expect, it, vi } from "vite-plus/test";
import { callMcpTool } from "../lib/mcp-client";
import { McpAdapter, normalizeMcpAdapterResult } from "./mcp";

vi.mock("../lib/mcp-client", () => ({ callMcpTool: vi.fn() }));

describe("McpAdapter search prices", () => {
	it.each([
		["$1,234.56", 1234.56],
		["$1,234,567.89", 1234567.89],
		["1.189,00 €", 1189],
		["1.234.567,89 €", 1234567.89],
		["1 234,56 €", 1234.56],
		["1234.56", 1234.56],
		["1234,56", 1234.56],
		["-1,234.56", -1234.56],
		["0,00", 0],
		[42.5, 42.5],
	])("normalizes %s to %s", async (price, expected) => {
		vi.mocked(callMcpTool).mockResolvedValueOnce({
			success: true,
			rawResult: {
				structuredContent: {
					items: [
						{ id: "product-1", title: "Example", price, currency: "USD" },
					],
				},
			},
		});
		const adapter = new McpAdapter({
			id: "adapter-1",
			appId: "app-1",
			name: "example",
			displayName: null,
			adapterType: "mcp",
			config: {
				serverUrl: "https://example.com/mcp",
				toolMap: { search: "search_products" },
			},
			fieldMappings: null,
			verticals: null,
			enabled: true,
			priority: 0,
			createdAt: null,
			updatedAt: null,
		});

		const result = await adapter.search("example", {}, { env: {} });

		expect(result.success).toBe(true);
		expect(result.items[0]?.price).toEqual({
			amount: expected,
			currency: "USD",
		});
	});
});

describe("McpAdapter field mappings", () => {
	it("maps overlapping fields through a null intermediate without failing the search", async () => {
		vi.mocked(callMcpTool).mockResolvedValueOnce({
			success: true,
			rawResult: {
				structuredContent: {
					items: [
						{
							id: "product-1",
							title: "Example",
							pricing: { amount: null, currency: "EUR" },
							value: 12,
						},
					],
				},
			},
		});
		const adapter = new McpAdapter({
			id: "adapter-1",
			appId: "app-1",
			name: "example",
			displayName: null,
			adapterType: "mcp",
			config: {
				serverUrl: "https://example.com/mcp",
				toolMap: { search: "search_products" },
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

describe("normalizeMcpAdapterResult", () => {
	it("uses the shared structured-content semantics, including falsey values", () => {
		expect(normalizeMcpAdapterResult({ structuredContent: 0 })).toBe(0);
	});

	it("joins all text blocks before parsing JSON", () => {
		expect(
			normalizeMcpAdapterResult({
				content: [
					{ type: "text", text: '{"rows":' },
					{ type: "text", text: "[1]}" },
				],
			}),
		).toEqual({ rows: [1] });
	});

	it("preserves the protocol wrapper when itemsPath explicitly targets it", () => {
		const result = {
			content: [{ type: "text", text: "ignored" }],
			_meta: { products: [{ id: "one" }] },
		};

		expect(normalizeMcpAdapterResult(result, "_meta.products")).toBe(result);
	});

	it("does not preserve the removed non-standard json content block", () => {
		const content = [{ type: "json", data: { legacy: true } }];
		expect(normalizeMcpAdapterResult({ content })).toBe(content);
	});
});
