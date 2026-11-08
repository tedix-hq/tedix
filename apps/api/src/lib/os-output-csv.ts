import { sheetCsvText } from "@tedix/api-contract/utils/sheet-csv";
import type {
	OsOutputContent,
	OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createZip } from "./ooxml/zip";

/** Formula-injection-safe CSV (CRLF rows), shared by every CSV export. */
export function encodeCsv(rows: OsSheetCell[][]): Uint8Array {
	return new TextEncoder().encode(sheetCsvText(rows));
}

export async function buildOsSheetCsv(
	content: Extract<OsOutputContent, { kind: "sheet" }>,
	sheetId?: string,
): Promise<{
	bytes: Uint8Array;
	extension: "csv" | "zip";
	contentType: string;
}> {
	let sheets = content.workbook?.sheets.map((sheet) => ({
		id: sheet.id,
		name: sheet.name,
		rows: [
			sheet.columns.map((column) => column.label),
			...sheet.rows.map((row) =>
				sheet.columns.map((_, index) => row[index]?.value ?? null),
			),
		],
	})) ?? [{ id: "", name: "Sheet1", rows: [content.columns, ...content.rows] }];
	if (sheetId) sheets = sheets.filter((sheet) => sheet.id === sheetId);
	if (sheets.length === 1)
		return {
			bytes: encodeCsv(sheets[0]!.rows),
			extension: "csv",
			contentType: "text/csv; charset=utf-8",
		};
	// Prefix the ordinal so duplicate names and sanitized names never collide.
	const bytes = await createZip(
		sheets.map((sheet, index) => ({
			name: `${index + 1}-${sheet.name.replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, 100) || "Sheet"}.csv`,
			data: encodeCsv(sheet.rows),
		})),
	);
	return { bytes, extension: "zip", contentType: "application/zip" };
}
