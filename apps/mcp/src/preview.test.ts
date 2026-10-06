import { describe, expect, it } from "vite-plus/test";
import { injectPreviewData } from "./preview";

describe("standalone widget preview", () => {
	it("embeds tool data before hydration without a fake host", () => {
		const html = injectPreviewData("<html><head></head><body></body></html>", {
			rows: [1, 2],
		});
		expect(html).toContain(
			'<script type="application/json" id="tedix-tool-data">{"rows":[1,2]}</script></head>',
		);
		expect(html).not.toContain("window.openai");
	});
	it("escapes script-closing content and supports fragments", () => {
		const html = injectPreviewData("<div>Preview</div>", {
			text: "</script><img src=x onerror=alert(1)>",
		});
		const data = html.slice(html.indexOf(">") + 1, html.indexOf("</script>"));
		expect(JSON.parse(data)).toEqual({
			text: "</script><img src=x onerror=alert(1)>",
		});
		expect(html).not.toContain("<img");
		expect(html.endsWith("<div>Preview</div>")).toBe(true);
	});
});
