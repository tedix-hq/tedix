import type { OsDocumentBlock } from "../schemas/os-workspaces";
import type { OfficeCell, OfficeFileContent } from "./office-file-read";

/**
 * How much of an uploaded file is kept as readable text beside it. Agents and
 * other readers get this bounded extract; the editable copy reads the file.
 */
export const OFFICE_EXTRACT_LIMITS = {
	rowsPerSheet: 200,
	/** Data columns per table; one more column holds the row number. */
	columns: 63,
	chars: 50_000,
	blocks: 1_000,
};

export function spreadsheetColumnLabel(index: number): string {
	let label = "";
	for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
		label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
	return label;
}

export function officeCellText(cell: OfficeCell): string {
	if (cell === null) return "";
	if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
	return String(cell);
}

function clip(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Document blocks for a read file, bounded by OFFICE_EXTRACT_LIMITS. A sheet
 * becomes one table per sheet with spreadsheet column letters and row numbers,
 * so a reader can name cells the way the file does. A note says what was left out.
 */
export function officeExtractBlocks(
	content: OfficeFileContent,
): OsDocumentBlock[] {
	const blocks: OsDocumentBlock[] = [];
	let chars = 0;
	let full = false;
	const room = (text: string) => {
		if (
			chars + text.length > OFFICE_EXTRACT_LIMITS.chars ||
			blocks.length >= OFFICE_EXTRACT_LIMITS.blocks
		) {
			full = true;
			return false;
		}
		chars += text.length;
		return true;
	};
	const tableRows = (rows: string[][]) => {
		const kept: string[][] = [];
		for (const row of rows) {
			if (!room(row.join(" "))) break;
			kept.push(row);
		}
		return kept;
	};
	if (content.kind === "sheet") {
		for (const sheet of content.sheets) {
			if (full) break;
			if (content.sheets.length > 1 || content.format === "xlsx") {
				if (!room(sheet.name)) break;
				blocks.push({
					type: "heading",
					level: 2,
					text: clip(sheet.name, 2_000),
				});
			}
			if (sheet.rows.length === 0) {
				blocks.push({ type: "paragraph", text: "This sheet is empty." });
				continue;
			}
			const widest = sheet.rows.reduce(
				(max, row) => Math.max(max, row.length),
				1,
			);
			const width = Math.min(OFFICE_EXTRACT_LIMITS.columns, widest);
			const shown = sheet.rows.slice(0, OFFICE_EXTRACT_LIMITS.rowsPerSheet);
			const rows = tableRows(
				shown.map((row, index) => [
					String(index + 1),
					...Array.from({ length: width }, (_, column) =>
						clip(officeCellText(row[column] ?? null), 4_000),
					),
				]),
			);
			blocks.push({
				type: "table",
				headers: [
					"Row",
					...Array.from({ length: width }, (_, column) =>
						spreadsheetColumnLabel(column),
					),
				],
				rows,
			});
			const notes = [
				rows.length < sheet.rows.length
					? `Showing rows 1 to ${rows.length} of ${sheet.rows.length}.`
					: "",
				widest > width
					? `Showing columns A to ${spreadsheetColumnLabel(width - 1)} of ${spreadsheetColumnLabel(widest - 1)}.`
					: "",
			].filter(Boolean);
			if (notes.length)
				blocks.push({
					type: "paragraph",
					text: `${notes.join(" ")} Make an editable copy to work with every cell.`,
				});
		}
	} else if (content.kind === "document") {
		for (const block of content.blocks) {
			if (block.type === "table") {
				const width = Math.min(
					64,
					Math.max(...block.rows.map((row) => row.length), 1),
				);
				const pad = (row: string[]) =>
					Array.from({ length: width }, (_, index) =>
						clip(row[index] ?? "", 4_000),
					);
				const [head = [], ...rest] = block.rows;
				if (!room(head.join(" "))) break;
				blocks.push({
					type: "table",
					headers: pad(head),
					rows: tableRows(rest.slice(0, 1_000).map(pad)),
				});
			} else {
				if (!room(block.text)) break;
				blocks.push(
					block.type === "heading"
						? { ...block, text: clip(block.text, 2_000) }
						: { type: "paragraph", text: clip(block.text, 20_000) },
				);
			}
			if (full) break;
		}
	} else {
		for (const [index, slide] of content.slides.entries()) {
			const title = slide.title
				? `Slide ${index + 1}: ${slide.title}`
				: `Slide ${index + 1}`;
			if (!room(title)) break;
			blocks.push({ type: "heading", level: 2, text: clip(title, 2_000) });
			const items: string[] = [];
			for (const line of slide.text.slice(0, 200)) {
				if (!room(line)) break;
				items.push(clip(line, 2_000));
			}
			if (items.length) blocks.push({ type: "list", ordered: false, items });
			if (slide.notes && room(slide.notes))
				blocks.push({
					type: "paragraph",
					text: clip(`Speaker notes: ${slide.notes}`, 20_000),
				});
			if (full) break;
		}
	}
	if (full || content.truncated)
		blocks.push({
			type: "paragraph",
			text: "This is the start of the file only. Make an editable copy to work with all of it.",
		});
	return blocks;
}

/** Plain text of extracted blocks, with tables as pipe-separated rows. */
export function officeExtractText(blocks: readonly OsDocumentBlock[]): string {
	return blocks
		.map((block) => {
			switch (block.type) {
				case "heading":
					return `${"#".repeat(block.level)} ${block.text}`;
				case "table":
					return [block.headers, ...block.rows]
						.map(
							(row) =>
								`| ${row.map((cell) => cell.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|")).join(" | ")} |`,
						)
						.join("\n");
				case "list":
					return block.items.map((item) => `- ${item}`).join("\n");
				case "paragraph":
					return block.text;
				default:
					return "";
			}
		})
		.filter(Boolean)
		.join("\n\n");
}
