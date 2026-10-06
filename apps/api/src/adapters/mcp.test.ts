import { describe, expect, it } from "vite-plus/test";
import { normalizeMcpAdapterResult } from "./mcp";

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
