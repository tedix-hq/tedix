import { describe, expect, it } from "vite-plus/test";
import { normalizeWidgetMcpToolResult } from "./widget-test-result";

describe("normalizeWidgetMcpToolResult", () => {
	it("uses structured content as widget data", () => {
		expect(
			normalizeWidgetMcpToolResult(
				{
					content: [{ type: "text", text: "summary" }],
					structuredContent: { items: [{ id: "one" }] },
				},
				"list_items",
			),
		).toEqual({
			content: [{ type: "text", text: "summary" }],
			data: { items: [{ id: "one" }] },
		});
	});

	it("recovers JSON widget data from text-only results", () => {
		expect(
			normalizeWidgetMcpToolResult(
				{ content: [{ type: "text", text: '{"items":[1]}' }] },
				"list_items",
			).data,
		).toEqual({ items: [1] });
	});

	it("propagates MCP tool errors", () => {
		expect(() =>
			normalizeWidgetMcpToolResult(
				{
					isError: true,
					content: [{ type: "text", text: "upstream failed" }],
				},
				"list_items",
			),
		).toThrow("MCP tool error: upstream failed");
	});

	it("does not pass scalar results into object-backed widget layouts", () => {
		expect(
			normalizeWidgetMcpToolResult({ structuredContent: 0 }, "count_items")
				.data,
		).toEqual({});
	});
});
