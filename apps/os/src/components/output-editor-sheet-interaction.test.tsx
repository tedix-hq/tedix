import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CollabParticipant } from "@/collab/presence";
import type { SheetContent } from "@/lib/output-models";
import { sheetSelectionToPresence } from "@/lib/sheet-grid";
import { SheetEditor, type SheetEditorPresence } from "./output-editor-sheet";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseValue = (): SheetContent => ({
	kind: "sheet",
	columns: ["Deal", "Value"],
	rows: [
		["Acme", 1200],
		["Globex", 300],
	],
});

type Changes = SheetContent[];

function mount(presence?: SheetEditorPresence) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const changes: Changes = [];
	function Harness() {
		const [value, setValue] = useState<SheetContent>(baseValue());
		return (
			<SheetEditor
				value={value}
				presence={presence}
				onChange={(next) => {
					changes.push(next as SheetContent);
					setValue(next as SheetContent);
				}}
			/>
		);
	}
	act(() => root.render(<Harness />));
	const query = <T extends Element>(selector: string) =>
		container.querySelector<T>(selector);
	const cell = (label: string) =>
		Array.from(
			container.querySelectorAll<HTMLElement>('[role="gridcell"]'),
		).find((item) => item.getAttribute("aria-label")?.split(" ")[0] === label)!;
	const nameBox = () =>
		query<HTMLInputElement>('[aria-label="Selected cell"]')!.value;
	const editor = () => query<HTMLTextAreaElement>(".sheet-editor-cell-editor");
	const key = (
		target: Element,
		keyName: string,
		init: KeyboardEventInit = {},
	) =>
		act(() => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: keyName,
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
		});
	const active = () => query<HTMLElement>('[role="gridcell"][tabindex="0"]')!;
	const type = (text: string) => {
		const element = editor()!;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setter.call(element, text);
			element.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const mouse = (target: Element, name: string, init: MouseEventInit = {}) =>
		act(() => {
			target.dispatchEvent(
				new MouseEvent(name, { bubbles: true, cancelable: true, ...init }),
			);
		});
	const clipboard = (name: "copy" | "cut" | "paste", text = "") => {
		const data = new Map<string, string>([["text/plain", text]]);
		const event = new Event(name, { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: {
				getData: (format: string) => data.get(format) ?? "",
				setData: (format: string, value: string) => data.set(format, value),
			},
		});
		act(() => {
			active().dispatchEvent(event);
		});
		return data.get("text/plain") ?? "";
	};
	const last = () => changes.at(-1)!.workbook!.sheets[0]!;
	return {
		container,
		changes,
		cell,
		nameBox,
		editor,
		key,
		active,
		type,
		mouse,
		clipboard,
		last,
		query,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("SheetEditor interaction", () => {
	it("is an accessible grid with one roving tab stop", () => {
		const view = mount();
		const grid = view.query('[role="grid"]');
		expect(grid?.getAttribute("aria-label")).toBe("Spreadsheet grid");
		expect(grid?.getAttribute("aria-multiselectable")).toBe("true");
		expect(
			view.container.querySelectorAll('[role="gridcell"][tabindex="0"]'),
		).toHaveLength(1);
		const a1 = view.cell("A1");
		expect(a1.getAttribute("aria-selected")).toBe("true");
		expect(a1.getAttribute("aria-colindex")).toBe("2");
		expect(a1.closest('[role="row"]')?.getAttribute("aria-rowindex")).toBe("2");
		view.cleanup();
	});

	it("replaces a cell by typing and commits once on Enter, moving down", () => {
		const view = mount();
		view.key(view.active(), "x");
		expect(view.editor()?.value).toBe("x");
		view.type("x2");
		view.type("x23");
		// Nothing is saved while typing.
		expect(view.changes).toHaveLength(0);
		view.key(view.editor()!, "Enter");
		expect(view.changes).toHaveLength(1);
		expect(view.last().rows[0]?.[0]?.input).toBe("x23");
		expect(view.editor()).toBeNull();
		expect(view.nameBox()).toBe("A2");
		view.cleanup();
	});

	it("commits on Tab moving right, Shift+Tab moving left, and cancels on Escape", () => {
		const view = mount();
		view.key(view.active(), "F2");
		expect(view.editor()?.value).toBe("Acme");
		view.type("Acme Corp");
		view.key(view.editor()!, "Tab");
		expect(view.nameBox()).toBe("B1");
		expect(view.last().rows[0]?.[0]?.input).toBe("Acme Corp");
		view.key(view.active(), "Enter");
		view.type("999");
		view.key(view.editor()!, "Escape");
		expect(view.changes).toHaveLength(1);
		expect(view.editor()).toBeNull();
		view.key(view.active(), "7");
		view.key(view.editor()!, "Tab", { shiftKey: true });
		expect(view.nameBox()).toBe("A1");
		expect(view.last().rows[0]?.[1]?.input).toBe("7");
		view.cleanup();
	});

	it("inserts a line break with Alt+Enter", () => {
		const view = mount();
		view.key(view.active(), "a");
		view.key(view.editor()!, "Enter", { altKey: true });
		expect(view.editor()?.value).toBe("a\n");
		view.cleanup();
	});

	it("navigates with Home, End, Page keys and Cmd+arrow data edges", () => {
		const view = mount();
		view.key(view.active(), "End");
		expect(view.nameBox()).toBe("J1");
		view.key(view.active(), "Home");
		expect(view.nameBox()).toBe("A1");
		view.key(view.active(), "PageDown");
		expect(view.nameBox()).toBe("A21");
		view.key(view.active(), "PageUp");
		expect(view.nameBox()).toBe("A1");
		view.key(view.active(), "ArrowDown", { metaKey: true });
		expect(view.nameBox()).toBe("A2");
		view.key(view.active(), "ArrowDown", { metaKey: true });
		expect(view.nameBox()).toBe("A30");
		view.key(view.active(), "ArrowRight", { ctrlKey: true, shiftKey: true });
		expect(view.nameBox()).toBe("A30:J30");
		view.key(view.active(), "a", { metaKey: true });
		expect(view.nameBox()).toBe("A1:J30");
		view.cleanup();
	});

	it("clears the selection with Delete and formats with Cmd+B, then undoes", () => {
		const view = mount();
		view.key(view.active(), "ArrowRight", { shiftKey: true });
		view.key(view.active(), "Delete");
		expect(view.last().rows[0]?.[0]?.input).toBe("");
		expect(view.last().rows[0]?.[1]?.input).toBe("");
		expect(view.last().rows[1]?.[0]?.input).toBe("Globex");
		view.key(view.active(), "z", { metaKey: true });
		expect(view.last().rows[0]?.[0]?.input).toBe("Acme");
		view.key(view.active(), "y", { ctrlKey: true });
		expect(view.last().rows[0]?.[0]?.input).toBe("");
		view.key(view.active(), "b", { metaKey: true });
		expect(view.last().rows[0]?.[1]?.format?.bold).toBe(true);
		view.cleanup();
	});

	it("selects by dragging, by row and column headers, and by the corner", () => {
		const view = mount();
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("B2"), "mouseover");
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup"));
		});
		expect(view.nameBox()).toBe("A1:B2");
		view.mouse(view.cell("C3"), "mouseover");
		expect(view.nameBox()).toBe("A1:B2");
		view.mouse(view.query('[data-column-header="1"]')!, "mousedown");
		expect(view.nameBox()).toBe("B1:B30");
		view.mouse(view.query('[data-column-header="3"]')!, "mousedown", {
			shiftKey: true,
		});
		expect(view.nameBox()).toBe("B1:D30");
		view.mouse(view.query('[data-row-header="2"]')!, "mousedown");
		expect(view.nameBox()).toBe("A3:J3");
		view.mouse(view.query("[data-select-all]")!, "mousedown");
		expect(view.nameBox()).toBe("A1:J30");
		view.cleanup();
	});

	it("double-clicks a column header to rename it, not a single click", () => {
		const view = mount();
		const header = view.query('[data-column-header="0"]')!;
		view.mouse(header, "mousedown");
		expect(document.body.textContent).not.toContain("Rename column");
		view.mouse(header, "dblclick");
		expect(document.body.textContent).toContain("Rename column");
		view.cleanup();
	});

	it("jumps and selects from the name box", () => {
		const view = mount();
		const box = view.query<HTMLInputElement>('[aria-label="Selected cell"]')!;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		act(() => {
			box.focus();
			setter.call(box, "b2:c4");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
		view.key(box, "Enter");
		expect(view.nameBox()).toBe("B2:C4");
		expect(view.active().getAttribute("aria-label")?.startsWith("C4")).toBe(
			true,
		);
		view.cleanup();
	});

	it("copies computed values as TSV and pastes TSV and CSV from other apps", () => {
		const view = mount();
		view.mouse(view.cell("A3"), "mousedown");
		view.key(view.active(), "=");
		view.type("=B1+B2");
		view.key(view.editor()!, "Enter");
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("B3"), "mousedown", { shiftKey: true });
		expect(view.clipboard("copy")).toBe("Acme\t1200\nGlobex\t300\n1500\t");
		view.mouse(view.cell("D1"), "mousedown");
		view.clipboard("paste", "North\t10\r\nSouth\t20\r\n");
		expect(view.nameBox()).toBe("D1:E2");
		expect(view.last().rows[1]?.[3]?.input).toBe("South");
		expect(view.last().rows[1]?.[4]?.value).toBe(20);
		view.mouse(view.cell("D5"), "mousedown");
		view.clipboard("paste", "a,b\nc,d");
		expect(view.last().rows[5]?.[4]?.input).toBe("d");
		view.mouse(view.cell("D8"), "mousedown");
		view.clipboard("paste", "Hello, world");
		expect(view.last().rows[7]?.[3]?.input).toBe("Hello, world");
		view.cleanup();
	});

	it("keeps inputs and formats on an in-sheet paste and clears on cut", () => {
		const view = mount();
		view.key(view.active(), "b", { metaKey: true });
		view.mouse(view.cell("A3"), "mousedown");
		view.key(view.active(), "=");
		view.type("=B1*2");
		view.key(view.editor()!, "Enter");
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("A3"), "mousedown", { shiftKey: true });
		const text = view.clipboard("cut");
		expect(text).toBe("Acme\nGlobex\n2400");
		expect(view.last().rows[0]?.[0]?.input).toBe("");
		view.mouse(view.cell("C1"), "mousedown");
		view.clipboard("paste", text);
		expect(view.last().rows[0]?.[2]?.input).toBe("Acme");
		expect(view.last().rows[0]?.[2]?.format?.bold).toBe(true);
		expect(view.last().rows[2]?.[2]?.input).toBe("=B1*2");
		view.cleanup();
	});

	it("inserts and deletes rows from the grid context menu, and duplicates a tab from its menu", () => {
		const view = mount();
		const menuItem = (label: string) =>
			Array.from(
				document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
			).find((item) => item.textContent?.startsWith(label));
		view.mouse(view.cell("A1"), "contextmenu", { button: 2 });
		act(() => menuItem("Insert row above")!.click());
		expect(view.last().rows[0]?.[0]?.input).toBe("");
		expect(view.last().rows[1]?.[0]?.input).toBe("Acme");
		view.mouse(view.cell("A1"), "contextmenu", { button: 2 });
		act(() => menuItem("Delete row")!.click());
		expect(view.last().rows[0]?.[0]?.input).toBe("Acme");
		const tab = Array.from(
			view.container.querySelectorAll<HTMLButtonElement>(
				".sheet-editor-tabs button[aria-pressed]",
			),
		)[0]!;
		view.mouse(tab, "contextmenu", { button: 2 });
		act(() => menuItem("Duplicate")!.click());
		expect(view.changes.at(-1)?.workbook?.sheets).toHaveLength(2);
		view.cleanup();
	});

	it("toggles wrap so a cell shows several lines", () => {
		const view = mount();
		view.key(view.active(), "a");
		view.key(view.editor()!, "Enter", { altKey: true });
		view.type("line one\nline two");
		view.key(view.editor()!, "Enter");
		view.mouse(view.cell("A1"), "mousedown");
		act(() =>
			view.query<HTMLButtonElement>('[aria-label="Wrap text"]')!.click(),
		);
		expect(view.last().rows[0]?.[0]?.format?.wrap).toBe(true);
		const display = view
			.cell("A1")
			.querySelector<HTMLElement>(".sheet-editor-cell")!;
		expect(display.style.whiteSpace).toBe("pre-wrap");
		expect(display.textContent).toBe("line one\nline two");
		view.cleanup();
	});

	it("starts an edit with a function from the insert-function list", () => {
		const view = mount();
		act(() =>
			view.query<HTMLButtonElement>('[aria-label="Insert function"]')!.click(),
		);
		const sum = Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		).find((item) => item.textContent === "SUM");
		expect(sum).toBeDefined();
		expect(document.body.textContent).toContain("Statistical");
		act(() => sum!.click());
		expect(view.editor()?.value).toBe("=SUM(");
		view.cleanup();
	});

	it("publishes its selection and draws peers' selections with a range label", () => {
		const onSelectionChange = vi.fn();
		const peer: CollabParticipant = {
			key: "peer-ada",
			displayName: "Ada",
			kind: "human",
			role: "member",
			verified: true,
			clientIds: [2],
			location: null,
			sessions: 1,
			selection: null,
		};
		const view = mount({ participants: [peer], onSelectionChange });
		const published = onSelectionChange.mock.calls.at(-1)?.[0];
		expect(published?.path).toMatch(/^sheet:/);
		view.cleanup();
		const actualSheet = published.path.slice("sheet:".length);
		const withSelection = {
			...peer,
			selection: sheetSelectionToPresence(actualSheet, {
				anchor: { row: 1, column: 1 },
				focus: { row: 2, column: 2 },
			}),
		};
		const second = mount({
			participants: [withSelection],
			onSelectionChange,
		});
		expect(second.container.textContent).toContain("Ada · B2:C3");
		expect(second.cell("C3").style.boxShadow).toContain("inset");
		expect(second.cell("D4").style.boxShadow).toBe("");
		second.key(second.active(), "ArrowRight");
		expect(onSelectionChange.mock.calls.at(-1)?.[0]).toEqual(
			sheetSelectionToPresence(actualSheet, {
				anchor: { row: 0, column: 1 },
				focus: { row: 0, column: 1 },
			}),
		);
		second.cleanup();
		expect(onSelectionChange.mock.calls.at(-1)?.[0]).toBeNull();
	});
});

describe("SheetEditor keyboard and status", () => {
	it("fills down from the first row with Cmd+D", () => {
		const view = mount();
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("A3"), "mousedown", { shiftKey: true });
		view.key(view.active(), "d", { metaKey: true });
		expect(
			view
				.last()
				.rows.slice(0, 3)
				.map((row) => row[0]?.input),
		).toEqual(["Acme", "Acme", "Acme"]);
		view.cleanup();
	});

	it("clears formatting with Cmd+Backslash and leaves the value", () => {
		const view = mount();
		view.key(view.active(), "b", { metaKey: true });
		expect(view.last().rows[0]?.[0]?.format?.bold).toBe(true);
		view.key(view.active(), "\\", { metaKey: true });
		expect(view.last().rows[0]?.[0]?.format).toBeUndefined();
		expect(view.last().rows[0]?.[0]?.input).toBe("Acme");
		view.cleanup();
	});

	it("applies currency and percent with Cmd+Shift+4 and 5", () => {
		const view = mount();
		view.mouse(view.cell("B1"), "mousedown");
		view.key(view.active(), "$", {
			metaKey: true,
			shiftKey: true,
			code: "Digit4",
		});
		expect(view.last().rows[0]?.[1]?.format?.numberFormat).toBe("currency");
		view.key(view.active(), "%", {
			metaKey: true,
			shiftKey: true,
			code: "Digit5",
		});
		expect(view.last().rows[0]?.[1]?.format?.numberFormat).toBe("percent");
		view.cleanup();
	});

	it("outlines a copied range until Escape", () => {
		const view = mount();
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("B2"), "mousedown", { shiftKey: true });
		view.clipboard("copy");
		expect(
			view.container.querySelectorAll(".sheet-editor-copied"),
		).toHaveLength(4);
		view.key(view.active(), "Escape");
		expect(view.query(".sheet-editor-copied")).toBeNull();
		view.cleanup();
	});

	it("selects the row with Shift+Space and the column with Ctrl+Space", () => {
		const view = mount();
		view.mouse(view.cell("B2"), "mousedown");
		view.key(view.active(), " ", { shiftKey: true });
		expect(view.nameBox()).toBe("A2:J2");
		view.mouse(view.cell("B2"), "mousedown");
		view.key(view.active(), " ", { ctrlKey: true });
		expect(view.nameBox()).toBe("B1:B30");
		view.cleanup();
	});

	it("saves and stays with Cmd+Enter", () => {
		const view = mount();
		view.key(view.active(), "x");
		view.key(view.editor()!, "Enter", { metaKey: true });
		expect(view.nameBox()).toBe("A1");
		expect(view.last().rows[0]?.[0]?.input).toBe("x");
		view.cleanup();
	});

	it("sums a numeric selection and counts a text one", () => {
		const view = mount();
		const status = () =>
			view.query(".sheet-editor-tabs .sheet-status")?.textContent ?? "";
		expect(status()).toContain("spreadsheet functions");
		view.mouse(view.cell("B1"), "mousedown");
		view.mouse(view.cell("B2"), "mousedown", { shiftKey: true });
		expect(status()).toMatch(/Sum\s*1,500/);
		expect(status()).toMatch(/Average\s*750/);
		view.mouse(view.cell("A1"), "mousedown");
		view.mouse(view.cell("A2"), "mousedown", { shiftKey: true });
		expect(status()).toBe("Count 2");
		view.cleanup();
	});

	it("shows formulas a writer saved without computing them", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const value = {
			kind: "sheet",
			columns: ["A"],
			rows: [],
			workbook: {
				activeSheetId: "s",
				sheets: [
					{
						id: "s",
						name: "S",
						columns: [{ id: "a", label: "A", width: 120 }],
						rows: [[{ input: "=SUM(1,2)", value: null }]],
						frozenRows: 0,
						frozenColumns: 0,
					},
				],
			},
		} as unknown as SheetContent;
		act(() => root.render(<SheetEditor value={value} onChange={vi.fn()} />));
		expect(
			container.querySelector('[role="gridcell"]')?.getAttribute("aria-label"),
		).toBe("A1 3");
		act(() => root.unmount());
		container.remove();
	});
});

describe("sheet regression sweep", () => {
	it("extends the grid on ArrowDown so typing preserves the previous last row", () => {
		const view = mount();
		view.mouse(view.cell("A30"), "mousedown");
		view.key(view.active(), "l");
		view.type("Last existing row");
		view.key(view.editor()!, "Tab");
		view.mouse(view.cell("A30"), "mousedown");
		view.key(view.active(), "ArrowDown");
		expect(view.nameBox()).toBe("A31");
		expect(view.last().rows).toHaveLength(31);
		view.key(view.active(), "n");
		view.type("New row");
		view.key(view.editor()!, "Tab");
		expect(view.last().rows[29]?.[0]?.input).toBe("Last existing row");
		expect(view.last().rows[30]?.[0]?.input).toBe("New row");
		view.cleanup();
	});

	it.each(["cell", "column"])(
		"sorts a whole table from a single %s selection",
		(selection) => {
			const view = mount();
			view.mouse(
				selection === "cell"
					? view.cell("B1")
					: view.query('[data-column-header="1"]')!,
				"mousedown",
			);
			act(() =>
				view.query<HTMLButtonElement>('[aria-label="Sort ascending"]')!.click(),
			);
			expect(
				view
					.last()
					.rows.slice(0, 2)
					.map((row) => row.slice(0, 2).map((cell) => cell?.input)),
			).toEqual([
				["Globex", "300"],
				["Acme", "1200"],
			]);
			view.cleanup();
		},
	);
});
