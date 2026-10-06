import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SheetContent } from "@/lib/output-models";
import { SheetEditor } from "./output-editor-sheet";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseValue = (): SheetContent => ({
	kind: "sheet",
	columns: ["Deal", "Value"],
	rows: [
		["Acme", 1200],
		["Globex", null],
	],
});

function renderEditor(disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const onChange = vi.fn();
	act(() =>
		root.render(
			<SheetEditor
				value={baseValue()}
				onChange={onChange}
				disabled={disabled}
			/>,
		),
	);
	return {
		container,
		onChange,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("SheetEditor", () => {
	it("keeps spreadsheet chrome on Kumo adapters and semantic selection tokens", () => {
		const mounted = renderEditor();
		// Every native control comes from a Kumo adapter (or the shared toolbar).
		for (const control of mounted.container.querySelectorAll(
			"button, input, select, textarea",
		)) {
			// Base UI's own hidden form mirror belongs to the adapter.
			if (control.id.endsWith("-hidden-input")) continue;
			expect(
				control.hasAttribute("data-slot") ||
					control.hasAttribute("data-kumo-component") ||
					control.hasAttribute("data-toolbar-control") ||
					control.closest("[data-toolbar-control]") !== null,
				control.outerHTML.slice(0, 120),
			).toBe(true);
		}
		// The selected cell uses the semantic focus ring, not the accent.
		const selected = mounted.container.querySelector(".ring-kumo-focus");
		expect(selected).not.toBeNull();
		expect(mounted.container.querySelector(".ring-kumo-accent")).toBeNull();
		// Toolbar targets are the shared primitives the document editor uses.
		const toolbarButtons = mounted.container.querySelectorAll(
			'[data-toolbar-control="icon"]',
		);
		expect(toolbarButtons.length).toBeGreaterThan(0);
		mounted.cleanup();
	});

	it("renders a selectable spreadsheet with formula, formatting, tabs, and grid controls", () => {
		const mounted = renderEditor();
		expect(
			mounted.container.querySelector('[aria-label="Spreadsheet grid"]'),
		).not.toBeNull();
		expect(
			mounted.container.querySelector<HTMLInputElement>(
				'[aria-label="Selected cell"]',
			)?.value,
		).toBe("A1");
		expect(
			mounted.container.querySelector('[aria-label="Formula bar"]'),
		).not.toBeNull();
		// The formula bar declares the compact 28px role (`size="sm"`), which the
		// Input adapter resolves to `!h-7` plus the caption type role; the page
		// no longer hardcodes the height.
		const formulaBar = mounted.container.querySelector(
			'[aria-label="Formula bar"]',
		)?.className;
		expect(formulaBar).toContain("!h-7");
		expect(formulaBar).toContain("type-tedix-caption");
		expect(
			mounted.container.querySelector(".sheet-editor-formula")?.className,
		).toContain("grid-cols-[4rem_minmax(0,1fr)]");
		expect(
			mounted.container.querySelector(".sheet-editor-grid table")?.className,
		).toContain("type-tedix-control");
		expect(
			mounted.container.querySelector(
				'.sheet-editor-grid input[aria-label="Deal row 1"]',
			)?.className,
		).toContain("h-7");
		for (const name of [
			"Auto sum",
			"Bold",
			"Italic",
			"Underline",
			"Sort ascending",
			"Sort descending",
			"Add sheet",
		]) {
			expect(
				mounted.container.querySelector(`[aria-label="${name}"]`),
			).not.toBeNull();
		}
		expect(mounted.container.textContent).toContain("Excel-style functions");
		expect(mounted.container.textContent).toContain("Sheet1");
		expect(
			mounted.container.querySelector('[data-kumo-component="Select"]'),
		).not.toBeNull();
		const toolbar = mounted.container.querySelector(
			'[data-kumo-component="Toolbar"]',
		);
		expect(toolbar?.className).toContain("text-xs");
		expect(toolbar?.parentElement?.className).toContain("border-y");
		expect(
			mounted.container.querySelector('[aria-label="Bold"]')?.className,
		).toContain("items-center justify-center p-0");
		expect(toolbar?.closest('[data-editor="workbook"]')?.className).toContain(
			"gap-0",
		);
		// Colour controls are icon-sized targets like every other item in the row.
		// They used to render as "Text [swatch]" / "Fill [swatch]", the two widest
		// and loudest things in a row of 28px icons.
		for (const name of ["Cell text color", "Cell fill color"]) {
			const picker = mounted.container.querySelector(`[aria-label="${name}"]`);
			expect(picker, name).not.toBeNull();
			expect(picker?.closest("label")?.textContent).toBe("");
		}
		// "Automatic" is the number-format Select's own value; nothing else in the
		// row may contribute visible text.
		expect(toolbar?.textContent).toBe("Automatic");
		// The 28x28 square sizing in `styles.css` keys off this attribute, and it
		// must never reach a Kumo Select trigger (also a direct `button` child of
		// the Toolbar) or the trigger collapses to a bare caret.
		for (const trigger of mounted.container.querySelectorAll(
			'[data-kumo-component="Select"]',
		)) {
			expect(trigger.getAttribute("data-toolbar-control")).toBeNull();
		}
		expect(
			mounted.container
				.querySelector('[aria-label="Bold"]')
				?.getAttribute("data-toolbar-control"),
		).toBe("icon");
		// history | text style | colour | alignment | number format | structure
		expect(toolbar?.querySelectorAll("span.w-px")).toHaveLength(5);
		// Polarity split: the toolbar is app chrome and follows the shell, the
		// desk is the recessed ground, and formula bar + grid + tabs are ONE
		// fixed-light page on it. `.sheet-editor-page` is the single element that
		// may declare `color-scheme: light` -- scoping the rows individually put
		// a dark desk band between a light formula bar and a light grid, and
		// scoping the root made `--tedix-desk` resolve light so the desk
		// disappeared in a dark shell.
		const desk = mounted.container.querySelector(".sheet-editor-desk");
		const page = mounted.container.querySelector(".sheet-editor-page");
		expect(desk?.parentElement?.className).toContain("sheet-editor");
		expect(page?.parentElement).toBe(desk);
		for (const row of [
			".sheet-editor-formula",
			".sheet-editor-grid",
			".sheet-editor-tabs",
		]) {
			expect(page?.querySelector(row), row).not.toBeNull();
		}
		// The toolbar must stay outside the page (and so outside the fixed-light
		// scope) or it stops following the shell.
		expect(toolbar?.closest(".sheet-editor-page")).toBeNull();
		expect(desk?.contains(toolbar as Node)).toBe(false);
		expect(mounted.container.querySelector(".sheet-editor-toolbar")).toBeNull();
		// Two rows under the root: shell toolbar, then the desk.
		expect(
			mounted.container.querySelector('[data-editor="workbook"]')?.children,
		).toHaveLength(2);
		expect(mounted.container.querySelector("select")).toBeNull();
		mounted.cleanup();
	});

	it("adds a workbook tab while keeping the legacy active-sheet projection", () => {
		const mounted = renderEditor();
		act(() =>
			mounted.container
				.querySelector<HTMLButtonElement>('[aria-label="Add sheet"]')
				?.click(),
		);
		const next = mounted.onChange.mock.calls.at(-1)?.[0] as
			| SheetContent
			| undefined;
		expect(next?.workbook?.sheets).toHaveLength(2);
		expect(next?.columns).toEqual([
			"Deal",
			"Value",
			"C",
			"D",
			"E",
			"F",
			"G",
			"H",
			"I",
			"J",
		]);
		// The newly created tab becomes active, so the legacy projection mirrors it.
		expect(next?.rows[0]?.slice(0, 2)).toEqual([null, null]);
		expect(
			next?.workbook?.sheets[0]?.rows[0]
				?.slice(0, 2)
				.map((cell) => cell?.value),
		).toEqual(["Acme", 1200]);
		mounted.cleanup();
	});

	it("formats the selected cell and emits rich workbook state", () => {
		const mounted = renderEditor();
		act(() =>
			mounted.container
				.querySelector<HTMLButtonElement>('[aria-label="Bold"]')
				?.click(),
		);
		const next = mounted.onChange.mock.calls.at(-1)?.[0] as
			| SheetContent
			| undefined;
		expect(next?.workbook?.sheets[0]?.rows[0]?.[0]?.format?.bold).toBe(true);
		expect(next?.rows[0]?.[0]).toBe("Acme");
		mounted.cleanup();
	});

	it("disables mutating controls in read-only mode", () => {
		const mounted = renderEditor(true);
		for (const name of [
			"Auto sum",
			"Bold",
			"Italic",
			"Underline",
			"Add sheet",
		]) {
			const control = mounted.container.querySelector<HTMLButtonElement>(
				`[aria-label="${name}"]`,
			);
			expect(
				control?.disabled || control?.getAttribute("aria-disabled") === "true",
				name,
			).toBe(true);
		}
		mounted.container
			.querySelector<HTMLButtonElement>('[aria-label="Auto sum"]')
			?.click();
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(
			mounted.container.querySelector<HTMLInputElement>(
				'[aria-label="Formula bar"]',
			)?.disabled,
		).toBe(true);
		mounted.cleanup();
	});
});
