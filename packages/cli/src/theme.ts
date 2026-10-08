/**
 * Tedix terminal theme — the "Codex" dark identity from docs/engineering/product/design.md
 * mapped to the terminal: a single sage accent (#7FB28C) over a warm-black,
 * with muted + faint text tiers. Each swatch carries truecolor / 256-color / 16-color
 * SGR so the same token renders well across terminals (downshifting by the
 * detected color depth). The `paint()` helpers emit raw ANSI for our string
 * builders (markdown, spinner, banner); THEME_HEX exposes hex strings for ink
 * components (ink/chalk downsample those by capability automatically).
 */

import type { ColorMode } from "./terminal";

interface Swatch {
	/** [r,g,b] for truecolor terminals. */
	rgb: readonly [number, number, number];
	/** xterm-256 index for 256-color terminals. */
	x256: number;
	/** SGR foreground code for 16-color terminals. */
	x16: string;
}

// Foreground tints of the design.md Codex palette.
const SAGE: Swatch = { rgb: [127, 178, 140], x256: 108, x16: "32" }; // accent #7FB28C
const SAGE_DIM: Swatch = { rgb: [85, 122, 95], x256: 65, x16: "32" }; // accent-dim #557A5F
const MUTED: Swatch = { rgb: [155, 168, 158], x256: 245, x16: "37" }; // #9BA89E
const FAINT: Swatch = { rgb: [94, 107, 97], x256: 240, x16: "90" }; // #5E6B61
const WARN: Swatch = { rgb: [216, 178, 92], x256: 179, x16: "33" }; // warm gold

type Depth = "truecolor" | "256" | "16";

function colorDepth(): Depth {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
	const term = process.env.TERM ?? "";
	if (term.includes("256")) return "256";
	return "16";
}

function fgCode(swatch: Swatch): string {
	switch (colorDepth()) {
		case "truecolor":
			return `38;2;${swatch.rgb[0]};${swatch.rgb[1]};${swatch.rgb[2]}`;
		case "256":
			return `38;5;${swatch.x256}`;
		default:
			return swatch.x16;
	}
}

function paint(
	swatch: Swatch,
	text: string,
	mode: ColorMode,
	extraSgr?: string,
): string {
	if (!mode.enabled) return text;
	// Emit any extra SGR (e.g. bold "1") as its OWN escape rather than a compound
	// "1;38;2;…m": ink's ANSI slicing/wrapping mishandles compound truecolor SGR
	// and leaks digit fragments of the code into the rendered text.
	const color = `\x1b[${fgCode(swatch)}m`;
	const open = extraSgr ? `\x1b[${extraSgr}m${color}` : color;
	return `${open}${text}\x1b[0m`;
}

/** Sage accent — the brand color. */
export function accent(text: string, mode: ColorMode): string {
	return paint(SAGE, text, mode);
}
/** Sage accent, bold — wordmark/headers. */
export function accentBold(text: string, mode: ColorMode): string {
	return paint(SAGE, text, mode, "1");
}
/** Dimmed sage — secondary accent. */
export function accentDim(text: string, mode: ColorMode): string {
	return paint(SAGE_DIM, text, mode);
}
/** Muted (secondary) text. */
export function muted(text: string, mode: ColorMode): string {
	return paint(MUTED, text, mode);
}
/** Tier-3 faint text — hairlines, hints, labels. */
export function faint(text: string, mode: ColorMode): string {
	return paint(FAINT, text, mode);
}
/** Warning. */
export function warn(text: string, mode: ColorMode): string {
	return paint(WARN, text, mode);
}

/** Hex strings for ink `color`/`borderColor` props (ink downsamples). */
export const THEME_HEX = {
	accent: "#7FB28C",
	accentDim: "#557A5F",
	text: "#E6EDE6",
	muted: "#9BA89E",
	faint: "#5E6B61",
	danger: "#D86A5C",
	warn: "#D8B25C",
} as const;
