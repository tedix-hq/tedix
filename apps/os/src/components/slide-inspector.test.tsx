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
	act(() =>
		root.render(
			<SlideInspector
				slide={slide}
				element={element}
				canMoveForward
				canMoveBackward
				onChangeSlide={() => {}}
				onChangeElement={(next) => changes.push(next)}
				onAction={() => {}}
				onImageFile={() => {}}
			/>,
		),
	);
	return {
		container,
		changes,
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
