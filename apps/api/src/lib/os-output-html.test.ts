/**
 * Export HTML rendering: structural output per kind, escaping of every user
 * string, and self-containment (no external requests, no script).
 */

import { describe, expect, it } from "vite-plus/test";
import { escapeHtml, renderOsOutputHtml } from "./os-output-html";

const revisionMeta = { revision: 3, createdAt: "2026-08-13T00:00:00.000Z" };

describe("escapeHtml", () => {
	it("escapes every HTML-significant character and keeps the rest", () => {
		expect(escapeHtml(`<script>alert("x&y")</script> 'q'`)).toBe(
			"&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt; &#39;q&#39;",
		);
		expect(escapeHtml("plain text 123")).toBe("plain text 123");
	});
});

describe("renderOsOutputHtml", () => {
	it("renders a document as an article of semantic blocks", () => {
		const html = renderOsOutputHtml(
			{ kind: "document", title: "Launch brief" },
			{
				...revisionMeta,
				content: {
					kind: "document",
					blocks: [
						{ type: "heading", level: 2, text: "Plan" },
						{ type: "paragraph", text: "Ship it." },
						{ type: "list", ordered: true, items: ["one", "two"] },
						{ type: "code", language: "ts", text: "const a = 1 < 2;" },
						{ type: "quote", text: "Measure twice." },
					],
				},
			},
		);
		expect(html).toContain("<title>Launch brief</title>");
		expect(html).toContain("<article>");
		expect(html).toContain("<h2>Plan</h2>");
		expect(html).toContain("<p>Ship it.</p>");
		expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
		expect(html).toContain(
			'<pre><code data-language="ts">const a = 1 &lt; 2;</code></pre>',
		);
		expect(html).toContain("<blockquote><p>Measure twice.</p></blockquote>");
		expect(html).toContain("document — revision 3");
	});

	it("renders a sheet as a rectangular table with typed cells", () => {
		const html = renderOsOutputHtml(
			{ kind: "sheet", title: "Pipeline" },
			{
				...revisionMeta,
				content: {
					kind: "sheet",
					columns: ["Deal", "Value", "Won"],
					// The second row is ragged: it must be padded to the columns.
					rows: [
						["Acme", 1200, true],
						["Globex", null],
					],
				},
			},
		);
		expect(html).toContain(
			"<thead><tr><th>Deal</th><th>Value</th><th>Won</th></tr></thead>",
		);
		expect(html).toContain(
			'<tr><td>Acme</td><td class="num">1200</td><td>true</td></tr>',
		);
		expect(html).toContain("<tr><td>Globex</td><td></td><td></td></tr>");
	});

	it("renders a presentation as page-broken sections with notes", () => {
		const html = renderOsOutputHtml(
			{ kind: "presentation", title: "Board deck" },
			{
				...revisionMeta,
				content: {
					kind: "presentation",
					slides: [
						{ title: "Q3", bullets: ["Revenue", "Churn"], notes: "smile" },
						{ title: "Q4 plan", bullets: [] },
					],
				},
			},
		);
		expect(html).toContain('<section class="slide">');
		expect(html).toContain("<h2>Q3</h2>");
		expect(html).toContain("<ul><li>Revenue</li><li>Churn</li></ul>");
		expect(html).toContain('<aside class="notes">smile</aside>');
		expect(html).toContain("<h2>Q4 plan</h2>");
		expect(html).toContain("page-break-after: always");
	});

	it("renders rich documents, workbook tabs, and visual deck canvases", () => {
		const richDocument = renderOsOutputHtml(
			{ kind: "document", title: "Rich" },
			{
				...revisionMeta,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "Bold" }],
					richText: {
						type: "doc",
						content: [
							{
								type: "paragraph",
								content: [
									{ type: "text", text: "Bold", marks: [{ type: "bold" }] },
								],
							},
						],
					},
				},
			},
		);
		expect(richDocument).toContain("<p><strong>Bold</strong></p>");

		const workbook = renderOsOutputHtml(
			{ kind: "sheet", title: "Book" },
			{
				...revisionMeta,
				content: {
					kind: "sheet",
					columns: ["Value"],
					rows: [[42]],
					workbook: {
						activeSheetId: "s1",
						sheets: [
							{
								id: "s1",
								name: "Current",
								columns: [{ id: "c1", label: "Value", width: 120 }],
								rows: [
									[{ input: "=SUM(40,2)", value: 42, format: { bold: true } }],
								],
								frozenRows: 0,
								frozenColumns: 0,
							},
							{
								id: "s2",
								name: "Archive",
								columns: [{ id: "c2", label: "Old", width: 120 }],
								rows: [],
								frozenRows: 0,
								frozenColumns: 0,
							},
						],
					},
				},
			},
		);
		expect(workbook).toContain('<section class="sheet"><h2>Current</h2>');
		expect(workbook).toContain('<section class="sheet"><h2>Archive</h2>');
		expect(workbook).toContain("font-weight:700");

		const deck = renderOsOutputHtml(
			{ kind: "presentation", title: "Deck" },
			{
				...revisionMeta,
				content: {
					kind: "presentation",
					slides: [{ title: "Launch", bullets: [] }],
					deck: {
						width: 1200,
						height: 675,
						activeSlideId: "one",
						slides: [
							{
								id: "one",
								name: "Launch",
								layout: "title",
								background: "#ffffff",
								notes: "Pause",
								elements: [
									{
										id: "title",
										type: "title",
										x: 70,
										y: 50,
										width: 900,
										height: 100,
										text: "Launch",
										style: { fontSize: 48 },
									},
								],
							},
						],
					},
				},
			},
		);
		expect(deck).toContain('<section class="canvas-slide"');
		expect(deck).toContain("position:absolute;left:70px;top:50px");
		expect(deck).toContain('<aside class="notes">Pause</aside>');
	});

	it("escapes user text in every position, including title, cells, and bullets", () => {
		const hostile = `<img src=x onerror=alert(1)>`;
		const documentHtml = renderOsOutputHtml(
			{ kind: "document", title: hostile },
			{
				...revisionMeta,
				content: {
					kind: "document",
					blocks: [
						{ type: "paragraph", text: hostile },
						{ type: "code", language: `"><script>`, text: hostile },
					],
				},
			},
		);
		const sheetHtml = renderOsOutputHtml(
			{ kind: "sheet", title: "s" },
			{
				...revisionMeta,
				content: { kind: "sheet", columns: [hostile], rows: [[hostile]] },
			},
		);
		const presentationHtml = renderOsOutputHtml(
			{ kind: "presentation", title: "p" },
			{
				...revisionMeta,
				content: {
					kind: "presentation",
					slides: [{ title: hostile, bullets: [hostile], notes: hostile }],
				},
			},
		);
		for (const html of [documentHtml, sheetHtml, presentationHtml]) {
			expect(html).not.toContain(hostile);
			expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		}
	});

	it("is self-contained: no scripts and no external references", () => {
		const html = renderOsOutputHtml(
			{ kind: "document", title: "t" },
			{
				...revisionMeta,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "body" }],
				},
			},
		);
		expect(html).not.toContain("<script");
		expect(html).not.toContain("src=");
		expect(html).not.toContain("href=");
		expect(html).not.toContain("@import");
		expect(html).not.toContain("url(");
	});
});

it("exports rich links and styled resized images without external image requests", () => {
	const html = renderOsOutputHtml(
		{ kind: "document", title: "Books" },
		{
			...revisionMeta,
			content: {
				kind: "document",
				blocks: [],
				richText: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{
									type: "text",
									text: "Task",
									marks: [
										{
											type: "link",
											attrs: { href: "https://tedix.dev/task?a=1&b=2" },
										},
										{
											type: "textStyle",
											attrs: { fontSize: "20px", fontFamily: "Georgia, serif" },
										},
									],
								},
							],
						},
						{
							type: "image",
							attrs: {
								src: "data:image/png;base64,AAAA",
								width: 320,
								height: 160,
							},
						},
						{
							type: "image",
							attrs: { src: "https://example.com/private.png" },
						},
					],
				},
			},
		},
	);
	expect(html).toContain('href="https://tedix.dev/task?a=1&amp;b=2"');
	expect(html).toContain("font-size:20px");
	expect(html).toContain("font-family:Georgia, serif");
	expect(html).toContain('width="320" height="160"');
	expect(html).not.toContain('src="https:');
});
