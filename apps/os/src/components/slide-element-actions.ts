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
let clipboard: OsPresentationElement | null = null;

/** Empties the element clipboard; tests use it to start from a known state. */
export function clearSlideElementClipboard() {
	clipboard = null;
}

function offsetCopy(element: OsPresentationElement): OsPresentationElement {
	const copy = structuredClone(element);
	return {
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
	};
}

/**
 * Applies one element action to the slide. Returns the changed slide (null
 * when the slide is unchanged, as for copy) and the element to select, or
 * null when the action does not apply.
 */
export function applySlideElementAction(
	action: SlideElementAction,
	slide: OsPresentationCanvasSlide,
	selectedId: string | null,
): {
	slide: OsPresentationCanvasSlide | null;
	selectedId: string | null;
} | null {
	if (action === "paste") {
		if (!clipboard) return null;
		const pasted = offsetCopy(clipboard);
		return {
			slide: { ...slide, elements: [...slide.elements, pasted] },
			selectedId: pasted.id,
		};
	}
	const index = slide.elements.findIndex(
		(element) => element.id === selectedId,
	);
	const element = slide.elements[index];
	if (!element) return null;
	const without = slide.elements.filter((_, at) => at !== index);
	switch (action) {
		case "copy":
			clipboard = structuredClone(element);
			return { slide: null, selectedId: element.id };
		case "cut":
			clipboard = structuredClone(element);
			return { slide: { ...slide, elements: without }, selectedId: null };
		case "delete":
			return { slide: { ...slide, elements: without }, selectedId: null };
		case "duplicate": {
			const duplicate = offsetCopy(element);
			return {
				slide: { ...slide, elements: [...slide.elements, duplicate] },
				selectedId: duplicate.id,
			};
		}
		case "forward":
		case "backward": {
			// Z-order is array order: later elements paint on top.
			const target = index + (action === "forward" ? 1 : -1);
			if (target < 0 || target >= slide.elements.length) return null;
			without.splice(target, 0, element);
			return { slide: { ...slide, elements: without }, selectedId: element.id };
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
