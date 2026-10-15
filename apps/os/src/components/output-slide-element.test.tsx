import { slideElementStyle } from "@tedix/api-contract/utils/presentation-style";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import { setPresentationAppearance } from "@/lib/presentation-appearance";
import type { PresentationContent } from "@/lib/output-models";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { SlidesEditor } from "./output-editor-slides";
import { OutputContentView } from "./output-content";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional deck; the title is one of three stacked display lines, the shape
// that exposed the drift (positions scaled, type stayed at UI size).
const deck: PresentationContent = {
	kind: "presentation",
	slides: [{ title: "Your Next", bullets: [] }],
	deck: {
		width: 1200,
		height: 675,
		activeSlideId: "cover",
		slides: [
			{
				id: "cover",
				name: "Cover",
				layout: "blank",
				background: "#13172A",
				elements: [
					{
						id: "line-1",
						type: "title",
						x: 80,
						y: 158.75,
						width: 595,
						height: 130,
						text: "Your Next",
						style: { fontSize: 85, fontWeight: "bold", color: "#F4F1EA" },
					},
					{
						id: "card",
						type: "text",
						x: 600,
						y: 400,
						width: 500,
						height: 200,
						text: "Body copy that wraps",
						style: {
							fontSize: 22,
							borderWidth: 2,
							borderColor: "#DDD6C8",
							borderRadius: 24,
							textAlign: "center",
						},
					},
				],
			},
		],
	},
};

function mount(node: React.ReactNode) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(node));
	return {
		container,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const GEOMETRY = [
	"left",
	"top",
	"width",
	"height",
	"font-size",
	"line-height",
	"font-weight",
	"letter-spacing",
	"border-style",
	"border-radius",
	"text-align",
] as const;

/** Resolve an inline length on a canvas `canvasWidth` CSS pixels wide. */
function resolve(
	property: string,
	value: string,
	canvasWidth: number,
): number | string {
	const canvasHeight = (canvasWidth * 9) / 16;
	const percent = value.match(/^([\d.]+)%$/);
	if (percent)
		return (
			(Number(percent[1]) / 100) *
			(property === "top" || property === "height" ? canvasHeight : canvasWidth)
		);
	const cqw = value.match(/^calc\(([\d.]+) \* 100cqw \/ 1200\)$/);
	if (cqw) return (Number(cqw[1]) * canvasWidth) / 1200;
	return value;
}

function geometry(element: HTMLElement, canvasWidth: number) {
	return Object.fromEntries(
		GEOMETRY.map((property) => [
			property,
			resolve(property, element.style.getPropertyValue(property), canvasWidth),
		]),
	);
}

describe("one slide renderer", () => {
	it.each([
		[undefined, "#111111"],
		[
			{
				...DEFAULT_ORGANIZATION_OS_THEME,
				light: {
					...DEFAULT_ORGANIZATION_OS_THEME.light,
					foreground: "#223344",
				},
			},
			"#223344",
		],
		[
			{ ...DEFAULT_ORGANIZATION_OS_THEME, slideTones: { neutral: "#334455" } },
			"#334455",
		],
	])(
		"keeps slide text independent of dark app colours with theme %j",
		(appearance, expected) => {
			const light = structuredClone(deck);
			const slide = light.deck!.slides[0]!;
			slide.background = "#ffffff";
			delete slide.elements[0]!.style.color;
			slide.elements.push({
				...slide.elements[1]!,
				id: "bullets",
				type: "bullet",
				text: "One\nTwo",
				style: {},
			});
			slide.elements[1]!.style.color = "#cc3300";
			setPresentationAppearance({ appearance });
			const mounted = mount(
				<div className="dark" style={{ color: "#fafafa" }}>
					<SlidesEditor value={light} onChange={() => {}} />
					<SlidesEditor value={light} onChange={() => {}} disabled />
					<OutputContentView content={light} />
				</div>,
			);
			try {
				const canvases = mounted.container.querySelectorAll<HTMLElement>(
					".slides-editor-canvas, .slide-thumb-canvas, .deck-read-canvas, .deck-read-thumb-canvas",
				);
				expect(canvases.length).toBeGreaterThanOrEqual(4);
				for (const canvas of canvases) {
					expect(canvas.style.color).toBe(expected);
					for (const id of ["line-1", "bullets"]) {
						const element = canvas.querySelector<HTMLElement>(
							`[data-slide-element="${id}"]`,
						)!;
						expect(getComputedStyle(element).color).toBe(expected);
					}
					expect(
						canvas.querySelector<HTMLElement>('[data-slide-element="card"]')!
							.style.color,
					).toBe("#cc3300");
				}
			} finally {
				mounted.cleanup();
				setPresentationAppearance({});
			}
		},
	);

	it("gives the editor stage and the viewer the same element geometry at any scale", () => {
		const editor = mount(<SlidesEditor value={deck} onChange={() => {}} />);
		const viewer = mount(<OutputContentView content={deck} />);
		for (const id of ["line-1", "card"]) {
			const onStage = editor.container.querySelector<HTMLElement>(
				`.slides-editor-stage [data-slide-element="${id}"]`,
			);
			const inViewer = viewer.container.querySelector<HTMLElement>(
				`.deck-read-canvas [data-slide-element="${id}"]`,
			);
			expect(onStage).not.toBeNull();
			expect(inViewer).not.toBeNull();
			for (const canvasWidth of [1200, 620 * (16 / 9), 176]) {
				expect(geometry(onStage!, canvasWidth)).toEqual(
					geometry(inViewer!, canvasWidth),
				);
			}
		}
		// At a 600px canvas the 85px display line is 42.5px, not UI-sized.
		const title = editor.container.querySelector<HTMLElement>(
			'.slides-editor-stage [data-slide-element="line-1"]',
		)!;
		expect(geometry(title, 600)).toMatchObject({
			left: 40,
			top: 158.75 / 2,
			width: 297.5,
			"font-size": 42.5,
			"line-height": "1.1",
		});
		// The border scales with the canvas too, and is actually drawn. (The
		// width is read from the style object: happy-dom drops a `calc()`
		// border-width that browsers accept.)
		const card = editor.container.querySelector<HTMLElement>(
			'.slides-editor-stage [data-slide-element="card"]',
		)!;
		expect(geometry(card, 600)).toMatchObject({
			"border-style": "solid",
			"border-radius": 12,
		});
		const cardStyle = slideElementStyle(deck.deck!.slides[0]!.elements[1]!);
		expect(resolve("border-width", String(cardStyle.borderWidth), 600)).toBe(1);
		editor.cleanup();
		viewer.cleanup();
	});

	it("edits text in a bare textarea that inherits the element style", () => {
		const editor = mount(<SlidesEditor value={deck} onChange={() => {}} />);
		const input = editor.container.querySelector<HTMLTextAreaElement>(
			'.slides-editor-stage [data-slide-element="line-1"] textarea',
		);
		expect(input?.className).toBe("slide-element-input");
		// No Kumo type role: `type-tedix-body` forced a 14px size with !important.
		expect(input?.style.opacity).toBe("0");
		expect(input?.style.padding).toBe("inherit");
		editor.cleanup();
	});

	it("renders inline bold safely in the viewer and keeps raw markers in the editor", () => {
		const styled = structuredClone(deck);
		styled.deck!.slides[0]!.elements[0]!.text = "A **bold <tag>** title";
		styled.deck!.slides[0]!.elements.push({
			id: "arrow",
			type: "arrow",
			x: 50,
			y: 500,
			width: 200,
			height: 40,
			style: { color: "#ff0000", rotation: 15 },
		});
		const viewer = mount(<OutputContentView content={styled} />);
		const editor = mount(<SlidesEditor value={styled} onChange={() => {}} />);
		const presenter = mount(
			<SlidesEditor value={styled} onChange={() => {}} disabled />,
		);
		const title = viewer.container.querySelector(
			'[data-slide-element="line-1"]',
		);
		expect(title?.querySelector("strong")?.textContent).toBe("bold <tag>");
		expect(title?.querySelector("tag")).toBeNull();
		expect(
			editor.container.querySelector<HTMLTextAreaElement>(
				'.slides-editor-stage [data-slide-element="line-1"] textarea',
			)?.value,
		).toBe("A **bold <tag>** title");
		expect(
			viewer.container
				.querySelector('[data-slide-element="arrow"] path')
				?.getAttribute("d"),
		).toBe("M 2 20 H 198 M 180 2 L 198 20 L 180 38");
		for (const surface of [editor, presenter]) {
			const arrow = surface.container.querySelector(
				'.slides-editor-stage [data-slide-element="arrow"]',
			);
			expect(arrow?.querySelector("path")?.getAttribute("d")).toBe(
				"M 2 20 H 198 M 180 2 L 198 20 L 180 38",
			);
			expect(arrow?.querySelector("textarea")).toBeNull();
		}
		const presentedTitle = presenter.container.querySelector(
			'.slides-editor-stage [data-slide-element="line-1"]',
		);
		expect(presentedTitle?.querySelector("strong")?.textContent).toBe(
			"bold <tag>",
		);
		expect(presentedTitle?.querySelector("tag")).toBeNull();
		expect(presentedTitle?.querySelector("textarea")).toBeNull();
		presenter.cleanup();
		editor.cleanup();
		viewer.cleanup();
	});
});
