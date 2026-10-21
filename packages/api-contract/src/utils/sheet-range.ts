import type { OsOutputContent } from "../schemas/os-workspaces";

type SheetContent = Extract<OsOutputContent, { kind: "sheet" }>;
type Cell = SheetContent["rows"][number][number];

/**
 * Write a rectangle of cells into a sheet body at (startRow, startColumn),
 * growing rows as needed. The active workbook sheet, when there is one, gets
 * the same cells and keeps each cell's format. Callers check the rectangle
 * fits the sheet's columns and row cap first; validate the result with
 * `OsOutputContentSchema`.
 */
export function applySheetRange(
	content: SheetContent,
	startRow: number,
	startColumn: number,
	cells: readonly (readonly Cell[])[],
) {
	const columnCount = content.columns.length;
	const endRow = startRow + cells.length;
	const rows = content.rows.map((row) => [...row]);
	while (rows.length < endRow) {
		rows.push(Array.from({ length: columnCount }, () => null));
	}
	for (const [rowOffset, sourceRow] of cells.entries()) {
		const target = rows[startRow + rowOffset]!;
		while (target.length < startColumn) target.push(null);
		for (const [columnOffset, cell] of sourceRow.entries()) {
			target[startColumn + columnOffset] = cell;
		}
	}
	const workbook = content.workbook
		? {
				...content.workbook,
				sheets: content.workbook.sheets.map((sheet) => {
					if (sheet.id !== content.workbook?.activeSheetId) return sheet;
					const richRows = sheet.rows.map((row) => [...row]);
					while (richRows.length < endRow) {
						richRows.push(
							Array.from({ length: sheet.columns.length }, () => ({
								input: "",
								value: null,
							})),
						);
					}
					for (const [rowOffset, sourceRow] of cells.entries()) {
						const target = richRows[startRow + rowOffset]!;
						while (target.length < startColumn) {
							target.push({ input: "", value: null });
						}
						for (const [columnOffset, cell] of sourceRow.entries()) {
							const index = startColumn + columnOffset;
							const previous = target[index];
							target[index] = {
								input: cell === null ? "" : String(cell),
								value: cell,
								...(previous?.format ? { format: previous.format } : {}),
							};
						}
					}
					return { ...sheet, rows: richRows };
				}),
			}
		: undefined;
	return {
		kind: "sheet" as const,
		columns: content.columns,
		rows,
		...(workbook ? { workbook } : {}),
	};
}
