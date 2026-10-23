import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Static WCAG gate for the Kumo token bridge. `kumo.css` and `feed-deck.css`
 * project the untenanted OS palette (`apps/os/src/styles.css`, :root light /
 * `.dark`) into semantic text and surface roles through var(), light-dark()
 * and color-mix() chains, so this test resolves each chain the way the
 * browser does and asserts the shipped pairs meet WCAG AA.
 */

type Mode = "light" | "dark";
type Rgb = [number, number, number];
type Rgba = [...Rgb, number];

const KUMO_CSS = readFileSync(new URL("./kumo.css", import.meta.url), "utf8");
const FEED_DECK_CSS = readFileSync(
	new URL("./feed-deck.css", import.meta.url),
	"utf8",
);
/* The package owns the projections; the palette they resolve against is
 * app-owned, so the untenanted light/dark blocks are read as the baseline. */
const OS_PALETTE_CSS = readFileSync(
	new URL("../../../apps/os/src/styles.css", import.meta.url),
	"utf8",
);

function splitTopLevel(source: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === separator && depth === 0) {
			parts.push(source.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
}

/* Collects `--name: value` pairs from plain selector blocks; nested at-rule
 * bodies are skipped (they only carry spacing overrides, never palette). */
function cssDeclarations(
	css: string,
): Array<{ selector: string; name: string; value: string }> {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const found: Array<{ selector: string; name: string; value: string }> = [];
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf("{", cursor);
		if (open === -1) break;
		const prelude = text.slice(cursor, open).trim();
		let depth = 1;
		let close = open + 1;
		while (close < text.length && depth > 0) {
			if (text[close] === "{") depth++;
			else if (text[close] === "}") depth--;
			close++;
		}
		if (prelude !== "" && !prelude.startsWith("@")) {
			for (const declaration of splitTopLevel(
				text.slice(open + 1, close - 1),
				";",
			)) {
				const match = declaration.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/);
				if (match)
					found.push({ selector: prelude, name: match[1], value: match[2] });
			}
		}
		cursor = close;
	}
	return found;
}

function buildScopes(): Record<Mode, Map<string, string>> {
	const light = new Map<string, string>();
	const darkOnly = new Map<string, string>();
	for (const declaration of cssDeclarations(OS_PALETTE_CSS)) {
		const selectors = declaration.selector.split(",").map((s) => s.trim());
		if (selectors.includes(":root"))
			light.set(declaration.name, declaration.value);
		if (selectors.includes(".dark") || selectors.includes('[data-mode="dark"]'))
			darkOnly.set(declaration.name, declaration.value);
	}
	/* The dark palette overrides only the tokens it restates. */
	const dark = new Map(light);
	for (const [name, value] of darkOnly) dark.set(name, value);

	/* The token bridges are mode-agnostic: light-dark() picks the branch at
	 * evaluation time, not at parse time. */
	const shared = new Map<string, string>();
	for (const css of [KUMO_CSS, FEED_DECK_CSS])
		for (const declaration of cssDeclarations(css))
			shared.set(declaration.name, declaration.value);

	return {
		light: new Map([...light, ...shared]),
		dark: new Map([...dark, ...shared]),
	};
}

function linearize(channel: number): number {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4;
}

function delinearize(channel: number): number {
	return channel <= 0.0031308
		? 12.92 * channel
		: 1.055 * channel ** (1 / 2.4) - 0.055;
}

type Oklch = [l: number, c: number, h: number];

function srgbToOklch([r, g, b]: Rgb): Oklch {
	const [lr, lg, lb] = [linearize(r), linearize(g), linearize(b)];
	const l = Math.cbrt(
		0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
	);
	const m = Math.cbrt(
		0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
	);
	const s = Math.cbrt(
		0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
	);
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		Math.hypot(a, bb),
		Math.atan2(bb, a),
	];
}

function oklchToSrgb([l, c, h]: Oklch): Rgb {
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
		-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
		-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
	].map((channel) => Math.min(1, Math.max(0, delinearize(channel)))) as Rgb;
}

function parseHex(value: string): Rgba | null {
	const digits = value.slice(1);
	const expanded =
		digits.length === 3 || digits.length === 4
			? [...digits].map((c) => c + c).join("")
			: digits;
	if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expanded)) return null;
	const channel = (offset: number) =>
		Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
	return [
		channel(0),
		channel(2),
		channel(4),
		expanded.length === 8 ? channel(6) : 1,
	];
}

function parseAlpha(part: string | undefined): number {
	if (part === undefined) return 1;
	return part.endsWith("%")
		? Number.parseFloat(part) / 100
		: Number.parseFloat(part);
}

function parseRgb(args: string): Rgba | null {
	const [channels, slash] = splitTopLevel(args, "/");
	const parts = channels.includes(",")
		? channels.split(",").map((part) => part.trim())
		: channels.trim().split(/\s+/);
	if (parts.length !== 3 && parts.length !== 4) return null;
	const channel = (part: string) =>
		part.endsWith("%")
			? Number.parseFloat(part) / 100
			: Number.parseFloat(part) / 255;
	const rgb = parts.slice(0, 3).map(channel);
	if (rgb.some(Number.isNaN)) return null;
	return [...(rgb as Rgb), parseAlpha(slash ?? parts[3])];
}

function parseOklch(args: string): Rgba | null {
	const [components, alpha] = splitTopLevel(args, "/");
	const parts = components.trim().split(/\s+/);
	if (parts.length !== 3) return null;
	const l = parts[0].endsWith("%")
		? Number.parseFloat(parts[0]) / 100
		: Number.parseFloat(parts[0]);
	const c = Number.parseFloat(parts[1]);
	const h = (Number.parseFloat(parts[2]) * Math.PI) / 180;
	if ([l, c, h].some(Number.isNaN)) return null;
	const [r, g, b] = oklchToSrgb([l, c, h]);
	return [r, g, b, parseAlpha(alpha)];
}

/* `color-mix` premultiplies in srgb; the oklch branch interpolates L, C and
 * the shorter hue arc (a powerless component adopts the other color's hue). */
function mixColors(
	first: Rgba,
	second: Rgba,
	weightFirst: number,
	weightSecond: number,
	space: string,
): Rgba | null {
	const total = weightFirst + weightSecond;
	if (total <= 0) return null;
	const w1 = weightFirst / total;
	const w2 = weightSecond / total;
	const alpha = (first[3] * w1 + second[3] * w2) * Math.min(1, total);
	if (space === "srgb" || space === "srgb-linear") {
		const channel = (index: number) =>
			first[index] * first[3] * w1 + second[index] * second[3] * w2;
		const a = Math.min(1, alpha);
		return [
			channel(0) / a || 0,
			channel(1) / a || 0,
			channel(2) / a || 0,
			alpha,
		];
	}
	if (space !== "oklch") return null;
	const one = srgbToOklch([first[0], first[1], first[2]]);
	const two = srgbToOklch([second[0], second[1], second[2]]);
	if (one[1] < 0.000004) one[2] = two[2];
	if (two[1] < 0.000004) two[2] = one[2];
	const hue =
		two[2] +
		Math.atan2(Math.sin(one[2] - two[2]), Math.cos(one[2] - two[2])) * w1;
	const [r, g, b] = oklchToSrgb([
		two[0] + (one[0] - two[0]) * w1,
		two[1] + (one[1] - two[1]) * w1,
		hue,
	]);
	return [r, g, b, alpha];
}

/* `var(--x) 70%` — the optional weight is the last top-level token. */
function colorAndWeight(
	part: string,
): { color: string; weight: number | null } | null {
	let depth = 0;
	let cut = -1;
	for (let i = 0; i < part.length; i++) {
		const char = part[i];
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === " " && depth === 0) cut = i;
	}
	if (cut === -1) return { color: part.trim(), weight: null };
	const color = part.slice(0, cut).trim();
	const weight = part.slice(cut).trim();
	if (!weight.endsWith("%")) return null;
	return { color, weight: Number.parseFloat(weight) / 100 };
}

function evaluate(
	value: string,
	scope: Map<string, string>,
	mode: Mode,
	depth = 0,
): Rgba | null {
	if (depth > 24) return null;
	const text = value.trim();
	const call = text.match(/^([a-z-]+)\(([\s\S]*)\)$/);
	if (call) {
		const [, name, args] = call;
		if (name === "var") {
			const [reference, fallback] = splitTopLevel(args, ",");
			const raw = scope.get(reference.trim());
			const resolved =
				raw === undefined ? null : evaluate(raw, scope, mode, depth + 1);
			if (resolved) return resolved;
			return fallback === undefined
				? null
				: evaluate(fallback, scope, mode, depth + 1);
		}
		if (name === "light-dark") {
			const [light, dark] = splitTopLevel(args, ",");
			if (light === undefined || dark === undefined) return null;
			return evaluate(mode === "light" ? light : dark, scope, mode, depth + 1);
		}
		if (name === "color-mix") {
			const [space, first, second] = splitTopLevel(args, ",").map((p) =>
				p.trim(),
			);
			if (!space?.startsWith("in ") || !first || !second) return null;
			const a = colorAndWeight(first);
			const b = colorAndWeight(second);
			if (!a || !b) return null;
			const colorA = evaluate(a.color, scope, mode, depth + 1);
			const colorB = evaluate(b.color, scope, mode, depth + 1);
			if (!colorA || !colorB) return null;
			const wa = a.weight ?? (b.weight === null ? 0.5 : 1 - b.weight);
			const wb = b.weight ?? 1 - wa;
			return mixColors(colorA, colorB, wa, wb, space.slice(3).trim());
		}
		if (name === "rgb" || name === "rgba") return parseRgb(args);
		if (name === "oklch") return parseOklch(args);
	}
	if (text.startsWith("#")) return parseHex(text);
	if (text === "transparent") return [0, 0, 0, 0];
	if (text === "white") return [1, 1, 1, 1];
	if (text === "black") return [0, 0, 0, 1];
	return null;
}

function relativeLuminance([r, g, b]: Rgb): number {
	return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function compositeOver([r, g, b, a]: Rgba, [br, bg, bb]: Rgb): Rgb {
	return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

function contrastRatio(first: Rgb, second: Rgb): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

interface Pair {
	readonly name: string;
	readonly foreground: string;
	readonly background: string;
	readonly minimum: number;
}

const TEXT_TOKENS = [
	"--text-color-kumo-default",
	"--text-color-kumo-strong",
	"--text-color-kumo-subtle",
];
const SURFACE_TOKENS = [
	"--color-kumo-base",
	"--color-kumo-control",
	"--color-kumo-overlay",
	"--color-kumo-tint",
];
const STATUS_TEXT_TOKENS = [
	"--text-color-kumo-link",
	"--text-color-kumo-danger",
];

const PAIRS: Pair[] = [
	...TEXT_TOKENS.flatMap((foreground) =>
		SURFACE_TOKENS.map((background): Pair => ({
			name: `${foreground} on ${background}`,
			foreground,
			background,
			minimum: AA_TEXT,
		})),
	),
	...STATUS_TEXT_TOKENS.flatMap((foreground) =>
		SURFACE_TOKENS.map((background): Pair => ({
			name: `${foreground} on ${background}`,
			foreground,
			background,
			minimum: AA_TEXT,
		})),
	),
	{
		name: "--primary-foreground on --color-kumo-brand",
		foreground: "--primary-foreground",
		background: "--color-kumo-brand",
		minimum: AA_TEXT,
	},
	{
		/* Kumo's emphasis button forces `!text-white` on this fill. */
		name: "white on --tedix-action-danger",
		foreground: "white",
		background: "--tedix-action-danger",
		minimum: AA_TEXT,
	},
	{
		name: "--text-color-kumo-badge-inverted on --color-kumo-badge-inverted",
		foreground: "--text-color-kumo-badge-inverted",
		background: "--color-kumo-badge-inverted",
		minimum: AA_TEXT,
	},
	...SURFACE_TOKENS.map((background): Pair => ({
		name: `--color-kumo-focus on ${background}`,
		foreground: "--color-kumo-focus",
		background,
		minimum: AA_NON_TEXT,
	})),
	...["--fd-ink", "--fd-muted"].flatMap((foreground) =>
		["--fd-paper", "--fd-surface"].map((background): Pair => ({
			name: `${foreground} on ${background}`,
			foreground,
			background,
			minimum: AA_TEXT,
		})),
	),
];

interface Measurement {
	mode: Mode;
	pair: Pair;
	ratio: number | null;
}

function contrastViolations(measurements: Measurement[]) {
	return measurements.filter(
		(m): m is Measurement & { ratio: number } =>
			m.ratio !== null && m.ratio < m.pair.minimum,
	);
}

function measure(
	mode: Mode,
	pair: Pair,
	scope: Map<string, string>,
): Measurement {
	const resolve = (token: string) =>
		evaluate(
			token.startsWith("--") ? (scope.get(token) ?? token) : token,
			scope,
			mode,
		);
	const foreground = resolve(pair.foreground);
	const background = resolve(pair.background);
	if (!foreground || !background || background[3] < 1)
		return { mode, pair, ratio: null };
	const text: Rgb =
		foreground[3] < 1
			? compositeOver(foreground, [background[0], background[1], background[2]])
			: [foreground[0], foreground[1], foreground[2]];
	return {
		mode,
		pair,
		ratio: contrastRatio(text, [background[0], background[1], background[2]]),
	};
}

describe("kumo token contrast gate", () => {
	test.each([
		[4.49, AA_TEXT, 1],
		[4.5, AA_TEXT, 0],
		[4.51, AA_TEXT, 0],
		[2.99, AA_NON_TEXT, 1],
		[3, AA_NON_TEXT, 0],
		[3.01, AA_NON_TEXT, 0],
	])(
		"ratio %s against minimum %s has %s violations",
		(ratio, minimum, count) => {
			const measurement: Measurement = {
				mode: "light",
				pair: {
					name: "boundary",
					foreground: "black",
					background: "white",
					minimum,
				},
				ratio,
			};
			expect(contrastViolations([measurement])).toHaveLength(count);
		},
	);

	const scopes = buildScopes();
	const measurements = (["light", "dark"] as Mode[]).flatMap((mode) =>
		PAIRS.map((pair) => measure(mode, pair, scopes[mode])),
	);

	for (const { mode, pair, ratio } of measurements) {
		const key = `${mode}:${pair.name}`;
		const label =
			ratio === null
				? "unresolved"
				: `${ratio.toFixed(2)}:1 (min ${pair.minimum})`;
		console.info(`[contrast] ${key} -> ${label}`);
	}

	test("resolves every gated token pair in both themes", () => {
		const unresolved = measurements.filter((m) => m.ratio === null);
		expect(
			unresolved.map(
				(m) =>
					`${m.mode}:${m.pair.name} (${m.pair.foreground} on ${m.pair.background})`,
			),
		).toEqual([]);
	});

	test("holds semantic text/surface pairs at WCAG AA in light and dark", () => {
		const violations = contrastViolations(measurements);
		expect(
			violations.map(
				({ mode, pair, ratio }) =>
					`${mode}:${pair.name} = ${ratio.toFixed(2)}:1, needs ${pair.minimum}:1`,
			),
		).toEqual([]);
	});
});
