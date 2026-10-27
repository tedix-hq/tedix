import { projectWorkbook } from "../lib/output-models";

/** Fictional workbook with a 208 x 31 research tab and eleven smaller tabs. */
export function largeSheetText(): string {
	return JSON.stringify(
		projectWorkbook({
			activeSheetId: "sheet-0",
			sheets: Array.from({ length: 12 }, (_, tab) => ({
				id: `sheet-${tab}`,
				name: `Research ${tab + 1}`,
				columns: Array.from({ length: 31 }, (_, col) => ({
					id: `column-${col}`,
					label: `Column ${col + 1}`,
					width: 120,
				})),
				rows: Array.from({ length: tab === 0 ? 208 : 2 }, (_, row) =>
					Array.from({ length: 31 }, (_, col) => {
						const text = `Sample research note ${tab}/${row}/${col}. `.padEnd(
							55,
							"x",
						);
						return { input: text, value: text };
					}),
				),
				frozenRows: 1,
				frozenColumns: 0,
			})),
		}),
		null,
		2,
	);
}
