import type { PresentationContent } from "@/lib/output-models";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { SlidesEditor } from "./output-editor-slides";
import {
	slideLabel,
	slideMatches,
	templateSlide,
} from "./output-editor-slide-list";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const threeSlides = (): PresentationContent => ({
	kind: "presentation",
	slides: [
		{ title: "Alpha", bullets: ["Revenue grew"] },
		{ title: "Beta", bullets: ["Hiring plan"] },
		{ title: "Gamma", bullets: [] },
	],
});

function mountEditor(initial = threeSlides(), disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const emitted: PresentationContent[] = [];
	function Harness() {
		const [value, setValue] = useState(initial);
		return (
			<SlidesEditor
				value={value}
				disabled={disabled}
				onChange={(next) => {
					emitted.push(next);
					setValue(next);
				}}
			/>
		);
	}
	act(() => root.render(<Harness />));
	const rows = () =>
		Array.from(container.querySelectorAll<HTMLElement>("[data-slide-row]")).map(
			(row) =>
				row.querySelector("[data-slide-open]")?.getAttribute("aria-label") ??
				"",
		);
	const order = () =>
		emitted.at(-1)?.deck?.slides.map((slide) => slideLabel(slide)) ?? [];
	const press = (target: Element, init: KeyboardEventInit) => {
		const event = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			target.dispatchEvent(event);
		});
		return event;
	};
	const search = (text: string) => {
		const input = container.querySelector<HTMLInputElement>(
			'[aria-label="Search slides"]',
		)!;
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setValue.call(input, text);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		return input;
	};
	const undo = () =>
		act(() =>
			container
				.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!
				.click(),
		);
	return {
		container,
		emitted,
		rows,
		order,
		press,
		search,
		undo,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function dragEvent(type: string, clientY: number) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const data = new Map<string, string>();
	Object.assign(event, {
		clientY,
		dataTransfer: {
			effectAllowed: "",
			dropEffect: "",
			setData: (key: string, value: string) => data.set(key, value),
			getData: (key: string) => data.get(key) ?? "",
		},
	});
	return event;
}

describe("SlideList", () => {
	it("shows each row's number, thumbnail and first-title label", () => {
		const mounted = mountEditor();
		expect(mounted.rows()).toEqual([
			"Slide 1: Alpha",
			"Slide 2: Beta",
			"Slide 3: Gamma",
		]);
		const row = mounted.container.querySelector("[data-slide-row]")!;
		expect(row.querySelector(".slide-thumb-canvas")).not.toBeNull();
		expect(row.textContent).toContain("1");
		// A long nowrap label widened an `auto` grid column past the rail and
		// clipped the row's Delete button; the column is bounded instead.
		expect(row.parentElement?.className).toContain("grid-cols-1");
		expect(
			slideLabel({
				id: "s",
				name: "Fallback",
				layout: "blank",
				background: "#fff",
				elements: [
					{
						id: "a",
						type: "card",
						x: 0,
						y: 0,
						width: 9,
						height: 9,
						text: "Card",
						style: {},
					},
					{
						id: "b",
						type: "subtitle",
						x: 0,
						y: 0,
						width: 9,
						height: 9,
						text: " Sub\n line ",
						style: {},
					},
				],
			}),
		).toBe("Sub line");
		mounted.cleanup();
	});

	it("reorders with Alt+Arrow, announces it, and undoes it", () => {
		const mounted = mountEditor();
		const first = mounted.container.querySelector(
			"[data-slide-row] [data-slide-open]",
		)!;
		const event = mounted.press(first, { key: "ArrowDown", altKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(mounted.order()).toEqual(["Beta", "Alpha", "Gamma"]);
		expect(
			mounted.container.querySelector('[aria-live="polite"]')?.textContent,
		).toBe("Moved Alpha to position 2 of 3");
		mounted.undo();
		expect(mounted.order()).toEqual(["Alpha", "Beta", "Gamma"]);
		mounted.cleanup();
	});

	it("drags a row to a new position behind a drop line", () => {
		const mounted = mountEditor();
		const rows = () =>
			mounted.container.querySelectorAll<HTMLElement>("[data-slide-row]");
		for (const row of rows())
			row.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
		act(() => {
			rows()[0]!.dispatchEvent(dragEvent("dragstart", 10));
		});
		act(() => {
			rows()[2]!.dispatchEvent(dragEvent("dragover", 90));
		});
		expect(rows()[2]?.getAttribute("data-drop")).toBe("after");
		act(() => {
			rows()[2]!.dispatchEvent(dragEvent("drop", 90));
		});
		expect(mounted.order()).toEqual(["Beta", "Gamma", "Alpha"]);
		expect(mounted.container.querySelector("[data-drop]")).toBeNull();
		mounted.cleanup();
	});

	it("searches element text, jumps on Enter, clears on Escape, and stops reordering", () => {
		const mounted = mountEditor();
		const input = mounted.search("hiring");
		expect(mounted.rows()).toEqual(["Slide 2: Beta"]);
		const row =
			mounted.container.querySelector<HTMLElement>("[data-slide-row]")!;
		expect(row.getAttribute("draggable")).toBe("false");
		mounted.press(row.querySelector("[data-slide-open]")!, {
			key: "ArrowUp",
			altKey: true,
		});
		mounted.press(input, { key: "Enter" });
		expect(mounted.emitted).toEqual([]);
		expect(
			mounted.container.querySelector(".slides-editor-stage")?.textContent,
		).toContain("Beta");
		mounted.search("nothing here");
		expect(mounted.container.textContent).toContain("No slides match");
		mounted.press(input, { key: "Escape" });
		expect(input.value).toBe("");
		expect(mounted.rows()).toHaveLength(3);
		mounted.cleanup();
	});

	it("duplicates after the row and deletes from the row, through undo", () => {
		const mounted = mountEditor();
		const action = (label: string, row: number) =>
			act(() =>
				mounted.container
					.querySelectorAll("[data-slide-row]")
					[row]!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
					.click(),
			);
		action("Duplicate slide", 0);
		expect(mounted.order()).toEqual(["Alpha", "Alpha", "Beta", "Gamma"]);
		const copy = mounted.emitted.at(-1)!.deck!.slides[1]!;
		expect(copy.name).toMatch(/copy$/);
		expect(copy.id).not.toBe(mounted.emitted.at(-1)!.deck!.slides[0]!.id);
		action("Delete slide", 3);
		expect(mounted.order()).toEqual(["Alpha", "Alpha", "Beta"]);
		mounted.undo();
		mounted.undo();
		expect(mounted.order()).toEqual(["Alpha", "Beta", "Gamma"]);
		mounted.cleanup();
	});

	it("disables row actions and reordering when read-only", () => {
		const mounted = mountEditor(threeSlides(), true);
		const row =
			mounted.container.querySelector<HTMLElement>("[data-slide-row]")!;
		expect(row.getAttribute("draggable")).toBe("false");
		for (const label of ["Duplicate slide", "Delete slide"])
			expect(
				row.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
					?.disabled,
			).toBe(true);
		mounted.cleanup();
	});

	it("promotes row actions to a static 44px column on coarse pointers", () => {
		const mounted = mountEditor();
		const row =
			mounted.container.querySelector<HTMLElement>("[data-slide-row]")!;
		// On touch the actions leave the absolute overlay for a real column
		// beside the content, so they can be discovered without covering the
		// thumbnail or label. Fine pointers keep the compact hover/focus
		// overlay unchanged.
		expect(row.className).toContain("coarse:flex");
		const actions = row.querySelector<HTMLElement>(
			'[aria-label="Duplicate slide"]',
		)!.parentElement!;
		expect(actions.className).toContain("absolute");
		expect(actions.className).toContain("coarse:static");
		expect(actions.className).toContain("coarse:flex-col");
		expect(actions.className).toContain("coarse:opacity-100");
		for (const label of ["Duplicate slide", "Delete slide"])
			expect(
				row.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
					?.className,
			).toContain("coarse:size-11");
		mounted.cleanup();
	});

	it("builds editable, unbranded layouts", () => {
		const cards = templateSlide("four-card", 0);
		for (const query of ["01", "Card heading", "One clear idea"])
			expect(slideMatches(cards, query)).toBe(true);
		const title = templateSlide("title", 0);
		expect(title.elements.map((element) => element.type)).toEqual([
			"divider",
			"title",
			"subtitle",
		]);
		for (const layout of [
			"title-content",
			"two-column",
			"four-card",
		] as const) {
			const slide = templateSlide(layout, 4);
			expect(slide.name).toBe("Slide 5");
			expect(slide.elements[1]).toMatchObject({ type: "title" });
			expect(slide.elements.at(-1)).toMatchObject({ type: "divider", y: 663 });
			for (const element of slide.elements) {
				expect(element.x + element.width).toBeLessThanOrEqual(1200);
				expect(element.y + element.height).toBeLessThanOrEqual(675);
			}
		}
		expect(
			templateSlide("two-column", 0).elements.filter(
				(element) => element.type === "text",
			),
		).toHaveLength(4);
		expect(templateSlide("blank", 0).elements).toEqual([]);
	});

	it("inserts a new template slide after the current slide", async () => {
		const mounted = mountEditor();
		act(() =>
			mounted.container
				.querySelector<HTMLButtonElement>('[aria-label="Slide 2: Beta"]')!
				.click(),
		);
		const trigger = mounted.container.querySelector<HTMLButtonElement>(
			'[aria-label="New slide template"]',
		);
		await act(async () => {
			trigger?.click();
			await Promise.resolve();
		});
		const option = Array.from(
			document.querySelectorAll('[role="menuitem"]'),
		).find((candidate) => candidate.textContent === "Title") as HTMLElement;
		await act(async () => {
			option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			option.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
			option.click();
			await Promise.resolve();
		});
		expect(mounted.order()).toEqual([
			"Alpha",
			"Beta",
			"Presentation title",
			"Gamma",
		]);
		expect(mounted.rows()[2]).toBe("Slide 3: Presentation title");
		mounted.undo();
		expect(mounted.order()).toEqual(["Alpha", "Beta", "Gamma"]);
		mounted.cleanup();
	});
});
