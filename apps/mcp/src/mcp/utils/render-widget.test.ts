import { describe, expect, it, vi } from "vite-plus/test";
import type { AppTool } from "../server-context";
import {
	getToolBundleHtml,
	getToolLayoutSpec,
	isRenderWidgetTool,
	MAX_WIDGET_BUNDLE_HTML_BYTES,
} from "./render-widget";

function tool(config: Record<string, unknown> | null): AppTool {
	return { toolId: "test_tool", config } as unknown as AppTool;
}

describe("widget layout failure diagnostics", () => {
	it("omits malformed stored layout content and parser text from the log", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(
				getToolLayoutSpec(tool({ layoutSpec: '{"private-layout-canary":}' })),
			).toBeNull();
			expect(warn).toHaveBeenCalledOnce();
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).toContain("widget.layout_spec_parse_failed");
			expect(logged).toContain("SyntaxError");
			expect(logged).not.toContain("private-layout-canary");
			expect(logged).not.toContain("Unexpected token");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("getToolBundleHtml", () => {
	it("returns the trimmed committed bundle and marks the tool as a widget", () => {
		const bundled = tool({
			widgetBundleHtml: "  <main>Console</main>\n",
		});
		expect(getToolBundleHtml(bundled)).toBe("<main>Console</main>");
		expect(isRenderWidgetTool(bundled)).toBe(true);
	});

	it("returns null for absent, empty, or non-string bundles", () => {
		expect(getToolBundleHtml(tool(null))).toBeNull();
		expect(getToolBundleHtml(tool({}))).toBeNull();
		expect(getToolBundleHtml(tool({ widgetBundleHtml: "   " }))).toBeNull();
		expect(getToolBundleHtml(tool({ widgetBundleHtml: 42 }))).toBeNull();
	});

	it("fails closed (null, warned) past the size cap instead of truncating", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const oversized = tool({
			widgetBundleHtml: "x".repeat(MAX_WIDGET_BUNDLE_HTML_BYTES + 1),
		});
		expect(getToolBundleHtml(oversized)).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});
});
