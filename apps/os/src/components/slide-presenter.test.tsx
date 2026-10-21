import type { OsPresentationDeck } from "@tedix/api-contract/schemas/os-workspaces";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SlidePresenter } from "./slide-presenter";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const deck: OsPresentationDeck = {
	width: 1200,
	height: 675,
	activeSlideId: "s1",
	slides: ["Overview", "Details", "Next steps"].map((name, index) => ({
		id: `s${index + 1}`,
		name,
		layout: "blank",
		background: "#ffffff",
		elements: [],
	})),
};
let cleanup: () => void;
afterEach(() => cleanup?.());

function mount(hasSelection = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const navigate = vi.fn();
	const exit = vi.fn();
	const deselect = vi.fn();
	function Harness() {
		const [slideId, setSlideId] = useState("s1");
		const [selected, setSelected] = useState(hasSelection);
		return (
			<SlidePresenter
				deck={deck}
				slideId={slideId}
				hasSelection={selected}
				onNavigate={(id) => {
					navigate(id);
					setSlideId(id);
				}}
				onExit={exit}
				onDeselect={() => {
					deselect();
					setSelected(false);
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
		navigate,
		exit,
		deselect,
		button: (name: string) =>
			container.querySelector<HTMLButtonElement>(
				`button[aria-label="${name}"]`,
			)!,
	};
}
function key(target: EventTarget, value: string) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: value,
				bubbles: true,
				cancelable: true,
			}),
		);
	});
}

describe("SlidePresenter", () => {
	it("navigates next and previous with controls and disables the ends", () => {
		const mounted = mount();
		expect(mounted.button("Previous slide").disabled).toBe(true);
		act(() => mounted.button("Next slide").click());
		expect(mounted.navigate).toHaveBeenLastCalledWith("s2");
		act(() => mounted.button("Next slide").click());
		expect(mounted.navigate).toHaveBeenLastCalledWith("s3");
		expect(mounted.button("Next slide").disabled).toBe(true);
		act(() => mounted.button("Previous slide").click());
		expect(mounted.navigate).toHaveBeenLastCalledWith("s2");
	});

	it("handles next and previous keys inside the dialog and after focus leaves it", () => {
		const mounted = mount();
		key(mounted.container.querySelector('[role="dialog"]')!, "ArrowRight");
		expect(mounted.navigate).toHaveBeenLastCalledWith("s2");
		expect(mounted.navigate).toHaveBeenCalledTimes(1);
		key(document.body, "ArrowLeft");
		expect(mounted.navigate).toHaveBeenLastCalledWith("s1");
		key(document.body, "End");
		expect(mounted.navigate).toHaveBeenLastCalledWith("s3");
		key(document.body, "Home");
		expect(mounted.navigate).toHaveBeenLastCalledWith("s1");
	});

	it("exits on Escape", () => {
		const mounted = mount();
		key(mounted.container.querySelector('[role="dialog"]')!, "Escape");
		expect(mounted.exit).toHaveBeenCalledTimes(1);
	});

	it("closes the jump menu, then deselects, then exits on successive Escape presses", () => {
		const mounted = mount(true);
		act(() => mounted.button("Jump to slide").click());
		key(document.body, "Escape");
		expect(mounted.button("Jump to slide").getAttribute("aria-expanded")).toBe(
			"false",
		);
		expect(mounted.deselect).not.toHaveBeenCalled();
		expect(mounted.exit).not.toHaveBeenCalled();
		key(document.body, "Escape");
		expect(mounted.deselect).toHaveBeenCalledTimes(1);
		expect(mounted.exit).not.toHaveBeenCalled();
		key(document.body, "Escape");
		expect(mounted.exit).toHaveBeenCalledTimes(1);
	});

	it("keeps Space for a focused control and removes global key handling on unmount", () => {
		const mounted = mount();
		key(mounted.button("Jump to slide"), " ");
		expect(mounted.navigate).not.toHaveBeenCalled();
		cleanup();
		cleanup = () => {};
		key(document.body, "ArrowRight");
		key(document.body, "Escape");
		expect(mounted.navigate).not.toHaveBeenCalled();
		expect(mounted.exit).not.toHaveBeenCalled();
	});
});
