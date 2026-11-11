import { describe, expect, it } from "vite-plus/test";
import { skillMediaSecurityHeaders } from "./skill-media-routes";

describe("skill media response headers", () => {
	it("never lets the browser second-guess the declared type", () => {
		for (const type of ["image/png", "image/svg+xml", "text/html"]) {
			expect(skillMediaSecurityHeaders(type)["X-Content-Type-Options"]).toBe(
				"nosniff",
			);
		}
	});

	it("sandboxes every type that can carry script", () => {
		for (const type of [
			"image/svg+xml",
			"IMAGE/SVG+XML; charset=utf-8",
			"text/html",
			"application/xhtml+xml",
			"image/unknown-future-type",
		]) {
			expect(
				skillMediaSecurityHeaders(type)["Content-Security-Policy"],
				type,
			).toBe("default-src 'none'; sandbox");
		}
	});

	it("leaves plain pictures, audio and video playable", () => {
		for (const type of ["image/png", "image/webp", "audio/mpeg", "video/mp4"]) {
			expect(
				skillMediaSecurityHeaders(type)["Content-Security-Policy"],
				type,
			).toBeUndefined();
		}
	});
});
