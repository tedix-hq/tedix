import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import type { PresentationContent, SheetContent } from "@/lib/output-models";
import { SheetEditor } from "./output-editor-sheet";
import { SlidesEditor } from "./output-editor-slides";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount<T extends OsOutputContent>(
	initial: T,
	Editor: (props: { value: T; onChange: (next: T) => void }) => React.ReactNode,
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let latest = initial;
	function Harness() {
		const [value, setValue] = useState(initial);
		latest = value;
		return <Editor value={value} onChange={setValue} />;
	}
	act(() => root.render(<Harness />));
	return {
		container,
		value: () => latest,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(field),
		"value",
	)!.set!;
	for (let end = 1; end <= text.length; end++)
		act(() => {
			setter.call(field, text.slice(0, end));
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
}

const click = (element: Element | null) =>
	act(() => (element as HTMLElement).click());

describe("structured editor undo", () => {
	it("makes typing into a slide element one undo step", () => {
		const mounted = mount<PresentationContent>(
			{ kind: "presentation", slides: [{ title: "Q3", bullets: [] }] },
			SlidesEditor,
		);
		const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
			".slide-element-input",
		)!;
		typeInto(textarea, "Quarter");
		expect(mounted.value().slides[0]!.title).toBe("Quarter");
		click(mounted.container.querySelector('[aria-label="Undo"]'));
		expect(mounted.value().slides[0]!.title).toBe("Q3");
		click(mounted.container.querySelector('[aria-label="Redo"]'));
		expect(mounted.value().slides[0]!.title).toBe("Quarter");
		mounted.cleanup();
	});

	it("makes typing into a slide name one undo step", () => {
		const mounted = mount<PresentationContent>(
			{ kind: "presentation", slides: [{ title: "Q3", bullets: [] }] },
			SlidesEditor,
		);
		const name =
			mounted.container.querySelector<HTMLInputElement>("#slide-name")!;
		typeInto(name, "Intro");
		expect(mounted.value().deck!.slides[0]!.name).toBe("Intro");
		click(mounted.container.querySelector('[aria-label="Undo"]'));
		expect(mounted.value().deck!.slides[0]!.name).toBe("Q3");
		mounted.cleanup();
	});

	it("makes typing into a cell one undo step and recalculates", () => {
		const mounted = mount<SheetContent>(
			{
				kind: "sheet",
				columns: ["A", "B"],
				rows: [
					[1, "=A1*2"],
					[null, null],
				],
			},
			SheetEditor,
		);
		const formula = mounted.container.querySelector<HTMLInputElement>(
			'[aria-label="Formula bar"]',
		)!;
		// Typing edits a draft; Enter commits it as one step.
		act(() => formula.focus());
		typeInto(formula, "2");
		typeInto(formula, "21");
		expect(mounted.value().rows[0]![0]).toBe(1);
		act(() => {
			formula.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(mounted.value().rows[0]!.slice(0, 2)).toEqual([21, 42]);
		click(mounted.container.querySelector('[aria-label="Undo"]'));
		expect(mounted.value().rows[0]!.slice(0, 2)).toEqual([1, 2]);
		const undo = mounted.container.querySelector('[aria-label="Undo"]');
		expect(
			(undo as HTMLButtonElement).disabled ||
				undo?.getAttribute("aria-disabled") === "true",
		).toBe(true);
		mounted.cleanup();
	});
});
