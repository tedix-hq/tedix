/**
 * `.xlsx` (SpreadsheetML) written straight from a sheet output's content model.
 *
 * The point of this path is that a spreadsheet leaves Tedix as a spreadsheet:
 * typed cells, the author's formulas, every sheet of a workbook, its frozen
 * panes and its column widths. A screenshot or a printed page carries none of
 * that, which is why the export cannot go through Browser Rendering.
 */

import type {
	OsOutputContent,
	OsSheetCell,
	OsWorkbookCell,
	OsWorkbookCellFormat,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createZip, relationships, xmlEscape, xmlPart } from "./zip";

type SheetContent = Extract<OsOutputContent, { kind: "sheet" }>;

const MAIN_NS =
	"http://schemas.openxmlformats.org/spreadsheetml/2006/main" as const;
const REL_NS =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships" as const;

/** A1-style column name for a zero-based column index. */
export function columnName(index: number): string {
	let name = "";
	let cursor = index;
	while (cursor >= 0) {
		name = String.fromCharCode(65 + (cursor % 26)) + name;
		cursor = Math.floor(cursor / 26) - 1;
	}
	return name;
}

/**
 * Excel refuses `[]:*?/\` in a sheet name, caps it at 31 characters, and
 * refuses an empty one.
 */
function sheetName(raw: string, fallback: string): string {
	const cleaned = raw
		.replace(/[[\]:*?/\\]/g, " ")
		.trim()
		.slice(0, 31);
	return cleaned.length > 0 ? cleaned : fallback;
}

/** `#rrggbb` (or `rrggbb`) to the ARGB hex an OOXML color attribute wants. */
function argb(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
	return match ? `FF${match[1]!.toUpperCase()}` : undefined;
}

/** Built-in `numFmtId`s, so no custom `numFmts` table is needed. */
const NUMBER_FORMAT_IDS: Record<string, number> = {
	automatic: 0,
	number: 2,
	currency: 44,
	percent: 10,
	scientific: 11,
	date: 14,
	time: 21,
};

/**
 * The style table. Index 0 is the default cell and index 1 is the bold header
 * row; every distinct cell format in the workbook is interned after those.
 */
class StyleTable {
	private fonts = [
		'<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>',
		'<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>',
	];
	// Indices 0 and 1 are reserved by the format: Excel rejects a fills table
	// that does not begin with `none` and `gray125`.
	private fills = [
		'<fill><patternFill patternType="none"/></fill>',
		'<fill><patternFill patternType="gray125"/></fill>',
	];
	private xfs = [
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
		'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
	];
	private interned = new Map<string, number>();

	/** Style index for a cell format, creating the font/fill/xf if needed. */
	indexFor(format: OsWorkbookCellFormat | undefined): number {
		if (!format) return 0;
		const key = JSON.stringify([
			format.bold ?? false,
			format.italic ?? false,
			format.underline ?? false,
			format.strike ?? false,
			format.textColor ?? "",
			format.fillColor ?? "",
			format.horizontalAlign ?? "",
			format.wrap ?? false,
			format.numberFormat ?? "",
		]);
		const existing = this.interned.get(key);
		if (existing !== undefined) return existing;

		const textArgb = argb(format.textColor);
		const fontParts = [
			format.bold ? "<b/>" : "",
			format.italic ? "<i/>" : "",
			format.underline ? "<u/>" : "",
			format.strike ? "<strike/>" : "",
			'<sz val="11"/>',
			textArgb ? `<color rgb="${textArgb}"/>` : '<color theme="1"/>',
			'<name val="Calibri"/>',
		].join("");
		const fontId = this.fonts.push(`<font>${fontParts}</font>`) - 1;

		const fillArgb = argb(format.fillColor);
		const fillId = fillArgb
			? this.fills.push(
					`<fill><patternFill patternType="solid"><fgColor rgb="${fillArgb}"/><bgColor indexed="64"/></patternFill></fill>`,
				) - 1
			: 0;

		const numFmtId = NUMBER_FORMAT_IDS[format.numberFormat ?? "automatic"] ?? 0;
		const alignment =
			format.horizontalAlign || format.wrap
				? `<alignment${format.horizontalAlign ? ` horizontal="${format.horizontalAlign}"` : ""}${
						format.wrap ? ' wrapText="1"' : ""
					}/>`
				: "";
		const attrs = [
			`numFmtId="${numFmtId}"`,
			`fontId="${fontId}"`,
			`fillId="${fillId}"`,
			'borderId="0"',
			'xfId="0"',
			'applyFont="1"',
			fillId > 0 ? 'applyFill="1"' : "",
			numFmtId > 0 ? 'applyNumberFormat="1"' : "",
			alignment ? 'applyAlignment="1"' : "",
		]
			.filter(Boolean)
			.join(" ");
		const index =
			this.xfs.push(
				alignment ? `<xf ${attrs}>${alignment}</xf>` : `<xf ${attrs}/>`,
			) - 1;
		this.interned.set(key, index);
		return index;
	}

	render(): string {
		return (
			`<styleSheet xmlns="${MAIN_NS}">` +
			`<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts>` +
			`<fills count="${this.fills.length}">${this.fills.join("")}</fills>` +
			'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
			'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			`<cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>` +
			'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
			"</styleSheet>"
		);
	}
}

/** One `<c>` element, or "" for a cell the sheet should simply not carry. */
function cellXml(
	reference: string,
	styleIndex: number,
	cell: OsWorkbookCell | null,
): string {
	if (!cell) return "";
	const style = styleIndex > 0 ? ` s="${styleIndex}"` : "";
	const input = cell.input ?? "";
	if (input.startsWith("=")) {
		const formula = xmlEscape(input.slice(1));
		// The cached value is what a reader shows before it recalculates; a
		// string result needs `t="str"` or Excel reads it as a number.
		const cached = cachedValueXml(cell.value);
		return `<c r="${reference}"${style}${cached.type}><f>${formula}</f>${cached.value}</c>`;
	}
	return literalCellXml(reference, style, cell.value);
}

function cachedValueXml(value: OsSheetCell): { type: string; value: string } {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { type: "", value: `<v>${value}</v>` };
	}
	if (typeof value === "boolean") {
		return { type: ' t="b"', value: `<v>${value ? 1 : 0}</v>` };
	}
	if (typeof value === "string" && value.length > 0) {
		return { type: ' t="str"', value: `<v>${xmlEscape(value)}</v>` };
	}
	return { type: "", value: "" };
}

function literalCellXml(
	reference: string,
	style: string,
	value: OsSheetCell,
): string {
	if (value === null || value === undefined) {
		// An empty cell still needs its element when it carries formatting,
		// otherwise the fill or number format would be lost.
		return style ? `<c r="${reference}"${style}/>` : "";
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			return `<c r="${reference}"${style} t="e"><v>#NUM!</v></c>`;
		}
		return `<c r="${reference}"${style}><v>${value}</v></c>`;
	}
	if (typeof value === "boolean") {
		return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
	}
	return (
		`<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">` +
		`${xmlEscape(value)}</t></is></c>`
	);
}

interface NormalizedSheet {
	name: string;
	columns: Array<{ label: string; width: number }>;
	rows: Array<Array<OsWorkbookCell | null>>;
	frozenRows: number;
	frozenColumns: number;
}

/**
 * Collapse both shapes of the sheet model onto one. A workbook body is
 * authoritative when present — it is the one that carries formulas, formats
 * and the other sheets; `columns`/`rows` only mirror the active sheet.
 */
function normalizeSheets(content: SheetContent): NormalizedSheet[] {
	if (content.workbook && content.workbook.sheets.length > 0) {
		return content.workbook.sheets.map((sheet, index) => ({
			name: sheetName(sheet.name, `Sheet${index + 1}`),
			columns: sheet.columns.map((column) => ({
				label: column.label,
				width: column.width ?? 120,
			})),
			rows: sheet.rows,
			frozenRows: sheet.frozenRows ?? 0,
			frozenColumns: sheet.frozenColumns ?? 0,
		}));
	}
	return [
		{
			name: "Sheet1",
			columns: content.columns.map((label) => ({ label, width: 120 })),
			// The flat model has no formula concept: every value is a literal,
			// so a leading `=` stays text rather than becoming a formula the
			// author never wrote.
			rows: content.rows.map((row) =>
				row.map((value) => ({ input: "", value })),
			),
			frozenRows: 0,
			frozenColumns: 0,
		},
	];
}

function worksheetXml(sheet: NormalizedSheet, styles: StyleTable): string {
	const width = Math.max(
		sheet.columns.length,
		...sheet.rows.map((row) => row.length),
		1,
	);
	const rowsXml: string[] = [];
	if (sheet.columns.length > 0) {
		const header = sheet.columns
			.map((column, index) =>
				literalCellXml(`${columnName(index)}1`, ' s="1"', column.label),
			)
			.join("");
		rowsXml.push(`<row r="1">${header}</row>`);
	}
	const firstDataRow = sheet.columns.length > 0 ? 2 : 1;
	for (const [rowIndex, row] of sheet.rows.entries()) {
		const reference = firstDataRow + rowIndex;
		const cells = row
			.map((cell, columnIndex) =>
				cellXml(
					`${columnName(columnIndex)}${reference}`,
					styles.indexFor(cell?.format),
					cell ?? null,
				),
			)
			.join("");
		if (cells.length > 0) rowsXml.push(`<row r="${reference}">${cells}</row>`);
	}

	const lastRow = firstDataRow + sheet.rows.length - 1;
	const dimension = `<dimension ref="A1:${columnName(width - 1)}${Math.max(lastRow, 1)}"/>`;

	// `frozenRows` counts data rows, and the header occupies row 1, so the
	// split is one row lower than the model's count.
	const ySplit = sheet.frozenRows + (sheet.columns.length > 0 ? 1 : 0);
	const xSplit = sheet.frozenColumns;
	const pane =
		ySplit > 0 || xSplit > 0
			? `<pane${xSplit > 0 ? ` xSplit="${xSplit}"` : ""}${
					ySplit > 0 ? ` ySplit="${ySplit}"` : ""
				} topLeftCell="${columnName(xSplit)}${ySplit + 1}" activePane="bottomRight" state="frozen"/>`
			: "";
	const cols =
		sheet.columns.length > 0
			? `<cols>${sheet.columns
					.map(
						(column, index) =>
							`<col min="${index + 1}" max="${index + 1}" width="${(
								column.width / 7
							).toFixed(2)}" customWidth="1"/>`,
					)
					.join("")}</cols>`
			: "";

	return (
		`<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
		dimension +
		`<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
		'<sheetFormatPr defaultRowHeight="15"/>' +
		cols +
		`<sheetData>${rowsXml.join("")}</sheetData>` +
		"</worksheet>"
	);
}

/** Build the `.xlsx` bytes for a sheet output's current revision. */
export async function buildXlsx(content: SheetContent): Promise<Uint8Array> {
	const sheets = normalizeSheets(content);
	const styles = new StyleTable();
	const worksheets = sheets.map((sheet) => worksheetXml(sheet, styles));

	const sheetOverrides = sheets
		.map(
			(_sheet, index) =>
				`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		)
		.join("");

	const workbookRels = relationships([
		...sheets.map((_sheet, index) => ({
			id: `rId${index + 1}`,
			type: `${REL_NS}/worksheet`,
			target: `worksheets/sheet${index + 1}.xml`,
		})),
		{
			id: `rId${sheets.length + 1}`,
			type: `${REL_NS}/styles`,
			target: "styles.xml",
		},
	]);

	const workbook =
		`<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
		"<workbookPr/><bookViews><workbookView/></bookViews>" +
		`<sheets>${sheets
			.map(
				(sheet, index) =>
					`<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
			)
			.join("")}</sheets>` +
		"</workbook>";

	return createZip([
		xmlPart(
			"[Content_Types].xml",
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				sheetOverrides +
				'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
				"</Types>",
		),
		xmlPart(
			"_rels/.rels",
			relationships([
				{
					id: "rId1",
					type: `${REL_NS}/officeDocument`,
					target: "xl/workbook.xml",
				},
			]),
		),
		xmlPart("xl/workbook.xml", workbook),
		xmlPart("xl/_rels/workbook.xml.rels", workbookRels),
		xmlPart("xl/styles.xml", styles.render()),
		...worksheets.map((xml, index) =>
			xmlPart(`xl/worksheets/sheet${index + 1}.xml`, xml),
		),
	]);
}
