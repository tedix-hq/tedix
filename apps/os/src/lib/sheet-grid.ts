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
		"TEXTJOIN",
		"LEFT",
		"RIGHT",
		"MID",
		"LEN",
		"UPPER",
		"LOWER",
		"TRIM",
		"SUBSTITUTE",
		"TEXT",
		"HYPERLINK",
	],
	Lookup: ["VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "CHOOSE", "LOOKUP"],
	Date: [
		"TODAY",
		"NOW",
		"DATE",
		"YEAR",
		"MONTH",
		"DAY",
		"WEEKDAY",
		"EDATE",
		"DATEDIF",
	],
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

/** A computed spreadsheet error such as `#DIV/0!`, `#REF!` or `#CYCLE!`. */
export function isErrorValue(value: unknown): boolean {
	return typeof value === "string" && /^#[A-Z0-9/]+[!?]$/.test(value);
}

/** What the status bar says about a selection: count, and maths over numbers. */
export interface SelectionStats {
	/** Non-empty cells. */
	count: number;
	/** Cells whose computed value is a number. */
	numbers: number;
	sum: number;
	average: number | null;
	min: number | null;
	max: number | null;
}

export function selectionStats(
	sheet: OsWorkbookSheet,
	bounds: Bounds,
): SelectionStats {
	let count = 0;
	let numbers = 0;
	let sum = 0;
	let min: number | null = null;
	let max: number | null = null;
	for (let row = bounds.rowStart; row <= bounds.rowEnd; row++) {
		for (
			let column = bounds.columnStart;
			column <= bounds.columnEnd;
			column++
		) {
			const value = sheet.rows[row]?.[column]?.value;
			if (value === null || value === undefined || value === "") continue;
			count++;
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			numbers++;
			sum += value;
			min = min === null ? value : Math.min(min, value);
			max = max === null ? value : Math.max(max, value);
		}
	}
	return {
		count,
		numbers,
		sum,
		average: numbers > 0 ? sum / numbers : null,
		min,
		max,
	};
}

/**
 * True when a stored sheet holds an input whose cached value was never
 * computed (an import, or a writer that skipped recalculation), so a view must
 * evaluate before it can show it.
 */
export function hasUncomputedCells(
	sheets: readonly Pick<OsWorkbookSheet, "rows">[],
): boolean {
	return sheets.some((sheet) =>
		sheet.rows.some((row) =>
			row.some(
				(cell) =>
					!!cell &&
					cell.input !== "" &&
					(cell.value === null || cell.value === undefined),
			),
		),
	);
}

export interface ViewSort {
	column: number;
	direction: "ascending" | "descending";
}

function isBlank(value: unknown): boolean {
	return value === null || value === undefined || value === "";
}

/** Numbers before text, text in natural order. Blank handling is the caller's. */
function compareValues(left: unknown, right: unknown): number {
	if (typeof left === "number" && typeof right === "number")
		return left - right;
	if (typeof left === "number") return -1;
	if (typeof right === "number") return 1;
	return String(left).localeCompare(String(right), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

/**
 * Row order for a read-only view: frozen rows stay on top, the rest are
 * filtered by a case-insensitive query over their displayed text and sorted
 * by one column, blanks last in either direction. The workbook never changes.
 */
export function viewRowOrder(
	sheet: OsWorkbookSheet,
	options: {
		sort?: ViewSort | null;
		query?: string;
		display: (row: number, column: number) => string;
	},
): number[] {
	const pinned = Math.min(sheet.frozenRows, sheet.rows.length);
	const head = Array.from({ length: pinned }, (_, index) => index);
	let body = Array.from(
		{ length: sheet.rows.length - pinned },
		(_, index) => index + pinned,
	);
	const query = options.query?.trim().toLocaleLowerCase() ?? "";
	if (query) {
		body = body.filter((row) =>
			sheet.columns.some((_, column) =>
				options.display(row, column).toLocaleLowerCase().includes(query),
			),
		);
	}
	const sort = options.sort;
	if (sort) {
		const sign = sort.direction === "ascending" ? 1 : -1;
		const valueAt = (row: number) => sheet.rows[row]?.[sort.column]?.value;
		body = [...body].sort((left, right) => {
			const a = valueAt(left);
			const b = valueAt(right);
			if (isBlank(a) || isBlank(b))
				return Number(isBlank(a)) - Number(isBlank(b)) || left - right;
			return sign * compareValues(a, b) || left - right;
		});
	}
	return [...head, ...body];
}

type SheetFilter = NonNullable<OsWorkbookSheet["filter"]>;

/** A cell's value as a filter compares it: n:12, s:text, b:1, e:#N/A, or z: for blank. */
export function filterToken(
	cell: { value?: unknown; input?: string } | null | undefined,
): string {
	const value = cell?.value;
	if (value === null || value === undefined || value === "")
		return cell?.input && !cell.input.startsWith("=")
			? `s:${cell.input}`
			: "z:";
	if (isErrorValue(value)) return `e:${value}`;
	if (typeof value === "number") return `n:${value}`;
	if (typeof value === "boolean") return `b:${value ? "1" : "0"}`;
	return `s:${String(value)}`;
}

/** The last row a filter's table covers in this sheet. */
export function filterEnd(sheet: OsWorkbookSheet, filter: SheetFilter): number {
	return Math.min(filter.endRow, sheet.rows.length - 1);
}

/** The columns a filter covers: its own list, or every column. */
export function filterColumns(
	sheet: OsWorkbookSheet,
	filter: SheetFilter,
): number[] {
	return filter.columns.length
		? filter.columns
		: sheet.columns.map((_, column) => column);
}

/** Table rows the sheet's filter hides: a filtered column's value is not chosen. */
export function filteredRows(sheet: OsWorkbookSheet): Set<number> {
	const hidden = new Set<number>();
	const filter = sheet.filter;
	if (!filter) return hidden;
	const rules = Object.entries(filter.criteria)
		.filter(([, tokens]) => tokens.length)
		.map(([column, tokens]) => [Number(column), new Set(tokens)] as const);
	if (!rules.length) return hidden;
	for (let row = filter.row + 1; row <= filterEnd(sheet, filter); row++) {
		const line = sheet.rows[row];
		if (
			rules.some(([column, tokens]) => !tokens.has(filterToken(line?.[column])))
		)
			hidden.add(row);
	}
	return hidden;
}

/** Sort order for values: numbers, then text, blanks last. */
export function compareSortValues(
	a: unknown,
	b: unknown,
	ascending = true,
): number {
	const blank = (value: unknown) =>
		value === null || value === undefined || value === "";
	if (blank(a) || blank(b))
		return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
	const order =
		typeof a === "number" && typeof b === "number"
			? a - b
			: typeof a === "number"
				? -1
				: typeof b === "number"
					? 1
					: String(a).localeCompare(String(b), undefined, { numeric: true });
	return ascending ? order : -order;
}

/**
 * The values below a filter's header in one column, each once as its first
 * cell shows it, in sort order; blanks read "(Blanks)".
 */
export function filterChoices(
	sheet: OsWorkbookSheet,
	column: number,
	show: (cell: OsWorkbookSheet["rows"][number][number]) => string,
): Array<{ token: string; label: string }> {
	const filter = sheet.filter;
	if (!filter) return [];
	const found = new Map<string, { label: string; value: unknown }>();
	for (let row = filter.row + 1; row <= filterEnd(sheet, filter); row++) {
		const cell = sheet.rows[row]?.[column];
		const token = filterToken(cell);
		if (!found.has(token))
			found.set(token, {
				label: token === "z:" ? "(Blanks)" : show(cell ?? null),
				value: cell?.value ?? cell?.input ?? "",
			});
	}
	return [...found.entries()]
		.sort((a, b) => compareSortValues(a[1].value, b[1].value))
		.map(([token, { label }]) => ({ token, label }));
}

/**
 * The table to filter: the selection when it spans rows; otherwise the block
 * of data around the active cell, with the likeliest heading row as header.
 */
export function detectFilterRange(
	sheet: OsWorkbookSheet,
	bounds: Bounds,
	focus: Coordinate,
): SheetFilter | undefined {
	const has = (row: number, column: number) => {
		const cell = sheet.rows[row]?.[column];
		return (
			!!cell &&
			((cell.input ?? "") !== "" ||
				(cell.value !== null && cell.value !== undefined && cell.value !== ""))
		);
	};
	const order = (from: number, to: number) =>
		Array.from(
			{ length: Math.max(0, to - from) },
			(_, index) => from + 1 + index,
		);
	if (bounds.rowEnd > bounds.rowStart) {
		const columns: number[] = [];
		for (let column = bounds.columnStart; column <= bounds.columnEnd; column++)
			for (let row = bounds.rowStart; row <= bounds.rowEnd; row++)
				if (has(row, column)) {
					columns.push(column);
					break;
				}
		return columns.length
			? {
					row: bounds.rowStart,
					endRow: bounds.rowEnd,
					columns,
					criteria: {},
					rowOrder: order(bounds.rowStart, bounds.rowEnd),
					sort: null,
				}
			: undefined;
	}
	let minRow = Infinity,
		maxRow = -1,
		minColumn = Infinity,
		maxColumn = -1;
	sheet.rows.forEach((line, row) =>
		line.forEach((_, column) => {
			if (!has(row, column)) return;
			minRow = Math.min(minRow, row);
			maxRow = Math.max(maxRow, row);
			minColumn = Math.min(minColumn, column);
			maxColumn = Math.max(maxColumn, column);
		}),
	);
	if (maxRow <= minRow || maxColumn < minColumn) return undefined;
	// Prefer the block around the active cell; blank rows and columns bound it.
	if (
		focus.row >= minRow &&
		focus.row <= maxRow &&
		focus.column >= minColumn &&
		focus.column <= maxColumn &&
		has(focus.row, focus.column)
	) {
		const rowHas = (row: number) => {
			for (let column = minColumn; column <= maxColumn; column++)
				if (has(row, column)) return true;
			return false;
		};
		let top = focus.row,
			bottom = focus.row;
		while (top > minRow && rowHas(top - 1)) top--;
		while (bottom < maxRow && rowHas(bottom + 1)) bottom++;
		const columnHas = (column: number) => {
			for (let row = top; row <= bottom; row++)
				if (has(row, column)) return true;
			return false;
		};
		let left = focus.column,
			right = focus.column;
		while (left > minColumn && columnHas(left - 1)) left--;
		while (right < maxColumn && columnHas(right + 1)) right++;
		[minRow, maxRow, minColumn, maxColumn] = [top, bottom, left, right];
	}
	let best: { row: number; score: number } | undefined;
	for (let row = minRow; row <= Math.min(maxRow - 1, minRow + 12); row++) {
		let headings = 0,
			supported = 0;
		for (let column = minColumn; column <= maxColumn; column++) {
			if (has(row, column)) headings++;
			for (let below = row + 1; below <= maxRow; below++)
				if (has(below, column)) {
					supported++;
					break;
				}
		}
		if (!headings || !supported) continue;
		const score = headings * 5 + supported * 3 - (row - minRow) * 2;
		if (!best || score > best.score) best = { row, score };
	}
	if (!best) return undefined;
	const columns: number[] = [];
	for (let column = minColumn; column <= maxColumn; column++)
		for (let row = best.row; row <= maxRow; row++)
			if (has(row, column)) {
				columns.push(column);
				break;
			}
	return columns.length
		? {
				row: best.row,
				endRow: maxRow,
				columns,
				criteria: {},
				rowOrder: order(best.row, maxRow),
				sort: null,
			}
		: undefined;
}
