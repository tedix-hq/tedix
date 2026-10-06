import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { OutputContentView } from "./output-content";

const deckContent: OsOutputContent = {
	kind: "presentation",
	slides: [{ title: "Launch", bullets: [], notes: "Pause" }],
	deck: {
		width: 1200,
		height: 675,
		activeSlideId: "slide-1",
		slides: [
			{
				id: "slide-1",
				name: "Launch",
				layout: "title",
				background: "#ffffff",
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
				notes: "Pause",
			},
			{
				id: "slide-2",
				name: "Roadmap",
				layout: "title",
				background: "#f5f5f5",
				elements: [],
			},
		],
	},
};

/** The `class` attribute of the single element carrying `className`. */
function classAttributeFor(html: string, className: string): string {
	const match = html.match(
		new RegExp(`class="([^"]*\\b${className}\\b[^"]*)"`, "g"),
	);
	expect(match, `no element carried .${className}`).not.toBeNull();
	expect(match).toHaveLength(1);
	return match![0];
}

describe("OutputContentView", () => {
	it("renders an authenticated native player for video outputs", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "video",
					renderId: "5860e069-c32c-4659-94b3-6169da778d2c",
					mimeType: "video/mp4",
					caption: "Acme candidate",
				}}
			/>,
		);
		expect(html).toContain("<video");
		expect(html).toContain('controls=""');
		expect(html).toContain('preload="metadata"');
		expect(html).toContain(
			"/api/video-renders/5860e069-c32c-4659-94b3-6169da778d2c/media",
		);
		expect(html).toContain("Acme candidate");
	});

	it("renders legacy document blocks through the rich document projection", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "document",
					blocks: [
						{ type: "heading", level: 2, text: "Launch" },
						{ type: "paragraph", text: "Ship the Tedix OS." },
						{ type: "list", ordered: true, items: ["Plan", "Do"] },
					],
				}}
			/>,
		);
		expect(html).toContain("<h2>Launch</h2>");
		expect(html).toContain("<p>Ship the Tedix OS.</p>");
		expect(html).toContain("<ol><li><p>Plan</p></li><li><p>Do</p></li></ol>");
	});

	it("renders persisted rich marks without injecting raw HTML", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "document",
					blocks: [{ type: "paragraph", text: "Safe" }],
					richText: {
						type: "doc",
						content: [
							{
								type: "paragraph",
								content: [
									{ type: "text", text: "Bold", marks: [{ type: "bold" }] },
									{ type: "text", text: " <script>alert(1)</script>" },
								],
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain("<strong>Bold</strong>");
		expect(html).toContain('data-kumo-part="document-paper"');
		expect(html).toContain("bg-(--tedix-document-paper)");
		expect(html).toContain("text-(--tedix-document-ink)");
		expect(html).not.toContain("bg-white");
		expect(html).not.toContain("text-slate");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("uses compact document paper spacing and heading scales on phones", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "document",
					blocks: [{ type: "heading", level: 1, text: "Phone-safe" }],
				}}
			/>,
		);

		// Page margins, not card padding: the document renders as a page on a
		// desk, so the vertical inset is deliberately larger than the horizontal
		// one and matches the editing surface.
		expect(html).toContain("px-4 py-8");
		expect(html).toContain("sm:px-10 sm:py-10");
		expect(html).toContain("[&amp;_h1]:text-[26px]");
		expect(html).toContain("[&amp;_h2]:text-[21px]");
	});

	it("renders a multi-sheet workbook with cached values and formatting", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "sheet",
					columns: ["Amount"],
					rows: [[3]],
					workbook: {
						activeSheetId: "s1",
						sheets: [
							{
								id: "s1",
								name: "Pipeline",
								columns: [{ id: "c1", label: "Amount", width: 140 }],
								rows: [
									[{ input: "=SUM(1,2)", value: 3, format: { bold: true } }],
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
				}}
			/>,
		);
		expect(html).toContain("Amount");
		expect(html).toContain(">3</td>");
		expect(html).toContain("Pipeline");
		expect(html).toContain("Archive");
	});

	it("renders the visual deck canvas and speaker notes", () => {
		const html = renderToStaticMarkup(
			<OutputContentView content={deckContent} />,
		);
		expect(html).toContain("Launch");
		expect(html).toContain("Notes: Pause");
		// The canvas is fitted by `.deck-read-canvas` inside `.deck-read-stage`,
		// not by a width-driven `aspect-video` utility.
		expect(html).toContain("deck-read-stage");
		expect(html).toContain("deck-read-canvas");
		expect(html).toContain("container-type:inline-size");
		expect(html).toContain("font-size:calc(48 * 100cqw / 1200)");
		expect(html).toContain("padding:0");
		expect(html).toContain('data-kumo-component="Button"');
		expect(html).not.toContain("border-blue-");
	});

	it("fits the deck canvas to both axes of its stage instead of driving it by width", () => {
		const html = renderToStaticMarkup(
			<OutputContentView content={deckContent} />,
		);
		const canvasClass = classAttributeFor(html, "deck-read-canvas");

		// `w-full` + `aspect-video` fixes width and derives height, so the slide
		// overflows a short container. Both must be gone from the canvas.
		expect(canvasClass).not.toContain("aspect-video");
		expect(canvasClass).not.toContain("w-full");
		// The editor canvas dropped its drop shadow; the read view matches.
		expect(canvasClass).not.toMatch(/\bshadow-/);

		const styles = readFileSync("src/styles.css", "utf8");
		const stage = styles.slice(
			styles.indexOf(".deck-read-stage {"),
			styles.indexOf("}", styles.indexOf(".deck-read-stage {")),
		);
		const canvas = styles.slice(
			styles.indexOf(".deck-read-canvas {"),
			styles.indexOf("}", styles.indexOf(".deck-read-canvas {")),
		);
		// The stage must be a size container, or `100cqh` below resolves against
		// nothing and the height bound silently stops applying.
		expect(stage).toContain("container-type: size");
		// A definite height is required: Chrome resolves cqh to 0 when a size
		// container has an indefinite block size, collapsing the canvas.
		// This test checks CSS structure only. The DOM test environment performs
		// no layout or container-query evaluation; rendered size needs a browser.
		expect(stage).toMatch(/(?<!-)\bheight:/);
		expect(
			stage,
			"a min-height cannot size a `container-type: size` stage: cqh resolves to 0",
		).not.toMatch(/\bmin-height:/);
		// Bounded on BOTH axes at exactly 16:9.
		expect(canvas).toContain("width: min(100cqw, 100cqh * 16 / 9)");
		expect(canvas).toContain("aspect-ratio: 16 / 9");
		// Radius is deliberately owned by the markup while the "artifact surfaces
		// are square" question is open; this rule must stay neutral on it.
		expect(canvas).not.toContain("border-radius");
	});

	it("keeps the deck rail keyboard-operable and marks the active slide", () => {
		const html = renderToStaticMarkup(
			<OutputContentView content={deckContent} />,
		);
		expect(html).toContain('aria-current="true"');
		expect((html.match(/aria-current="true"/g) ?? []).length).toBe(1);
		expect(html).toContain("Roadmap");
	});

	it("gives the committed sheet the same page grammar as the sheet editor", () => {
		// Reading a sheet used to look nothing like editing one: a shell-themed
		// `rounded-xl border bg-kumo-base` card in the read view against a square
		// white page on a recessed desk in the editor. Both lanes share
		// `.sheet-page` now, so the fixed-light scope and page chrome are declared
		// once.
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "sheet",
					columns: ["Amount"],
					rows: [[3]],
					workbook: {
						activeSheetId: "s1",
						sheets: [
							{
								id: "s1",
								name: "Pipeline",
								columns: [{ id: "c1", label: "Amount", width: 140 }],
								rows: [[{ input: "3", value: 3 }]],
								frozenRows: 0,
								frozenColumns: 0,
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain("sheet-read-desk");
		expect(html).toContain("sheet-page sheet-read-page");
		expect(html).not.toContain("rounded-xl border border-kumo-line");
		const css = readFileSync("src/styles.css", "utf8");
		const page = css.match(/^\.sheet-page \{[^}]*\}/m)?.[0] ?? "";
		expect(page).toContain("color-scheme: light");
		expect(page).toContain("var(--tedix-sheet-paper)");
		expect(page).toContain("border-radius: 0");
		// The desk must resolve OUTSIDE that light scope or --tedix-desk takes its
		// light branch and the recess disappears in a dark shell.
		const desk = css.match(/^\.sheet-read-desk \{[^}]*\}/m)?.[0] ?? "";
		expect(desk).toContain("var(--tedix-desk)");
		expect(desk).not.toContain("color-scheme");
	});

	it("renders the deck rail as slide previews, not a list of names", () => {
		const html = renderToStaticMarkup(
			<OutputContentView content={deckContent} />,
		);
		// Real miniatures via the shared ReadOnlyElement renderer, so there is no
		// second slide renderer to drift. One canvas per slide plus the main one.
		const thumbs = html.split("deck-read-thumb-canvas").length - 1;
		expect(thumbs).toBe(2);
		// Slide text appears in the previews, not only in the main canvas.
		expect(html.split("Roadmap").length - 1).toBeGreaterThan(1);
		// Still a Kumo Button, still keyboard-operable, still marks the current
		// slide -- the editor rail uses the same adapter.
		expect(html).toContain('data-kumo-component="Button"');
		expect(html.split('aria-current="true"').length - 1).toBe(1);
		const css = readFileSync("src/styles.css", "utf8");
		const thumb = css.match(/^\.deck-read-thumb-canvas \{[^}]*\}/m)?.[0] ?? "";
		// ReadOnlyElement sizes type in cqw against a 1200px reference, so the
		// thumbnail must be its own inline-size container or the text renders at
		// the main canvas's scale.
		expect(thumb).toContain("container-type: inline-size");
		expect(thumb).toContain("aspect-ratio: 16 / 9");
	});
});
