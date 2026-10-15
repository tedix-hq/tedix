import type { PresentationContent } from "@/lib/output-models";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SlidesEditor } from "./output-editor-slides";
import { clearSlideElementClipboard } from "./slide-element-actions";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initial = (): PresentationContent => ({
	kind: "presentation",
	slides: [
		{ title: "Q3", bullets: ["Revenue", "Costs"] },
		{ title: "Q4", bullets: [] },
	],
});

let mounted: ReturnType<typeof mountEditor>;

function mountEditor() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const emitted: PresentationContent[] = [];
	function Harness() {
		const [value, setValue] = useState(initial);
		return (
			<SlidesEditor
				value={value}
				onChange={(next) => {
					emitted.push(next);
					setValue(next);
				}}
			/>
		);
	}
	act(() => root.render(<Harness />));
	const query = <T extends Element>(selector: string) =>
		container.querySelector<T>(selector);
	const editor = query<HTMLElement>(".slides-editor")!;
	const stageElements = () =>
		Array.from(
			container.querySelectorAll<HTMLElement>(
				".slides-editor-stage [data-slide-element]",
			),
		);
	const deck = () => emitted.at(-1)?.deck;
	const slideElements = (index = 0) => deck()?.slides[index]?.elements ?? [];
	const press = (
		key: string,
		init: KeyboardEventInit = {},
		target: Element = editor,
	) => {
		const event = new KeyboardEvent("keydown", {
			key,
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			target.dispatchEvent(event);
		});
		return event;
	};
	const click = (element: HTMLElement | null) =>
		act(() => {
			element!.click();
		});
	const button = (label: string) =>
		query<HTMLButtonElement>(`[aria-label="${label}"]`)!;
	// The selected element's x, read from the deck by the stage's selection.
	const selectedX = () => {
		const id = query<HTMLElement>(
			".slides-editor-stage [data-slide-element][data-selected]",
		)?.dataset.slideElement;
		const element = slideElements().find((candidate) => candidate.id === id);
		return element ? Math.round(element.x) : Number.NaN;
	};
	return {
		container,
		stageElements,
		slideElements,
		press,
		click,
		button,
		selectedX,
		select: (index: number) => click(stageElements()[index]!),
		undo: () => press("z"),
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

beforeEach(() => {
	clearSlideElementClipboard();
	mounted = mountEditor();
});

afterEach(() => mounted.cleanup());

describe("slide element clipboard shortcuts", () => {
	it("copies and pastes the selected element offset by 24px and selects it", () => {
		mounted.select(0);
		const before = mounted.stageElements().length;
		expect(mounted.press("c").defaultPrevented).toBe(true);
		expect(
			mounted.press("v", { ctrlKey: false, metaKey: true }).defaultPrevented,
		).toBe(true);
		const elements = mounted.slideElements();
		expect(elements).toHaveLength(before + 1);
		const [source, pasted] = [elements[0]!, elements.at(-1)!];
		expect(pasted.id).not.toBe(source.id);
		expect(pasted).toMatchObject({
			type: source.type,
			text: source.text,
			x: source.x + 24,
			y: source.y + 24,
		});
		expect(mounted.selectedX()).toBe(Math.round(pasted.x));
		// A second paste mints another id.
		mounted.press("v");
		const ids = mounted.slideElements().map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);
		mounted.undo();
		mounted.undo();
		expect(mounted.stageElements()).toHaveLength(before);
	});

	it("cuts the selected element and pastes it onto the current slide", () => {
		mounted.select(0);
		const before = mounted.stageElements().length;
		const source = mounted.stageElements()[0]!;
		const cut = {
			type: source.dataset.element,
			text: source.querySelector("textarea")?.value,
		};
		mounted.press("x");
		expect(mounted.stageElements()).toHaveLength(before - 1);
		mounted.click(mounted.button("Slide 2: Q4"));
		const secondBefore = mounted.stageElements().length;
		mounted.press("v");
		expect(mounted.stageElements()).toHaveLength(secondBefore + 1);
		expect(mounted.slideElements(1).at(-1)).toMatchObject({
			type: cut.type,
			text: cut.text,
		});
		mounted.undo();
		expect(mounted.stageElements()).toHaveLength(secondBefore);
		mounted.undo();
		mounted.click(mounted.button("Slide 1: Q3"));
		expect(mounted.stageElements()).toHaveLength(before);
	});

	it("duplicates the selected element in place, offset by 24px", () => {
		mounted.select(1);
		const before = mounted.stageElements().length;
		expect(mounted.press("d").defaultPrevented).toBe(true);
		const elements = mounted.slideElements();
		const duplicate = elements.at(-1)!;
		const original = elements[1]!;
		expect(elements).toHaveLength(before + 1);
		expect(duplicate.id).not.toBe(original.id);
		expect(duplicate.x).toBe(original.x + 24);
		expect(duplicate.y).toBe(original.y + 24);
		expect(mounted.selectedX()).toBe(Math.round(duplicate.x));
		mounted.undo();
		expect(mounted.stageElements()).toHaveLength(before);
	});

	it("leaves shortcuts to text fields and does nothing without a selection", () => {
		const before = mounted.stageElements().length;
		expect(mounted.press("d").defaultPrevented).toBe(false);
		expect(mounted.press("c").defaultPrevented).toBe(false);
		mounted.select(0);
		const textarea = mounted.container.querySelector(
			".slides-editor-stage textarea",
		)!;
		for (const key of ["c", "x", "v", "d"])
			expect(mounted.press(key, {}, textarea).defaultPrevented).toBe(false);
		// Nothing was copied from the textarea, so paste has nothing to insert.
		expect(mounted.press("v").defaultPrevented).toBe(false);
		expect(mounted.stageElements()).toHaveLength(before);
	});
});

describe("slide element inspector actions", () => {
	it("duplicates, reorders and deletes the selected element, each undoable", () => {
		mounted.select(0);
		const ids = () => mounted.slideElements().map((element) => element.id);
		const before = mounted.stageElements().length;
		expect(mounted.button("Send backward").disabled).toBe(true);
		mounted.click(mounted.button("Duplicate element"));
		expect(mounted.stageElements()).toHaveLength(before + 1);
		const duplicated = ids().at(-1)!;
		expect(mounted.button("Bring forward").disabled).toBe(true);
		mounted.click(mounted.button("Send backward"));
		expect(ids().at(-2)).toBe(duplicated);
		mounted.click(mounted.button("Bring forward"));
		expect(ids().at(-1)).toBe(duplicated);
		mounted.undo();
		expect(ids().at(-2)).toBe(duplicated);
		mounted.undo();
		expect(ids().at(-1)).toBe(duplicated);
		mounted.click(mounted.button("Delete element"));
		expect(ids()).not.toContain(duplicated);
		mounted.undo();
		expect(ids().at(-1)).toBe(duplicated);
		mounted.undo();
		expect(mounted.stageElements()).toHaveLength(before);
	});
});
