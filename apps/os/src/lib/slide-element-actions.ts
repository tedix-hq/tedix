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
