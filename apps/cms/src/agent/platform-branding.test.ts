import { describe, expect, it } from "vite-plus/test";

import {
	resolvePlatformBranding,
	safeBrandingHttpUrl,
} from "../../templates/marketing/src/lib/platform-branding";

describe("marketing platform branding adapter", () => {
	it("fails soft for malformed branding", () => {
		const resolved = resolvePlatformBranding({ PLATFORM_BRANDING: "{" });
		expect(resolved.platformBranding).toEqual({});
		expect(resolved.brandCss).toBe("");
		expect(resolved.themeMode).toBe("system");
		expect(resolved.htmlClass).toBeUndefined();
	});

	it("maps the platform palette and fonts onto canonical CSS variables", () => {
		const resolved = resolvePlatformBranding({
			PLATFORM_BRANDING: JSON.stringify({
				colors: {
					primary: "#123456",
					accent: "#654321",
					secondary: "#abcdef",
					background: "#fafafa",
					text: "#111111",
					textSecondary: "#444444",
				},
				fonts: {
					provider: "google",
					heading: "Comfortaa",
					body: "Roboto",
				},
				themeMode: "dark",
			}),
		});

		expect(resolved.brandCss).toContain("--color-brand-600: #123456;");
		expect(resolved.brandCss).toContain("--color-brand-500: #654321;");
		expect(resolved.brandCss).toContain("--color-brand-700: #abcdef;");
		expect(resolved.brandCss).toContain(
			"--color-brand-50: color-mix(in srgb, #123456 8%, white);",
		);
		expect(resolved.brandCss).toContain("--color-bg: #fafafa;");
		expect(resolved.brandCss).toContain("--font-display:");
		expect(resolved.googleFontsHref).toContain("Comfortaa");
		expect(resolved.googleFontsHref).toContain("Roboto");
		expect(resolved.htmlClass).toBe("dark");
	});

	it("strips CSS delimiters and rejects unsafe font and URL inputs", () => {
		const resolved = resolvePlatformBranding({
			PLATFORM_BRANDING: JSON.stringify({
				colors: { primary: "red;}body{display:none" },
				fonts: { heading: "Bad;Font" },
			}),
		});
		expect(resolved.brandCss).not.toContain("body{");
		expect(resolved.googleFontsHref).toBeNull();
		expect(safeBrandingHttpUrl("javascript:alert(1)")).toBeNull();
		expect(safeBrandingHttpUrl("https://tedix.dev/home")).toBe(
			"https://tedix.dev/home",
		);
	});
});
