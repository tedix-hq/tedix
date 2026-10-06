/**
 * Brand Theme Utilities
 *
 * Converts a branding profile to CSS custom properties using OKLCH.
 * Used by BrandThemeProvider and BrandThemeStyle for brand theming.
 *
 * Two guarantees this module owns:
 *
 *  1. A tenant supplies each color ONCE. Every `*ColorDark` input is optional
 *     and is derived from its light seed when absent (see DARK DERIVATIONS
 *     below). Supplying a dark value explicitly still wins — derivation is a
 *     floor, never an override of a deliberate choice.
 *  2. Colors that would ship below the WCAG AA floor are CORRECTED, not warned
 *     about (see CONTRAST CORRECTION below).
 */

import { getContrastColor, isValidHexColor } from "./color-contrast";
import {
	type DarkDerivation,
	deriveOklch,
	formatOklch,
	hexToOklch,
	type Oklch,
	oklchToHex,
	solveContrastLightness,
} from "./oklch";

/**
 * Color value from Firecrawl branding extraction
 */
export interface BrandColor {
	/** Hex color value (e.g., "#0051FF") */
	hex: string;
	/** RGB values */
	rgb?: { r: number; g: number; b: number };
	/** HSL values */
	hsl?: { h: number; s: number; l: number };
	/** Color name/label */
	name?: string;
	/** Usage context (primary, secondary, accent, background, text) */
	usage?: string;
}

/**
 * Typography info from Firecrawl branding extraction
 */
export interface BrandTypography {
	/** Primary font family */
	fontFamily?: string;
	/** Font families array */
	fonts?: string[];
	/** Heading font family */
	headingFont?: string;
	/** Body font family */
	bodyFont?: string;
}

/**
 * Branding profile from Firecrawl extraction
 * Matches the structure returned by Firecrawl's "branding" format
 */
export interface BrandingProfile {
	/** Logo URL */
	logo?: string;
	/** Favicon URL */
	favicon?: string;
	/** OG Image URL */
	ogImage?: string;
	/** Brand colors extracted from the page */
	colors?: BrandColor[];
	/** Primary brand color */
	primaryColor?: string;
	/** Secondary brand color */
	secondaryColor?: string;
	/** Accent color */
	accentColor?: string;
	/** Background color */
	backgroundColor?: string;
	/** Text color */
	textColor?: string;
	/** Secondary text color (muted) */
	textSecondaryColor?: string;
	/** Link color */
	linkColor?: string;
	/** Success state color */
	successColor?: string;
	/** Warning state color */
	warningColor?: string;
	/** Error state color */
	errorColor?: string;
	/*
	 * Dark-mode overrides. All optional: omit one and it is derived from its
	 * light counterpart, holding hue and retargeting lightness. Supply one and
	 * it is used verbatim.
	 */
	/** Primary brand color (dark mode). Derived from `primaryColor` when omitted. */
	primaryColorDark?: string;
	/** Secondary brand color (dark mode). Derived from `secondaryColor` when omitted. */
	secondaryColorDark?: string;
	/** Accent color (dark mode). Derived from `accentColor` when omitted. */
	accentColorDark?: string;
	/** Background color (dark mode). Derived from `backgroundColor` when omitted. */
	backgroundColorDark?: string;
	/** Text color (dark mode). Derived from `textColor` when omitted. */
	textColorDark?: string;
	/** Secondary text color (muted) (dark mode). Derived from `textSecondaryColor` when omitted. */
	textSecondaryColorDark?: string;
	/** Link color (dark mode). Derived from `linkColor` when omitted. */
	linkColorDark?: string;
	/** Success state color (dark mode). Derived from `successColor` when omitted. */
	successColorDark?: string;
	/** Warning state color (dark mode). Derived from `warningColor` when omitted. */
	warningColorDark?: string;
	/** Error state color (dark mode). Derived from `errorColor` when omitted. */
	errorColorDark?: string;
	/** Typography information */
	typography?: BrandTypography;
	/** Color scheme preference */
	colorScheme?: "light" | "dark";
	/** Brand name */
	name?: string;
	/** Brand tagline/slogan */
	tagline?: string;
	/** Social media links */
	socialLinks?: Record<string, string>;
}

/*
 * DARK DERIVATIONS
 * ================
 *
 * Each recipe REPLACES the seed's lightness and holds its hue; chroma is only
 * ever reduced. Hue is the brand, so hue is never touched — which is what makes
 * one recipe safe for every tenant color we have never seen. This only works in
 * a perceptually uniform space: one lightness target has to be simultaneously
 * right for a tenant's orange and a tenant's blue.
 *
 * The shape is adapted from Cloudflare OS's Apache-2.0 accent family, which
 * solves the same problem (one admin-picked seed, both modes): fills get a
 * replaced lightness, and brand text and links land near L 0.76.
 *
 * The BINDING CONSTRAINT on the fill lightness is this package's own dark canvas
 * at L 0.22 (#1b1b1b) — considerably lighter than the near-black the reference
 * implementation sits on, so its L 0.45 does not transfer: measured worst case
 * across all hues at max chroma, L 0.45 renders at 1.98:1 against #1b1b1b, which
 * is invisible. Two constraints bracket the number, measured over hue 0..359 x
 * chroma 0..0.4:
 *
 *   - the fill must clear 3:1 against the canvas (WCAG 1.4.11, non-text UI);
 *     worst case rises through 2.99:1 at L 0.55 and 3.12:1 at L 0.56;
 *   - black-or-white foreground text on the fill must clear 4.5:1; that margin
 *     is 4.58:1 and starts eroding as the fill gets lighter.
 *
 * L 0.56 is the lowest lightness satisfying both, so it is the value that keeps
 * the most of the brand's own depth. Worst cases at L 0.56: 3.12:1 against the
 * canvas (hue 302, chroma 0.30), 4.58:1 for the paired foreground.
 *
 *   | recipe          | L    | chroma       | measured worst case vs #1b1b1b     |
 *   | --------------- | ---- | ------------ | ---------------------------------- |
 *   | DARK_FILL       | 0.56 | unchanged    | 3.12:1 — see above                 |
 *   | DARK_SURFACE    | 0.22 | x0.35, <=.03 | n/a, this IS the canvas            |
 *   | DARK_TEXT       | 0.93 | x0.5         | 13.67:1                            |
 *   | DARK_MUTED_TEXT | 0.72 | x0.5         | 6.29:1                             |
 *   | DARK_LINK       | 0.76 | unchanged    | 7.14:1                             |
 *
 * DARK_SURFACE's lightness is exactly this package's dark `--background`
 * (`oklch(0.22 0 0)` in styles/globals.css) so a tenant-tinted canvas stays in
 * step with the surface and border ramp defined around it. Its chroma is crushed
 * to at most 0.03 because a saturated dark canvas tints every neutral drawn on
 * it; that is a tint, not a wash.
 *
 * The text recipes halve chroma: bright, fully saturated text vibrates against a
 * dark field. DARK_LINK keeps full chroma — a link is supposed to read as
 * branded — and 0.72 vs 0.93 keeps muted text legible while still reading as
 * de-emphasis.
 *
 * These are FLOORS, not final values: anything the contrast pass covers is then
 * measured against the canvas it will actually sit on and moved further if the
 * derived value still falls short.
 */
const DARK_FILL: DarkDerivation = { lightness: 0.56 };
const DARK_SURFACE: DarkDerivation = {
	lightness: 0.22,
	chromaScale: 0.35,
	chromaCeiling: 0.03,
};
const DARK_TEXT: DarkDerivation = { lightness: 0.93, chromaScale: 0.5 };
const DARK_MUTED_TEXT: DarkDerivation = { lightness: 0.72, chromaScale: 0.5 };
const DARK_LINK: DarkDerivation = { lightness: 0.76 };

/*
 * CONTRAST CORRECTION
 * ===================
 *
 * This module used to compute a contrast ratio, `console.warn` when it failed,
 * and then ship the failing color anyway — a message in a production console
 * nobody reads, in a widget embedded in someone else's page. It could only warn
 * because its only lever was `getContrastColor`, which returns black or white
 * and therefore cannot express "the tenant's blue, darker". With an OKLCH
 * lightness handle the failure is solvable, so it is now solved: the emitted
 * color is the one nearest the tenant's that clears the floor
 * (`solveContrastLightness`).
 *
 * THE BINDING CONSTRAINT is the 4.5:1 normal-text floor, not the 3:1 non-text
 * UI floor. `--primary` looks like a fill token but is consumed BOTH ways in
 * this package — `bg-primary` on controls (3:1 would do) and `text-primary` on
 * icons and labels (needs 4.5:1). The stricter consumption binds, and 4.5 is
 * also the threshold the previous warning already judged against, so nothing
 * here tightens the product rule; it only makes the existing rule effective.
 *
 * WHAT IS AND IS NOT CORRECTED, and why:
 *   - `--primary`, `--foreground`, `--link` ARE corrected. All three are read as
 *     text against a canvas we know.
 *   - `--brand-primary`, `--brand-foreground`, `--brand-*` are NOT. Those are
 *     the brand of record — the color a mark or a swatch is drawn in, where the
 *     tenant's exact value is the point. Correcting the semantic token while
 *     preserving the brand token is what lets accessibility and brand fidelity
 *     both hold.
 *   - `--muted-foreground` is NOT, deliberately. Forcing muted text to 4.5:1
 *     against the same canvas as `--foreground` erases the only thing the token
 *     encodes. That one is a design decision for the tenant, not a substitution
 *     we can make on their behalf.
 *   - `--background` is NOT: it is the canvas everything else is measured
 *     against.
 */
const WCAG_AA_NORMAL_TEXT = 4.5;

/** Canvas assumed when the tenant supplies no background. */
const DEFAULT_LIGHT_CANVAS = "#FFFFFF";
/**
 * Dark canvas assumed when the tenant supplies neither `backgroundColorDark`
 * nor `backgroundColor`. This is this package's own dark `--background`,
 * `oklch(0.22 0 0)` in styles/globals.css, which paints #1b1b1b — the inline
 * comment beside it in that file says #212121, but the oklch value is what
 * renders and therefore what a contrast ratio has to be measured against.
 * Keeping this in step with DARK_SURFACE's lightness means a tenant who supplies
 * a light background and a tenant who supplies none are solved against canvases
 * of the same lightness.
 */
const DEFAULT_DARK_CANVAS = "#1b1b1b";

type LightColorKey =
	| "primaryColor"
	| "secondaryColor"
	| "accentColor"
	| "backgroundColor"
	| "textColor"
	| "textSecondaryColor"
	| "linkColor"
	| "successColor"
	| "warningColor"
	| "errorColor";

type DarkColorKey = `${LightColorKey}Dark`;

/**
 * One brand color and everything that follows from it.
 *
 * `baseVars` land in the unscoped `:root:root` block, `lightVars` in the
 * light-only block; the dark block always receives both lists. That split is
 * inherited from the CSS this module emitted before and is preserved exactly,
 * because tenants' own stylesheets cascade against these selectors.
 */
interface BrandSlot {
	lightKey: LightColorKey;
	darkKey: DarkColorKey;
	/** Vars emitted at `:root:root` from the light value. */
	baseVars: readonly string[];
	/** Vars emitted in the light-only block from the light value. */
	lightVars: readonly string[];
	/** Auto-computed readable foreground paired with this color, if any. */
	foreground?: { name: string; scope: "base" | "light" };
	/** How the dark value is derived when the tenant omits `darkKey`. */
	dark: DarkDerivation;
	/** Vars that must clear the WCAG floor against the canvas, if any. */
	correct?: readonly string[];
}

const BRAND_SLOTS: readonly BrandSlot[] = [
	{
		lightKey: "primaryColor",
		darkKey: "primaryColorDark",
		baseVars: ["--brand-primary", "--primary"],
		lightVars: [],
		foreground: { name: "--primary-foreground", scope: "base" },
		dark: DARK_FILL,
		correct: ["--primary"],
	},
	{
		lightKey: "secondaryColor",
		darkKey: "secondaryColorDark",
		baseVars: ["--brand-secondary"],
		lightVars: ["--secondary"],
		foreground: { name: "--secondary-foreground", scope: "light" },
		dark: DARK_FILL,
	},
	{
		lightKey: "accentColor",
		darkKey: "accentColorDark",
		baseVars: ["--brand-accent"],
		lightVars: ["--accent"],
		foreground: { name: "--accent-foreground", scope: "light" },
		dark: DARK_FILL,
	},
	{
		lightKey: "backgroundColor",
		darkKey: "backgroundColorDark",
		baseVars: ["--brand-background"],
		lightVars: ["--background"],
		dark: DARK_SURFACE,
	},
	{
		lightKey: "textColor",
		darkKey: "textColorDark",
		baseVars: ["--brand-foreground"],
		lightVars: ["--foreground"],
		dark: DARK_TEXT,
		correct: ["--foreground"],
	},
	{
		lightKey: "textSecondaryColor",
		darkKey: "textSecondaryColorDark",
		baseVars: [],
		lightVars: ["--muted-foreground"],
		dark: DARK_MUTED_TEXT,
	},
	{
		lightKey: "linkColor",
		darkKey: "linkColorDark",
		baseVars: ["--link"],
		lightVars: [],
		dark: DARK_LINK,
		correct: ["--link"],
	},
	{
		lightKey: "successColor",
		darkKey: "successColorDark",
		baseVars: ["--success"],
		lightVars: [],
		foreground: { name: "--success-foreground", scope: "base" },
		dark: DARK_FILL,
	},
	{
		lightKey: "warningColor",
		darkKey: "warningColorDark",
		baseVars: ["--warning"],
		lightVars: [],
		foreground: { name: "--warning-foreground", scope: "base" },
		dark: DARK_FILL,
	},
	{
		lightKey: "errorColor",
		darkKey: "errorColorDark",
		baseVars: ["--destructive"],
		lightVars: [],
		foreground: { name: "--destructive-foreground", scope: "base" },
		dark: DARK_FILL,
	},
];

/** A contrast substitution that was actually made, with the ratio it achieved. */
export interface ContrastSubstitution {
	/** CSS custom property whose value was substituted. */
	token: string;
	mode: "light" | "dark";
	/** Color the tenant asked for (or that was derived for them). */
	requested: string;
	/** Color emitted instead. */
	emitted: string;
	/** Canvas the ratio was measured against. */
	background: string;
	/** Ratio the requested color would have shipped at. */
	requestedRatio: number;
	/** Ratio the emitted color ships at. */
	ratio: number;
	/** False when the canvas itself makes the floor unreachable. */
	meetsTarget: boolean;
}

export interface BrandThemeResult {
	css: string;
	/** Every substitution made, with its resulting ratio. Empty when nothing failed. */
	substitutions: ContrastSubstitution[];
}

function validHex(value: string | undefined): string | null {
	return value && isValidHexColor(value) ? value : null;
}

function toOklch(value: string | null): Oklch | null {
	if (!value) return null;
	try {
		return hexToOklch(value);
	} catch {
		return null;
	}
}

/**
 * Primary seed, falling back to the `colors` array.
 *
 * The array fallback used to be a trailing special case that emitted only the
 * light vars; routing it through the slot table means an array-derived brand
 * gets the same dark palette and the same contrast correction as an explicit
 * `primaryColor`.
 */
function resolvePrimarySeed(branding: BrandingProfile): string | null {
	const explicit = validHex(branding.primaryColor);
	if (explicit) return explicit;

	const fromArray = branding.colors?.find(
		(color) =>
			color.usage === "primary" ||
			color.name?.toLowerCase().includes("primary"),
	);
	return validHex(fromArray?.hex);
}

/**
 * Build the brand theme CSS and the record of every contrast substitution.
 */
export function buildBrandTheme(branding: BrandingProfile): BrandThemeResult {
	const baseVars: string[] = [];
	const lightVars: string[] = [];
	const darkVars: string[] = [];
	const substitutions: ContrastSubstitution[] = [];

	const lightBackground = validHex(branding.backgroundColor);
	const lightCanvas = lightBackground ?? DEFAULT_LIGHT_CANVAS;

	/*
	 * The dark canvas has to be resolved before any slot is emitted, because
	 * every dark contrast decision is measured against it. Order of authority:
	 * the tenant's explicit dark background, then the dark background we would
	 * derive from their light one, then this package's own dark canvas.
	 */
	const explicitDarkBackground = validHex(branding.backgroundColorDark);
	const derivedDarkBackground = (() => {
		const seed = toOklch(lightBackground);
		return seed ? oklchToHex(deriveOklch(seed, DARK_SURFACE)) : null;
	})();
	const darkCanvas =
		explicitDarkBackground ?? derivedDarkBackground ?? DEFAULT_DARK_CANVAS;

	const emit = (target: string[], name: string, color: Oklch): void => {
		target.push(`${name}: ${formatOklch(color)};`);
	};

	for (const slot of BRAND_SLOTS) {
		const lightSeedHex =
			slot.lightKey === "primaryColor"
				? resolvePrimarySeed(branding)
				: validHex(branding[slot.lightKey]);
		const lightSeed = toOklch(lightSeedHex);

		/*
		 * Explicit dark input wins outright. Derivation only fills a gap; it never
		 * overrides a choice the tenant made on purpose.
		 */
		const explicitDark = toOklch(validHex(branding[slot.darkKey]));
		const darkSeed =
			explicitDark ?? (lightSeed ? deriveOklch(lightSeed, slot.dark) : null);

		const resolve = (
			seed: Oklch,
			name: string,
			mode: "light" | "dark",
			background: string,
		): Oklch => {
			if (!slot.correct?.includes(name)) return seed;
			const solved = solveContrastLightness(
				seed,
				background,
				WCAG_AA_NORMAL_TEXT,
			);
			if (solved.adjusted) {
				substitutions.push({
					token: name,
					mode,
					requested: oklchToHex(seed),
					emitted: solved.hex,
					background,
					requestedRatio: solved.seedRatio,
					ratio: solved.ratio,
					meetsTarget: solved.meetsTarget,
				});
			}
			return solved.color;
		};

		/*
		 * The `-foreground` pair belongs to the SEMANTIC token, not the brand
		 * token: what renders is `bg-primary text-primary-foreground`, so the
		 * label has to be readable on `--primary` as corrected, not on the
		 * uncorrected `--brand-primary` it is emitted beside. In every slot the
		 * semantic token is the last one listed, brand-of-record first.
		 */
		const slotVars = [...slot.baseVars, ...slot.lightVars];
		const fillName = slotVars[slotVars.length - 1];

		if (lightSeed) {
			// Resolve once per var: `resolve` records substitutions as a side effect.
			const resolved = new Map(
				slotVars.map((name) => [
					name,
					resolve(lightSeed, name, "light", lightCanvas),
				]),
			);
			for (const name of slot.baseVars) {
				emit(baseVars, name, resolved.get(name) ?? lightSeed);
			}
			for (const name of slot.lightVars) {
				emit(lightVars, name, resolved.get(name) ?? lightSeed);
			}
			if (slot.foreground) {
				const fill = (fillName && resolved.get(fillName)) || lightSeed;
				const target = slot.foreground.scope === "base" ? baseVars : lightVars;
				emit(
					target,
					slot.foreground.name,
					hexToOklch(getContrastColor(oklchToHex(fill))),
				);
			}
		}

		if (darkSeed) {
			const resolved = new Map(
				slotVars.map((name) => [
					name,
					resolve(darkSeed, name, "dark", darkCanvas),
				]),
			);
			for (const name of slotVars) {
				emit(darkVars, name, resolved.get(name) ?? darkSeed);
			}
			if (slot.foreground) {
				const fill = (fillName && resolved.get(fillName)) || darkSeed;
				emit(
					darkVars,
					slot.foreground.name,
					hexToOklch(getContrastColor(oklchToHex(fill))),
				);
			}
		}
	}

	// Typography
	if (branding.typography?.fontFamily) {
		baseVars.push(`--brand-font-family: ${branding.typography.fontFamily};`);
		baseVars.push(`--font-sans: ${branding.typography.fontFamily};`);
	}

	if (branding.typography?.headingFont) {
		baseVars.push(`--brand-heading-font: ${branding.typography.headingFont};`);
	}

	if (branding.typography?.bodyFont) {
		baseVars.push(`--brand-body-font: ${branding.typography.bodyFont};`);
	}

	if (
		baseVars.length === 0 &&
		lightVars.length === 0 &&
		darkVars.length === 0
	) {
		return { css: "", substitutions };
	}

	/*
	 * `:root:root` is a deliberate specificity hack, not a typo: these vars must
	 * outrank the package's own `:root` and `.dark` blocks in styles/globals.css
	 * without resorting to `!important`. `:where()` is the wrong tool here — it
	 * ZEROES specificity, which is the opposite of what an override layer needs;
	 * it would leave every tenant color losing to the defaults it is meant to
	 * replace.
	 */
	const blocks: string[] = [];
	if (baseVars.length > 0) {
		blocks.push(`:root:root {\n  ${baseVars.join("\n  ")}\n}`);
	}
	if (lightVars.length > 0) {
		blocks.push(
			`:root:root:not(.dark), :root:root[data-theme="light"] {\n  ${lightVars.join(
				"\n  ",
			)}\n}`,
		);
	}
	if (darkVars.length > 0) {
		blocks.push(
			`:root:root.dark, :root:root[data-theme="dark"] {\n  ${darkVars.join(
				"\n  ",
			)}\n}`,
		);
	}

	return { css: blocks.join("\n"), substitutions };
}

/**
 * Generate CSS custom properties from a branding profile.
 *
 * Dark-mode vars are always emitted for any color the tenant supplied, whether
 * or not they supplied its `*Dark` counterpart.
 *
 * The mode branch stays in the SELECTOR (`.dark` / `[data-theme="dark"]`) rather
 * than moving to `light-dark()`, even though `light-dark()` would collapse the
 * two blocks into one. `light-dark()` resolves off the `color-scheme` property,
 * and this widget renders inside third-party hosts that switch it to dark by
 * setting a `dark` class or a `data-theme` attribute — the exact signals
 * `getDocumentTheme()` in hooks/use-document-theme.ts reads. A host that flips
 * the class without declaring `color-scheme: dark` would get light colors from
 * `light-dark()`, which is the bug this change exists to remove. `light-dark()`
 * earns its place where a mode selector is unavailable, e.g. inline styles;
 * here a selector is available and is strictly more reliable.
 */
export function generateBrandThemeCss(branding: BrandingProfile): string {
	return buildBrandTheme(branding).css;
}

/**
 * Report every contrast substitution the theme makes, with resulting ratios.
 *
 * Exists so a substitution is inspectable — by a test, by an admin surface, or
 * by anyone asking why a shipped color is not the hex they typed.
 */
export function getBrandThemeContrastReport(
	branding: BrandingProfile,
): ContrastSubstitution[] {
	return buildBrandTheme(branding).substitutions;
}

/**
 * Get primary color hex from branding profile
 */
export function getPrimaryColor(
	branding?: BrandingProfile | null,
): string | null {
	if (!branding) return null;

	if (branding.primaryColor) {
		return branding.primaryColor;
	}

	const primaryFromArray = branding.colors?.find(
		(c) => c.usage === "primary" || c.name?.toLowerCase().includes("primary"),
	);

	return primaryFromArray?.hex ?? null;
}

/**
 * Check if a branding profile has enough data to theme
 */
export function hasBrandingData(branding?: BrandingProfile | null): boolean {
	if (!branding) return false;
	return !!(
		branding.primaryColor ||
		branding.secondaryColor ||
		branding.accentColor ||
		branding.primaryColorDark ||
		branding.secondaryColorDark ||
		branding.accentColorDark ||
		branding.backgroundColor ||
		branding.backgroundColorDark ||
		branding.textColor ||
		branding.textColorDark ||
		branding.colors?.length ||
		branding.typography?.fontFamily
	);
}
