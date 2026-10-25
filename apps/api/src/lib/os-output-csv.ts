import type {
	OsOutputContent,
	OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";
import { createZip } from "./ooxml/zip";

function csv(rows: OsSheetCell[][]): Uint8Array {
	return new TextEncoder().encode(
		rows
			.map((row) =>
				row
					.map((value) => {
						let text = value === null ? "" : String(value);
						// CSV quoting alone does not stop spreadsheet formula evaluation.
						// Prefix text (including headers) with an apostrophe for = + - @
						// and fullwidth equivalents, even after whitespace/control characters,
						// or for a leading tab/CR/LF. Preserve the original text and typed numbers.
						if (
							typeof value === "string" &&
							/^[\s\p{Cc}]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(value)
						)
							text = `'${value}`;
						return /[",\r\n]/.test(text)
							? `"${text.replaceAll('"', '""')}"`
							: text;
					})
					.join(","),
			)
			.join("\r\n") + (rows.length ? "\r\n" : ""),
	);
}

export async function buildOsSheetCsv(
	content: Extract<OsOutputContent, { kind: "sheet" }>,
): Promise<{
	bytes: Uint8Array;
	extension: "csv" | "zip";
	contentType: string;
}> {
	const sheets = content.workbook?.sheets.map((sheet) => ({
		name: sheet.name,
		rows: [
			sheet.columns.map((column) => column.label),
			...sheet.rows.map((row) =>
				sheet.columns.map((_, index) => row[index]?.value ?? null),
			),
		],
	})) ?? [{ name: "Sheet1", rows: [content.columns, ...content.rows] }];
	if (sheets.length === 1)
		return {
			bytes: csv(sheets[0]!.rows),
			extension: "csv",
			contentType: "text/csv; charset=utf-8",
		};
	// Prefix the ordinal so duplicate names and sanitized names never collide.
	const bytes = await createZip(
		sheets.map((sheet, index) => ({
			name: `${index + 1}-${sheet.name.replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, 100) || "Sheet"}.csv`,
			data: csv(sheet.rows),
		})),
	);
	return { bytes, extension: "zip", contentType: "application/zip" };
}
