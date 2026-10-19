import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	OsWorkbookSchema,
	type OsWorkbook,
} from "@tedix/api-contract/schemas/os-workspaces";
import { projectWorkbook, type SheetContent } from "@/lib/output-models";
import { SheetEditor } from "./output-editor-sheet";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function mount() {
	const workbook = OsWorkbookSchema.parse({
		activeSheetId: "a",
		sheets: ["a", "b"].map((id) => ({
			id,
			name: id,
			columns: ["A", "B"].map((id) => ({ id, label: id })),
			rows: [
				[
					{ input: "2", value: 2 },
					{ input: "=A1", value: 2 },
				],
				[{ input: "3", value: 3 }, null],
				[null, null],
			],
		})),
	});
	const writes: OsWorkbook[] = [];
	function Editor() {
		const [value, setValue] = useState<SheetContent>(projectWorkbook(workbook));
		return (
			<SheetEditor
				value={value}
				onChange={(next) => {
					writes.push(next.workbook!);
					setValue(next);
				}}
			/>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<Editor />));
	const click = (label: string) => {
		let button = [...container.querySelectorAll<HTMLElement>("button")].find(
			(item) =>
				item.getAttribute("aria-label") === label || item.textContent === label,
		);
		if (!button) {
			const trigger = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((item) => item.textContent?.includes("Rows and columns"))!;
			act(() => trigger.click());
			button = [
				...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
			].find((item) => item.textContent === label);
		}
		expect(button, label).toBeDefined();
		act(() => button!.click());
	};
	return {
		container,
		click,
		writes,
		cleanup() {
			act(() => root.unmount());
			container.remove();
		},
	};
}
describe("sheet structure integration", () => {
	it("inserts/deletes rows and columns, rewrites formulas, and does not repad a smaller saved grid", () => {
		const editor = mount();
		editor.click("Insert row above");
		expect(editor.writes.at(-1)!.sheets[0]!.rows[1]![1]!.input).toBe("=A2");
		editor.click("Delete selected rows");
		expect(editor.writes.at(-1)!.sheets[0]!.rows).toHaveLength(3);
		editor.click("Insert column left");
		expect(editor.writes.at(-1)!.sheets[0]!.rows[0]![2]!.input).toBe("=B1");
		editor.click("Delete selected columns");
		expect(editor.writes.at(-1)!.sheets[0]!.columns).toHaveLength(2);
		expect(editor.container.querySelectorAll("tbody tr")).toHaveLength(3);
		editor.cleanup();
	});
	it("duplicates and deletes inactive tabs and exposes rename on each tab", () => {
		const editor = mount();
		editor.click("Duplicate b");
		expect(editor.writes.at(-1)!.sheets).toHaveLength(3);
		editor.click("Delete a");
		expect(editor.writes.at(-1)!.sheets.map((sheet) => sheet.id)).not.toContain(
			"a",
		);
		const tab = [...editor.container.querySelectorAll("button")].find(
			(button) => button.textContent === "b",
		)!;
		act(() => tab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
			"Rename sheet",
		);
		editor.cleanup();
	});
	it("freezes selected panes and renders sticky cell offsets", () => {
		const editor = mount();
		editor.click("Freeze rows through selection");
		editor.click("Freeze columns through selection");
		const cell =
			editor.container.querySelector<HTMLTableCellElement>("tbody td")!;
		expect(cell.style.position).toBe("sticky");
		expect(cell.style.top).toBe("36px");
		expect(cell.style.left).toBe("44px");
		editor.click("Unfreeze panes");
		expect(
			editor.container.querySelector<HTMLTableCellElement>("tbody td")!.style
				.position,
		).toBe("");
		editor.cleanup();
	});
	it("resizes by header edge drag in one write and supports keyboard resize", () => {
		const editor = mount();
		const handle = editor.container.querySelector<HTMLElement>(
			'[aria-label="Column 1 width"]',
		)!;
		handle.setPointerCapture = vi.fn();
		handle.releasePointerCapture = vi.fn();
		act(() =>
			handle.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					pointerId: 1,
					button: 0,
					clientX: 120,
				}),
			),
		);
		act(() =>
			handle.dispatchEvent(
				new PointerEvent("pointermove", {
					bubbles: true,
					pointerId: 1,
					clientX: 180,
				}),
			),
		);
		expect(editor.writes).toHaveLength(0);
		act(() =>
			handle.dispatchEvent(
				new PointerEvent("pointerup", {
					bubbles: true,
					pointerId: 1,
					clientX: 180,
				}),
			),
		);
		expect(editor.writes).toHaveLength(1);
		expect(editor.writes[0]!.sheets[0]!.columns[0]!.width).toBe(180);
		act(() =>
			editor.container
				.querySelector('[aria-label="Row 1 height"]')!
				.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
				),
		);
		expect(editor.writes.at(-1)!.sheets[0]!.rowHeights?.[0]).toBe(36);
		editor.cleanup();
	});
});
