import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { type CanvasDocSelection, canvasDocKey } from "@/lib/canvas-search";
import { CanvasWorkpieceTabs } from "./canvas-workpiece-tabs";

const outputs = [
	{ id: "doc-one", title: "Q3 Review", kind: "document" },
	{ id: "doc-two", title: "Q3 Review", kind: "document" },
	{ id: "sheet-one", title: "Q3 Review", kind: "sheet" },
];

function renderTabs(ids = outputs.map(({ id }) => id)) {
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<CanvasWorkpieceTabs
				opened={[
					...ids.map((id) => ({ type: "output" as const, id })),
					{ type: "gadget", id: "app-one" },
				]}
				selectedKey="output:doc-one"
				gadgets={[{ id: "app-one", name: "Q3 Review" }]}
				outputs={outputs}
				onClose={() => {}}
				onSelect={() => {}}
			/>,
		),
		"text/html",
	);
}

describe("workpiece tab accessible names", () => {
	it("distinguishes same-titled tabs and close controls by kind and stable identity", () => {
		const doc = renderTabs();
		const tabs = [...doc.querySelectorAll('[role="tab"]')];
		const names = tabs.map((tab) => tab.getAttribute("aria-label"));
		expect(names).toEqual([
			"Q3 Review (Document, doc-one)",
			"Q3 Review (Document, doc-two)",
			"Q3 Review (Sheet, sheet-one)",
			"Q3 Review (App, app-one)",
		]);
		expect(tabs.map((tab) => tab.textContent)).toEqual(
			Array(4).fill("Q3 Review"),
		);
		expect(
			[...doc.querySelectorAll('button:not([role="tab"])')].map((button) =>
				button.getAttribute("aria-label"),
			),
		).toEqual(names.map((name) => `Close ${name}`));
		const remaining = renderTabs(["doc-two"]);
		expect(
			remaining.querySelector('[role="tab"]')?.getAttribute("aria-label"),
		).toBe(names[1]);
	});

	it("labels unloaded workpieces without exposing undefined metadata", () => {
		const doc = renderTabs(["missing"]);
		expect(doc.querySelector('[role="tab"]')?.getAttribute("aria-label")).toBe(
			"Workpiece (Workpiece, missing)",
		);
	});
});

const keyboardDocs: CanvasDocSelection[] = outputs.map(({ id }) => ({
	type: "output",
	id,
}));

/**
 * A live mount with the selection model the canvas shell drives: selection
 * follows the tab the keys land on, and closing the selected tab selects the
 * neighbour that slides into its place.
 */
function mountTabs() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	function Harness() {
		const [opened, setOpened] = useState<CanvasDocSelection[]>(keyboardDocs);
		const [selectedKey, setSelectedKey] = useState<string | null>(
			"output:doc-one",
		);
		return (
			<CanvasWorkpieceTabs
				opened={opened}
				selectedKey={selectedKey}
				gadgets={[{ id: "app-one", name: "Q3 Review" }]}
				outputs={outputs}
				onClose={(key) => {
					const index = opened.findIndex((doc) => canvasDocKey(doc) === key);
					const remaining = opened.filter((doc) => canvasDocKey(doc) !== key);
					setOpened(remaining);
					setSelectedKey((current) => {
						if (current !== key) return current;
						const next = remaining[Math.min(index, remaining.length - 1)];
						return next ? canvasDocKey(next) : null;
					});
				}}
				onSelect={(doc) => setSelectedKey(canvasDocKey(doc))}
			/>
		);
	}
	act(() => root.render(<Harness />));
	return {
		container,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function press(key: string) {
	act(() => {
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key }),
		);
	});
}

describe("workpiece tab keyboard operation", () => {
	it("keeps one tab stop and roams it with the arrows, Home and End", () => {
		const { container, unmount } = mountTabs();
		const tabs = () => [
			...container.querySelectorAll<HTMLElement>('[role="tab"]'),
		];

		// Roving focus: the selected tab is the strip's only Tab stop.
		expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

		// Arrows wrap around and selection follows focus.
		act(() => tabs()[0]?.focus());
		press("ArrowLeft");
		expect(document.activeElement).toBe(tabs()[2]);
		expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
		press("ArrowRight");
		expect(document.activeElement).toBe(tabs()[0]);
		expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");

		// Home and End jump to the ends.
		press("End");
		expect(document.activeElement).toBe(tabs()[2]);
		expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
		press("Home");
		expect(document.activeElement).toBe(tabs()[0]);
		expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
		unmount();
	});

	it("closes the focused tab on Delete and hands focus to its neighbour", () => {
		const { container, unmount } = mountTabs();
		const tabs = () => [
			...container.querySelectorAll<HTMLElement>('[role="tab"]'),
		];

		// End lands on the last tab and selects it; Delete closes it.
		act(() => tabs()[0]?.focus());
		press("End");
		press("Delete");
		expect(tabs()).toHaveLength(2);
		expect(document.activeElement).toBe(tabs()[1]);
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0]);
		unmount();
	});
});
