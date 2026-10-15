import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { svgMarkupFromSource } from "@/lib/slide-svg-markup";
import { SlideInspector } from "./slide-inspector";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const slide: OsPresentationCanvasSlide = {
	id: "s1",
	name: "One",
	layout: "blank",
	background: "#ffffff",
	elements: [],
};

function mount(element: OsPresentationElement) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const changes: OsPresentationElement[] = [];
	const slideChanges: OsPresentationCanvasSlide[] = [];
	act(() =>
		root.render(
			<SlideInspector
				slide={slide}
				element={element}
				canMoveForward
				canMoveBackward
				onChangeSlide={(next) => slideChanges.push(next)}
				onChangeElement={(next) => changes.push(next)}
				onAction={() => {}}
				onImageFile={() => {}}
				onBackgroundImageFile={() => {}}
			/>,
		),
	);
	return {
		container,
		changes,
		slideChanges,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(field),
		"value",
	)!.set!;
	act(() => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("SlideInspector", () => {
	it("edits an SVG element's code into a safe image source", () => {
		const mounted = mount({
			id: "v",
			type: "svg",
			x: 0,
			y: 0,
			width: 200,
			height: 200,
			style: {},
		});
		const code = mounted.container.querySelector<HTMLTextAreaElement>(
			'[aria-label="Element SVG code"]',
		)!;
		type(code, '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
		const src = mounted.changes.at(-1)?.src;
		expect(src).toMatch(/^data:image\/svg\+xml;/);
		expect(svgMarkupFromSource(src)).toContain("<rect");
		type(code, "<div>not svg</div>");
		expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe(
			"SVG code must start with an <svg> element.",
		);
		mounted.cleanup();
	});

	it("gives images a URL, alt text and fit, with geometry under Advanced", async () => {
		const mounted = mount({
			id: "i",
			type: "image",
			x: 10,
			y: 10,
			width: 200,
			height: 100,
			style: {},
		});
		const url = mounted.container.querySelector<HTMLInputElement>(
			'[aria-label="Element image URL"]',
		)!;
		type(url, "javascript:alert(1)");
		expect(mounted.changes).toHaveLength(0);
		type(url, "https://example.com/a.png");
		expect(mounted.changes.at(-1)?.src).toBe("https://example.com/a.png");
		type(
			mounted.container.querySelector<HTMLInputElement>(
				'[aria-label="Element alt text"]',
			)!,
			"Chart",
		);
		expect(mounted.changes.at(-1)?.text).toBe("Chart");
		expect(
			mounted.container.querySelector('[aria-label="Element fit"]'),
		).not.toBeNull();
		expect(
			mounted.container.querySelector('[aria-label="Element x"]'),
		).toBeNull();
		const advanced = Array.from(
			mounted.container.querySelectorAll("button"),
		).find((button) => button.textContent?.trim() === "Advanced")!;
		await act(async () => {
			advanced.click();
			await Promise.resolve();
		});
		expect(
			mounted.container.querySelector('[aria-label="Element x"]'),
		).not.toBeNull();
		expect(
			mounted.container.querySelector('[aria-label="Element opacity"]'),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("does not commit a font size outside the schema while it is typed", () => {
		const mounted = mount({
			id: "t",
			type: "text",
			x: 0,
			y: 0,
			width: 200,
			height: 100,
			text: "Hi",
			style: { fontSize: 24 },
		});
		const size = mounted.container.querySelector<HTMLInputElement>(
			'[aria-label="Element font size"]',
		)!;
		type(size, "1");
		expect(mounted.changes).toHaveLength(0);
		type(size, "16");
		expect(mounted.changes.at(-1)?.style.fontSize).toBe(16);
		mounted.cleanup();
	});

	it("edits card parts, highlight words and bullet items as text", () => {
		const field = (container: HTMLElement, label: string) =>
			container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
				`[aria-label="Element ${label}"]`,
			)!;
		const card = mount({
			id: "c",
			type: "card",
			x: 0,
			y: 0,
			width: 300,
			height: 200,
			text: "Old",
			style: {},
		});
		expect(field(card.container, "title").value).toBe("Old");
		type(field(card.container, "eyebrow"), "Step 1");
		expect(card.changes.at(-1)?.props).toEqual({ eyebrow: "Step 1" });
		expect(field(card.container, "body").tagName).toBe("TEXTAREA");
		const words = field(card.container, "highlight words");
		type(words, "fast, ");
		// The draft keeps the trailing separator while the stored list is clean.
		expect(words.value).toBe("fast, ");
		expect(card.changes.at(-1)?.props?.highlight).toEqual(["fast"]);
		card.cleanup();

		const list = mount({
			id: "b",
			type: "bullet",
			x: 0,
			y: 0,
			width: 300,
			height: 200,
			style: {},
		});
		const items = field(list.container, "items");
		expect(items.tagName).toBe("TEXTAREA");
		type(items, "One\nTwo");
		expect(list.changes.at(-1)?.text).toBe("One\nTwo");
		list.cleanup();
	});

	it("sets slide background dots, inset surface and image", () => {
		const mounted = mount({
			id: "t",
			type: "text",
			x: 0,
			y: 0,
			width: 200,
			height: 100,
			style: {},
		});
		const query = (label: string) =>
			mounted.container.querySelector<HTMLInputElement>(
				`[aria-label="${label}"]`,
			)!;
		type(query("Slide dot grid opacity"), "0.4");
		expect(mounted.slideChanges.at(-1)?.dotGridOpacity).toBe(0.4);
		act(() => query("Slide inset surface").click());
		expect(mounted.slideChanges.at(-1)?.insetSurface).toEqual({
			color: "#ffffff",
			inset: 24,
			radius: 8,
		});
		type(query("Slide background image URL"), "http://insecure.test/a.png");
		expect(mounted.slideChanges.at(-1)?.backgroundImage).toBeUndefined();
		// A partly typed address stays in the field until it is usable.
		expect(query("Slide background image URL").value).toBe(
			"http://insecure.test/a.png",
		);
		type(query("Slide background image URL"), "https://example.com/bg.png");
		expect(mounted.slideChanges.at(-1)?.backgroundImage).toBe(
			"https://example.com/bg.png",
		);
		expect(
			mounted.container.querySelector(
				'input[type="file"][aria-label="Upload background image"]',
			),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("marks hover and press with motion that honours reduced motion", () => {
		const css = readFileSync("src/styles.css", "utf8");
		expect(css).toMatch(
			/\[data-slide-element\]:not\(\[data-selected\]\):not\(\[tabindex="-1"\]\):hover \{\n\toutline: 1px dashed/,
		);
		const motion = css.split(
			"@media (prefers-reduced-motion: no-preference) {",
		)[1];
		expect(motion?.split("\n}\n")[0]).toContain("transform: scale(0.96)");
	});
});
