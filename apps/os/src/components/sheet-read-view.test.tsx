import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import type { SheetContent } from "@/lib/output-models";
import { WorkbookView } from "./sheet-read-view";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(content: SheetContent) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<WorkbookView content={content} />));
	return {
		container,
		cleanup() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const workbook = (rows: { input: string; value: unknown }[][]): SheetContent =>
	({
		kind: "sheet",
		columns: [],
		rows: [],
		workbook: {
			locale: "en-US",
			currency: "EUR",
			activeSheetId: "s",
			sheets: [
				{
					id: "s",
					name: "Prices",
					columns: [
						{ id: "a", label: "Item", width: 120 },
						{ id: "b", label: "B", width: 120 },
					],
					rows: rows.map((row, index) =>
						row.map((cell, column) =>
							column === 1 && index === 0
								? { ...cell, format: { numberFormat: "currency" } }
								: cell,
						),
					),
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	}) as unknown as SheetContent;

describe("WorkbookView", () => {
	it("formats money in the workbook's currency and right-aligns numbers", () => {
		const view = render(
			workbook([
				[
					{ input: "Rye", value: "Rye" },
					{ input: "4.5", value: 4.5 },
				],
				[
					{ input: "Spelt", value: "Spelt" },
					{ input: "=1/0", value: null },
				],
			]),
		);
		const cells = [...view.container.querySelectorAll("td")];
		expect(cells[1]?.textContent).toBe("€4.50");
		expect(cells[1]?.dataset.kind).toBe("number");
		expect(cells[1]?.style.textAlign).toBe("right");
		expect(cells[3]?.dataset.kind).toBe("error");
		view.cleanup();
	});

	it("names a column by letter and label, and by letter alone when unnamed", () => {
		const view = render(workbook([[{ input: "Rye", value: "Rye" }]]));
		const headers = [...view.container.querySelectorAll("thead th")].map(
			(th) => th.textContent,
		);
		expect(headers.slice(1)).toEqual(["AItem", "B"]);
		expect(
			view.container.querySelector("thead th")?.getAttribute("aria-sort"),
		).toBeNull();
		expect(
			view.container.querySelectorAll("thead th")[1]?.getAttribute("aria-sort"),
		).toBe("none");
		view.cleanup();
	});

	it("says a sheet is empty instead of drawing a blank grid", () => {
		const view = render({ kind: "sheet", columns: [], rows: [] });
		expect(view.container.textContent).toContain("This sheet is empty");
		expect(view.container.querySelector("table")).toBeNull();
		expect(view.container.textContent).toContain("Empty");
		view.cleanup();
	});
});
