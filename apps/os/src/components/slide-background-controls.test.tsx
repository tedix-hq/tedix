import type { OsPresentationCanvasSlide } from "@tedix/api-contract/schemas/os-workspaces";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SlideBackgroundControls } from "./slide-background-controls";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const slide: OsPresentationCanvasSlide = {
	id: "s1",
	name: "Overview",
	layout: "blank",
	background: "#ffffff",
	elements: [],
	notes: "Keep these notes",
};
let cleanup: () => void;
afterEach(() => cleanup?.());

function mount(initial = slide, disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const changes: OsPresentationCanvasSlide[] = [];
	const upload = vi.fn();
	function Harness() {
		const [value, setValue] = useState(initial);
		return (
			<SlideBackgroundControls
				slide={value}
				disabled={disabled}
				onBackgroundImageFile={upload}
				onChangeSlide={(next) => {
					changes.push(next);
					setValue(next);
				}}
			/>
		);
	}
	act(() => root.render(<Harness />));
	cleanup = () => {
		act(() => root.unmount());
		container.remove();
	};
	return {
		container,
		changes,
		upload,
		input: (label: string) =>
			container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!,
	};
}

function type(input: HTMLInputElement, value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("SlideBackgroundControls", () => {
	it("emits a colour update without changing the rest of the slide", () => {
		const mounted = mount();
		type(mounted.input("Slide background"), "#336699");
		expect(mounted.changes).toEqual([{ ...slide, background: "#336699" }]);
	});

	it("keeps an existing image while typing, accepts HTTPS and clears empty input", () => {
		const initial = {
			...slide,
			backgroundImage: "https://example.com/old.png",
		};
		const mounted = mount(initial);
		const input = mounted.input("Slide background image URL");
		for (const partial of [
			"h",
			"https:",
			"http://example.com/image.png",
			"javascript:alert(1)",
		]) {
			type(input, partial);
			expect(input.value).toBe(partial);
			expect(mounted.changes).toHaveLength(0);
		}
		act(() =>
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
		);
		expect(input.value).toBe(initial.backgroundImage);
		type(input, " https://example.com/new.png ");
		expect(mounted.changes.at(-1)).toEqual({
			...slide,
			backgroundImage: "https://example.com/new.png",
		});
		type(input, "");
		expect(mounted.changes.at(-1)).toEqual({
			...slide,
			backgroundImage: undefined,
		});
	});

	it("removes an image and passes a selected file to the upload handler", () => {
		const mounted = mount({
			...slide,
			backgroundImage: "https://example.com/image.png",
		});
		const remove = Array.from(
			mounted.container.querySelectorAll("button"),
		).find((button) => button.textContent === "Remove image")!;
		act(() => remove.click());
		expect(mounted.changes.at(-1)).toEqual({
			...slide,
			backgroundImage: undefined,
		});
		const file = new File(["image"], "background.png", { type: "image/png" });
		const input = mounted.input("Upload background image");
		Object.defineProperty(input, "files", { value: [file] });
		act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
		expect(mounted.upload).toHaveBeenCalledWith(file);
	});

	it("clamps grid opacity and toggles the default inset surface", () => {
		const mounted = mount();
		const input = mounted.input("Slide dot grid opacity");
		type(input, "0.4");
		expect(mounted.changes.at(-1)?.dotGridOpacity).toBe(0.4);
		type(input, "2");
		expect(mounted.changes.at(-1)?.dotGridOpacity).toBe(1);
		type(input, "");
		expect(mounted.changes.at(-1)?.dotGridOpacity).toBeUndefined();
		const toggle = mounted.input("Slide inset surface");
		act(() => toggle.click());
		expect(mounted.changes.at(-1)?.insetSurface).toEqual({
			color: "#ffffff",
			inset: 24,
			radius: 8,
		});
		act(() => toggle.click());
		expect(mounted.changes.at(-1)?.insetSurface).toBeUndefined();
	});

	it("disables every background control when editing is disabled", () => {
		const mounted = mount(
			{ ...slide, backgroundImage: "https://example.com/image.png" },
			true,
		);
		for (const control of mounted.container.querySelectorAll<
			HTMLInputElement | HTMLButtonElement
		>("input, button"))
			expect(control.disabled).toBe(true);
	});
});
