import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect } from "vite-plus/test";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import { setPresentationAppearance } from "@/lib/presentation-appearance";
import { SlidesEditor } from "./output-editor-slides";
import { OutputContentView } from "./output-content";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const base = { x: 50, y: 100, width: 300, height: 200, style: {} };
const content = OsOutputContentSchema.parse({
	kind: "presentation",
	slides: [],
	deck: {
		activeSlideId: "s",
		theme: {
			headingFont: "Space Grotesk, sans-serif",
			bodyFont: "Inter, sans-serif",
		},
		slides: [
			{
				id: "s",
				name: "Slide",
				backgroundImage: "https://example.org/cover.png",
				dotGridOpacity: 0.25,
				insetSurface: {},
				elements: [
					{
						...base,
						id: "heading",
						type: "title",
						text: "Deck title",
						style: { fontWeight: "light", letterSpacing: 2 },
					},
					{
						...base,
						id: "card",
						type: "card",
						props: {
							eyebrow: "EYEBROW",
							title: "**Key** title",
							body: "Safe <copy>",
							tone: "success",
							highlight: ["Key"],
						},
					},
					{
						...base,
						id: "box",
						type: "box",
						props: { title: "Box", body: "Body", dashed: true },
					},
					{
						...base,
						id: "bullet",
						type: "bullet",
						text: "First wrapped item\nSecond item",
					},
					{
						...base,
						id: "arrow",
						type: "arrow",
						props: {
							from: { x: 600, y: 400 },
							to: { x: 300, y: 200 },
							label: "Flow",
							dashed: true,
							strokeWidth: 3,
						},
					},
					{
						...base,
						id: "pill",
						type: "label",
						text: "LABEL",
						props: { tone: "accent" },
					},
					{ ...base, id: "ellipse", type: "shape", props: { kind: "ellipse" } },
					{ ...base, id: "logo", type: "logo" },
				],
			},
		],
	},
});

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

it("renders every parity feature identically on the editable stage, viewer and thumbnails", () => {
	if (content.kind !== "presentation") throw new Error("fixture");
	setPresentationAppearance({
		name: "Example Studio",
		appearance: {
			...DEFAULT_ORGANIZATION_OS_THEME,
			slideTones: { success: "#116633" },
		},
	});
	const stage = mount(<SlidesEditor value={content} onChange={() => {}} />);
	const viewer = mount(<OutputContentView content={content} />);
	try {
		for (const element of content.deck!.slides[0]!.elements) {
			const expected = viewer.container.querySelector<HTMLElement>(
				`.deck-read-canvas [data-slide-element="${element.id}"]`,
			)!;
			for (const surface of [
				stage.container.querySelector<HTMLElement>(
					`.slides-editor-stage [data-slide-element="${element.id}"]`,
				)!,
				viewer.container.querySelector<HTMLElement>(
					`.deck-read-thumb-canvas [data-slide-element="${element.id}"]`,
				)!,
			]) {
				expect(surface.style.cssText).toBe(expected.style.cssText);
				expect(surface.querySelector(":scope > div")?.innerHTML).toBe(
					expected.querySelector(":scope > div")?.innerHTML,
				);
			}
		}
		const canvas = stage.container.querySelector(".slides-editor-stage")!;
		const heading = canvas.querySelector<HTMLElement>(
			'[data-slide-element="heading"]',
		)!;
		expect(heading.style.fontFamily).toBe('"Space Grotesk", sans-serif');
		expect(heading.style.fontWeight).toBe("300");
		expect(heading.style.letterSpacing).toContain("100cqw");
		expect(
			canvas.querySelector<HTMLElement>('[data-slide-element="bullet"]')!.style
				.fontFamily,
		).toBe("Inter, sans-serif");
		expect(
			canvas.querySelector('[data-slide-part="eyebrow"]')?.textContent,
		).toBe("EYEBROW");
		expect(
			canvas.querySelector('[data-slide-part="title"] strong')?.textContent,
		).toBe("Key");
		expect(canvas.querySelector('[data-slide-part="body"]')?.textContent).toBe(
			"Safe <copy>",
		);
		expect(canvas.querySelectorAll('[role="listitem"]')).toHaveLength(2);
		expect(
			canvas
				.querySelector('[data-slide-element="arrow"] path')
				?.getAttribute("stroke-dasharray"),
		).toBe("6 6");
		expect(
			canvas.querySelector('[data-slide-element="arrow"] text')?.textContent,
		).toBe("Flow");
		expect(
			canvas.querySelector('[data-slide-element="logo"]')?.textContent,
		).toBe("Example Studio");
		expect(
			canvas.querySelector<HTMLElement>('[data-slide-element="ellipse"]')?.style
				.borderRadius,
		).toBe("50%");
		expect(
			canvas.querySelectorAll('[data-slide-background="dots"]'),
		).toHaveLength(1);
		expect(
			canvas.querySelector('[data-slide-background="inset"]'),
		).not.toBeNull();
	} finally {
		stage.cleanup();
		viewer.cleanup();
		setPresentationAppearance({});
	}
});
