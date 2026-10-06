import { accentDim } from "./theme";
import { type ColorMode, stripControlChars } from "./terminal";

/**
 * Minimal, dependency-free markdown → ANSI renderer for kernel/Home answers,
 * which are frequently markdown (headers, lists, fenced code, the plan-card
 * output). Mirrors the rendering Claude Code / Codex do for assistant text.
 *
 * Scope is deliberately small and line-oriented: headers, bullet/numbered
 * lists, blockquotes, horizontal rules, fenced code blocks, and inline
 * `code`/**bold**／*italic*／[text](url). It never throws — anything it does not
 * recognize passes through verbatim, and with `mode.enabled === false`
 * (non-TTY / --json / NO_COLOR) it returns the text essentially unchanged so
 * machine consumers and pipes are unaffected.
 */

const RESET = "\x1b[0m";

function sgr(code: string, text: string, mode: ColorMode): string {
	if (!mode.enabled || !text) return text;
	return `\x1b[${code}m${text}${RESET}`;
}

const bold = (t: string, m: ColorMode) => sgr("1", t, m);
const dim = (t: string, m: ColorMode) => sgr("2", t, m);
const italic = (t: string, m: ColorMode) => sgr("3", t, m);
const underline = (t: string, m: ColorMode) => sgr("4", t, m);
const cyan = (t: string, m: ColorMode) => sgr("36", t, m);

/**
 * Apply inline spans (code, bold, italic, links) to a single already-trimmed
 * text run. Order matters: extract code spans first so their contents are not
 * re-processed for bold/italic.
 */
export function renderInline(text: string, mode: ColorMode): string {
	if (!text) return text;
	// `inline code` → cyan. Capture first so ** / * inside code is left alone.
	let out = text.replace(/`([^`]+)`/g, (_m, code) => cyan(code, mode));
	// [label](url) → label + dim url. Allow one level of balanced parens in url.
	out = out.replace(
		/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
		(_m, label, url) => `${label} ${dim(`(${url})`, mode)}`,
	);
	// **bold** / __bold__ — must come before single * / _ rules
	out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b) => bold(b, mode));
	out = out.replace(/__([^_]+)__/g, (_m, b) => bold(b, mode));
	// *italic* — require non-word boundary so a*b and file*glob aren't mangled
	out = out.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, (_m, i) => italic(i, mode));
	// _italic_ — tightened to avoid snake_case identifiers
	out = out.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_m, i) =>
		italic(i, mode),
	);
	return out;
}

const FENCE_RE = /^\s*```/;
const HEADER_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/**
 * Compute the display width of a string for terminal column alignment.
 * East-Asian-Wide and emoji = 2; combining/zero-width/control = 0; else 1.
 */
export function displayWidth(str: string): number {
	let w = 0;
	for (const ch of str) {
		const cp = ch.codePointAt(0) ?? 0;
		// Zero-width: combining marks, joiners, BOM, variation selectors
		if (
			(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
			(cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical supplement
			(cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical extended
			(cp >= 0x20d0 && cp <= 0x20ff) || // combining diacritical for symbols
			cp === 0x200b || // zero-width space
			cp === 0x200c || // zero-width non-joiner
			cp === 0x200d || // zero-width joiner
			cp === 0xfeff || // BOM / zero-width no-break space
			(cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
			(cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
		) {
			continue; // width 0
		}
		// Control chars
		if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
			continue; // width 0
		}
		// Wide: CJK, fullwidth, emoji ranges
		if (
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2329 && cp <= 0x232a) ||
			(cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
			(cp >= 0x3250 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0xa4c6) ||
			(cp >= 0xa960 && cp <= 0xa97c) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6b) ||
			(cp >= 0xff01 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1b000 && cp <= 0x1b001) ||
			(cp >= 0x1f004 && cp <= 0x1f0cf) ||
			(cp >= 0x1f18e && cp <= 0x1f251) ||
			(cp >= 0x1f300 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x2fffd) ||
			(cp >= 0x30000 && cp <= 0x3fffd)
		) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}

/** Pad a string to `width` display columns by appending spaces. */
function padToWidth(str: string, width: number): string {
	const dw = displayWidth(str);
	return dw >= width ? str : str + " ".repeat(width - dw);
}

/**
 * Truncate a string to at most `maxWidth` display columns. When truncated,
 * replaces the last character with `…` (U+2026, display width 1).
 * Uses codepoint iteration so surrogate pairs / emoji clusters are not split.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (displayWidth(str) <= maxWidth) return str;
	// Reserve 1 col for the ellipsis
	const target = maxWidth - 1;
	let w = 0;
	let out = "";
	for (const ch of str) {
		const cw = displayWidth(ch);
		if (w + cw > target) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** Split a `| a | b |` table row into trimmed cells (outer pipes dropped). */
function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").map((c) => c.trim());
}

/** A GFM table separator: contains a pipe and every cell is `:?-+:?`. */
function isTableSeparator(line: string): boolean {
	if (!line.includes("|")) return false;
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Compute the total display width a rendered table will occupy given column
 * widths. Formula: sum(widths) + (cols - 1) * 3  — the ` │ ` separator
 * between each pair of adjacent columns is 3 display columns.
 */
function tableLineWidth(widths: number[]): number {
	if (widths.length === 0) return 0;
	return widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * 3;
}

/**
 * Render a GFM pipe table as a column-aligned, bordered block (header bold),
 * constrained to `termWidth` terminal columns.
 *
 * Strategy:
 *   1. Compute natural content widths.
 *   2. If the table fits, render it as-is.
 *   3. If it overflows, shrink the widest columns first (proportional shrink)
 *      by iteratively capping the tallest column until the table fits or every
 *      column is at its minimum (1 col for content + ellipsis slot).
 *   4. If even a 1-col-per-column table is too wide (extremely many columns),
 *      fall back to a "label: value" list — one block per body row.
 */
function renderTable(
	header: string[],
	body: string[][],
	mode: ColorMode,
	termWidth: number,
): string[] {
	const cols = Math.max(header.length, ...body.map((r) => r.length), 1);
	// Natural content widths (minimum 1 so empty columns still render).
	const natural = Array.from({ length: cols }, (_, c) => {
		let w = displayWidth(header[c] ?? "");
		for (const r of body) w = Math.max(w, displayWidth(r[c] ?? ""));
		return Math.max(w, 1);
	});

	// Derive the fitted widths, shrinking proportionally if needed.
	const widths = fitTableWidths(natural, termWidth);

	// Fallback: too many columns even at width 1 → per-row label:value list.
	if (widths === null) {
		return renderTableAsList(header, body, mode);
	}

	const sep = dim(" │ ", mode);
	const row = (cells: string[], decorate: (s: string) => string) =>
		widths
			.map((w, c) =>
				decorate(padToWidth(truncateToWidth(cells[c] ?? "", w), w)),
			)
			.join(sep);
	return [
		row(header, (s) => bold(s, mode)),
		dim(widths.map((w) => "─".repeat(w)).join("─┼─"), mode),
		...body.map((r) => row(r, (s) => s)),
	];
}

/**
 * Given natural column widths and a terminal width budget, return fitted widths
 * that sum to ≤ termWidth (accounting for ` │ ` separators), or `null` if even
 * minimum-width columns exceed the budget.
 *
 * Algorithm: repeatedly cap the widest column down by 1 until the table fits.
 * This is O(cols × excess) but tables are small so it is fine.
 */
export function fitTableWidths(
	natural: number[],
	termWidth: number,
): number[] | null {
	if (natural.length === 0) return [];
	const w = natural.slice();
	// Fast path: already fits.
	if (tableLineWidth(w) <= termWidth) return w;
	// Check minimum: each column at width 1.
	const minWidth = tableLineWidth(w.map(() => 1));
	if (minWidth > termWidth) return null;
	// Iteratively shrink the widest column until the table fits.
	// To avoid O(n²) worst case we sort indices by width desc and walk.
	while (tableLineWidth(w) > termWidth) {
		const excess = tableLineWidth(w) - termWidth;
		// Find max width.
		let maxW = 0;
		for (const cw of w) if (cw > maxW) maxW = cw;
		// Budget we can trim across all columns at maxW simultaneously.
		const atMax = w.filter((cw) => cw === maxW).length;
		// How much can we drop maxW before it equals the next-highest value?
		const secondMax = w.reduce((m, cw) => (cw < maxW ? Math.max(m, cw) : m), 1);
		const dropToNext = maxW - secondMax; // columns at maxW can each lose this many
		const totalDropToNext = atMax * dropToNext;
		if (totalDropToNext >= excess) {
			// Distribute the trim evenly among the tallest columns.
			// Drop as little as possible: each of the atMax columns loses ⌈excess/atMax⌉.
			const perCol = Math.ceil(excess / atMax);
			for (let i = 0; i < w.length; i++) {
				if (w[i] === maxW) {
					w[i] = Math.max(1, (w[i] ?? 1) - perCol);
				}
			}
		} else {
			// Drop all maxW columns to secondMax.
			for (let i = 0; i < w.length; i++) {
				if (w[i] === maxW) {
					w[i] = secondMax;
				}
			}
		}
	}
	return w;
}

/**
 * Fallback render for tables too wide to display columnar at any width.
 * Produces one block per body row: `Header: cell` pairs, one per line,
 * separated by a blank line. Always readable regardless of terminal width.
 */
function renderTableAsList(
	header: string[],
	body: string[][],
	mode: ColorMode,
): string[] {
	const lines: string[] = [];
	for (let ri = 0; ri < body.length; ri++) {
		if (ri > 0) lines.push(""); // blank separator between rows
		const row = body[ri] ?? [];
		for (let ci = 0; ci < header.length; ci++) {
			const label = header[ci] ?? "";
			const value = row[ci] ?? "";
			lines.push(`${bold(label, mode)}: ${value}`);
		}
	}
	return lines;
}

/**
 * Render a markdown document to an ANSI string. Returns the original text
 * verbatim when color is disabled (so pipes / --json / NO_COLOR are untouched),
 * except code-fence markers are still stripped for readability.
 *
 * `termWidth` controls the maximum line width for table rendering. When omitted
 * it reads `process.stdout.columns` (defaulting to 80 when undefined or 0).
 * Pass an explicit value in tests to avoid TTY dependency.
 */
export function renderMarkdown(
	text: string,
	mode: ColorMode,
	termWidth?: number,
): string {
	if (!text) return text;
	// Color disabled (--json / NO_COLOR / non-TTY pipe) → return verbatim so
	// machine consumers and redirects see the raw markdown untransformed.
	if (!mode.enabled) return text;
	// Sanitize at the render boundary: strip terminal-injection vectors from
	// untrusted answer text before any parsing or TTY output.
	const safe = stripControlChars(text);
	const lines = safe.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let inCode = false;
	// Resolve terminal width once per render call (avoid repeated property reads).
	const tw =
		termWidth !== undefined && termWidth > 0
			? termWidth
			: (process.stdout.columns ?? 0) > 0
				? (process.stdout.columns ?? 80)
				: 80;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (FENCE_RE.test(line)) {
			// Frame the block: a labelled top border (with the language from the
			// info string) on open, a closing border on close. The ``` marker
			// line itself is replaced by the border.
			if (!inCode) {
				const lang = line.replace(FENCE_RE, "").trim();
				out.push(accentDim(lang ? `┌─ ${lang}` : "┌─", mode));
			} else {
				out.push(accentDim("└─", mode));
			}
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			// Preserve code verbatim behind a sage left gutter.
			out.push(`${accentDim("│", mode)} ${line}`);
			continue;
		}

		// GFM pipe table: a |-bearing header row immediately followed by a |---|
		// separator. Consume the whole block and render it column-aligned.
		if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
			const tableHeader = splitTableRow(line);
			const body: string[][] = [];
			let j = i + 2;
			while (
				j < lines.length &&
				(lines[j] ?? "").includes("|") &&
				!FENCE_RE.test(lines[j] ?? "")
			) {
				body.push(splitTableRow(lines[j] ?? ""));
				j++;
			}
			out.push(...renderTable(tableHeader, body, mode, tw));
			i = j - 1;
			continue;
		}

		const header = HEADER_RE.exec(line);
		if (header) {
			const level = (header[1] ?? "").length;
			const body = renderInline((header[2] ?? "").trim(), mode);
			// h1/h2 bold+underline, deeper headers just bold.
			out.push(
				level <= 2 ? bold(underline(body, mode), mode) : bold(body, mode),
			);
			continue;
		}

		if (HR_RE.test(line)) {
			out.push(dim("─".repeat(40), mode));
			continue;
		}

		const quote = QUOTE_RE.exec(line);
		if (quote) {
			out.push(
				`${dim("│", mode)} ${dim(renderInline(quote[1] ?? "", mode), mode)}`,
			);
			continue;
		}

		const bullet = BULLET_RE.exec(line);
		if (bullet) {
			out.push(
				`${bullet[1] ?? ""}${accentDim("•", mode)} ${renderInline(bullet[2] ?? "", mode)}`,
			);
			continue;
		}

		const numbered = NUMBERED_RE.exec(line);
		if (numbered) {
			out.push(
				`${numbered[1] ?? ""}${accentDim(`${numbered[2] ?? ""}.`, mode)} ${renderInline(numbered[3] ?? "", mode)}`,
			);
			continue;
		}

		out.push(renderInline(line, mode));
	}

	return out.join("\n");
}
