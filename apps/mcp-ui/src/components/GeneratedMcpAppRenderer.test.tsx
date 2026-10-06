import { describe, expect, it } from "vite-plus/test";
import {
	generatedMcpAppDocument,
	generatedMcpAppPayloadFrom,
	resolveGeneratedMcpAppTheme,
} from "./GeneratedMcpAppRenderer";

describe("GeneratedMcpAppRenderer", () => {
	it("finds a bounded generated app payload inside a Code Mode projection", () => {
		expect(
			generatedMcpAppPayloadFrom({
				resultProjection: {
					generatedMcpApp: { html: "<main>Hello</main>" },
				},
			}),
		).toEqual({
			html: "<main>Hello</main>",
			renderMode: "sandboxed-html-css",
		});
	});

	it("injects a fail-closed CSP before model-authored markup", () => {
		const document = generatedMcpAppDocument(
			"<html><head><title>View</title></head><body><script>alert(1)</script></body></html>",
		);
		expect(document).toContain("default-src 'none'");
		expect(document).toContain("connect-src 'none'");
		expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
			document.indexOf("<title>"),
		);
	});

	it("binds the scriptless generated document to the MCP host theme", () => {
		const light = generatedMcpAppDocument("<main>View</main>", "light");
		const dark = generatedMcpAppDocument("<main>View</main>", "dark");

		expect(light).toContain('<html data-theme="light">');
		expect(dark).toContain('<html data-theme="dark" class="dark">');
		expect(dark).toContain("color-scheme:dark");
		expect(dark).toContain("background:var(--background)");
		expect(dark).toContain("--card:oklch(.28 0 0)");
	});

	it("prefers the explicit embed theme over an early bridge fallback", () => {
		expect(resolveGeneratedMcpAppTheme("?theme=dark", "light")).toBe("dark");
		expect(resolveGeneratedMcpAppTheme("?theme=light", "dark")).toBe("light");
	});
});
