import { slideElementGeometry } from "@tedix/api-contract/utils/presentation-style";
import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	createOutputNodeId,
	PRESENTATION_HEIGHT,
	PRESENTATION_WIDTH,
} from "@/lib/output-models";

/** Copies and duplicates land this far from their source, in slide pixels. */
const PASTE_OFFSET = 24;

export type SlideElementAction =
	| "copy"
	| "cut"
	| "paste"
	| "duplicate"
	| "forward"
	| "backward"
	| "delete";

// In-memory and per tab: no cross-tab paste, nothing on the system clipboard.
let clipboard: OsPresentationElement[] = [];

/** Empties the element clipboard; tests use it to start from a known state. */
export function clearSlideElementClipboard() {
	clipboard = [];
}

function offsetCopy(element: OsPresentationElement): OsPresentationElement {
	const copy = structuredClone(element);
	return slideElementGeometry(copy, {
		...copy,
		id: createOutputNodeId(copy.type),
		x: Math.max(
			0,
			Math.min(PRESENTATION_WIDTH - copy.width, copy.x + PASTE_OFFSET),
		),
		y: Math.max(
			0,
			Math.min(PRESENTATION_HEIGHT - copy.height, copy.y + PASTE_OFFSET),
		),
	});
}

/**
 * Applies one element action to the selected elements. Returns the changed
 * slide (null when the slide is unchanged, as for copy) and the elements to
 * select, or null when the action does not apply. Layer order moves only a
 * single selected element.
 */
export function applySlideElementAction(
	action: SlideElementAction,
	slide: OsPresentationCanvasSlide,
	selectedIds: readonly string[],
): {
	slide: OsPresentationCanvasSlide | null;
	selectedIds: string[];
} | null {
	if (action === "paste") {
		if (!clipboard.length) return null;
		const pasted = clipboard.map(offsetCopy);
		// The next paste lands a step further along, not on top of this one.
		clipboard = structuredClone(pasted);
		return {
			slide: { ...slide, elements: [...slide.elements, ...pasted] },
			selectedIds: pasted.map((element) => element.id),
		};
	}
	const chosen = new Set(selectedIds);
	// Slide order, so copies keep which element paints on top.
	const elements = slide.elements.filter((element) => chosen.has(element.id));
	if (!elements.length) return null;
	const ids = elements.map((element) => element.id);
	const without = slide.elements.filter((element) => !chosen.has(element.id));
	switch (action) {
		case "copy":
			clipboard = structuredClone(elements);
			return { slide: null, selectedIds: ids };
		case "cut":
			clipboard = structuredClone(elements);
			return { slide: { ...slide, elements: without }, selectedIds: [] };
		case "delete":
			return { slide: { ...slide, elements: without }, selectedIds: [] };
		case "duplicate": {
			const copies = elements.map(offsetCopy);
			return {
				slide: { ...slide, elements: [...slide.elements, ...copies] },
				selectedIds: copies.map((element) => element.id),
			};
		}
		case "forward":
		case "backward": {
			const [element] = elements;
			if (elements.length !== 1 || !element) return null;
			// Z-order is array order: later elements paint on top.
			const index = slide.elements.indexOf(element);
			const target = index + (action === "forward" ? 1 : -1);
			if (target < 0 || target >= slide.elements.length) return null;
			without.splice(target, 0, element);
			return { slide: { ...slide, elements: without }, selectedIds: ids };
		}
	}
}

export type SlideAlignMode =
	| "left"
	| "center"
	| "right"
	| "top"
	| "middle"
	| "bottom"
	| "distribute-horizontal"
	| "distribute-vertical";

/**
 * Where each element goes to line the group up along one edge or centre of
 * the box around them all, or to space them evenly inside it. Distributing
 * needs three elements; the outermost ones stay put. Returns only the
 * elements that move.
 */
export function alignSlideElements(
	elements: readonly OsPresentationElement[],
	mode: SlideAlignMode,
): Array<{ id: string; x: number; y: number }> {
	if (elements.length < 2) return [];
	const left = Math.min(...elements.map((element) => element.x)),
		right = Math.max(...elements.map((element) => element.x + element.width)),
		top = Math.min(...elements.map((element) => element.y)),
		bottom = Math.max(...elements.map((element) => element.y + element.height));
	const next = new Map(
		elements.map((element) => [element.id, { x: element.x, y: element.y }]),
	);
	if (mode === "distribute-horizontal" || mode === "distribute-vertical") {
		if (elements.length < 3) return [];
		const across = mode === "distribute-horizontal";
		const size = (element: OsPresentationElement) =>
			across ? element.width : element.height;
		const sorted = [...elements].sort((a, b) =>
			across ? a.x - b.x : a.y - b.y,
		);
		const total = sorted.reduce((sum, element) => sum + size(element), 0);
		const gap =
			((across ? right - left : bottom - top) - total) / (sorted.length - 1);
		let cursor = across ? left : top;
		for (const element of sorted) {
			next.get(element.id)![across ? "x" : "y"] = Math.round(cursor);
			cursor += size(element) + gap;
		}
	} else
		for (const element of elements) {
			const place = next.get(element.id)!;
			if (mode === "left") place.x = left;
			else if (mode === "center")
				place.x = Math.round((left + right) / 2 - element.width / 2);
			else if (mode === "right") place.x = Math.round(right - element.width);
			else if (mode === "top") place.y = top;
			else if (mode === "middle")
				place.y = Math.round((top + bottom) / 2 - element.height / 2);
			else place.y = Math.round(bottom - element.height);
		}
	return elements.flatMap((element) => {
		const place = next.get(element.id)!;
		return place.x === element.x && place.y === element.y
			? []
			: [{ id: element.id, ...place }];
	});
}

const SHORTCUTS: Record<string, SlideElementAction | undefined> = {
	c: "copy",
	x: "cut",
	v: "paste",
	d: "duplicate",
};

/** Maps Cmd/Ctrl+C, X, V and D to their element action. */
export function slideElementShortcut(
	event: Pick<
		KeyboardEvent,
		"key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
	>,
): SlideElementAction | null {
	if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey)
		return null;
	return SHORTCUTS[event.key.toLowerCase()] ?? null;
}
