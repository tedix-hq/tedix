import type { OsSheetCell } from "../schemas/os-workspaces";

/** CSV quoting plus spreadsheet formula-injection protection; numeric negatives stay numeric. */
export function sheetCsvText(
	rows: readonly (readonly OsSheetCell[])[],
): string {
	return (
		rows
			.map((row) =>
				row
					.map((value) => {
						let text = value === null ? "" : String(value);
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
			.join("\r\n") + (rows.length ? "\r\n" : "")
	);
}
