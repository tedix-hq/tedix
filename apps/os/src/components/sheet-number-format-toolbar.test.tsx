import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EditorToolbar } from "./output-editor-toolbar";
import { SheetNumberFormatToolbar } from "./sheet-number-format-toolbar";
import type { OsWorkbookCellFormat } from "@tedix/api-contract/schemas/os-workspaces";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
});
function render(format: OsWorkbookCellFormat = {}, disabled = false) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onChange = vi.fn();
	act(() =>
		root!.render(
			<EditorToolbar>
				<SheetNumberFormatToolbar
					format={format}
					disabled={disabled}
					onChange={onChange}
				/>
			</EditorToolbar>,
		),
	);
	const click = (label: string) => {
		const button = host.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`,
		)!;
		expect(button).not.toBeNull();
		act(() => button.click());
	};
	return { onChange, click };
}

describe("sheet number format toolbar", () => {
	it.each([
		["Currency", "currency"],
		["Integer", "integer"],
		["Percent", "percent"],
		["Date", "date"],
		["Time", "time"],
		["Date and time", "datetime"],
		["Plain text", "text"],
	] as const)("applies %s", (label, numberFormat) => {
		const { onChange, click } = render();
		click(label);
		expect(onChange).toHaveBeenCalledWith({
			numberFormat,
			decimals: undefined,
		});
	});
	it("increases and decreases decimal precision", () => {
		const { onChange, click } = render({
			numberFormat: "percent",
			decimals: 2,
		});
		click("Increase decimals");
		expect(onChange).toHaveBeenLastCalledWith({
			numberFormat: "percent",
			decimals: 3,
		});
		click("Decrease decimals");
		expect(onChange).toHaveBeenLastCalledWith({
			numberFormat: "percent",
			decimals: 1,
		});
	});
	it("makes integers decimal numbers when precision is increased", () => {
		const { onChange, click } = render({ numberFormat: "integer" });
		click("Increase decimals");
		expect(onChange).toHaveBeenCalledWith({
			numberFormat: "number",
			decimals: 1,
		});
	});
	it("disables formatting in read-only sheets", () => {
		const { onChange, click } = render({}, true);
		click("Percent");
		expect(onChange).not.toHaveBeenCalled();
	});
});
