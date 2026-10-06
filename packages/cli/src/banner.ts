/**
 * Welcome card for the interactive REPL — a rounded box (Codex / Claude-Code
 * style) holding the tedix wordmark + version + tagline, the active workspace +
 * gateway, and the working directory, with a getting-started hint line below.
 * Returns pre-colored string lines committed to the ink <Static> scrollback;
 * the box is drawn as ASCII (not an ink border) so it never re-renders and is
 * resize-safe. Box width is bounded by the renderer terminal, measured in
 * display columns rather than codepoints. Narrow terminals use a compact header.
 */

import { graphemes } from "./composer-graphemes";
import { stripControlChars, type ColorMode } from "./terminal";
import { accent, accentBold, faint, muted } from "./theme";

/** Visible display columns, including wide glyphs and joined emoji. */
const visibleWidth = (s: string): number => Bun.stringWidth(s);

/**
 * Welcome header style. By DEFAULT the spelled-out "TEDIX" wordmark below. Set
 * TEDIX_LOGO to switch to a compact header instead: the value is a
 * small mark before the wordmark (e.g. "✦", "🪐", "▸"); "" shows bare "tedix".
 */

/** Spelled-out "TEDIX" — ANSI-Shadow 3D wordmark (36 cols × 6 rows). */
const TEDIX_WORDMARK = [
	"████████╗███████╗██████╗ ██╗██╗  ██╗",
	"╚══██╔══╝██╔════╝██╔══██╗██║╚██╗██╔╝",
	"   ██║   █████╗  ██║  ██║██║ ╚███╔╝ ",
	"   ██║   ██╔══╝  ██║  ██║██║ ██╔██╗ ",
	"   ██║   ███████╗██████╔╝██║██╔╝ ██╗",
	"   ╚═╝   ╚══════╝╚═════╝ ╚═╝╚═╝  ╚═╝",
];

export interface BannerContext {
	version: string;
	workspace: string;
	gatewayUrl: string;
	cwd: string;
	color: ColorMode;
	/** Columns of the stream that Ink renders to. Defaults to 80 for plain callers. */
	columns?: number;
	/** Plain full identity and hints without the decorative logo or box. */
	screenReader?: boolean;
}

/** Collapse $HOME to `~` for a compact cwd. */
function tildeify(cwd: string): string {
	const home = process.env.HOME;
	return home && (cwd === home || cwd.startsWith(`${home}/`))
		? `~${cwd.slice(home.length)}`
		: cwd;
}

/** Strip the scheme + trailing /mcp so the gateway reads as a host. */
export function gatewayHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url.replace(/^https?:\/\//, "").replace(/\/mcp$/, "");
	}
}

/** Shared startup and /help hints, independent of terminal decoration. */
export const INTERACTIVE_KEY_HINTS = [
	"/help commands · @path attach",
	"Alt+Enter newline · Ctrl+Q queue",
	"Shift+Enter newline if supported",
	"PgUp/PgDn activity · Ctrl+G mode",
	"Ctrl+D quit empty draft",
] as const;

/** Wrap plain text at word boundaries, splitting long paths by grapheme width. */
function wrapDisplay(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		if (line && visibleWidth(`${line} ${word}`) <= width) {
			line += ` ${word}`;
			continue;
		}
		if (line) lines.push(line);
		line = "";
		for (const char of graphemes(word)) {
			if (line && visibleWidth(line + char) > width) {
				lines.push(line);
				line = "";
			}
			line += char;
		}
	}
	if (line || lines.length === 0) lines.push(line);
	return lines;
}

export function renderBanner(ctx: BannerContext): string[] {
	const c = ctx.color;
	const workspace = stripControlChars(ctx.workspace);
	const gateway = stripControlChars(gatewayHost(ctx.gatewayUrl));
	const directory = stripControlChars(tildeify(ctx.cwd));
	if (ctx.screenReader) {
		return [
			`Tedix CLI v${ctx.version}`,
			`Workspace: ${workspace}`,
			`Gateway: ${gateway}`,
			`Directory: ${directory}`,
			"",
			...INTERACTIVE_KEY_HINTS.map((hint) => hint.replaceAll(" · ", "; ")),
		];
	}
	const columns = Number.isFinite(ctx.columns)
		? Math.max(6, Math.floor(ctx.columns!))
		: 80;
	// Leave the last terminal column unused to avoid terminal auto-wrap.
	const contentWidth = columns - 5;
	const mark = process.env.TEDIX_LOGO;
	const compact =
		mark !== undefined ||
		Math.max(...TEDIX_WORDMARK.map(visibleWidth)) > contentWidth;
	const header = compact
		? [
				...wrapDisplay(
					`${mark ? `${stripControlChars(mark)}  ` : ""}tedix`,
					contentWidth,
				).map((line) => accentBold(line, c)),
				...wrapDisplay(`v${ctx.version}`, contentWidth).map((line) =>
					faint(line, c),
				),
			]
		: [
				...TEDIX_WORDMARK.map((line) => accent(line, c)),
				...wrapDisplay(
					`v${ctx.version} · persistent AI workers`,
					contentWidth,
				).map((line) => faint(line, c)),
			];
	const rows = [
		...header,
		"",
		...[
			`Workspace: ${workspace}`,
			`Gateway: ${gateway}`,
			`Directory: ${directory}`,
		].flatMap((line) =>
			wrapDisplay(line, contentWidth).map((part) => muted(part, c)),
		),
	];
	const inner = Math.max(...rows.map(visibleWidth));
	const padRow = (r: string) =>
		r + " ".repeat(Math.max(0, inner - visibleWidth(r)));
	const horiz = "─".repeat(inner + 2);
	const bar = faint("│", c);
	return [
		faint(`╭${horiz}╮`, c),
		...rows.map((r) => `${bar} ${padRow(r)} ${bar}`),
		faint(`╰${horiz}╯`, c),
		"",
		...INTERACTIVE_KEY_HINTS.flatMap((hint) =>
			wrapDisplay(hint, columns - 3).map((line) => `  ${faint(line, c)}`),
		),
	];
}
