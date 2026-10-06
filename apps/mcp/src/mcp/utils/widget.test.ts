import { describe, expect, it, vi } from "vite-plus/test";
import type { WidgetThemePayload } from "@tedix/api-contract/schemas/widget-theme";
import { getAppsSDKCompatibleHtml, rewriteRelativeUrls } from "./widget";

describe("widget asset URLs", () => {
	it("resolves assets for opaque-origin frames without a base element or host shim", () => {
		const html = rewriteRelativeUrls(
			'<html><head><script type="module" src="/_astro/widget.js"></script></head><body><img src="/logo.png"></body></html>',
			"https://mcp-ui.tedix.dev",
		);
		expect(html).toContain('src="https://mcp-ui.tedix.dev/_astro/widget.js"');
		expect(html).toContain('src="https://mcp-ui.tedix.dev/logo.png"');
		expect(html).not.toContain("<base");
		expect(html).not.toContain("window.skybridge");
	});
});

describe("widget theme failure diagnostics", () => {
	it("keeps a cyclic theme and its serialization error out of the log while fetching the widget", async () => {
		const theme: Record<string, unknown> = {};
		theme["private-theme-key-canary"] = theme;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("<html>ok</html>"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const html = await getAppsSDKCompatibleHtml(
				"https://mcp-ui.tedix.dev",
				"/widget",
				{ theme: theme as unknown as WidgetThemePayload },
			);
			expect(html).toBe("<html>ok</html>");
			expect(fetch).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledOnce();
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).toContain("widget.theme_serialization_failed");
			expect(logged).toContain("TypeError");
			expect(logged).not.toContain("private-theme-key-canary");
			expect(logged).not.toContain("circular structure");
		} finally {
			warn.mockRestore();
			fetch.mockRestore();
		}
	});
});
