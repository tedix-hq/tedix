import type { PresentationContent } from "@/lib/output-models";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	PRESENTATION_ELEMENT_TYPES,
	SlidesEditor,
} from "./output-editor-slides";
import {
	filterSlideComponents,
	SLIDE_COMPONENT_CATEGORIES,
} from "./slide-insert-library";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mountEditor() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const emitted: PresentationContent[] = [];
	function Harness() {
		const [value, setValue] = useState<PresentationContent>({
			kind: "presentation",
			slides: [{ title: "Launch", bullets: [] }],
		});
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
	return {
		container,
		emitted,
		elements: () => emitted.at(-1)?.deck?.slides[0]?.elements ?? [],
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

async function until(check: () => boolean) {
	for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await flush();
}

async function openLibrary(container: HTMLElement) {
	await act(async () => {
		container
			.querySelector<HTMLButtonElement>('[aria-label="Insert slide element"]')!
			.click();
		await Promise.resolve();
	});
	return document.querySelector<HTMLInputElement>(
		'[aria-label="Filter components"]',
	)!;
}

function type(input: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)!.set!;
	act(() => {
		setValue.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function press(target: Element, key: string) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

const rows = () =>
	[...document.querySelectorAll<HTMLElement>("[data-slide-component]")].map(
		(row) => row.dataset.slideComponent,
	);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("slide component library", () => {
	it("groups every element type under Text, Containers, Decoration and Visual", () => {
		expect(SLIDE_COMPONENT_CATEGORIES.map((category) => category.name)).toEqual(
			["Text", "Containers", "Decoration", "Visual"],
		);
		const types = SLIDE_COMPONENT_CATEGORIES.flatMap((category) =>
			category.components.map((component) => component.type),
		);
		expect([...types].sort()).toEqual([...PRESENTATION_ELEMENT_TYPES].sort());
		for (const component of filterSlideComponents("")) {
			expect(component.name).not.toBe("");
			expect(component.description).not.toBe("");
			expect(component.icon).toBeDefined();
		}
	});

	it("filters by name and by description", () => {
		expect(filterSlideComponents("bullet").map((row) => row.type)).toEqual([
			"bullet",
		]);
		expect(filterSlideComponents("RULE").map((row) => row.type)).toEqual([
			"divider",
		]);
		expect(filterSlideComponents("zzz")).toEqual([]);
	});

	it("lists categories with labelled rows, then filters to a flat list", async () => {
		const mounted = mountEditor();
		const filter = await openLibrary(mounted.container);
		expect(document.activeElement).toBe(filter);
		const library = document.querySelector('[aria-label="Component library"]')!;
		expect(
			[...library.querySelectorAll("section")].map((section) =>
				section.getAttribute("aria-label"),
			),
		).toEqual(["Text", "Containers", "Decoration", "Visual"]);
		expect(rows()).toHaveLength(PRESENTATION_ELEMENT_TYPES.length);
		expect(
			document
				.querySelector('[data-slide-component="divider"]')
				?.getAttribute("aria-label"),
		).toBe("Insert Divider: Horizontal rule");
		type(filter, "circle");
		expect(rows()).toEqual(["shape"]);
		expect(library.querySelector("section")).toBeNull();
		type(filter, "nothing like this");
		expect(library.textContent).toContain("No matching components");
		mounted.cleanup();
	});

	it("inserts the first match on Enter, centered on the slide and selected", async () => {
		const mounted = mountEditor();
		const filter = await openLibrary(mounted.container);
		type(filter, "rule");
		press(filter, "Enter");
		await flush();
		const divider = mounted
			.elements()
			.find((element) => element.type === "divider");
		expect(divider).toMatchObject({ x: 250, y: 334, width: 700, height: 8 });
		expect(
			mounted.container.querySelector<HTMLInputElement>(
				'[aria-label="Element x"]',
			)?.value,
		).toBe("250");
		expect(
			document.querySelector('[aria-label="Component library"]'),
		).toBeNull();
		mounted.cleanup();
	});

	it("clears the query on Escape before closing", async () => {
		const mounted = mountEditor();
		const filter = await openLibrary(mounted.container);
		type(filter, "card");
		press(filter, "Escape");
		await flush();
		expect(filter.value).toBe("");
		expect(
			document.querySelector('[aria-label="Component library"]'),
		).not.toBeNull();
		expect(rows()).toHaveLength(PRESENTATION_ELEMENT_TYPES.length);
		mounted.cleanup();
	});
});

describe("slide images", () => {
	const svg = () => new File(["<svg/>"], "Logo.svg", { type: "image/svg+xml" });

	it("uploads an image from Insert as a centered, selected, labelled element", async () => {
		const mounted = mountEditor();
		await openLibrary(mounted.container);
		const input = mounted.container.querySelector<HTMLInputElement>(
			'[aria-label="Upload slide image"]',
		)!;
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		const upload = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Upload image",
		)!;
		act(() => upload.click());
		expect(click).toHaveBeenCalled();
		Object.defineProperty(input, "files", {
			value: [svg()],
			configurable: true,
		});
		act(() => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await until(() =>
			mounted.elements().some((element) => element.type === "svg"),
		);
		const visual = mounted.elements().find((element) => element.type === "svg");
		expect(visual).toMatchObject({
			src: "data:image/svg+xml;base64,PHN2Zy8+",
			text: "Logo",
			x: 460,
			y: 238,
		});
		expect(
			mounted.container.querySelector('img[alt="Logo"]')?.getAttribute("src"),
		).toBe("data:image/svg+xml;base64,PHN2Zy8+");
		expect(
			mounted.container.querySelector('[aria-label="Replace image"]'),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("adds a dropped image at the drop point", async () => {
		const mounted = mountEditor();
		const stage = mounted.container.querySelector<HTMLElement>(
			".slides-editor-stage",
		)!;
		vi.spyOn(
			stage.querySelector(".slides-editor-canvas")!,
			"getBoundingClientRect",
		).mockReturnValue({
			left: 0,
			top: 0,
			width: 600,
			height: 337.5,
		} as DOMRect);
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop, {
			clientX: 150,
			clientY: 100,
			dataTransfer: { files: [svg()], items: [], types: ["Files"] },
		});
		act(() => {
			stage.dispatchEvent(drop);
		});
		await until(() =>
			mounted.elements().some((element) => element.type === "svg"),
		);
		expect(drop.defaultPrevented).toBe(true);
		// (150, 100) on a half-size canvas is (300, 200) on the slide; the
		// 280×200 SVG box centers there.
		expect(
			mounted.elements().find((element) => element.type === "svg"),
		).toMatchObject({ x: 160, y: 100 });
		mounted.cleanup();
	});

	it("adds a pasted image but leaves text-field pastes alone", async () => {
		const mounted = mountEditor();
		const editor = mounted.container.querySelector<HTMLElement>(
			'[data-editor="presentation-canvas"]',
		)!;
		const paste = (target: Element) => {
			const event = new Event("paste", { bubbles: true, cancelable: true });
			Object.assign(event, {
				clipboardData: {
					files: [],
					items: [{ kind: "file", type: "image/svg+xml", getAsFile: svg }],
				},
			});
			act(() => {
				target.dispatchEvent(event);
			});
			return event;
		};
		expect(
			paste(mounted.container.querySelector('[aria-label="Search slides"]')!)
				.defaultPrevented,
		).toBe(false);
		expect(paste(editor).defaultPrevented).toBe(true);
		await until(() =>
			mounted.elements().some((element) => element.type === "svg"),
		);
		expect(
			mounted.elements().filter((element) => element.type === "svg"),
		).toHaveLength(1);
		mounted.cleanup();
	});

	it("uploads into a selected image element from the inspector", async () => {
		const mounted = mountEditor();
		const editor = mounted.container.querySelector(
			'[data-editor="presentation-canvas"]',
		)!;
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.assign(event, {
			clipboardData: { files: [svg()], items: [] },
		});
		act(() => {
			editor.dispatchEvent(event);
		});
		await until(() =>
			Boolean(
				mounted.container.querySelector(
					'.slides-editor-inspector input[type="file"]',
				),
			),
		);
		const inspectorInput = mounted.container.querySelector<HTMLInputElement>(
			'.slides-editor-inspector input[type="file"]',
		)!;
		expect(inspectorInput.getAttribute("aria-label")).toBe("Replace image");
		const png = new File(["png"], "Chart.png", { type: "image/png" });
		vi.stubGlobal(
			"Image",
			class {
				naturalWidth = 20;
				naturalHeight = 10;
				onload: (() => void) | null = null;
				set src(_value: string) {
					queueMicrotask(() => this.onload?.());
				}
			},
		);
		Object.defineProperty(inspectorInput, "files", {
			value: [png],
			configurable: true,
		});
		act(() => {
			inspectorInput.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await until(() =>
			mounted
				.elements()
				.some((element) => element.src?.startsWith("data:image/png")),
		);
		const visuals = mounted
			.elements()
			.filter((element) => element.type === "svg");
		expect(visuals).toHaveLength(1);
		expect(visuals[0]?.src).toBe("data:image/png;base64,cG5n");
		mounted.cleanup();
	});

	it("reports a file it cannot embed", async () => {
		const mounted = mountEditor();
		const stage = mounted.container.querySelector(".slides-editor-stage")!;
		const editor = mounted.container.querySelector(
			'[data-editor="presentation-canvas"]',
		)!;
		const before = mounted.emitted.length;
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.assign(event, {
			clipboardData: {
				files: [
					new File(["a".repeat(1_500_000)], "huge.svg", {
						type: "image/svg+xml",
					}),
				],
				items: [],
			},
		});
		act(() => {
			stage.dispatchEvent(event);
		});
		await until(() => Boolean(editor.querySelector('[role="alert"]')));
		expect(mounted.emitted.length).toBe(before);
		expect(editor.querySelector('[role="alert"]')?.textContent).toMatch(
			/too large/,
		);
		mounted.cleanup();
	});
});
