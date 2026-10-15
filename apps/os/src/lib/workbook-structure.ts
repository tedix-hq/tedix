import type {
	OsWorkbook,
	OsWorkbookCell,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";

export interface WorkbookRange {
	rowStart: number;
	rowEnd: number;
	columnStart: number;
	columnEnd: number;
}
export const DEFAULT_ROW_HEIGHT = 28;
export const HEADER_HEIGHT = 36;
export const ROW_HEADER_WIDTH = 44;

export function columnLabel(index: number): string {
	let label = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
		label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
	return label;
}
function columnIndex(label: string): number {
	return (
		[...label.toUpperCase()].reduce(
			(n, char) => n * 26 + char.charCodeAt(0) - 64,
			0,
		) - 1
	);
}
function changeSheet(
	workbook: OsWorkbook,
	id: string,
	change: (sheet: OsWorkbookSheet) => OsWorkbookSheet,
): OsWorkbook {
	return {
		...workbook,
		sheets: workbook.sheets.map((sheet) =>
			sheet.id === id ? change(sheet) : sheet,
		),
	};
}
function emptyCell(): OsWorkbookCell {
	return { input: "", value: null };
}
function sheetName(prefix: string): string {
	const name = prefix.slice(0, -1);
	return name.startsWith("'") ? name.slice(1, -1).replaceAll("''", "'") : name;
}

// Match whole references, leaving formula strings and identifiers such as LOG10 alone.
const REFERENCE =
	/("(?:[^"]|"")*")|(?<![\w.])((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?[1-9]\d*)(?::(\$?[A-Za-z]{1,3}\$?[1-9]\d*))?(?![\w.(])/g;
function rewriteFormula(
	input: string,
	owner: OsWorkbookSheet,
	target: OsWorkbookSheet,
	axis: "row" | "column",
	at: number,
	count: number,
	remove: boolean,
): string {
	if (!input.startsWith("=")) return input;
	const parse = (ref: string) => {
		const [, absoluteColumn, column, absoluteRow, row] =
			/^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(ref)!;
		return {
			absoluteColumn,
			column: columnIndex(column!),
			absoluteRow,
			row: Number(row) - 1,
		};
	};
	const render = (ref: ReturnType<typeof parse>, coordinate: number) => {
		const row = axis === "row" ? coordinate : ref.row;
		const column = axis === "column" ? coordinate : ref.column;
		return `${ref.absoluteColumn}${columnLabel(column)}${ref.absoluteRow}${row + 1}`;
	};
	return input.replace(
		REFERENCE,
		(
			whole,
			literal: string | undefined,
			prefix: string | undefined,
			first: string,
			last: string | undefined,
		) => {
			if (
				literal ||
				(prefix
					? sheetName(prefix).toLowerCase() !== target.name.toLowerCase()
					: owner.id !== target.id)
			)
				return whole;
			const a = parse(first);
			const b = last ? parse(last) : a;
			const start = a[axis],
				end = b[axis];
			const shift = (n: number) =>
				n < at ? n : remove ? (n >= at + count ? n - count : null) : n + count;
			if (!last) {
				const next = shift(start);
				return next === null ? "#REF!" : (prefix ?? "") + render(a, next);
			}
			const low = Math.min(start, end),
				high = Math.max(start, end);
			const remainingLow =
				remove && low >= at && low < at + count ? at + count : low;
			const remainingHigh =
				remove && high >= at && high < at + count ? at - 1 : high;
			if (remainingLow > remainingHigh) return "#REF!";
			const lo = shift(remainingLow)!,
				hi = shift(remainingHigh)!;
			return (
				(prefix ?? "") +
				render(a, start <= end ? lo : hi) +
				":" +
				render(b, start <= end ? hi : lo)
			);
		},
	);
}

function structure(
	workbook: OsWorkbook,
	sheetId: string,
	axis: "row" | "column",
	at: number,
	count: number,
	remove: boolean,
): OsWorkbook {
	const sheet = workbook.sheets.find((item) => item.id === sheetId);
	if (!sheet) return workbook;
	const size = axis === "row" ? sheet.rows.length : sheet.columns.length;
	if (
		!Number.isInteger(at) ||
		!Number.isInteger(count) ||
		count < 1 ||
		at < 0 ||
		at > size ||
		(remove && (at + count > size || size - count < 1)) ||
		(!remove && size + count > (axis === "row" ? 1000 : 64))
	)
		return workbook;
	const splice = <T>(items: T[], create: (index: number) => T): T[] => {
		const next = [...items];
		next.splice(
			at,
			remove ? count : 0,
			...(!remove ? Array.from({ length: count }, (_, i) => create(i)) : []),
		);
		return next;
	};
	const freeze = (n: number) =>
		remove ? n - Math.max(0, Math.min(count, n - at)) : at < n ? n + count : n;
	const next = changeSheet(workbook, sheetId, (current) =>
		axis === "row"
			? {
					...current,
					rows: splice(current.rows, () => current.columns.map(emptyCell)),
					...(current.rowHeights
						? {
								rowHeights: splice(
									current.rows.map(
										(_, i) => current.rowHeights?.[i] ?? DEFAULT_ROW_HEIGHT,
									),
									() => DEFAULT_ROW_HEIGHT,
								),
							}
						: {}),
					frozenRows: freeze(current.frozenRows),
				}
			: {
					...current,
					columns: splice(current.columns, (i) => ({
						id: `column-${crypto.randomUUID()}`,
						label: columnLabel(at + i),
						width: 120,
					})),
					rows: current.rows.map((row) =>
						splice(
							current.columns.map((_, i) => row[i] ?? null),
							emptyCell,
						),
					),
					frozenColumns: freeze(current.frozenColumns),
				},
	);
	return {
		...next,
		sheets: next.sheets.map((owner) => ({
			...owner,
			rows: owner.rows.map((row) =>
				row.map((cell) =>
					cell
						? {
								...cell,
								input: rewriteFormula(
									cell.input,
									owner,
									sheet,
									axis,
									at,
									count,
									remove,
								),
							}
						: null,
				),
			),
		})),
	};
}
export function insertRows(
	workbook: OsWorkbook,
	sheetId: string,
	at: number,
	count = 1,
): OsWorkbook {
	return structure(workbook, sheetId, "row", at, count, false);
}
export function deleteRows(
	workbook: OsWorkbook,
	sheetId: string,
	at: number,
	count = 1,
): OsWorkbook {
	return structure(workbook, sheetId, "row", at, count, true);
}
export function insertColumns(
	workbook: OsWorkbook,
	sheetId: string,
	at: number,
	count = 1,
): OsWorkbook {
	return structure(workbook, sheetId, "column", at, count, false);
}
export function deleteColumns(
	workbook: OsWorkbook,
	sheetId: string,
	at: number,
	count = 1,
): OsWorkbook {
	return structure(workbook, sheetId, "column", at, count, true);
}

export function resizeRow(
	workbook: OsWorkbook,
	sheetId: string,
	row: number,
	height: number,
): OsWorkbook {
	return changeSheet(workbook, sheetId, (sheet) => ({
		...sheet,
		rowHeights: sheet.rows.map((_, i) =>
			i === row
				? Math.round(Math.max(20, Math.min(600, height)))
				: (sheet.rowHeights?.[i] ?? DEFAULT_ROW_HEIGHT),
		),
	}));
}
export function resizeColumn(
	workbook: OsWorkbook,
	sheetId: string,
	column: number,
	width: number,
): OsWorkbook {
	return changeSheet(workbook, sheetId, (sheet) => ({
		...sheet,
		columns: sheet.columns.map((item, i) =>
			i === column
				? { ...item, width: Math.round(Math.max(48, Math.min(600, width))) }
				: item,
		),
	}));
}
export function freezePanes(
	workbook: OsWorkbook,
	sheetId: string,
	rows: number,
	columns: number,
): OsWorkbook {
	return changeSheet(workbook, sheetId, (sheet) => ({
		...sheet,
		frozenRows: Math.max(0, Math.min(sheet.rows.length, Math.trunc(rows))),
		frozenColumns: Math.max(
			0,
			Math.min(sheet.columns.length, Math.trunc(columns)),
		),
	}));
}
export function frozenCellStyle(
	sheet: OsWorkbookSheet,
	row: number,
	column: number,
): { position?: "sticky"; top?: number; left?: number; zIndex?: number } {
	const top =
		row < sheet.frozenRows
			? HEADER_HEIGHT +
				Array.from(
					{ length: row },
					(_, i) => sheet.rowHeights?.[i] ?? DEFAULT_ROW_HEIGHT,
				).reduce((a, b) => a + b, 0)
			: undefined;
	const left =
		column < sheet.frozenColumns
			? ROW_HEADER_WIDTH +
				sheet.columns
					.slice(0, column)
					.reduce((sum, item) => sum + item.width, 0)
			: undefined;
	return top !== undefined || left !== undefined
		? {
				position: "sticky",
				top,
				left,
				zIndex: top !== undefined && left !== undefined ? 4 : 2,
			}
		: {};
}

export function sortRange(
	workbook: OsWorkbook,
	sheetId: string,
	range: WorkbookRange,
	column: number,
	direction: "ascending" | "descending",
	hasHeader = false,
): OsWorkbook {
	return changeSheet(workbook, sheetId, (sheet) => {
		const start = range.rowStart + (hasHeader ? 1 : 0);
		const source = sheet.rows
			.slice(start, range.rowEnd + 1)
			.map((row) => row.slice(range.columnStart, range.columnEnd + 1));
		const key = column - range.columnStart;
		const empty = (row: (OsWorkbookCell | null)[]) =>
			row.every((cell) => !cell?.input.trim());
		source.sort((a, b) => {
			if (empty(a) !== empty(b)) return empty(a) ? 1 : -1;
			const av = a[key]?.value ?? a[key]?.input ?? "",
				bv = b[key]?.value ?? b[key]?.input ?? "";
			if (av === "" || bv === "") return av === bv ? 0 : av === "" ? 1 : -1;
			return (
				(typeof av === "number" && typeof bv === "number"
					? av - bv
					: String(av).localeCompare(String(bv), undefined, {
							numeric: true,
						})) * (direction === "ascending" ? 1 : -1)
			);
		});
		return {
			...sheet,
			rows: sheet.rows.map((row, i) =>
				i < start || i > range.rowEnd
					? row
					: row.map((cell, col) =>
							col < range.columnStart || col > range.columnEnd
								? cell
								: (source[i - start]?.[col - range.columnStart] ?? null),
						),
			),
		};
	});
}

export function autoSum(
	workbook: OsWorkbook,
	sheetId: string,
	range: WorkbookRange,
): OsWorkbook {
	return changeSheet(workbook, sheetId, (sheet) => {
		const rows = sheet.rows.map((row) => [...row]);
		const numeric = (r: number, c: number) =>
			typeof rows[r]?.[c]?.value === "number";
		const put = (
			r: number,
			c: number,
			fromR: number,
			fromC: number,
			toR: number,
			toC: number,
		) => {
			if (r >= 1000) return;
			while (rows.length <= r) rows.push(sheet.columns.map(emptyCell));
			rows[r]![c] = {
				...(rows[r]?.[c] ?? emptyCell()),
				input: `=SUM(${columnLabel(fromC)}${fromR + 1}:${columnLabel(toC)}${toR + 1})`,
			};
		};
		if (
			range.rowStart === range.rowEnd &&
			range.columnStart === range.columnEnd
		) {
			const r = range.rowStart,
				c = range.columnStart;
			let top = r - 1;
			while (top >= 0 && numeric(top, c)) top--;
			if (top < r - 1) put(r, c, top + 1, c, r - 1, c);
			else {
				let left = c - 1;
				while (left >= 0 && numeric(r, left)) left--;
				if (left < c - 1) put(r, c, r, left + 1, r, c - 1);
			}
		} else {
			for (let c = range.columnStart; c <= range.columnEnd; c++) {
				let top = range.rowStart;
				while (top <= range.rowEnd && !numeric(top, c)) top++;
				if (top <= range.rowEnd)
					put(range.rowEnd + 1, c, top, c, range.rowEnd, c);
			}
		}
		return { ...sheet, rows };
	});
}

export function renameSheet(
	workbook: OsWorkbook,
	sheetId: string,
	name: string,
): OsWorkbook {
	const previous = workbook.sheets.find((sheet) => sheet.id === sheetId);
	const trimmed = name.trim().slice(0, 120);
	if (
		!previous ||
		!trimmed ||
		workbook.sheets.some(
			(sheet) =>
				sheet.id !== sheetId &&
				sheet.name.toLowerCase() === trimmed.toLowerCase(),
		)
	)
		return workbook;
	const prefix = `'${trimmed.replaceAll("'", "''")}'!`;
	return {
		...workbook,
		sheets: workbook.sheets.map((sheet) => ({
			...sheet,
			name: sheet.id === sheetId ? trimmed : sheet.name,
			rows: sheet.rows.map((row) =>
				row.map((cell) =>
					cell
						? {
								...cell,
								input: cell.input.startsWith("=")
									? cell.input.replace(
											REFERENCE,
											(whole, literal, qualifier) =>
												!literal &&
												qualifier &&
												sheetName(qualifier).toLowerCase() ===
													previous.name.toLowerCase()
													? prefix + whole.slice(qualifier.length)
													: whole,
										)
									: cell.input,
							}
						: null,
				),
			),
		})),
	};
}
export function duplicateSheet(
	workbook: OsWorkbook,
	sheetId: string,
	id = `sheet-${crypto.randomUUID()}`,
): OsWorkbook {
	const sheet = workbook.sheets.find((item) => item.id === sheetId);
	if (
		!sheet ||
		workbook.sheets.length >= 32 ||
		workbook.sheets.some((item) => item.id === id)
	)
		return workbook;
	let name = `${sheet.name.slice(0, 108)} copy`,
		suffix = 2;
	while (
		workbook.sheets.some(
			(item) => item.name.toLowerCase() === name.toLowerCase(),
		)
	)
		name = `${sheet.name.slice(0, 108)} copy ${suffix++}`;
	const copy = structuredClone(sheet);
	copy.id = id;
	copy.name = name;
	return {
		...workbook,
		activeSheetId: id,
		sheets: workbook.sheets.flatMap((item) =>
			item.id === sheetId ? [item, copy] : [item],
		),
	};
}
export function deleteSheet(workbook: OsWorkbook, sheetId: string): OsWorkbook {
	const sheet = workbook.sheets.find((item) => item.id === sheetId);
	if (!sheet || workbook.sheets.length <= 1) return workbook;
	const sheets = workbook.sheets
		.filter((item) => item.id !== sheetId)
		.map((owner) => ({
			...owner,
			rows: owner.rows.map((row) =>
				row.map((cell) =>
					cell?.input.startsWith("=")
						? {
								...cell,
								input: cell.input.replace(
									REFERENCE,
									(whole, literal, prefix) =>
										!literal &&
										prefix &&
										sheetName(prefix).toLowerCase() === sheet.name.toLowerCase()
											? "#REF!"
											: whole,
								),
							}
						: cell,
				),
			),
		}));
	return {
		...workbook,
		sheets,
		activeSheetId:
			workbook.activeSheetId === sheetId
				? sheets[0]!.id
				: workbook.activeSheetId,
	};
}
