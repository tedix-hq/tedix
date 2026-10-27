import type { PresentationContent } from "@/lib/output-models";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SlidesEditor } from "./output-editor-slides";
import { writeSlideFocalPoint } from "./slide-inspector-fields";
import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SVG_FILE = new File(["<svg/>"], "Icon.svg", { type: "image/svg+xml" });

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

/** Paste an SVG onto the stage so an image element exists and is selected. */
async function insertSvgImage(container: HTMLElement) {
	const editor = container.querySelector<HTMLElement>(
		'[data-editor="presentation-canvas"]',
	)!;
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.assign(event, {
		clipboardData: { files: [SVG_FILE], items: [] },
	});
	act(() => {
		editor.dispatchEvent(event);
	});
	await until(() =>
		container.querySelector('[data-inspector-element="image"], [data-inspector-element="svg"]') !==
			null ||
		container.querySelector(".slides-editor-inspector input[type='file']") !==
			null,
	);
}

const element = (focal?: { x: number; y: number }): OsPresentationElement => ({
	id: "img",
	type: "image",
	x: 0,
	y: 0,
	width: 200,
	height: 100,
	style: {},
	...(focal ? { props: { focalPoint: focal } } : {}),
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("writeSlideFocalPoint", () => {
	it("sets, updates and clears the focal point inside props", () => {
		const withFocal = writeSlideFocalPoint(element(), { x: 0.2, y: 0.8 });
		expect(withFocal.props?.focalPoint).toEqual({ x: 0.2, y: 0.8 });
		expect(
			writeSlideFocalPoint(element(), { x: -1, y: 3 }).props?.focalPoint,
		).toEqual({ x: 0, y: 1 });
		expect(
			writeSlideFocalPoint(withFocal, undefined).props?.focalPoint,
		).toBeUndefined();
	});
});

describe("image reposition mode", () => {
	it("pins the focal point where the author presses and releases it on Escape", async () => {
		const mounted = mountEditor();
		await insertSvgImage(mounted.container);
		const reposition = [...mounted.container.querySelectorAll("button")].find(
			(button) => button.getAttribute("aria-label") === "Reposition image inside its frame",
		)!;
		expect(reposition).toBeDefined();
		act(() => reposition.click());
		await flush();
		const imageElement = mounted.container.querySelector<HTMLElement>(
			"[data-slide-element][data-cropping]",
		)!;
		expect(imageElement).not.toBeNull();
		vi.spyOn(imageElement, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 280,
			height: 200,
			right: 280,
			bottom: 200,
		} as DOMRect);
		for (const [type, point] of [
			["pointerdown", { clientX: 70, clientY: 50, button: 0 }],
			["pointerup", { clientX: 70, clientY: 50, button: 0 }],
		] as const) {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, point);
			act(() => {
				imageElement.dispatchEvent(event);
			});
		}
		await until(() =>
			mounted
				.elements()
				.some((item) => item.props?.focalPoint !== undefined),
		);
		// (70, 50) inside a 280x200 frame pins the focal point at (0.25, 0.25).
		expect(
			mounted.elements().find((item) => item.type === "svg")?.props
				?.focalPoint,
		).toEqual({ x: 0.25, y: 0.25 });
		expect(
			mounted.container.querySelector("img")?.getAttribute("style"),
		).toContain("object-position:25% 25%");
		const focused = mounted.container.querySelector<HTMLElement>(
			"[data-slide-element][data-cropping]",
		)!;
		act(() => {
			focused.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Escape",
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		await until(
			() =>
				mounted.container.querySelector("[data-cropping]") === null,
		);
		expect(
			mounted.container.querySelector("[data-slide-element][data-selected]"),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("clears the focal point from the Center image button", async () => {
		const mounted = mountEditor();
		await insertSvgImage(mounted.container);
		const reposition = [...mounted.container.querySelectorAll("button")].find(
			(button) =>
				button.getAttribute("aria-label") ===
				"Reposition image inside its frame",
		)!;
		act(() => reposition.click());
		await flush();
		const imageElement = mounted.container.querySelector<HTMLElement>(
			"[data-slide-element][data-cropping]",
		)!;
		vi.spyOn(imageElement, "getBoundingClientRect").mockReturnValue({
			left: 0,
			top: 0,
			width: 280,
			height: 200,
			right: 280,
			bottom: 200,
		} as DOMRect);
		for (const type of ["pointerdown", "pointerup"] as const) {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { clientX: 14, clientY: 10, button: 0 });
			act(() => {
				imageElement.dispatchEvent(event);
			});
		}
		await until(() =>
			[...mounted.container.querySelectorAll("button")].some(
				(button) => button.textContent?.trim() === "Center image",
			),
		);
		const center = [...mounted.container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Center image",
		)!;
		act(() => center.click());
		await until(
			() =>
				mounted
					.elements()
					.every((item) => item.props?.focalPoint === undefined),
		);
		expect(
			mounted.container.querySelector("img")?.getAttribute("style"),
		).not.toContain("object-position");
		mounted.cleanup();
	});
});
