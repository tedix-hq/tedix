import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	ensureSlideFontLoaded,
	googleFontsStylesheetUrl,
	loadableSlideFontFamily,
} from "./slide-fonts";

afterEach(() => {
	for (const link of document.head.querySelectorAll("link[data-slide-font]")) {
		link.remove();
	}
});

describe("slide fonts", () => {
	it("picks the first family the OS cannot already render", () => {
		expect(
			loadableSlideFontFamily("Space Grotesk, FT Kunst Grotesk, sans-serif"),
		).toBe("Space Grotesk");
		expect(loadableSlideFontFamily("'DM Sans', Arial, sans-serif")).toBe(
			"DM Sans",
		);
		expect(loadableSlideFontFamily('Arial, "Playfair Display"')).toBe(
			"Playfair Display",
		);
	});

	it.each([
		undefined,
		"",
		"sans-serif",
		"FT Kunst Grotesk, sans-serif",
		"-apple-system, BlinkMacSystemFont, Segoe UI",
		"Evil&family=x",
		"url(https://evil.example/font.woff2)",
	])("loads nothing for %s", (stack) => {
		expect(loadableSlideFontFamily(stack)).toBeNull();
	});

	it("builds Google Fonts stylesheet URLs only", () => {
		expect(googleFontsStylesheetUrl("Space Grotesk")).toBe(
			"https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
		);
		expect(googleFontsStylesheetUrl("Bebas Neue", false)).toBe(
			"https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap",
		);
	});

	it("adds one stylesheet per family", () => {
		ensureSlideFontLoaded("Space Grotesk, sans-serif");
		ensureSlideFontLoaded("'Space Grotesk', Arial");
		ensureSlideFontLoaded("DM Sans, sans-serif");
		ensureSlideFontLoaded("sans-serif");
		const links = [
			...document.head.querySelectorAll<HTMLLinkElement>(
				"link[data-slide-font]",
			),
		];
		expect(links.map((link) => link.getAttribute("data-slide-font"))).toEqual([
			"space grotesk",
			"dm sans",
		]);
		expect(links.every((link) => link.rel === "stylesheet")).toBe(true);
		expect(
			links.every((link) =>
				link.href.startsWith("https://fonts.googleapis.com/css2?"),
			),
		).toBe(true);
	});

	it("falls back to the unweighted stylesheet when the weighted one fails", () => {
		ensureSlideFontLoaded("Bebas Neue");
		const link = document.head.querySelector<HTMLLinkElement>(
			"link[data-slide-font]",
		);
		link?.dispatchEvent(new Event("error"));
		expect(link?.href).toBe(
			"https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap",
		);
	});
});
