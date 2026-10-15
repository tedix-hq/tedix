import { describe, expect, it } from "vite-plus/test";
import { svgMarkupFromSource, svgSourceFromMarkup } from "./slide-svg-markup";

describe("slide SVG markup", () => {
	it("round-trips markup through a data URI", () => {
		const markup = '<svg viewBox="0 0 10 10"><circle r="4" fill="#f60"/></svg>';
		const result = svgSourceFromMarkup(markup);
		expect(result.ok).toBe(true);
		const src = result.ok ? result.src : undefined;
		expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
		expect(svgMarkupFromSource(src)).toBe(markup);
	});

	it("reads an uploaded base64 SVG", () => {
		const markup = "<svg><rect/></svg>";
		expect(
			svgMarkupFromSource(`data:image/svg+xml;base64,${btoa(markup)}`),
		).toBe(markup);
	});

	it("rejects non-SVG code and leaves linked images alone", () => {
		expect(svgSourceFromMarkup("<div>no</div>").ok).toBe(false);
		expect(svgSourceFromMarkup("  ")).toEqual({ ok: true, src: undefined });
		expect(svgMarkupFromSource("https://example.com/logo.svg")).toBe("");
	});
});
