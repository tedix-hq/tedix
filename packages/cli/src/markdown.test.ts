import { describe, expect, it } from "bun:test";
import type { ColorMode } from "./terminal";
import {
	displayWidth,
	fitTableWidths,
	renderInline,
	renderMarkdown,
	truncateToWidth,
} from "./markdown";

const ON: ColorMode = { enabled: true };
const OFF: ColorMode = { enabled: false };

// Build the control-char matcher from escaped string fragments so this test
// contains no raw control bytes while still matching terminal ESC sequences.
const ESC_SRC = `${"\\u00"}1b`;
const SGR_RE = new RegExp(`${ESC_SRC}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(SGR_RE, "");

describe("renderInline", () => {
	it("renders inline code in cyan", () => {
		expect(renderInline("call `foo()` now", ON)).toBe(
			"call \x1b[36mfoo()\x1b[0m now",
		);
	});
	it("renders **bold** and *italic*", () => {
		expect(renderInline("**hi** and *lo*", ON)).toBe(
			"\x1b[1mhi\x1b[0m and \x1b[3mlo\x1b[0m",
		);
	});
	it("renders a link as label + dim url", () => {
		expect(renderInline("see [docs](https://x.dev)", ON)).toBe(
			"see docs \x1b[2m(https://x.dev)\x1b[0m",
		);
	});
	it("leaves bold markers inside inline code untouched", () => {
		// code captured first → the ** inside is not turned bold
		expect(renderInline("`a ** b`", ON)).toBe("\x1b[36ma ** b\x1b[0m");
	});
	it("passes plain text through unchanged", () => {
		expect(renderInline("just words", ON)).toBe("just words");
	});
});

describe("displayWidth", () => {
	it("ASCII chars are width 1", () => {
		expect(displayWidth("hello")).toBe(5);
	});

	it("CJK characters are width 2", () => {
		expect(displayWidth("日本語")).toBe(6);
	});

	it("emoji are width 2", () => {
		expect(displayWidth("🎉")).toBe(2);
	});

	it("mixed ASCII + CJK + emoji", () => {
		// "Hi" (2) + "日" (2) + "🎉" (2) = 6
		expect(displayWidth("Hi日🎉")).toBe(6);
	});

	it("combining marks are width 0", () => {
		// 'é' as 'e' + combining acute (U+0301): e=1, combining=0, total=1
		expect(displayWidth("é")).toBe(1);
	});

	it("zero-width joiner is width 0", () => {
		expect(displayWidth("‍")).toBe(0);
	});

	it("empty string is width 0", () => {
		expect(displayWidth("")).toBe(0);
	});
});

describe("renderInline — link with balanced parens", () => {
	it("renders a link whose URL contains balanced parens", () => {
		const result = renderInline(
			"[Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar))",
			OFF,
		);
		// Should contain the full URL including the balanced parens in the path
		expect(result).toContain("https://en.wikipedia.org/wiki/Foo_(bar)");
		// The label should appear
		expect(result).toContain("Wikipedia");
		// Output format: "Wikipedia (url)" — the whole thing is one match, no stray text
		expect(result).toBe("Wikipedia (https://en.wikipedia.org/wiki/Foo_(bar))");
	});

	it("still renders a plain link without parens", () => {
		const result = renderInline("[docs](https://x.dev)", OFF);
		expect(result).toContain("https://x.dev");
	});
});

describe("renderInline — intra-word italic/bold boundaries", () => {
	it("does NOT italicize underscores in snake_case identifiers", () => {
		const result = renderInline("file_name and another_var", ON);
		// No italic ANSI escape
		expect(result).not.toContain("\x1b[3m");
		expect(result).toContain("file_name");
	});

	it("does NOT render a*b as italic", () => {
		const result = renderInline("O(a*b) complexity", ON);
		expect(result).not.toContain("\x1b[3m");
	});

	it("DOES render *italic* when properly delimited", () => {
		const result = renderInline("this is *italic* text", ON);
		expect(result).toContain("\x1b[3m");
	});

	it("DOES render _italic_ when properly delimited", () => {
		const result = renderInline("this is _italic_ text", ON);
		expect(result).toContain("\x1b[3m");
	});
});

describe("renderMarkdown — terminal injection sanitization", () => {
	it("strips ANSI sequences from server text before rendering", () => {
		const injected = "\x1b[31mInjected\x1b[0m normal text";
		const result = renderMarkdown(injected, ON);
		// Injected raw ANSI should not appear verbatim (our own ANSI is ok)
		// Check that "Injected" appears without the surrounding raw injected codes
		expect(result).toContain("Injected");
		expect(result).toContain("normal text");
		// The raw injection code \x1b[31m should NOT appear in the output
		// (renderInline may add its own ANSI for formatting, but injected 31m is dropped)
		// We can verify by checking no 31m code remains
		expect(result).not.toMatch(new RegExp(`${ESC_SRC}\\[31m`));
	});

	it("strips OSC injection from server text", () => {
		const osc = "\x1b]0;malicious title\x07normal";
		const result = renderMarkdown(osc, ON);
		expect(result).not.toContain("malicious title");
		expect(result).toContain("normal");
	});
});

describe("renderMarkdown", () => {
	it("renders a GFM pipe table as an aligned block (not raw pipes)", () => {
		const md =
			"| Primitive | Use |\n|---|---|\n| DO | state |\n| Workflow | retries |";
		const out = renderMarkdown(md, ON);
		const plain = stripAnsi(out);
		// header cells padded to column width; separator turned into a rule, not `---`.
		expect(plain).toContain("Primitive │ Use");
		expect(plain).toContain("DO        │ state");
		expect(plain).not.toContain("|---|"); // raw separator gone
	});

	it("renders a GFM table with CJK content with correct column alignment", () => {
		// CJK chars are width-2 so column widths should account for that
		const md = "| Name | Value |\n|---|---|\n| 日本語 | ok |";
		const out = renderMarkdown(md, ON);
		const plain = stripAnsi(out);
		// "日本語" takes 6 display cols; "Name" takes 4 — column should be 6 wide
		// "ok" should be padded to match "Value" width (5)
		// Columns should be separated by │
		expect(plain).toContain("│");
		// "日本語" should appear in the output
		expect(plain).toContain("日本語");
		// Column separator should align: "Name  " (6 display cols) then " │ " then "Value"
		expect(plain).toContain("Name   │ Value");
	});

	it("renders headers, bullets, and numbered lists", () => {
		const md = "# Title\n- one\n- two\n1. first";
		const out = renderMarkdown(md, ON);
		expect(out).toContain("\x1b[1m"); // bold header
		// List markers are sage-dim (accentDim), not raw cyan.
		expect(out).not.toContain("\x1b[36m");
		expect(out).toContain("•");
		expect(out).toContain("1.");
		expect(out).toContain("one");
		expect(out).toContain("first");
	});

	it("frames code fences with a labelled border + gutter", () => {
		const md = "before\n```ts\nconst x = 1;\n```\nafter";
		const out = renderMarkdown(md, ON);
		expect(out).not.toContain("```");
		expect(out).toContain("const x = 1;"); // preserved verbatim
		expect(out).toContain("│"); // left gutter present
		expect(out).toContain("┌─ ts"); // labelled top border with the language
		expect(out).toContain("└─"); // closing border
	});

	it("does not treat ** inside a code block as bold", () => {
		const md = "```\na ** b\n```";
		expect(renderMarkdown(md, ON)).not.toContain("\x1b[1m");
	});

	it("renders blockquotes and horizontal rules", () => {
		const out = renderMarkdown("> quoted\n\n---", ON);
		expect(out).toContain("\x1b[2m│\x1b[0m"); // quote gutter
		expect(out).toContain("─".repeat(40));
	});

	it("with color disabled, returns the markdown completely verbatim (pipe-safe)", () => {
		const md = "# Title\n**bold** text\n```\ncode\n```";
		const out = renderMarkdown(md, OFF);
		expect(out).toBe(md); // no ANSI, no transformation at all
	});

	it("never throws on odd input and preserves empty string", () => {
		expect(renderMarkdown("", ON)).toBe("");
		expect(() => renderMarkdown("**unterminated\n`also", ON)).not.toThrow();
	});
});

// ── truncateToWidth ───────────────────────────────────────────────────────────

describe("truncateToWidth", () => {
	it("returns the string unchanged when it fits", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
		expect(truncateToWidth("hello", 5)).toBe("hello");
	});

	it("truncates with … when the string is too wide", () => {
		// "hello" = 5, max 4 → "hel…"
		expect(truncateToWidth("hello", 4)).toBe("hel…");
	});

	it("returns empty string for maxWidth ≤ 0", () => {
		expect(truncateToWidth("hello", 0)).toBe("");
		expect(truncateToWidth("hello", -1)).toBe("");
	});

	it("truncates to just '…' when maxWidth is 1", () => {
		// Only 1 col available: zero content cols + ellipsis
		expect(truncateToWidth("hi", 1)).toBe("…");
	});

	it("handles CJK characters (width 2) correctly", () => {
		// "日本語" = 6 display cols; max 5 → "日本…" (4+1=5)
		expect(truncateToWidth("日本語", 5)).toBe("日本…");
	});

	it("does not split a wide character mid-display", () => {
		// "A日B" = 1+2+1=4; max 3 → "A日" would be 3 but no room for …
		// target=2: "A"=1, adding "日"=2 would hit 3>2 → stop; out="A", result="A…"
		expect(truncateToWidth("A日B", 3)).toBe("A…");
	});
});

// ── fitTableWidths ────────────────────────────────────────────────────────────

describe("fitTableWidths", () => {
	it("returns natural widths when the table already fits", () => {
		// 3 cols of width 5: 5+3+5+3+5 = 21 ≤ 80
		const result = fitTableWidths([5, 5, 5], 80);
		expect(result).toEqual([5, 5, 5]);
	});

	it("returns null when the table cannot fit even at minimum width", () => {
		// 100 cols of width 1: 100 + 99*3 = 397 > 30
		const natural = Array.from({ length: 100 }, () => 1);
		expect(fitTableWidths(natural, 30)).toBeNull();
	});

	it("shrinks widths to fit within termWidth", () => {
		// 4 cols of natural width 20: 20+3+20+3+20+3+20 = 89 > 80
		// Should shrink so tableLineWidth ≤ 80
		const result = fitTableWidths([20, 20, 20, 20], 80);
		expect(result).not.toBeNull();
		if (result) {
			// Total: sum(widths) + 3*(cols-1) ≤ 80
			const total = result.reduce((s, w) => s + w, 0) + 3 * 3;
			expect(total).toBeLessThanOrEqual(80);
			// All widths ≥ 1
			for (const w of result) expect(w).toBeGreaterThanOrEqual(1);
		}
	});

	it("handles an empty natural array", () => {
		expect(fitTableWidths([], 80)).toEqual([]);
	});

	it("handles a single column that needs trimming", () => {
		// 1 col of width 100: just the col itself = 100 > 40
		const result = fitTableWidths([100], 40);
		expect(result).toEqual([40]);
	});
});

// ── renderMarkdown — wide table fitting ──────────────────────────────────────

describe("renderMarkdown — wide table fitting", () => {
	// CEO-style Gmail table: 4 wide columns typical of email list views
	const gmailTable = [
		"| Time | Sender | Subject | Snippet |",
		"|---|---|---|---|",
		"| 2024-01-15 10:23 | alice@example.com | Re: Q4 Budget Review — Final Numbers | Please find attached the final Q4 numbers for your review. |",
		"| 2024-01-14 09:11 | bob@company.org | Project Kickoff Meeting Tomorrow | Hi team, just a reminder that our kickoff meeting is scheduled |",
	].join("\n");

	it("renders a wide table within 80 columns (cell truncation with …)", () => {
		const out = renderMarkdown(gmailTable, ON, 80);
		const plain = stripAnsi(out);
		const lines = plain.split("\n");
		// Every rendered line must be ≤ 80 display columns.
		for (const line of lines) {
			expect(displayWidth(line)).toBeLessThanOrEqual(80);
		}
		// The header row must still contain the column names (possibly truncated).
		const headerLine = lines[0] ?? "";
		// All four column headers should appear (at least partially).
		expect(headerLine).toContain("Time");
		expect(headerLine).toContain("Sender");
		expect(headerLine).toContain("Subject");
		expect(headerLine).toContain("Snippet");
		// Columns must be separated by │.
		expect(headerLine).toContain("│");
		// The separator row (line 1) should contain ─ and no raw |---|.
		const sepLine = lines[1] ?? "";
		expect(sepLine).toContain("─");
		expect(sepLine).not.toContain("|---|");
	});

	it("truncated cells contain the ellipsis character", () => {
		const out = renderMarkdown(gmailTable, ON, 80);
		const plain = stripAnsi(out);
		// At 80 cols the long Snippet cells must be truncated.
		expect(plain).toContain("…");
	});

	it("columns are padded so │ separators align vertically", () => {
		const out = renderMarkdown(gmailTable, ON, 80);
		const plain = stripAnsi(out);
		const lines = plain.split("\n").filter((l) => l.includes("│"));
		// The first │ in every data/header line should be at the same column.
		const positions = lines.map((l) => l.indexOf("│"));
		const first = positions[0] ?? -1;
		for (const pos of positions) {
			expect(pos).toBe(first);
		}
	});

	it("falls back to label:value list when too many columns for the width", () => {
		// 20 columns, each with 5-char content; minimum table width = 20 + 19*3 = 77
		// but at termWidth=30 this cannot fit columnar.
		const headerCells = Array.from({ length: 20 }, (_, i) => `Col${i}`);
		const bodyCells = Array.from({ length: 20 }, (_, i) => `val${i}`);
		const md = [
			`| ${headerCells.join(" | ")} |`,
			`| ${headerCells.map(() => "---").join(" | ")} |`,
			`| ${bodyCells.join(" | ")} |`,
		].join("\n");
		const out = renderMarkdown(md, ON, 30);
		const plain = stripAnsi(out);
		// Should contain "Col0: val0" style pairs (label: value)
		expect(plain).toContain("Col0:");
		expect(plain).toContain("val0");
		// Should NOT contain raw |---| (no raw table)
		expect(plain).not.toContain("|---|");
		// Should NOT contain the wide aligned table format with ─┼─
		expect(plain).not.toMatch(/─┼─.*─┼─.*─┼─.*─┼─.*─┼─/);
	});

	it("non-table markdown is unaffected by termWidth parameter", () => {
		const md = "# Title\n- bullet one\n- bullet two";
		const out80 = renderMarkdown(md, ON, 80);
		const out40 = renderMarkdown(md, ON, 40);
		// Both should produce the same output (no table involved)
		expect(stripAnsi(out80)).toBe(stripAnsi(out40));
		expect(out80).toContain("\x1b[1m"); // bold header
	});

	it("small table that fits naturally renders at natural width (no truncation)", () => {
		const md = "| Name | Age |\n|---|---|\n| Alice | 30 |\n| Bob | 25 |";
		const out = renderMarkdown(md, ON, 80);
		const plain = stripAnsi(out);
		// No truncation expected — content fits easily.
		expect(plain).not.toContain("…");
		expect(plain).toContain("Alice");
		expect(plain).toContain("30");
	});

	it("color disabled: wide table is returned verbatim (pipe-safe for non-TTY)", () => {
		const out = renderMarkdown(gmailTable, OFF, 80);
		// mode.enabled === false → no transformation at all, raw markdown returned
		expect(out).toBe(gmailTable);
	});
});
