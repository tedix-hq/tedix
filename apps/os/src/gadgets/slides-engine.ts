import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import { slideElementGeometry } from "@tedix/api-contract/utils/presentation-style";
import { createElement } from "../lib/slide-element-defaults";
import {
	normalizePresentationContent,
	projectDeck,
	type PresentationContent,
} from "../lib/output-models";

export { normalizePresentationContent, projectDeck };
export type { PresentationContent };

export function newCanvasSlide(): OsPresentationCanvasSlide {
	const title = createElement("title", 0);
	title.text = "Untitled slide";
	return {
		id: `slide-${crypto.randomUUID()}`,
		name: "Untitled slide",
		layout: "title",
		background: "#ffffff",
		elements: [title],
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
	next.x = Math.max(0, Math.min(1200, next.x));
	next.y = Math.max(0, Math.min(675, next.y));
	next.width = Math.max(1, Math.min(1200, next.width));
	next.height = Math.max(1, Math.min(675, next.height));
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
