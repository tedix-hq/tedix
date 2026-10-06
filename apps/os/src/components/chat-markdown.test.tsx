import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ChatMarkdown } from "./chat-markdown";

/**
 * These assert on RENDERED OUTPUT, never on the sanitizer's return value.
 *
 * The bug they exist for was invisible to a string-level test by construction:
 * `sanitizeUntrustedMarkdown` returned a clean string for every input below,
 * and the markdown parser then DECODED the character reference the sanitizer
 * had no way to see, putting a live control back into the DOM. Only the render
 * knows what the operator actually reads, so only the render can prove it.
 */

/** RIGHT-TO-LEFT OVERRIDE — reorders everything after it on screen. */
const RLO = "\u202E";
/** RIGHT-TO-LEFT / LEFT-TO-RIGHT ISOLATE and POP DIRECTIONAL ISOLATE. */
const RLI = "\u2067";
const PDI = "\u2069";
/** LEFT-TO-RIGHT MARK / RIGHT-TO-LEFT MARK — implicit, and just as reordering. */
const LRM = "\u200E";
const RLM = "\u200F";

/** Every control the module claims to remove, live rather than encoded. */
const LITERAL_CONTROLS = [
	"\u061C",
	LRM,
	RLM,
	"\u202A",
	"\u202B",
	"\u202C",
	"\u202D",
	RLO,
	"\u2066",
	RLI,
	"\u2068",
	PDI,
];

function render(content: string): string {
	return renderToStaticMarkup(<ChatMarkdown content={content} />);
}

describe("ChatMarkdown document flow", () => {
	it("uses normal Markdown whitespace for assistant prose", () => {
		const html = render("line one\nline two");
		expect(html).not.toContain("whitespace-pre-wrap");
		expect(html).toContain("line one\nline two");
	});

	it("preserves deliberate single newlines for user-authored turns", () => {
		const html = renderToStaticMarkup(
			<ChatMarkdown content={"line one\nline two"} preserveLineBreaks />,
		);
		expect(html).toContain("whitespace-pre-wrap");
	});

	it("renders lists, blockquotes, and responsive tables with readable chrome", () => {
		const html = render(
			[
				"> quoted result",
				"",
				"- first",
				"- second",
				"",
				"| Name | Value |",
				"| --- | --- |",
				"| Alpha | 42 |",
			].join("\n"),
		);
		expect(html).toContain("<blockquote");
		expect(html).toContain("list-disc");
		expect(html).toContain("overflow-x-auto");
		expect(html).toContain("<table");
	});

	it("renders GFM task lists as compact read-only controls", () => {
		const html = render("- [x] shipped\n- [ ] verify production");
		expect(html).toContain("list-none pl-0");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("accent-[var(--primary)]");
		expect(html).toContain("shipped");
		expect(html).toContain("verify production");
	});
});

describe("ChatMarkdown code blocks", () => {
	it("scrolls a long fenced line horizontally instead of clipping it", () => {
		const html = render(
			["```ts", `const veryLongIdentifier = ${"x".repeat(400)};`, "```"].join(
				"\n",
			),
		);
		expect(html).toContain('data-slot="chat-markdown-code"');
		expect(html).toContain("min-w-0 max-w-full overflow-x-auto");
		expect(html).toContain("[&amp;_pre]:overflow-x-auto");
		expect(html).toContain("[&amp;_pre]:whitespace-pre");
		expect(html).not.toContain("overflow-hidden");
		// The container itself can shrink inside a narrow (370px) pane.
		expect(html).toContain("chat-markdown min-w-0 max-w-full");
	});

	it("keeps an unlabelled fence a block with the same width contract", () => {
		const html = render(["```", "plain", "```"].join("\n"));
		expect(html).toContain('data-slot="chat-markdown-code"');
	});
});

describe("ChatMarkdown links", () => {
	it("opens https links in a new tab with rel=noopener", () => {
		const html = render("[docs](https://docs.tedix.dev/x)");
		expect(html).toContain('href="https://docs.tedix.dev/x"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('target="_blank"');
	});

	it("keeps same-origin routes navigable in place", () => {
		const html = render("[open](/workspace/abc)");
		expect(html).toContain('href="/workspace/abc"');
		expect(html).not.toContain('target="_blank"');
	});

	it("leaves http, javascript, and protocol-relative destinations as text", () => {
		for (const bad of ["http://x.com", "javascript:alert(1)", "//evil.com/x"]) {
			const html = render(`[click](${bad})`);
			expect(html, bad).not.toContain("<a");
			expect(html, bad).toContain("click");
		}
	});
});

describe("ChatMarkdown direction controls", () => {
	it("removes a LITERAL override from the rendered document", () => {
		const html = render(`report${RLO}txt.exe`);
		expect(html).not.toContain(RLO);
		expect(html).toContain("reporttxt.exe");
	});

	it("removes an ENCODED override the markdown parser would decode", () => {
		// The reviewer's exact case. `&#x202E;` survives the string sanitizer —
		// it contains no control — and the parser turns it into one.
		const html = render("report&#x202E;txt.exe");
		expect(html).not.toContain(RLO);
		expect(html).toContain("reporttxt.exe");
	});

	it("removes every SPELLING of that same override", () => {
		// Hex, uppercase `X`, uppercase hex digits, zero-padded, and decimal:
		// one control, five ways to write it. The defence is positional (strip
		// the decoded tree), so the list is a regression net, not the mechanism.
		for (const spelling of [
			"&#x202E;",
			"&#X202e;",
			"&#x202e;",
			"&#x0202E;",
			"&#x00202E;",
			"&#8238;",
			"&#08238;",
		]) {
			const html = render(`report${spelling}txt.exe`);
			expect(html, spelling).not.toContain(RLO);
			expect(html, spelling).toContain("reporttxt.exe");
		}
	});

	it("removes every ENCODED control, not only the override", () => {
		const encoded = [
			// Embeddings/overrides U+202A–U+202E, hex then decimal.
			["&#x202A;", "&#x202B;", "&#x202C;", "&#x202D;", "&#x202E;"],
			["&#8234;", "&#8235;", "&#8236;", "&#8237;", "&#8238;"],
			// Isolates U+2066–U+2069, hex then decimal.
			["&#x2066;", "&#x2067;", "&#x2068;", "&#x2069;"],
			["&#8294;", "&#8295;", "&#8296;", "&#8297;"],
			// Implicit marks: LRM, RLM, ALM.
			["&#x200E;", "&#x200F;", "&#x061C;"],
			["&#8206;", "&#8207;", "&#1564;"],
		].flat();
		for (const spelling of encoded) {
			const html = render(`a${spelling}b`);
			for (const control of LITERAL_CONTROLS) {
				expect(html, spelling).not.toContain(control);
			}
			expect(html, spelling).toContain("ab");
		}
	});

	it("removes an encoded control from a heading, a list item, and emphasis", () => {
		// Not just paragraph text: the strip walks the whole tree, so a control
		// cannot hide in a construct the render path handles elsewhere.
		const html = render(
			[
				"# head&#x202E;ing",
				"",
				"- item&#8238;one",
				"",
				"**bo&#x202E;ld**",
			].join("\n"),
		);
		expect(html).not.toContain(RLO);
		expect(html).toContain("heading");
		expect(html).toContain("itemone");
		expect(html).toContain("<strong>bold</strong>");
	});

	it("removes an encoded control from a link's text, and never renders one in a URL", () => {
		const html = render("[fi&#x202E;le](https://example.com/a&#x202E;b)");
		expect(html).not.toContain(RLO);
		// The visible half — the link TEXT — is stripped like any other text.
		expect(html).toContain(">file<");
		// The destination is percent-encoded by the parser before it is ever a
		// property, so the control cannot reach the document as a live character
		// there either; it stays an inert URL octet the operator never reads.
		expect(html).toContain("https://example.com/a%E2%80%AEb");
	});

	it("shows no live control in an autolinked URL, which IS read as text", () => {
		// A GFM autolink renders the destination as the link text too — the one
		// place a URL is something the operator reads. Character references are
		// not decoded inside an autolink literal, so the entity stays visibly
		// spelled out; either way nothing live reaches the document.
		const html = render("see https://example.com/a&#x202E;b now");
		expect(html).not.toContain(RLO);
		expect(html).toContain("https://example.com/a&amp;#x202E;b");
	});

	it("removes an encoded control from an inline code span and a fence", () => {
		const inline = render("`na&#x202E;me`");
		expect(inline).not.toContain(RLO);
		const fenced = render(["```ts", "const a&#x202E;b = 1;", "```"].join("\n"));
		expect(fenced).not.toContain(RLO);
	});

	it("leaves ordinary text — including RTL script and other entities — alone", () => {
		const html = render("send &amp; مرحبا &#8212; now");
		expect(html).toContain("مرحبا");
		// The em dash is an ordinary character reference and must still decode.
		expect(html).toContain("—");
		expect(html).toContain("&amp;");
	});

	it("keeps raw HTML inert and literal, encoded or not", () => {
		// `skipHtml` plus the pre-parse angle-bracket escaping; entity spellings
		// decode to TEXT nodes, which React escapes on the way out.
		const html = render("<img onerror=x> and &#60;img onerror=y&#62;");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img onerror=x&gt;");
		expect(html).toContain("&lt;img onerror=y&gt;");
	});
});
