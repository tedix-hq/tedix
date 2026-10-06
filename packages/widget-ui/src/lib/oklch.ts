/**
 * OKLCH Color Engine
 *
 * Conversion, sRGB gamut mapping, and lightness solving in OKLCH.
 *
 * WHY OKLCH AND NOT HSL: OKLCH is perceptually uniform, so a lightness step of
 * 0.1 looks like the same size step on orange as it does on blue. That is the
 * property the dark-palette derivation depends on — one lightness target has to
 * produce a legible result for every tenant hue we are handed, and we never see
 * the tenant's colors before they ship.
 *
 * WHY THE MATH RUNS HERE AND NOT IN CSS: CSS can do all of this natively with
 * relative color syntax, `oklch(from <seed> 0.45 c h)`. We resolve the formulas
 * in TypeScript for two reasons that are specific to this package:
 *
 *  1. The widget is embedded in third-party hosts (ChatGPT among them). A
 *     resolved `oklch(45.00% 0.16 250)` literal is understood by every engine
 *     that understands `oklch()` at all — which this package already requires,
 *     since `styles/globals.css` is written entirely in `oklch()`. Relative
 *     color syntax is a strictly newer feature; where it is unsupported the
 *     declaration is dropped and the tenant silently falls back to the default
 *     palette, i.e. exactly the bug we are fixing. Resolving here means the
 *     derivation cannot be the thing that fails.
 *  2. Contrast correction has to MEASURE the color it emits. A CSS expression
 *     is opaque to us until the browser resolves it, so a correction expressed
 *     as CSS could only ever be asserted by assumption. Resolving here lets the
 *     tests assert the real ratio of the real emitted color.
 *
 * Matrices are Björn Ottosson's reference OKLab <-> linear-sRGB pair, used in
 * both directions, so a hex -> OKLCH -> hex round trip returns the same color
 * except where the emitted 4dp chroma cannot express it (~0.06% of the cube,
 * always within one 8-bit step — see the round-trip test).
 * @see https://bottosson.github.io/posts/oklab/
 */

import {
	getContrastRatio,
	isValidHexColor,
	normalizeHexColor,
} from "./color-contrast";

/** A color in OKLCH. `l` is 0..1 (not a percentage), `c` is 0..~0.4, `h` is degrees 0..360. */
export interface Oklch {
	l: number;
	c: number;
	h: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** sRGB transfer function (gamma encode), CSS Color 4 / IEC 61966-2-1. */
function linearToSrgb(channel: number): number {
	return channel <= 0.0031308
		? channel * 12.92
		: 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Inverse sRGB transfer function (gamma decode). */
function srgbToLinear(channel: number): number {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * Convert a hex color to OKLCH.
 *
 * Throws on an invalid hex string, matching `getRelativeLuminance`'s contract in
 * `color-contrast.ts` — callers in this package validate with `isValidHexColor`
 * first and treat a throw as "skip this color".
 */
export function hexToOklch(hex: string): Oklch {
	const normalized = normalizeHexColor(hex);
	if (!normalized || !isValidHexColor(hex)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}

	const value = normalized.replace(/^#/, "");
	const r = srgbToLinear(Number.parseInt(value.slice(0, 2), 16) / 255);
	const g = srgbToLinear(Number.parseInt(value.slice(2, 4), 16) / 255);
	const b = srgbToLinear(Number.parseInt(value.slice(4, 6), 16) / 255);

	const lCone = Math.cbrt(
		0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
	);
	const mCone = Math.cbrt(
		0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
	);
	const sCone = Math.cbrt(
		0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
	);

	const lightness =
		0.2104542553 * lCone + 0.793617785 * mCone - 0.0040720468 * sCone;
	const a = 1.9779984951 * lCone - 2.428592205 * mCone + 0.4505937099 * sCone;
	const bAxis =
		0.0259040371 * lCone + 0.7827717662 * mCone - 0.808675766 * sCone;

	const chroma = Math.sqrt(a * a + bAxis * bAxis);
	let hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
	if (hue < 0) hue += 360;

	return { l: lightness, c: chroma, h: hue };
}

/** Convert OKLCH to (possibly out-of-gamut) sRGB channels in 0..1. */
function oklchToSrgbChannels(color: Oklch): {
	r: number;
	g: number;
	b: number;
} {
	const hueRadians = (color.h * Math.PI) / 180;
	const a = color.c * Math.cos(hueRadians);
	const bAxis = color.c * Math.sin(hueRadians);

	const lCone = (color.l + 0.3963377774 * a + 0.2158037573 * bAxis) ** 3;
	const mCone = (color.l - 0.1055613458 * a - 0.0638541728 * bAxis) ** 3;
	const sCone = (color.l - 0.0894841775 * a - 1.291485548 * bAxis) ** 3;

	return {
		r: linearToSrgb(
			4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
		),
		g: linearToSrgb(
			-1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
		),
		b: linearToSrgb(
			-0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
		),
	};
}

const GAMUT_EPSILON = 1 / 512;

function inSrgbGamut(color: Oklch): boolean {
	const { r, g, b } = oklchToSrgbChannels(color);
	return [r, g, b].every(
		(channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
	);
}

/**
 * Reduce chroma until the color fits in sRGB, holding lightness and hue.
 *
 * This is the CSS Color 4 gamut-mapping shape (give up saturation, never hue or
 * lightness) rather than naive per-channel clipping, which shifts hue. It
 * matters here because the dark derivations push lightness to fixed targets
 * (0.56, 0.93) where a saturated seed's chroma is no longer reachable — a
 * vivid blue at L 0.93 does not exist in sRGB, and clipping would hand back a
 * washed color of a different hue.
 */
export function gamutMapOklch(color: Oklch): Oklch {
	const clamped: Oklch = {
		l: clamp01(color.l),
		c: Math.max(0, color.c),
		h: ((color.h % 360) + 360) % 360,
	};
	if (inSrgbGamut(clamped)) return clamped;

	let low = 0;
	let high = clamped.c;
	// 20 halvings of a <=0.4 chroma range lands well inside 8-bit resolution.
	for (let i = 0; i < 20; i += 1) {
		const mid = (low + high) / 2;
		if (inSrgbGamut({ ...clamped, c: mid })) {
			low = mid;
		} else {
			high = mid;
		}
	}
	return { ...clamped, c: low };
}

/*
 * Precision the CSS is written at. Everything downstream — including every
 * contrast measurement — is taken on the QUANTIZED color, because the quantized
 * color is the one that ships. Measuring the solver's float instead is not a
 * rounding nicety: rounding chroma to 4dp moved a channel by 1/255 and dropped a
 * corrected color from 4.537:1 to 4.496:1, i.e. below the floor it was
 * substituted in to clear, while the report claimed it passed.
 */
const LIGHTNESS_PERCENT_DIGITS = 2;
const CHROMA_DIGITS = 4;
const HUE_DIGITS = 2;

/** Round to the precision `formatOklch` emits, so measurement matches emission. */
export function quantizeOklch(color: Oklch): Oklch {
	const mapped = gamutMapOklch(color);
	return {
		l: Number((mapped.l * 100).toFixed(LIGHTNESS_PERCENT_DIGITS)) / 100,
		c: Number(mapped.c.toFixed(CHROMA_DIGITS)),
		// Hue carries no meaning once chroma rounds to zero, and the value that
		// falls out of a hex conversion of a grey is arbitrary. Pin it to 0 so
		// achromatic output is stable and readable.
		h:
			Number(mapped.c.toFixed(CHROMA_DIGITS)) === 0
				? 0
				: Number(mapped.h.toFixed(HUE_DIGITS)),
	};
}

/** Convert OKLCH to the hex color a browser will actually paint from our CSS. */
export function oklchToHex(color: Oklch): string {
	const { r, g, b } = oklchToSrgbChannels(quantizeOklch(color));
	const toHex = (channel: number) =>
		Math.round(clamp01(channel) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Format OKLCH as a CSS `oklch()` function.
 *
 * Lightness is emitted as a percentage to match the shape already used by
 * `styles/globals.css` and by the CSS this package emitted before.
 */
export function formatOklch(color: Oklch): string {
	const q = quantizeOklch(color);
	return `oklch(${(q.l * 100).toFixed(LIGHTNESS_PERCENT_DIGITS)}% ${q.c.toFixed(
		CHROMA_DIGITS,
	)} ${q.h.toFixed(HUE_DIGITS)})`;
}

/**
 * A dark-mode derivation: what to do to a light seed's OKLCH components.
 *
 * `lightness` REPLACES the seed's lightness (the seed's own lightness carries no
 * information about how it should read on a dark canvas). `chromaScale` and
 * `chromaCeiling` only ever reduce chroma. Hue is never touched — hue is the
 * brand.
 */
export interface DarkDerivation {
	/** Target OKLCH lightness on a dark canvas, 0..1. */
	lightness: number;
	/** Multiplier on the seed's chroma. 1 keeps the brand's saturation. */
	chromaScale?: number;
	/** Hard cap on the resulting chroma. */
	chromaCeiling?: number;
}

/** Apply a dark derivation to a light-mode seed. */
export function deriveOklch(seed: Oklch, recipe: DarkDerivation): Oklch {
	const scaled = seed.c * (recipe.chromaScale ?? 1);
	return gamutMapOklch({
		l: recipe.lightness,
		c:
			recipe.chromaCeiling === undefined
				? scaled
				: Math.min(scaled, recipe.chromaCeiling),
		h: seed.h,
	});
}

export interface ContrastSolution {
	/** The color to emit — the seed unchanged, or a lightness-substituted variant. */
	color: Oklch;
	/** Hex of `color`, as painted. */
	hex: string;
	/** Contrast ratio of `color` against the background it was solved for. */
	ratio: number;
	/** Ratio the seed itself achieved, for reporting a substitution. */
	seedRatio: number;
	/** True when a substitution was made. */
	adjusted: boolean;
	/** False when even pure black/white could not reach the target (background is mid-grey). */
	meetsTarget: boolean;
}

/**
 * Find the lightness closest to the seed's that clears `targetRatio` against
 * `background`, holding chroma and hue.
 *
 * WHY THIS IS SOLVABLE AT ALL: WCAG contrast is a monotone function of relative
 * luminance, and relative luminance is monotone in OKLCH lightness once chroma
 * is gamut-mapped (mapping only ever removes chroma, never adds luminance in the
 * opposite direction). So for a fixed background there is at most one crossing
 * in each direction, and a bisection finds it. This is the whole reason a
 * contrast FAILURE can be corrected rather than merely reported: the old code
 * could only warn because its only lever was `getContrastColor`, which picks
 * black or white and therefore cannot express "this brand color, two steps
 * darker".
 *
 * Both directions are searched and the smaller lightness move wins, because the
 * substitution is a tax on the tenant's brand and the job is to charge the
 * minimum. Darkening and lightening are NOT symmetric in cost — for a seed just
 * under the threshold on white, darkening moves ~0.1 and lightening would have
 * to cross the background entirely.
 *
 * If neither direction reaches the target the color is pinned to whichever
 * extreme scored best and `meetsTarget` is false. At the 4.5:1 AA floor that
 * branch is unreachable, and provably so: gamut mapping drives chroma to zero at
 * both ends of the lightness range, so the extremes really are black and white,
 * and white clears 4.5:1 against any canvas of luminance below 0.183 while black
 * clears it against any canvas above 0.175. The intervals overlap, so every
 * possible canvas admits a solution — the mid-grey worst case (#808080) still
 * reaches 5.32:1 by going black. The branch is kept because it stops being dead
 * at stricter targets: the AAA 7:1 floor genuinely is unreachable for canvases
 * in roughly luminance 0.10-0.30, and reporting the shortfall is better than
 * silently pretending to have met it.
 */
export function solveContrastLightness(
	seed: Oklch,
	background: string,
	targetRatio: number,
): ContrastSolution {
	const ratioAt = (lightness: number): number =>
		getContrastRatio(oklchToHex({ ...seed, l: lightness }), background);

	const seedRatio = ratioAt(seed.l);
	if (seedRatio >= targetRatio) {
		const color = gamutMapOklch(seed);
		return {
			color,
			hex: oklchToHex(color),
			ratio: seedRatio,
			seedRatio,
			adjusted: false,
			meetsTarget: true,
		};
	}

	const ITERATIONS = 24;

	// Darker: the feasible set is [0, x]; keep the LARGEST feasible lightness.
	let darker: number | null = null;
	if (ratioAt(0) >= targetRatio) {
		let feasible = 0;
		let infeasible = seed.l;
		for (let i = 0; i < ITERATIONS; i += 1) {
			const mid = (feasible + infeasible) / 2;
			if (ratioAt(mid) >= targetRatio) feasible = mid;
			else infeasible = mid;
		}
		darker = feasible;
	}

	// Lighter: the feasible set is [x, 1]; keep the SMALLEST feasible lightness.
	let lighter: number | null = null;
	if (ratioAt(1) >= targetRatio) {
		let infeasible = seed.l;
		let feasible = 1;
		for (let i = 0; i < ITERATIONS; i += 1) {
			const mid = (feasible + infeasible) / 2;
			if (ratioAt(mid) >= targetRatio) feasible = mid;
			else infeasible = mid;
		}
		lighter = feasible;
	}

	const candidates = [darker, lighter].filter(
		(value): value is number => value !== null,
	);

	if (candidates.length === 0) {
		// Unreachable target: take the better extreme and report the shortfall.
		const best = ratioAt(0) >= ratioAt(1) ? 0 : 1;
		const color = gamutMapOklch({ ...seed, l: best });
		return {
			color,
			hex: oklchToHex(color),
			ratio: ratioAt(best),
			seedRatio,
			adjusted: true,
			meetsTarget: false,
		};
	}

	const chosen = candidates.reduce((a, b) =>
		Math.abs(a - seed.l) <= Math.abs(b - seed.l) ? a : b,
	);
	const color = gamutMapOklch({ ...seed, l: chosen });
	const hex = oklchToHex(color);
	return {
		color,
		hex,
		// Measured on the emitted 8-bit color, not on the solver's float, so the
		// reported ratio is the ratio that ships.
		ratio: getContrastRatio(hex, background),
		seedRatio,
		adjusted: true,
		meetsTarget: getContrastRatio(hex, background) >= targetRatio,
	};
}
