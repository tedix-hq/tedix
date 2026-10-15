/**
 * Export HTML rendering: structural output per kind, escaping of every user
 * string, allowlisted resources, and readiness before capture.
 */

import { runInNewContext } from "node:vm";
import {
	OsOutputContentSchema,
	type OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { slideElementStyle } from "@tedix/api-contract/utils/presentation-style";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	escapeHtml,
	renderOsOutputHtml,
	OS_EXPORT_RESOURCE_WAIT,
} from "./os-output-html";

const revisionMeta = { revision: 3, createdAt: "2026-08-13T00:00:00.000Z" };

describe("export resource loading", () => {
	it("allows CMS raster assets and font hosts, rejecting arbitrary hosts and paths", () => {
		const allowed = (url: string) =>
			OS_EXPORT_RESOURCE_WAIT.allowRequestPattern.some((pattern) =>
				new RegExp(pattern).test(url),
			);
		expect(
			allowed("https://tedix.dev/_emdash/api/media/file/example.png"),
		).toBe(true);
		expect(allowed("https://fonts.googleapis.com/css2?family=DM+Sans")).toBe(
			true,
		);
		expect(allowed("https://fonts.gstatic.com/s/dmsans/v1/font.woff2")).toBe(
			true,
		);
		for (const url of [
			"http://127.0.0.1/a.png",
			"https://tedix.dev.evil.test/_emdash/api/media/file/a.png",
			"https://tedix.dev/_emdash/api/media/file/a.svg",
			"https://tedix.dev/admin",
			"https://fonts.gstatic.com.evil.test/font.woff2",
			"https://tedix.dev/_emdash/api/media/file/a.png?redirect=http://localhost",
		])
			expect(allowed(url)).toBe(false);
	});

	it.each(["success", "image failure", "font failure"])(
		"waits for page load, font readiness and image decoding: %s",
		async (outcome) => {
			let loaded!: () => void;
			let fontsReady!: () => void;
			let decoded!: () => void;
			let failed!: (error: Error) => void;
			const fonts = Object.assign(
				[{ status: outcome === "font failure" ? "error" : "loaded" }],
				{
					ready: new Promise<void>((resolve) => {
						fontsReady = resolve;
					}),
				},
			);
			const decode = vi.fn(
				() =>
					new Promise<void>((resolve, reject) => {
						decoded = resolve;
						failed = reject;
					}),
			);
			const document = {
				readyState: "loading",
				querySelectorAll: () => [],
				fonts,
				images: [{ decode }],
				body: { getBoundingClientRect: vi.fn() },
				documentElement: { dataset: {} as Record<string, string> },
			};
			const result = runInNewContext(
				OS_EXPORT_RESOURCE_WAIT.addScriptTag[0]!.content,
				{
					document,
					window: {
						addEventListener: (_: string, callback: () => void) => {
							loaded = callback;
						},
					},
				},
			);
			expect(decode).not.toHaveBeenCalled();
			loaded();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(decode).toHaveBeenCalledOnce();
			fontsReady();
			await Promise.resolve();
			expect(document.documentElement.dataset.exportReady).toBeUndefined();
			if (outcome === "image failure") failed(new Error("broken image"));
			else decoded();
			await result;
			expect(document.documentElement.dataset.exportReady).toBe(
				outcome === "success" ? "true" : undefined,
			);
			expect(OS_EXPORT_RESOURCE_WAIT.waitForSelector.timeout).toBe(20_000);
		},
	);

	it("renders allowlisted remote images and loads declared webfonts", () => {
		const html = renderOsOutputHtml(
			{ kind: "document", title: "Resources" },
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
										text: "Hello",
										marks: [
											{
												type: "textStyle",
												attrs: { fontFamily: "DM Sans, sans-serif" },
											},
										],
									},
								],
							},
							{
								type: "image",
								attrs: {
									src: "https://tedix.dev/_emdash/api/media/file/example.png",
								},
							},
							{ type: "image", attrs: { src: "http://127.0.0.1/private.png" } },
						],
					},
				},
			},
		);
		expect(html).toContain(
			'<img src="https://tedix.dev/_emdash/api/media/file/example.png"',
		);
		expect(html).toContain(
			"https://fonts.googleapis.com/css2?family=DM+Sans:wght@400",
		);
		expect(html).not.toContain("private.png");
	});
});

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

	it("renders audience slides at 16:9 without document chrome or speaker notes", () => {
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
		expect(html).not.toContain("smile");
		expect(html).not.toContain('<header class="export-header">');
		expect(html).not.toContain('class="slide-number"');
		expect(html).toContain("@page { size: 1200px 675px; margin: 0; }");
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
										style: { fontSize: 48, fontFamily: "Georgia, serif" },
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
		expect(deck).toContain("font-family:Georgia, serif");
		expect(deck).not.toContain("Pause");
		expect(deck).not.toContain('<header class="export-header">');
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

it.each([
	["Raleway", "font-family:Raleway", "Raleway"],
	["DM Mono", "font-family:DM Mono", "DM+Mono"],
	[
		'"Lexend", sans-serif',
		"font-family:&quot;Lexend&quot;, sans-serif",
		"Lexend",
	],
	["A".repeat(40), `font-family:${"A".repeat(40)}`, "A".repeat(40)],
	["A".repeat(41), `font-family:${"A".repeat(41)}`, null],
	["Font-Name", "font-family:Font-Name", null],
	["Arial, system-ui", "font-family:Arial, system-ui", null],
	["DM Sans, sans-serif", "font-family:DM Sans, sans-serif", "DM+Sans"],
	["Space Grotesk", "font-family:Space Grotesk", "Space+Grotesk"],
	[
		"'Times New Roman', serif",
		"font-family:&#39;Times New Roman&#39;, serif",
		null,
	],
	["serif; background:url(https://example.com)", null, null],
	['serif"><img src=x onerror=alert(1)>', null, null],
] as const)(
	"validates presentation font CSS: %s",
	(fontFamily, expected, webfont) => {
		const html = renderOsOutputHtml(
			{ kind: "presentation", title: "Fonts" },
			{
				...revisionMeta,
				content: {
					kind: "presentation",
					slides: [],
					deck: {
						width: 1200,
						height: 675,
						activeSlideId: "one",
						slides: [
							{
								id: "one",
								name: "Font",
								layout: "blank",
								background: "#ff6633",
								elements: [
									{
										id: "text",
										type: "text",
										x: 0,
										y: 0,
										width: 1200,
										height: 675,
										text: "Hello",
										style: { fontFamily },
									},
								],
							},
						],
					},
				},
			},
		);
		if (expected) expect(html).toContain(expected);
		else expect(html).not.toContain(`font-family:${fontFamily}`);
		if (webfont)
			expect(html).toContain(
				`href="https://fonts.googleapis.com/css2?family=${webfont}:wght@400&amp;display=block"`,
			);
		else expect(html).not.toContain('rel="stylesheet"');
		expect(html).not.toContain("https://example.com");
		expect(html).not.toContain("<img");
		expect(html).toContain('style="background:#ff6633"');
	},
);

it("deduplicates families, merges declared weights in order, and caps a deck at six families", () => {
	const families = [
		"DM Mono",
		"Lexend",
		"dm mono",
		"Lexend",
		"Lexend",
		"Oswald",
		"Roboto",
		"Lora",
		"Anton",
		"Bitter",
	];
	const weights = ["bold", "semibold", "normal", "medium", "normal"] as const;
	const html = renderOsOutputHtml(
		{ kind: "presentation", title: "Fonts" },
		{
			...revisionMeta,
			content: {
				kind: "presentation",
				slides: [],
				deck: {
					width: 1200,
					height: 675,
					activeSlideId: "one",
					slides: [
						{
							id: "one",
							name: "Fonts",
							layout: "blank",
							background: "#ffffff",
							elements: families.map((fontFamily, index) => ({
								id: String(index),
								type: "text",
								text: fontFamily,
								x: 0,
								y: index * 40,
								width: 600,
								height: 40,
								style: { fontFamily, fontWeight: weights[index] ?? "normal" },
							})),
						},
					],
				},
			},
		},
	);
	expect(html.match(/rel="stylesheet"/g)).toHaveLength(6);
	expect(html).toContain('family=DM+Mono:wght@400;700&amp;display=block"');
	expect(html).toContain('family=Lexend:wght@400;500;600&amp;display=block"');
	expect(html).toContain(
		'data-export-font-fallback="https://fonts.googleapis.com/css2?family=Lexend&amp;display=block"',
	);
	expect(html).not.toContain("family=Bitter");
});

it.each(["load", "error"])(
	"retries a failed weighted stylesheet once and waits for fonts after fallback: %s",
	async (outcome) => {
		const listeners: Record<string, () => void> = {};
		const link = {
			sheet: null,
			dataset: {
				exportFontFallback:
					"https://fonts.googleapis.com/css2?family=DM+Mono&display=block",
			},
			href: "https://fonts.googleapis.com/css2?family=DM+Mono:wght@600&display=block",
			addEventListener: vi.fn((event: string, callback: () => void) => {
				listeners[event] = callback;
			}),
		};
		const loaded = { sheet: {}, addEventListener: vi.fn() };
		let ready!: () => void;
		const document = {
			readyState: "complete",
			querySelectorAll: () => [link, loaded],
			fonts: Object.assign([], {
				ready: new Promise<void>((resolve) => {
					ready = resolve;
				}),
			}),
			images: [],
			body: { getBoundingClientRect: vi.fn() },
			documentElement: { dataset: {} as Record<string, string> },
		};
		const result = runInNewContext(
			OS_EXPORT_RESOURCE_WAIT.addScriptTag[0]!.content,
			{ document },
		);
		expect(link.href).toBe(link.dataset.exportFontFallback);
		expect(loaded.addEventListener).not.toHaveBeenCalled();
		expect(document.body.getBoundingClientRect).not.toHaveBeenCalled();
		listeners[outcome]!();
		await Promise.resolve();
		await Promise.resolve();
		expect(document.documentElement.dataset.exportReady).toBeUndefined();
		ready();
		await result;
		expect(link.addEventListener).toHaveBeenCalledTimes(2);
		expect(document.documentElement.dataset.exportReady).toBe("true");
	},
);

it.each([
	"radial-gradient(ellipse at center, #FFF45C 0%, transparent 70%)",
	"linear-gradient(90deg, #fff, rgba(255, 244, 92, 0))",
])("serializes the viewer gradient and opacity: %s", (background) => {
	const element: OsPresentationElement = {
		id: "glow",
		type: "shape",
		x: 40,
		y: 50,
		width: 400,
		height: 400,
		style: { background, opacity: 0.9 },
	};
	const content = OsOutputContentSchema.parse({
		kind: "presentation",
		slides: [],
		deck: {
			width: 1200,
			height: 675,
			activeSlideId: "one",
			slides: [
				{
					id: "one",
					name: "Glow",
					layout: "blank",
					background: "#121212",
					notes: "",
					elements: [element],
				},
			],
		},
	});
	const html = renderOsOutputHtml(
		{ kind: "presentation", title: "Glow" },
		{ ...revisionMeta, content },
	);
	expect(slideElementStyle(element).background).toBe(background);
	expect(html).toContain(`background:${background}`);
	expect(html).toContain("opacity:0.9");
	expect(html).toContain("padding:0");
});

it.each([
	"red;position:fixed",
	"url(https://example.com/a)",
	'image-set("https://example.com/a" 1x)',
	"u\\72l(https://example.com/a)",
	"</style><script>alert(1)</script>",
])("rejects CSS declaration and resource injection: %s", (background) => {
	const content = {
		kind: "presentation" as const,
		slides: [],
		deck: {
			width: 1200 as const,
			height: 675 as const,
			activeSlideId: "one",
			slides: [
				{
					id: "one",
					name: "Safe",
					layout: "blank" as const,
					background: "#fff",
					notes: "",
					elements: [
						{
							id: "shape",
							type: "shape" as const,
							x: 0,
							y: 0,
							width: 100,
							height: 100,
							style: { background },
						},
					],
				},
			],
		},
	};
	const html = renderOsOutputHtml(
		{ kind: "presentation", title: "Safe" },
		{ ...revisionMeta, content },
	);
	expect(html).not.toContain(background);
});
