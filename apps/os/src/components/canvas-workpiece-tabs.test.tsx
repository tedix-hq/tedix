import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
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
