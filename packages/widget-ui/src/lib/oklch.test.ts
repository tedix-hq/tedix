import { describe, expect, it } from "vite-plus/test";
import { getContrastRatio } from "./color-contrast";
import {
	deriveOklch,
	formatOklch,
	gamutMapOklch,
	hexToOklch,
	oklchToHex,
	solveContrastLightness,
} from "./oklch";

const SAMPLES = [
	"#000000",
	"#ffffff",
	"#0051ff",
	"#ffe600",
	"#d00000",
	"#7f7f7f",
	"#00c48c",
];

function channels(hex: string): number[] {
	return [1, 3, 5].map((offset) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16),
	);
}

describe("hexToOklch / oklchToHex", () => {
	it("round-trips the sample colors exactly", () => {
		for (const hex of SAMPLES) {
			expect(oklchToHex(hexToOklch(hex))).toBe(hex);
		}
	});

	it("round-trips the whole cube to within the emitted CSS precision", () => {
		/*
		 * `oklchToHex` deliberately measures the QUANTIZED color — the one
		 * `formatOklch` writes — so a color whose chroma does not survive rounding
		 * to 4dp can land one 8-bit step away. That is the same precision this
		 * module has always emitted at, and it is the price of having measurement
		 * and emission agree; a drift of more than one step would not be.
		 */
		let drifted = 0;
		for (let r = 0; r < 256; r += 7) {
			for (let g = 0; g < 256; g += 11) {
				for (let b = 0; b < 256; b += 13) {
					const hex = `#${[r, g, b]
						.map((value) => value.toString(16).padStart(2, "0"))
						.join("")}`;
					const painted = oklchToHex(hexToOklch(hex));
					const delta = Math.max(
						...channels(hex).map((value, index) =>
							Math.abs(value - channels(painted)[index]),
						),
					);
					expect(delta, `${hex} -> ${painted}`).toBeLessThanOrEqual(1);
					if (delta > 0) drifted += 1;
				}
			}
		}
		// And drift is rare enough to stay a rounding artifact, not a bug.
		expect(drifted).toBeLessThan(20);
	});

	it("reports lightness in 0..1 and hue in degrees", () => {
		const blue = hexToOklch("#0051ff");
		expect(blue.l).toBeGreaterThan(0.4);
		expect(blue.l).toBeLessThan(0.6);
		expect(blue.h).toBeGreaterThan(240);
		expect(blue.h).toBeLessThan(290);
	});

	it("rejects invalid hex", () => {
		expect(() => hexToOklch("not-a-color")).toThrow();
	});
});

describe("gamutMapOklch", () => {
	it("reduces chroma rather than shifting hue or lightness", () => {
		// A vivid blue at L 0.93 does not exist in sRGB.
		const requested = { l: 0.93, c: 0.26, h: 264 };
		const mapped = gamutMapOklch(requested);

		expect(mapped.l).toBeCloseTo(requested.l, 6);
		expect(mapped.h).toBeCloseTo(requested.h, 6);
		expect(mapped.c).toBeLessThan(requested.c);

		// And the mapped color survives a round trip through sRGB, i.e. it is in gamut.
		const painted = hexToOklch(oklchToHex(mapped));
		expect(painted.h).toBeCloseTo(requested.h, 0);
	});

	it("leaves in-gamut colors untouched", () => {
		const inGamut = hexToOklch("#0051ff");
		expect(gamutMapOklch(inGamut).c).toBeCloseTo(inGamut.c, 6);
	});
});

describe("deriveOklch", () => {
	it("replaces lightness and holds hue", () => {
		const seed = hexToOklch("#0051ff");
		const derived = deriveOklch(seed, { lightness: 0.45 });

		expect(derived.l).toBeCloseTo(0.45, 6);
		expect(derived.h).toBeCloseTo(seed.h, 6);
	});

	it("only ever reduces chroma", () => {
		const seed = hexToOklch("#0051ff");
		const derived = deriveOklch(seed, {
			lightness: 0.22,
			chromaScale: 0.35,
			chromaCeiling: 0.03,
		});

		expect(derived.c).toBeLessThanOrEqual(0.03);
		expect(derived.h).toBeCloseTo(seed.h, 6);
	});

	it("produces the same perceptual step for different hues", () => {
		// The point of OKLCH: one lightness target is valid for every tenant hue.
		for (const hex of ["#0051ff", "#ffe600", "#d00000", "#00c48c"]) {
			expect(deriveOklch(hexToOklch(hex), { lightness: 0.45 }).l).toBeCloseTo(
				0.45,
				6,
			);
		}
	});
});

describe("solveContrastLightness", () => {
	it("leaves a passing color alone", () => {
		const solved = solveContrastLightness(
			hexToOklch("#0051ff"),
			"#ffffff",
			4.5,
		);

		expect(solved.adjusted).toBe(false);
		expect(solved.hex).toBe("#0051ff");
		expect(solved.ratio).toBeGreaterThanOrEqual(4.5);
	});

	it("darkens a too-light color on a light canvas and clears the target", () => {
		const seed = hexToOklch("#ffe600");
		const solved = solveContrastLightness(seed, "#ffffff", 4.5);

		expect(solved.adjusted).toBe(true);
		expect(solved.meetsTarget).toBe(true);
		expect(solved.color.l).toBeLessThan(seed.l);
		expect(solved.color.h).toBeCloseTo(seed.h, 6);
		// Measured, not assumed.
		expect(getContrastRatio(solved.hex, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	});

	it("lightens a too-dark color on a dark canvas and clears the target", () => {
		const seed = hexToOklch("#1f3d7a");
		const solved = solveContrastLightness(seed, "#1b1b1b", 4.5);

		expect(solved.adjusted).toBe(true);
		expect(solved.meetsTarget).toBe(true);
		expect(solved.color.l).toBeGreaterThan(seed.l);
		expect(getContrastRatio(solved.hex, "#1b1b1b")).toBeGreaterThanOrEqual(4.5);
	});

	it("charges the minimum lightness move it can", () => {
		const seed = hexToOklch("#ffe600");
		const solved = solveContrastLightness(seed, "#ffffff", 4.5);
		// One step lighter than the solution must fail, or the solver overpaid.
		const lighter = { ...solved.color, l: solved.color.l + 0.01 };
		expect(getContrastRatio(oklchToHex(lighter), "#ffffff")).toBeLessThan(4.5);
	});

	it("always finds a solution at the 4.5:1 AA floor, even on mid-grey", () => {
		// Mid-grey is the worst canvas there is, and black still clears 4.5:1 on it.
		const solved = solveContrastLightness(
			hexToOklch("#808080"),
			"#808080",
			4.5,
		);

		expect(solved.adjusted).toBe(true);
		expect(solved.meetsTarget).toBe(true);
		expect(getContrastRatio(solved.hex, "#808080")).toBeGreaterThanOrEqual(4.5);
	});

	it("reports the shortfall instead of faking it when a target is unreachable", () => {
		// The AAA 7:1 floor genuinely is unreachable against a mid-grey canvas.
		const solved = solveContrastLightness(hexToOklch("#808080"), "#808080", 7);

		expect(solved.meetsTarget).toBe(false);
		expect(solved.ratio).toBeLessThan(7);
		// It still hands back the best color available rather than the failing seed.
		expect(solved.ratio).toBeGreaterThan(solved.seedRatio);
	});
});

describe("formatOklch", () => {
	it("emits a percentage lightness, matching globals.css", () => {
		expect(formatOklch({ l: 0.45, c: 0.1, h: 250 })).toBe(
			"oklch(45.00% 0.1000 250.00)",
		);
	});

	it("zeroes the meaningless hue of an achromatic color", () => {
		expect(formatOklch(hexToOklch("#ffffff"))).toBe(
			"oklch(100.00% 0.0000 0.00)",
		);
	});
});
