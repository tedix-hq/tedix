import { describe, expect, it } from "vite-plus/test";
import { unwrapCmsToolResult } from "./tool-result";

describe("unwrapCmsToolResult", () => {
	it("prefers canonical structured content over compatibility text", () => {
		expect(
			unwrapCmsToolResult(
				{
					content: [{ type: "text", text: '{"source":"legacy"}' }],
					structuredContent: { source: "canonical" },
				},
				"CMS test",
			),
		).toEqual({ source: "canonical" });
	});

	it("retains JSON text compatibility at the external CMS boundary", () => {
		expect(
			unwrapCmsToolResult(
				{ content: [{ type: "text", text: '{"ok":true}' }] },
				"CMS test",
			),
		).toEqual({ ok: true });
	});

	it("does not turn an upstream tool error into successful data", () => {
		expect(() =>
			unwrapCmsToolResult(
				{
					content: [{ type: "text", text: "provider rejected request" }],
					isError: true,
				},
				"CMS test",
			),
		).toThrow("MCP tool error: provider rejected request");
	});
});
