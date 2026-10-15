/**
 * Pure grid interaction rules for the workbook editor: A1 references, range
 * selection, data-edge jumps, clipboard tables and the presence encoding of a
 * cell selection. The component owns React state; everything here is a
 * function of its inputs so it can be tested without a DOM.
 */
import type {
	OsWorkbookCell,
	OsWorkbookCellFormat,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { CollabSelection } from "@/collab/presence";

export interface Coordinate {
	row: number;
	column: number;
}

export interface Selection {
	anchor: Coordinate;
	focus: Coordinate;
}

export interface Bounds {
	rowStart: number;
	rowEnd: number;
	columnStart: number;
	columnEnd: number;
}

export function columnLabel(index: number): string {
	let value = index + 1;
	let label = "";
	while (value > 0) {
		value -= 1;
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26);
	}
	return label;
}

export function cellLabel({ row, column }: Coordinate): string {
	return `${columnLabel(column)}${row + 1}`;
}

export function selectedBounds(selection: Selection): Bounds {
	return {
		rowStart: Math.min(selection.anchor.row, selection.focus.row),
		rowEnd: Math.max(selection.anchor.row, selection.focus.row),
		columnStart: Math.min(selection.anchor.column, selection.focus.column),
		columnEnd: Math.max(selection.anchor.column, selection.focus.column),
	};
}

export function boundsContain(bounds: Bounds, row: number, column: number) {
	return (
		row >= bounds.rowStart &&
		row <= bounds.rowEnd &&
		column >= bounds.columnStart &&
		column <= bounds.columnEnd
	);
}

/** `B3` for one cell, `B3:D7` for a range. */
export function rangeLabel(selection: Selection): string {
	const bounds = selectedBounds(selection);
	const start = cellLabel({ row: bounds.rowStart, column: bounds.columnStart });
	const end = cellLabel({ row: bounds.rowEnd, column: bounds.columnEnd });
	return start === end ? start : `${start}:${end}`;
}

export function parseCellLabel(value: string): Coordinate | null {
	const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value.trim().toUpperCase());
	if (!match) return null;
	let column = 0;
	for (const character of match[1]!)
		column = column * 26 + (character.charCodeAt(0) - 64);
	return { row: Number(match[2]) - 1, column: column - 1 };
}

/** Parse a name-box entry (`A1` or `A1:C5`) into a selection inside the sheet. */
export function parseRangeLabel(
	value: string,
	rows: number,
	columns: number,
): Selection | null {
	const [first, second, extra] = value.split(":");
	if (extra !== undefined || first === undefined) return null;
	const anchor = parseCellLabel(first);
	const focus = second === undefined ? anchor : parseCellLabel(second);
	if (!anchor || !focus) return null;
	const inside = (point: Coordinate) =>
		point.row < rows && point.column < columns;
	return inside(anchor) && inside(focus) ? { anchor, focus } : null;
}

export function clampCoordinate(
	point: Coordinate,
	rows: number,
	columns: number,
): Coordinate {
	return {
		row: Math.max(0, Math.min(rows - 1, point.row)),
		column: Math.max(0, Math.min(columns - 1, point.column)),
	};
}

function hasContent(sheet: OsWorkbookSheet, row: number, column: number) {
	return (sheet.rows[row]?.[column]?.input ?? "") !== "";
}

/**
 * Ctrl/Cmd+arrow: from inside a run of filled cells, stop at the run's last
 * cell; otherwise travel to the next filled cell, or the sheet edge.
 */
export function jumpToDataEdge(
	sheet: OsWorkbookSheet,
	from: Coordinate,
	delta: Coordinate,
): Coordinate {
	const rows = sheet.rows.length;
	const columns = sheet.columns.length;
	const inside = (point: Coordinate) =>
		point.row >= 0 &&
		point.row < rows &&
		point.column >= 0 &&
		point.column < columns;
	const step = (point: Coordinate) => ({
		row: point.row + delta.row,
		column: point.column + delta.column,
	});
	const filled = (point: Coordinate) =>
		hasContent(sheet, point.row, point.column);
	let next = step(from);
	if (!inside(next)) return from;
	if (filled(from) && filled(next)) {
		while (inside(step(next)) && filled(step(next))) next = step(next);
		return next;
	}
	while (inside(next) && !filled(next)) next = step(next);
	return inside(next) ? next : clampCoordinate(next, rows, columns);
}

/**
 * Tab/Enter inside a multi-cell selection walks the selection, wrapping at its
 * edges, instead of collapsing it.
 */
export function moveWithinSelection(
	selection: Selection,
	direction: 1 | -1,
	axis: "row" | "column",
): Selection {
	const bounds = selectedBounds(selection);
	let { row, column } = selection.focus;
	if (axis === "column") {
		column += direction;
		if (column > bounds.columnEnd) {
			column = bounds.columnStart;
			row = row + 1 > bounds.rowEnd ? bounds.rowStart : row + 1;
		} else if (column < bounds.columnStart) {
			column = bounds.columnEnd;
			row = row - 1 < bounds.rowStart ? bounds.rowEnd : row - 1;
		}
	} else {
		row += direction;
		if (row > bounds.rowEnd) {
			row = bounds.rowStart;
			column = column + 1 > bounds.columnEnd ? bounds.columnStart : column + 1;
		} else if (row < bounds.rowStart) {
			row = bounds.rowEnd;
			column = column - 1 < bounds.columnStart ? bounds.columnEnd : column - 1;
		}
	}
	return { anchor: selection.anchor, focus: { row, column } };
}

function displayText(cell: OsWorkbookCell | null | undefined): string {
	if (!cell) return "";
	if (!cell.input.startsWith("=")) return cell.input;
	return cell.value === null ? "" : String(cell.value);
}

function tsvField(value: string): string {
	return /[\t\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Computed values of the range as TSV, the format every spreadsheet pastes. */
export function boundsToTsv(sheet: OsWorkbookSheet, bounds: Bounds): string {
	const lines: string[] = [];
	for (let row = bounds.rowStart; row <= bounds.rowEnd; row++) {
		const fields: string[] = [];
		for (let column = bounds.columnStart; column <= bounds.columnEnd; column++)
			fields.push(tsvField(displayText(sheet.rows[row]?.[column])));
		lines.push(fields.join("\t"));
	}
	return lines.join("\n");
}

/** The cells of a range, with inputs and formats, for an in-sheet paste. */
export interface CopiedCells {
	tsv: string;
	cells: { input: string; format?: OsWorkbookCellFormat }[][];
}

export function copyBounds(
	sheet: OsWorkbookSheet,
	bounds: Bounds,
): CopiedCells {
	const cells: CopiedCells["cells"] = [];
	for (let row = bounds.rowStart; row <= bounds.rowEnd; row++) {
		const line: CopiedCells["cells"][number] = [];
		for (
			let column = bounds.columnStart;
			column <= bounds.columnEnd;
			column++
		) {
			const cell = sheet.rows[row]?.[column];
			line.push({
				input: cell?.input ?? "",
				...(cell?.format ? { format: cell.format } : {}),
			});
		}
		cells.push(line);
	}
	return { tsv: boundsToTsv(sheet, bounds), cells };
}

function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let atFieldStart = true;
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				field += '"';
				index++;
			} else if (character === '"') quoted = false;
			else field += character;
			continue;
		}
		if (character === '"' && atFieldStart) {
			quoted = true;
			atFieldStart = false;
		} else if (character === delimiter) {
			row.push(field);
			field = "";
			atFieldStart = true;
		} else if (character === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			atFieldStart = true;
		} else {
			field += character;
			atFieldStart = false;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/**
 * Clipboard text to a table. Excel and Google Sheets write TSV (quoting fields
 * that hold tabs, newlines or quotes); a CSV paste is recognised only when
 * every line splits into the same number of comma fields, so ordinary prose
 * with a comma still lands in one cell.
 */
export function parseClipboardTable(text: string): string[][] {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	if (normalized === "") return [[""]];
	if (normalized.includes("\t")) return parseDelimited(normalized, "\t");
	const csv = parseDelimited(normalized, ",");
	const width = csv[0]?.length ?? 0;
	if (csv.length > 1 && width > 1 && csv.every((row) => row.length === width))
		return csv;
	return parseDelimited(normalized, "\t");
}

/**
 * A cell range rides the collab presence channel as a `CollabSelection` whose
 * path names the sheet and whose offsets encode row and column. Such a path
 * never matches a document file, so the OT layer leaves it unmapped.
 */
const SHEET_PRESENCE_PREFIX = "sheet:";
const PRESENCE_ROW_STRIDE = 1024;

export function sheetSelectionToPresence(
	sheetId: string,
	selection: Selection,
): CollabSelection {
	const encode = (point: Coordinate) =>
		point.row * PRESENCE_ROW_STRIDE + point.column;
	return {
		path: `${SHEET_PRESENCE_PREFIX}${sheetId}`,
		anchor: encode(selection.anchor),
		head: encode(selection.focus),
	};
}

export function presenceToSheetSelection(
	selection: CollabSelection | null,
	sheetId: string,
): Selection | null {
	if (selection?.path !== `${SHEET_PRESENCE_PREFIX}${sheetId}`) return null;
	const decode = (offset: number) => ({
		row: Math.floor(offset / PRESENCE_ROW_STRIDE),
		column: offset % PRESENCE_ROW_STRIDE,
	});
	return { anchor: decode(selection.anchor), focus: decode(selection.head) };
}

/** Function picker groups, filtered to what the formula engine evaluates. */
const FUNCTION_GROUPS: Record<string, string[]> = {
	Math: [
		"SUM",
		"AVERAGE",
		"COUNT",
		"MAX",
		"MIN",
		"PRODUCT",
		"ROUND",
		"ABS",
		"SQRT",
		"MOD",
		"POWER",
	],
	Statistical: [
		"MEDIAN",
		"STDEV",
		"VAR",
		"COUNTA",
		"COUNTIF",
		"SUMIF",
		"SUMIFS",
		"COUNTIFS",
		"RANK",
		"LARGE",
	],
	Logical: ["IF", "IFS", "IFERROR", "AND", "OR", "NOT", "SWITCH"],
	Text: [
		"CONCAT",
		"CONCATENATE",
		"LEFT",
		"RIGHT",
		"MID",
		"LEN",
		"UPPER",
		"LOWER",
		"TRIM",
		"SUBSTITUTE",
		"TEXT",
	],
	Lookup: ["VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "CHOOSE", "LOOKUP"],
	Date: ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY", "EDATE"],
};

export function functionGroups(
	supported: readonly string[],
): { name: string; functions: string[] }[] {
	const available = new Set(supported.map((name) => name.toUpperCase()));
	return Object.entries(FUNCTION_GROUPS)
		.map(([name, functions]) => ({
			name,
			functions: functions.filter((fn) => available.has(fn)),
		}))
		.filter((group) => group.functions.length > 0);
}
