import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
	it("does not call an uploaded file an empty document", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "document",
					file: {
						workspaceId: "00000001-0000-4000-8000-000000000001",
						resourceId: "00000002-0000-4000-8000-000000000002",
					},
					blocks: [],
				}}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("Loading file");
		expect(html).not.toContain("This document is empty");
		expect(html).not.toContain("Start writing");
	});

	it("keeps the writing prompt for a document without a file", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{ kind: "document", blocks: [] }}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("This document is empty");
		expect(html).toContain("Start writing");
	});

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

	it("shows the Title style and block indents the editor saved", () => {
		const html = renderToStaticMarkup(
			<OutputContentView
				content={{
					kind: "document",
					blocks: [],
					richText: {
						type: "doc",
						content: [
							{
								type: "heading",
								attrs: { level: 1, variant: "title" },
								content: [{ type: "text", text: "Plan" }],
							},
							{
								type: "paragraph",
								attrs: { indent: 3 },
								content: [{ type: "text", text: "Nested" }],
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain('<h1 class="doc-title">Plan</h1>');
		expect(html).toContain('<p style="margin-left:120px">Nested</p>');
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
		// one, on phones and wider screens alike. The page and its typography
		// live in the editor stylesheet, shared with the editing surface.
		expect(html).toContain("document-read-page");
		expect(html).toContain("document-prose");
		const css = readFileSync("src/components/output-editor.css", "utf8");
		const page = [
			...css.matchAll(/\.document-read-page \{[^}]*padding: (\d+)px (\d+)px/g),
		].map((match) => [Number(match[1]), Number(match[2])]);
		expect(page).toHaveLength(2);
		for (const [vertical, horizontal] of page)
			expect(vertical).toBeGreaterThan(horizontal!);
		expect(css).toMatch(/\.document-prose h1 \{[^}]*font-size: 28px/);
		expect(css).toMatch(/\.document-prose h2 \{[^}]*font-size: 22px/);
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

	it("hugs the slide at 16:9 instead of letterboxing it in a fixed-height stage", () => {
		const html = renderToStaticMarkup(
			<OutputContentView content={deckContent} />,
		);
		const canvasClass = classAttributeFor(html, "deck-read-canvas");

		// Sizing is owned by `.deck-read-canvas`, not Tailwind utilities.
		expect(canvasClass).not.toContain("aspect-video");
		expect(canvasClass).not.toContain("w-full");
		// The editor canvas dropped its drop shadow; the read view matches.
		expect(canvasClass).not.toMatch(/\bshadow-/);

		const styles = readFileSync("src/components/output-editor.css", "utf8");
		const rule = (selector: string) => {
			const start = styles.indexOf(`${selector} {`);
			return styles.slice(start, styles.indexOf("}", start));
		};
		const root = rule(".deck-read");
		const stage = rule(".deck-read-stage,\n.deck-read-footer");
		const canvas = rule(".deck-read-canvas");
		// A fixed-height size-container stage letterboxed the slide with empty
		// space above and below it. The stage must take its height from the slide.
		expect(styles).not.toMatch(/\.deck-read-stage \{[^}]*\bheight:/);
		expect(styles).not.toMatch(/\.deck-read-stage \{[^}]*container-type: size/);
		// Width is bounded by the column and by a viewport-height budget, so a
		// short window still shows the whole slide; Notes and Present share it.
		expect(root).toMatch(
			/--deck-read-width: min\(100%, .*100dvh.* \* 16 \/ 9\)/,
		);
		expect(stage).toContain("width: var(--deck-read-width)");
		expect(canvas).toContain("width: 100%");
		expect(canvas).toContain("aspect-ratio: 16 / 9");
		// The rail must not set the row height: it scrolls inside the slide's.
		expect(styles).toMatch(/\.deck-read-rail \{[^}]*contain: size/);
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
		const css = readFileSync("src/components/output-editor.css", "utf8");
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
		const css = readFileSync("src/components/output-editor.css", "utf8");
		const thumb = css.match(/^\.deck-read-thumb-canvas \{[^}]*\}/m)?.[0] ?? "";
		// ReadOnlyElement sizes type in cqw against a 1200px reference, so the
		// thumbnail must be its own inline-size container or the text renders at
		// the main canvas's scale.
		expect(thumb).toContain("container-type: inline-size");
		expect(thumb).toContain("aspect-ratio: 16 / 9");
	});
});

describe("deck read view keys", () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;

	function mount(onEdit?: () => void) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() =>
			root.render(<OutputContentView content={deckContent} onEdit={onEdit} />),
		);
		return {
			container,
			cleanup: () => {
				act(() => root.unmount());
				container.remove();
			},
		};
	}
	const press = (key: string, target: EventTarget = document.body) =>
		act(() => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
			);
		});
	const current = (container: HTMLElement) =>
		container
			.querySelector('.deck-read-thumb[aria-current="true"]')
			?.getAttribute("aria-label");
	const presenter = () =>
		document.querySelector<HTMLElement>('[aria-label="Presentation mode"]');

	it("browses slides, presents with F and opens the editor with E", () => {
		let edits = 0;
		const mounted = mount(() => {
			edits += 1;
		});
		press("ArrowRight");
		expect(current(mounted.container)).toBe("Slide 2: Roadmap");
		press("Home");
		expect(current(mounted.container)).toBe("Slide 1: Launch");
		press(" ");
		expect(current(mounted.container)).toBe("Slide 2: Roadmap");
		// Typing in a field keeps its keys.
		const input = document.createElement("input");
		document.body.appendChild(input);
		press("ArrowLeft", input);
		expect(current(mounted.container)).toBe("Slide 2: Roadmap");
		input.remove();
		press("e");
		expect(edits).toBe(1);
		press("f");
		expect(presenter()?.textContent).toContain("2 / 2");
		// Present mode navigates and leaves on Escape.
		press("ArrowLeft", presenter()!);
		expect(presenter()?.textContent).toContain("1 / 2");
		// A jump-menu pick unmounts the focused button, leaving focus on the
		// body; present mode still owns the keys.
		act(() =>
			presenter()!
				.querySelector<HTMLButtonElement>('[aria-label="Jump to slide"]')!
				.click(),
		);
		act(() =>
			presenter()!
				.querySelector<HTMLButtonElement>('[aria-label="Slide 2: Roadmap"]')!
				.click(),
		);
		press("ArrowLeft");
		expect(presenter()?.textContent).toContain("1 / 2");
		press("Escape");
		expect(presenter()).toBeNull();
		expect(current(mounted.container)).toBe("Slide 1: Launch");
		mounted.cleanup();
	});

	it("ignores E when there is no editor to open", () => {
		const mounted = mount();
		press("e");
		expect(presenter()).toBeNull();
		mounted.cleanup();
	});
});

it("names read-only checklist items from their visible task text across outputs", () => {
	const content: OsOutputContent = {
		kind: "document",
		blocks: [
			{
				type: "checklist",
				items: [
					{ text: "Review **proposal**", checked: true },
					{ text: "Contact [supplier](https://example.test)", checked: false },
				],
			},
		],
	};
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		<>
			<OutputContentView content={content} />
			<OutputContentView content={content} />
		</>,
	);
	const checkboxes = Array.from(
		container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
	);
	expect(checkboxes).toHaveLength(4);
	const labelIds = checkboxes.map((checkbox) => {
		// A native checkbox has no readonly state: it must be disabled so it
		// leaves the tab order and is not presented as operable.
		expect(checkbox.readOnly).toBe(true);
		expect(checkbox.disabled).toBe(true);
		expect(checkbox.hasAttribute("aria-label")).toBe(false);
		const labelId = checkbox.getAttribute("aria-labelledby");
		expect(labelId).toBeTruthy();
		return labelId!;
	});
	expect(new Set(labelIds).size).toBe(4);
	expect(
		labelIds.map((id) => container.querySelector(`[id="${id}"]`)?.textContent),
	).toEqual([
		"Review proposal",
		"Contact supplier",
		"Review proposal",
		"Contact supplier",
	]);
	expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([
		true,
		false,
		true,
		false,
	]);
});

it("renders structured tables, task lists, callouts and toggles", () => {
	const html = renderToStaticMarkup(
		<OutputContentView
			content={{
				kind: "document",
				blocks: [
					{
						type: "table",
						headers: ["Name", "Goal"],
						rows: [["**Factory**", "[Ship](https://example.test)"]],
						widths: [160, 240],
						align: ["left", "right"],
					},
					{ type: "checklist", items: [{ text: "Review", checked: true }] },
					{ type: "callout", text: "Note" },
					{ type: "toggle", summary: "More", text: "Details" },
				],
			}}
		/>,
	);
	expect(html).toContain("<thead>");
	expect(html).toContain('<th scope="col"');
	expect(html).toContain("<strong>Factory</strong>");
	expect(html).toContain("width:160px");
	expect(html).toContain("text-align:right");
	expect(html).toContain('class="document-table-scroll"');
	expect(html).toContain("<details>");
	expect(html).toContain("<summary>More</summary>");
	expect(html).toContain('type="checkbox"');
	expect(html).toContain('data-type="callout"');
});
