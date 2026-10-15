import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { slideElementMarkup } from "@tedix/api-contract/utils/presentation-style";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderOsDocumentMarkdown } from "./os-output-markdown";
import { renderOsOutputHtml } from "./os-output-html";
import { buildOsSheetCsv } from "./os-output-csv";
import { buildPptx } from "./ooxml/pptx";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const text = (
	value: string,
	marks?: OsRichTextNode["marks"],
): OsRichTextNode => ({ type: "text", text: value, marks });
const paragraph = (...content: OsRichTextNode[]): OsRichTextNode => ({
	type: "paragraph",
	content,
});
const rich: Extract<OsOutputContent, { kind: "document" }> = {
	kind: "document",
	blocks: [{ type: "paragraph", text: "stale projection" }],
	richText: {
		type: "doc",
		content: [
			{ type: "heading", attrs: { level: 3 }, content: [text("Plan")] },
			paragraph(
				text("Bold", [{ type: "bold" }]),
				text("Italic", [{ type: "italic" }]),
				text("Strike", [{ type: "strike" }]),
				{ type: "hardBreak" },
				text("inline `code`", [{ type: "code" }]),
			),
			paragraph(
				text("Link", [
					{ type: "link", attrs: { href: "https://example.test/?a=1&b=2" } },
				]),
			),
			paragraph(
				text("Styled", [
					{ type: "underline" },
					{ type: "highlight", attrs: { color: "#ffee00" } },
					{
						type: "textStyle",
						attrs: {
							fontFamily: "Georgia",
							fontSize: "20px",
							color: "#123456",
						},
					},
				]),
			),
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [
							paragraph(text("First")),
							{
								type: "orderedList",
								attrs: { start: 4 },
								content: [
									{ type: "listItem", content: [paragraph(text("Nested"))] },
								],
							},
						],
					},
				],
			},
			{ type: "blockquote", content: [paragraph(text("Quote"))] },
			{
				type: "codeBlock",
				attrs: { language: "ts" },
				content: [text("const x = `a`;\n```", [{ type: "bold" }])],
			},
			{ type: "horizontalRule" },
			{
				type: "image",
				attrs: {
					src: `data:image/png;base64,${png}`,
					alt: 'Proof "image"',
					width: 120,
					height: 80,
				},
			},
		],
	},
};

describe("portable document exports", () => {
	it("retains rich nodes and marks in Markdown rather than the semantic projection", () => {
		const md = renderOsDocumentMarkdown(rich);
		for (const value of [
			"### Plan",
			"**Bold**",
			"*Italic*",
			"~~Strike~~",
			"  \n",
			"`` inline `code` ``",
			"[Link](<https://example.test/?a=1&b=2>)",
			"<u>Styled</u>",
			"<mark",
			"font-size:20px",
			"- First",
			"  4. Nested",
			"> Quote",
			"````ts\nconst x = `a`;\n```\n````",
			"---",
			"<img",
			'width="120"',
		])
			expect(md).toContain(value);
		expect(md).not.toContain("stale projection");
	});
	it("retains rich nodes, links, styles and image dimensions in HTML", () => {
		const html = renderOsOutputHtml(
			{ kind: "document", title: "Plan" },
			{ revision: 1, createdAt: "2026-10-15", content: rich },
		);
		for (const value of [
			"<h3>Plan</h3>",
			"<strong>Bold</strong>",
			"<em>Italic</em>",
			"<s>Strike</s>",
			"<br>",
			'<ol start="4">',
			"<blockquote>",
			"<pre><code>",
			"<hr>",
			'alt="Proof &quot;image&quot;"',
			'height="80"',
		])
			expect(html).toContain(value);
		expect(html).not.toContain("stale projection");
	});
	it("escapes HTML and Markdown and rejects executable links and image URLs", () => {
		const content = {
			...rich,
			richText: {
				type: "doc" as const,
				content: [
					paragraph(
						text("<script>*x*", [
							{ type: "link", attrs: { href: "javascript:alert(1)" } },
						]),
					),
					{ type: "image", attrs: { src: "javascript:alert(2)" } },
				],
			},
		};
		expect(renderOsDocumentMarkdown(content)).toContain("\\<script\\>\\*x\\*");
		expect(renderOsDocumentMarkdown(content)).not.toContain("javascript:");
		const html = renderOsOutputHtml(
			{ kind: "document", title: "Safe" },
			{ revision: 1, createdAt: "today", content },
		);
		expect(html).toContain("&lt;script&gt;*x*");
		expect(html).not.toContain("javascript:");
	});
	it("exports every semantic fallback block when richText is absent", () => {
		expect(
			renderOsDocumentMarkdown({
				kind: "document",
				blocks: [
					{ type: "heading", level: 1, text: "Title" },
					{ type: "paragraph", text: "Body" },
					{ type: "quote", text: "One\nTwo" },
					{ type: "list", ordered: true, items: ["A", "B"] },
					{ type: "code", language: "js", text: "let a=1" },
				],
			}),
		).toBe(
			"# Title\n\nBody\n\n> One\n> Two\n\n1. A\n2. B\n\n```js\nlet a=1\n```\n",
		);
	});
});

describe("CSV exports", () => {
	it("writes RFC4180 quoting, Unicode, empty cells, booleans and CRLF", async () => {
		const result = await buildOsSheetCsv({
			kind: "sheet",
			columns: ["Name", "Value", "Empty"],
			rows: [
				["Café, Inc", 'a"b\nc', null],
				[true, 42, ""],
			],
		});
		expect(result.extension).toBe("csv");
		expect(strFromU8(result.bytes)).toBe(
			'Name,Value,Empty\r\n"Café, Inc","a""b\nc",\r\ntrue,42,\r\n',
		);
	});
	it("exports all sheets, cached values and unique safe filenames in one ZIP", async () => {
		const result = await buildOsSheetCsv({
			kind: "sheet",
			columns: ["stale"],
			rows: [],
			workbook: {
				activeSheetId: "b",
				sheets: ["a", "b"].map((id, index) => ({
					id,
					name: "../Duplicate",
					columns: [{ id: "c", label: "Total", width: 120 }],
					rows: [[{ input: "=SUM(1,2)", value: 3 + index }]],
					frozenRows: 0,
					frozenColumns: 0,
				})),
			},
		});
		expect(result.extension).toBe("zip");
		const files = unzipSync(result.bytes);
		expect(Object.keys(files)).toEqual([
			"1-___Duplicate.csv",
			"2-___Duplicate.csv",
		]);
		expect(Object.values(files).map((bytes) => strFromU8(bytes))).toEqual([
			"Total\r\n3\r\n",
			"Total\r\n4\r\n",
		]);
	});
});

function deck(
	srcs: string[],
): Extract<OsOutputContent, { kind: "presentation" }> {
	return {
		kind: "presentation",
		slides: [],
		deck: {
			width: 1200,
			height: 675,
			activeSlideId: "s",
			slides: [
				{
					id: "s",
					name: "Proof",
					layout: "blank",
					background: "#ffffff",
					elements: srcs.map((src, index) => ({
						id: `i${index}`,
						type: src.includes("svg+xml") ? "svg" : "image",
						x: 20,
						y: 30,
						width: 200,
						height: 100,
						style: { rotation: 15 },
						src,
					})),
				},
			],
		},
	};
}
describe("PPTX images", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("fetches public raster images through the guarded loader and deduplicates requests", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
				{ headers: { "content-type": "image/png" } },
			),
		);
		vi.stubGlobal("fetch", fetch);
		const files = unzipSync(
			await buildPptx(
				deck([
					"https://example.test/image.png",
					"https://example.test/image.png",
				]),
			),
		);
		expect(files["ppt/media/image1.png"]).toBeDefined();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects private network images before fetching", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			buildPptx(deck(["https://127.0.0.1/image.png"])),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("embeds deduplicated PNG and JPEG with resolvable relationships and contained dimensions", async () => {
		// A minimal JPEG SOF header carries a 2x1 frame for geometry validation.
		const jpeg = btoa(
			String.fromCharCode(
				255,
				216,
				255,
				192,
				0,
				17,
				8,
				0,
				1,
				0,
				2,
				3,
				1,
				17,
				0,
				2,
				17,
				0,
				3,
				17,
				0,
				255,
				217,
			),
		);
		const files = unzipSync(
			await buildPptx(
				deck([
					`data:image/png;base64,${png}`,
					`data:image/jpeg;base64,${jpeg}`,
					`data:image/png;base64,${png}`,
				]),
			),
		);
		expect(
			Object.keys(files).filter((name) => name.startsWith("ppt/media/")),
		).toEqual(["ppt/media/image1.png", "ppt/media/image2.jpeg"]);
		expect(files["ppt/media/image1.png"]).toEqual(
			Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
		);
		const xml = strFromU8(files["ppt/slides/slide1.xml"]!);
		expect(xml.match(/<p:pic>/g)).toHaveLength(3);
		expect(xml).toContain('x="711200" y="304800"');
		expect(xml).toContain('cx="1016000" cy="1016000"');
		expect(xml).toContain('rot="900000"');
		const rels = strFromU8(files["ppt/slides/_rels/slide1.xml.rels"]!);
		expect(rels).toContain('Id="image2"');
		expect(rels).toContain('Target="../media/image1.png"');
		expect(strFromU8(files["[Content_Types].xml"]!)).toContain(
			'ContentType="image/jpeg"',
		);
	});
	it("adds an explicit omission note for SVG artwork", async () => {
		const files = unzipSync(
			await buildPptx(deck(["data:image/svg+xml;base64,PHN2Zy8+"])),
		);
		expect(strFromU8(files["export-notes.txt"]!)).toContain(
			"SVG elements were omitted",
		);
	});
	it("rejects invalid raster bytes instead of silently dropping images", async () => {
		await expect(
			buildPptx(deck(["data:image/png;base64,YmFk"])),
		).rejects.toThrow("Invalid PPTX image bytes");
	});
});

describe("PPTX bullet parity", () => {
	it.each([false, true])(
		"matches trimmed screen items and hanging spacing (compact=%s)",
		async (compact) => {
			const content = deck([]);
			const bullet = {
				id: "bullets",
				type: "bullet" as const,
				x: 20,
				y: 30,
				width: 800,
				height: 300,
				style: {},
				props: { compact },
				text: "  First  \n\n   Second   \n",
			};
			content.deck!.slides[0]!.elements.push(bullet, {
				...bullet,
				id: "plain",
				type: "text",
				text: "  preserve spaces  ",
			});
			const screen = slideElementMarkup(bullet, "pixels");
			expect(screen.match(/role="listitem"/g)).toHaveLength(2);
			expect(screen).toContain(">First</div>");
			expect(screen).toContain(">Second</div>");
			const files = unzipSync(await buildPptx(content));
			const xml = strFromU8(files["ppt/slides/slide1.xml"]!);
			expect(
				[...xml.matchAll(/<a:t(?: [^>]*)?>(.*?)<\/a:t>/g)].map(
					(match) => match[1],
				),
			).toEqual(["First", "Second", "  preserve spaces  "]);
			expect(xml).toContain('marL="182880" indent="-182880"');
			expect(xml).toContain(`<a:spcPts val="${compact ? 640 : 800}"/>`);
			expect(xml).toContain(`<a:spcPct val="${compact ? 145000 : 150000}"/>`);
		},
	);
});
