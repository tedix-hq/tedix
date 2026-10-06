import { describe, expect, it } from "vite-plus/test";
import { getContrastRatio } from "./color-contrast";
import { hexToOklch, type Oklch, oklchToHex } from "./oklch";
import {
	type BrandingProfile,
	buildBrandTheme,
	generateBrandThemeCss,
	getBrandThemeContrastReport,
	hasBrandingData,
} from "./theme";

/** Parse the emitted stylesheet into { selector -> { var -> value } }. */
function parseBlocks(
	css: string,
): { selector: string; vars: Map<string, string> }[] {
	const blocks: { selector: string; vars: Map<string, string> }[] = [];
	const blockPattern = /([^{}]+)\{([^}]*)\}/g;
	let match = blockPattern.exec(css);
	while (match) {
		const vars = new Map<string, string>();
		for (const line of match[2].split("\n")) {
			const declaration = line.trim().replace(/;$/, "");
			if (!declaration) continue;
			const separator = declaration.indexOf(":");
			vars.set(
				declaration.slice(0, separator).trim(),
				declaration.slice(separator + 1).trim(),
			);
		}
		blocks.push({ selector: match[1].trim(), vars });
		match = blockPattern.exec(css);
	}
	return blocks;
}

function varsFor(
	css: string,
	mode: "base" | "light" | "dark",
): Map<string, string> {
	const blocks = parseBlocks(css);
	const selectorFor = {
		base: (selector: string) => selector === ":root:root",
		light: (selector: string) => selector.includes('data-theme="light"'),
		dark: (selector: string) => selector.includes('data-theme="dark"'),
	}[mode];
	return blocks.find((block) => selectorFor(block.selector))?.vars ?? new Map();
}

/** Read an emitted `oklch(L% C H)` value back into components. */
function parseOklch(value: string): Oklch {
	const match = /oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/.exec(value);
	if (!match) throw new Error(`Not an oklch() value: ${value}`);
	return {
		l: Number(match[1]) / 100,
		c: Number(match[2]),
		h: Number(match[3]),
	};
}

/** Hex of an emitted var, so ratios are measured on what actually ships. */
function emittedHex(vars: Map<string, string>, name: string): string {
	const value = vars.get(name);
	if (!value) throw new Error(`Missing var: ${name}`);
	return oklchToHex(parseOklch(value));
}

describe("generateBrandThemeCss - dark palette derivation", () => {
	/*
	 * The defect this covers: a tenant used to have to supply every color twice.
	 * Supplying only the light value emitted no dark block at all, so the widget
	 * fell back to its default palette in dark mode and the tenant lost their
	 * brand.
	 */
	const lightOnly: BrandingProfile = {
		primaryColor: "#0051FF",
		secondaryColor: "#FF7A00",
		accentColor: "#00C48C",
		backgroundColor: "#FFFFFF",
		textColor: "#111111",
		textSecondaryColor: "#5A5A5A",
		linkColor: "#0051FF",
		successColor: "#00A86B",
		warningColor: "#E5A100",
		errorColor: "#D00000",
	};

	it("emits a dark block for a tenant who supplied only light colors", () => {
		const dark = varsFor(generateBrandThemeCss(lightOnly), "dark");

		for (const name of [
			"--brand-primary",
			"--primary",
			"--secondary",
			"--accent",
			"--background",
			"--foreground",
			"--muted-foreground",
			"--link",
			"--success",
			"--warning",
			"--destructive",
		]) {
			expect(
				dark.get(name),
				`expected ${name} in the dark block`,
			).toBeDefined();
		}
	});

	it("holds the brand hue in every derived dark color", () => {
		const dark = varsFor(generateBrandThemeCss(lightOnly), "dark");

		for (const [name, seed] of [
			["--brand-primary", lightOnly.primaryColor],
			["--secondary", lightOnly.secondaryColor],
			["--accent", lightOnly.accentColor],
			["--link", lightOnly.linkColor],
			["--destructive", lightOnly.errorColor],
		] as const) {
			const value = dark.get(name);
			if (!value || !seed) throw new Error(`missing ${name}`);
			expect(parseOklch(value).h).toBeCloseTo(hexToOklch(seed).h, 1);
		}
	});

	it("lands the derived dark canvas at the package's own dark lightness", () => {
		const dark = varsFor(generateBrandThemeCss(lightOnly), "dark");
		const background = parseOklch(dark.get("--background") ?? "");

		// styles/globals.css: `.dark { --background: oklch(0.22 0 0) }`
		expect(background.l).toBeCloseTo(0.22, 2);
		// A dark canvas may be tinted, never saturated.
		expect(background.c).toBeLessThanOrEqual(0.03);
	});

	it("gives derived dark body text a readable ratio on the derived dark canvas", () => {
		const dark = varsFor(generateBrandThemeCss(lightOnly), "dark");
		const ratio = getContrastRatio(
			emittedHex(dark, "--foreground"),
			emittedHex(dark, "--background"),
		);

		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});

	it("keeps derived dark fills distinguishable from the dark canvas", () => {
		const dark = varsFor(generateBrandThemeCss(lightOnly), "dark");
		const background = emittedHex(dark, "--background");

		// WCAG 1.4.11: non-text UI components need 3:1 against their surround.
		for (const name of [
			"--secondary",
			"--accent",
			"--success",
			"--destructive",
		]) {
			expect(
				getContrastRatio(emittedHex(dark, name), background),
				`${name} against the dark canvas`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it("derives dark colors for a brand supplied only through the colors array", () => {
		const dark = varsFor(
			generateBrandThemeCss({
				colors: [{ hex: "#0051FF", usage: "primary" }],
			}),
			"dark",
		);

		expect(dark.get("--brand-primary")).toBeDefined();
	});
});

describe("generateBrandThemeCss - explicit dark values win", () => {
	it("uses a supplied dark value verbatim instead of deriving one", () => {
		const explicitDark = "#88C0FF";
		const withExplicit = varsFor(
			generateBrandThemeCss({
				primaryColor: "#0051FF",
				primaryColorDark: explicitDark,
			}),
			"dark",
		);
		const derived = varsFor(
			generateBrandThemeCss({ primaryColor: "#0051FF" }),
			"dark",
		);

		expect(emittedHex(withExplicit, "--brand-primary")).toBe(
			explicitDark.toLowerCase(),
		);
		// And the choice actually changed the outcome.
		expect(withExplicit.get("--brand-primary")).not.toBe(
			derived.get("--brand-primary"),
		);
	});

	it("still honours a full light+dark profile, unchanged", () => {
		const css = generateBrandThemeCss({
			primaryColor: "#0051FF",
			primaryColorDark: "#88C0FF",
			backgroundColor: "#FFFFFF",
			backgroundColorDark: "#101010",
			textColor: "#111111",
			textColorDark: "#EFEFEF",
		});
		const dark = varsFor(css, "dark");

		expect(emittedHex(dark, "--brand-primary")).toBe("#88c0ff");
		expect(emittedHex(dark, "--background")).toBe("#101010");
		expect(emittedHex(dark, "--brand-foreground")).toBe("#efefef");
		// Nothing in that profile fails the floor, so nothing is substituted.
		expect(
			getBrandThemeContrastReport({
				primaryColor: "#0051FF",
				primaryColorDark: "#88C0FF",
				backgroundColor: "#FFFFFF",
				backgroundColorDark: "#101010",
				textColor: "#111111",
				textColorDark: "#EFEFEF",
			}),
		).toEqual([]);
	});
});

describe("generateBrandThemeCss - contrast correction", () => {
	/*
	 * Previously this path emitted a console.warn and shipped the failing color
	 * anyway. It now substitutes the nearest lightness that clears the floor.
	 */
	const lowContrastBrand: BrandingProfile = {
		primaryColor: "#FFE600",
		backgroundColor: "#FFFFFF",
	};

	it("corrects a low-contrast brand color instead of warning about it", () => {
		const { css, substitutions } = buildBrandTheme(lowContrastBrand);
		const base = varsFor(css, "base");

		const substitution = substitutions.find(
			(entry) => entry.token === "--primary" && entry.mode === "light",
		);
		expect(substitution).toBeDefined();
		expect(substitution?.requestedRatio).toBeLessThan(4.5);
		expect(substitution?.meetsTarget).toBe(true);

		// The correction is in the emitted CSS, not just in the report.
		expect(base.get("--primary")).not.toBe(base.get("--brand-primary"));
	});

	it("emits a corrected color that measurably clears 4.5:1", () => {
		const base = varsFor(generateBrandThemeCss(lowContrastBrand), "base");

		expect(
			getContrastRatio(emittedHex(base, "--primary"), "#FFFFFF"),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("reports the ratio it actually achieved, measured on the emitted color", () => {
		const [substitution] = getBrandThemeContrastReport(lowContrastBrand);

		expect(substitution.ratio).toBeCloseTo(
			getContrastRatio(substitution.emitted, substitution.background),
			6,
		);
		expect(substitution.ratio).toBeGreaterThanOrEqual(4.5);
	});

	it("preserves the brand of record while correcting the semantic token", () => {
		const base = varsFor(generateBrandThemeCss(lowContrastBrand), "base");

		expect(emittedHex(base, "--brand-primary")).toBe("#ffe600");
		expect(emittedHex(base, "--primary")).not.toBe("#ffe600");
		// Hue survives the correction: it is the tenant's yellow, just darker.
		expect(parseOklch(base.get("--primary") ?? "").h).toBeCloseTo(
			hexToOklch("#FFE600").h,
			1,
		);
	});

	it("corrects low-contrast body text against the tenant's own background", () => {
		const css = generateBrandThemeCss({
			backgroundColor: "#FFFFFF",
			textColor: "#AAAAAA",
		});
		const light = varsFor(css, "light");

		expect(
			getContrastRatio(emittedHex(light, "--foreground"), "#FFFFFF"),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("corrects a derived dark color against the dark canvas it will sit on", () => {
		// No background supplied, so the canvas is the package default (#1b1b1b,
		// i.e. `.dark { --background: oklch(0.22 0 0) }` in styles/globals.css).
		const dark = varsFor(
			generateBrandThemeCss({ primaryColor: "#0051FF" }),
			"dark",
		);

		expect(dark.get("--background")).toBeUndefined();
		expect(
			getContrastRatio(emittedHex(dark, "--primary"), "#1b1b1b"),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("corrects a derived dark color against a tenant-supplied dark canvas", () => {
		const dark = varsFor(
			generateBrandThemeCss({
				primaryColor: "#0051FF",
				backgroundColor: "#FFFFFF",
				backgroundColorDark: "#0A0A0A",
			}),
			"dark",
		);

		expect(
			getContrastRatio(
				emittedHex(dark, "--primary"),
				emittedHex(dark, "--background"),
			),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("pairs the auto foreground with the corrected fill, not the brand token", () => {
		const dark = varsFor(
			generateBrandThemeCss({ primaryColor: "#0051FF" }),
			"dark",
		);

		expect(
			getContrastRatio(
				emittedHex(dark, "--primary-foreground"),
				emittedHex(dark, "--primary"),
			),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("leaves muted text uncorrected, by design", () => {
		const report = getBrandThemeContrastReport({
			backgroundColor: "#FFFFFF",
			textSecondaryColor: "#BBBBBB",
		});

		expect(report.some((entry) => entry.token === "--muted-foreground")).toBe(
			false,
		);
	});

	it("clears the floor even on the worst possible canvas", () => {
		// Mid-grey is the hardest canvas to sit on; a solution still exists at 4.5:1.
		const light = varsFor(
			generateBrandThemeCss({
				backgroundColor: "#808080",
				textColor: "#7F7F7F",
			}),
			"light",
		);

		expect(
			getContrastRatio(emittedHex(light, "--foreground"), "#808080"),
		).toBeGreaterThanOrEqual(4.5);
	});
});

describe("generateBrandThemeCss - emission shape", () => {
	it("returns an empty string when there is nothing to theme", () => {
		expect(generateBrandThemeCss({})).toBe("");
		expect(generateBrandThemeCss({ primaryColor: "not-a-color" })).toBe("");
	});

	it("keeps the doubled :root:root override specificity", () => {
		const css = generateBrandThemeCss({ primaryColor: "#0051FF" });

		expect(css).toContain(":root:root {");
		expect(css).toContain(':root:root.dark, :root:root[data-theme="dark"]');
	});

	it("still emits typography vars", () => {
		const base = varsFor(
			generateBrandThemeCss({
				typography: { fontFamily: "Inter, sans-serif" },
			}),
			"base",
		);

		expect(base.get("--font-sans")).toBe("Inter, sans-serif");
	});

	it("emits dark-only profiles without inventing light values", () => {
		const css = generateBrandThemeCss({ primaryColorDark: "#88C0FF" });

		expect(varsFor(css, "dark").get("--brand-primary")).toBeDefined();
		expect(varsFor(css, "base").get("--brand-primary")).toBeUndefined();
	});
});

describe("hasBrandingData", () => {
	it("accepts a light-only profile and a dark-only profile alike", () => {
		expect(hasBrandingData({ primaryColor: "#0051FF" })).toBe(true);
		expect(hasBrandingData({ primaryColorDark: "#88C0FF" })).toBe(true);
		expect(hasBrandingData({})).toBe(false);
		expect(hasBrandingData(null)).toBe(false);
	});
});
