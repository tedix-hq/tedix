import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { slideElementGeometry } from "@tedix/api-contract/utils/presentation-style";
import {
	OS_SLIDE_MAX_X,
	OS_SLIDE_MAX_Y,
	OS_SLIDE_MIN_X,
	OS_SLIDE_MIN_Y,
} from "@tedix/api-contract/utils/os-output-limits";
import { createElement } from "../lib/slide-element-defaults";
import {
	normalizePresentationContent,
	projectDeck,
	type PresentationContent,
} from "../lib/output-models";

export { normalizePresentationContent, projectDeck };
export type { PresentationContent };

export type NewSlideLayout =
	| "title"
	| "title-content"
	| "two-column"
	| "four-card";

/** What the New slide menu offers, in order; the first is the button's default. */
export const NEW_SLIDE_LAYOUTS: Array<[NewSlideLayout, string]> = [
	["title-content", "Narrative"],
	["title", "Title"],
	["two-column", "Two columns"],
	["four-card", "Four columns"],
];

function block(
	type: OsPresentationElementType,
	box: Pick<OsPresentationElement, "x" | "y" | "width" | "height">,
	text: string,
	style: OsPresentationElement["style"],
): OsPresentationElement {
	return { ...createElement(type, 0), ...box, text, style };
}
const heading = (text: string) =>
	block("title", { x: 35, y: 76, width: 984, height: 80 }, text, {
		fontSize: 28,
		fontWeight: "semibold",
		color: "#000000",
		lineHeight: 1.2,
		letterSpacing: -0.8,
	});
const body = (
	box: Pick<OsPresentationElement, "x" | "y" | "width" | "height">,
	text: string,
	size = 19,
	weight?: "semibold",
) =>
	block("text", box, text, {
		fontSize: size,
		color: "#000000",
		lineHeight: weight ? 1.3 : 1.6,
		...(weight ? { fontWeight: weight } : {}),
	});

/** A new slide built from one of the layouts, with placeholder text to replace. */
export function newCanvasSlide(
	layout: NewSlideLayout = "title-content",
): OsPresentationCanvasSlide {
	const section = block(
		"sectionLabel",
		{ x: 36, y: 35, width: 240, height: 24 },
		"SECTION",
		{},
	);
	const elements: OsPresentationElement[] =
		layout === "title"
			? [
					block("title", { x: 33, y: 245, width: 760, height: 140 }, "Title", {
						fontSize: 58,
						fontWeight: "bold",
						color: "#171717",
						lineHeight: 1.1,
						letterSpacing: -1.7,
					}),
				]
			: layout === "two-column"
				? [
						section,
						heading("Compare two options side by side"),
						...[36, 609].flatMap((x) => [
							body(
								{ x, y: 204, width: 553, height: 32 },
								"Column heading",
								18,
								"semibold",
							),
							body(
								{ x, y: 252, width: 553, height: 160 },
								"Add concise supporting copy. Keep both columns parallel in structure and similar in length.",
							),
						]),
					]
				: layout === "four-card"
					? [
							section,
							heading("Four points worth remembering"),
							...[34, 328, 622, 916].flatMap((x, index) => [
								body(
									{ x, y: 194, width: 250, height: 40 },
									String(index + 1).padStart(2, "0"),
									28,
									"semibold",
								),
								body(
									{ x, y: 252, width: 250, height: 32 },
									"Point heading",
									18,
									"semibold",
								),
								body(
									{ x, y: 296, width: 250, height: 200 },
									"One or two sentences that explain this point.",
									17,
								),
							]),
						]
					: [
							section,
							heading("Write the headline as a specific assertion"),
							body(
								{ x: 36, y: 204, width: 760, height: 200 },
								"Replace this with one or two short paragraphs of supporting evidence. Keep body copy to roughly 40–60 words and leave generous white space on the right.",
							),
						];
	return {
		id: `slide-${crypto.randomUUID()}`,
		name: layout === "title" ? "Title" : "Untitled slide",
		layout,
		background: "#ffffff",
		elements,
	};
}

export function newSlideElement(
	type: OsPresentationElementType,
	count: number,
) {
	return createElement(type, count);
}

export function duplicateCanvasSlide(
	slide: OsPresentationCanvasSlide,
): OsPresentationCanvasSlide {
	const copy = structuredClone(slide);
	copy.id = `slide-${crypto.randomUUID()}`;
	copy.name = `${slide.name} copy`.slice(0, 200);
	copy.elements = copy.elements.map((element) => ({
		...element,
		id: `${element.type}-${crypto.randomUUID()}`,
	}));
	return copy;
}

export function updateElementGeometry(
	element: OsPresentationElement,
	changes: Partial<Pick<OsPresentationElement, "x" | "y" | "width" | "height">>,
) {
	const next = { ...element, ...changes };
	// Whole slide pixels, so dragged positions stay readable in the panel.
	// An element may bleed up to 100 slide pixels past the edges.
	next.x = Math.max(
		OS_SLIDE_MIN_X,
		Math.min(OS_SLIDE_MAX_X, Math.round(next.x)),
	);
	next.y = Math.max(
		OS_SLIDE_MIN_Y,
		Math.min(OS_SLIDE_MAX_Y, Math.round(next.y)),
	);
	next.width = Math.max(
		1,
		Math.min(OS_SLIDE_MAX_X - OS_SLIDE_MIN_X, Math.round(next.width)),
	);
	next.height = Math.max(
		1,
		Math.min(OS_SLIDE_MAX_Y - OS_SLIDE_MIN_Y, Math.round(next.height)),
	);
	return slideElementGeometry(element, next);
}

export function reorderSlide(
	deck: OsPresentationDeck,
	from: number,
	to: number,
) {
	if (
		from < 0 ||
		to < 0 ||
		from >= deck.slides.length ||
		to >= deck.slides.length
	)
		return deck;
	const slides = [...deck.slides];
	slides.splice(to, 0, slides.splice(from, 1)[0]!);
	return { ...deck, slides };
}
