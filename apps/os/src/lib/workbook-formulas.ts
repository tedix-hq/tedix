import type {
	OsSheetCell,
	OsWorkbook,
	OsWorkbookCell,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	Parser,
	SUPPORTED_FORMULAS,
	type FormulaCoordinate,
} from "hot-formula-parser";

export const WORKBOOK_SUPPORTED_FORMULA_COUNT = SUPPORTED_FORMULAS.length;

function literalValue(input: string): OsSheetCell {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed.toLowerCase() === "true") return true;
	if (trimmed.toLowerCase() === "false") return false;
	const numeric = Number(trimmed);
	return Number.isFinite(numeric) ? numeric : input;
}

function scalarResult(value: unknown): OsSheetCell {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : "#NUM!";
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

function cellAt(
	sheet: OsWorkbookSheet,
	rowIndex: number,
	columnIndex: number,
): OsWorkbookCell | null {
	return sheet.rows[rowIndex]?.[columnIndex] ?? null;
}

function sheetByName(
	workbook: OsWorkbook,
	name: string,
): OsWorkbookSheet | null {
	const normalized = name.trim().toLocaleLowerCase();
	return (
		workbook.sheets.find(
			(sheet) => sheet.name.toLocaleLowerCase() === normalized,
		) ?? null
	);
}

function columnIndex(label: string): number {
	let result = 0;
	for (const character of label.replaceAll("$", "").toUpperCase()) {
		result = result * 26 + (character.charCodeAt(0) - 64);
	}
	return result - 1;
}

function coordinateValue(
	coordinate: FormulaCoordinate,
	evaluate: (rowIndex: number, columnIndex: number) => OsSheetCell,
): OsSheetCell {
	return evaluate(coordinate.row.index, coordinate.column.index);
}

function rangeValue(
	start: FormulaCoordinate,
	end: FormulaCoordinate,
	evaluate: (rowIndex: number, columnIndex: number) => OsSheetCell,
): OsSheetCell[][] {
	const rows: OsSheetCell[][] = [];
	for (let row = start.row.index; row <= end.row.index; row += 1) {
		const values: OsSheetCell[] = [];
		for (
			let column = start.column.index;
			column <= end.column.index;
			column += 1
		) {
			values.push(evaluate(row, column));
		}
		rows.push(values);
	}
	return rows;
}

const CROSS_SHEET_RANGE =
	/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/g;
const CROSS_SHEET_CELL =
	/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!\$?([A-Z]+)\$?(\d+)/g;

/**
 * Recalculate every formula without `eval`. Formula.js supplies the Excel
 * function inventory; hooks resolve A1/range references recursively and a
 * small preprocessor maps cross-sheet references to parser variables.
 */
export function evaluateWorkbook(workbook: OsWorkbook): OsWorkbook {
	const memo = new Map<string, OsSheetCell>();
	const evaluating = new Set<string>();

	const evaluateCell = (
		sheet: OsWorkbookSheet,
		rowIndex: number,
		columnIndex_: number,
	): OsSheetCell => {
		const key = `${sheet.id}:${rowIndex}:${columnIndex_}`;
		const cached = memo.get(key);
		if (cached !== undefined || memo.has(key)) return cached ?? null;
		if (evaluating.has(key)) return "#CYCLE!";
		evaluating.add(key);
		const cell = cellAt(sheet, rowIndex, columnIndex_);
		const input = cell?.input ?? "";
		if (!input.startsWith("=")) {
			const value = literalValue(input);
			memo.set(key, value);
			evaluating.delete(key);
			return value;
		}

		const parser = new Parser();
		parser.on("callCellValue", (coordinate, done) => {
			done(
				coordinateValue(coordinate, (row, column) =>
					evaluateCell(sheet, row, column),
				),
			);
		});
		parser.on("callRangeValue", (start, end, done) => {
			done(
				rangeValue(start, end, (row, column) =>
					evaluateCell(sheet, row, column),
				),
			);
		});

		let expression = input.slice(1);
		let variableIndex = 0;
		expression = expression.replace(
			CROSS_SHEET_RANGE,
			(
				_match,
				quotedName,
				plainName,
				startColumn,
				startRow,
				endColumn,
				endRow,
			) => {
				const variable = `TEDIX_RANGE_${variableIndex++}`;
				const target = sheetByName(workbook, quotedName ?? plainName ?? "");
				const values: OsSheetCell[][] = [];
				if (target) {
					for (let row = Number(startRow) - 1; row < Number(endRow); row += 1) {
						const cells: OsSheetCell[] = [];
						for (
							let column = columnIndex(startColumn);
							column <= columnIndex(endColumn);
							column += 1
						) {
							cells.push(evaluateCell(target, row, column));
						}
						values.push(cells);
					}
				}
				parser.setVariable(variable, values);
				return variable;
			},
		);
		expression = expression.replace(
			CROSS_SHEET_CELL,
			(_match, quotedName, plainName, column, row) => {
				const variable = `TEDIX_CELL_${variableIndex++}`;
				const target = sheetByName(workbook, quotedName ?? plainName ?? "");
				parser.setVariable(
					variable,
					target
						? evaluateCell(target, Number(row) - 1, columnIndex(column))
						: "#REF!",
				);
				return variable;
			},
		);

		const parsed = parser.parse(expression);
		const value = parsed.error ?? scalarResult(parsed.result);
		memo.set(key, value);
		evaluating.delete(key);
		return value;
	};

	return {
		...workbook,
		sheets: workbook.sheets.map((sheet) => ({
			...sheet,
			rows: sheet.rows.map((row, rowIndex) =>
				sheet.columns.map((_, columnIndex_) => {
					const current = row[columnIndex_] ?? { input: "", value: null };
					return {
						...current,
						value: evaluateCell(sheet, rowIndex, columnIndex_),
					};
				}),
			),
		})),
	};
}

export function formatWorkbookValue(cell: OsWorkbookCell | null): string {
	const value = cell?.value ?? null;
	if (value === null) return "";
	const format = cell?.format?.numberFormat ?? "automatic";
	if (typeof value !== "number") return String(value);
	switch (format) {
		case "currency":
			return new Intl.NumberFormat(undefined, {
				style: "currency",
				currency: "USD",
			}).format(value);
		case "percent":
			return new Intl.NumberFormat(undefined, {
				style: "percent",
				maximumFractionDigits: 2,
			}).format(value);
		case "scientific":
			return value.toExponential(4);
		case "date":
			return new Date(value).toLocaleDateString();
		case "time":
			return new Date(value).toLocaleTimeString();
		case "number":
			return new Intl.NumberFormat().format(value);
		default:
			return String(value);
	}
}
