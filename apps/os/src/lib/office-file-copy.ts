import type {
	OsDocumentBlock,
	OsOutputContent,
	OsWorkbookCell,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import { richTextFromBlocks } from "@tedix/api-contract/utils/os-document";
import {
	OS_DECK_MAX_SLIDES,
	OS_SHEET_CELL_MAX_LENGTH,
	OS_SHEET_MAX_COLUMNS,
	OS_SHEET_MAX_ROWS,
} from "@tedix/api-contract/utils/os-output-limits";
import type {
	OfficeCell,
	OfficeFileContent,
} from "@tedix/api-contract/utils/office-file-read";
import { projectWorkbook } from "./output-models";
import { columnLabel } from "./workbook-structure";

export type EditableCopyKind = "document" | "sheet" | "presentation";

export function editableCopyKind(content: OfficeFileContent): EditableCopyKind {
	return content.kind === "slides" ? "presentation" : content.kind;
}

/** "Budget.xlsx" becomes "Budget"; the copy is a Tedix file, not the upload. */
export function editableCopyTitle(filename: string): string {
	return filename.replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Untitled";
}

const clip = (text: string, max: number) =>
	text.length > max ? text.slice(0, max) : text;

/** Text the sheet would read as a number, a boolean or a formula stays text. */
function workbookCell(value: OfficeCell, formula?: string): OsWorkbookCell {
	if (formula !== undefined)
		return {
			input: clip(`=${formula}`, OS_SHEET_CELL_MAX_LENGTH),
			value:
				typeof value === "string"
					? clip(value, OS_SHEET_CELL_MAX_LENGTH)
					: value,
		};
	if (typeof value !== "string")
		return {
			input: value === null ? "" : String(value).toUpperCase(),
			value,
		};
	const text = clip(value, OS_SHEET_CELL_MAX_LENGTH);
	const trimmed = text.trim();
	const readsAsOther =
		text.startsWith("=") ||
		/^(true|false)$/i.test(trimmed) ||
		(trimmed !== "" && Number.isFinite(Number(trimmed)));
	return {
		input: text,
		value: text,
		...(readsAsOther ? { format: { numberFormat: "text" as const } } : {}),
	};
}

function uniqueSheetName(name: string, used: Set<string>, index: number) {
	const base = clip(name.trim() || `Sheet${index + 1}`, 120);
	let candidate = base;
	for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1)
		candidate = `${clip(base, 115)} (${suffix})`;
	used.add(candidate.toLowerCase());
	return candidate;
}

function documentBlocks(
	content: Extract<OfficeFileContent, { kind: "document" }>,
): OsDocumentBlock[] {
	const blocks: OsDocumentBlock[] = [];
	for (const block of content.blocks) {
		if (block.type === "heading")
			blocks.push({ ...block, text: clip(block.text, 2_000) });
		else if (block.type === "paragraph")
			blocks.push({ type: "paragraph", text: clip(block.text, 20_000) });
		else {
			const width = Math.min(
				64,
				block.rows.reduce((max, row) => Math.max(max, row.length), 1),
			);
			const pad = (row: string[]) =>
				Array.from({ length: width }, (_, index) =>
					clip(row[index] ?? "", 4_000),
				);
			const [head = [], ...rest] = block.rows;
			// A long table continues as further tables under the same header row.
			for (let start = 0; start === 0 || start < rest.length; start += 1_000)
				blocks.push({
					type: "table",
					headers: pad(head),
					rows: rest.slice(start, start + 1_000).map(pad),
				});
		}
	}
	return blocks.slice(0, 10_000);
}

/**
 * An editable Tedix sheet, doc or slides body for a read upload, in the shapes
 * the create path accepts: a workbook keeps every sheet, values and formulas;
 * a doc keeps headings, paragraphs and tables; slides keep titles, text and
 * speaker notes.
 */
export function editableCopyContent(
	content: OfficeFileContent,
): OsOutputContent {
	if (content.kind === "sheet") {
		const used = new Set<string>();
		const sheets: OsWorkbookSheet[] = content.sheets.map((sheet, index) => {
			const rows = sheet.rows.slice(0, OS_SHEET_MAX_ROWS);
			const width = Math.min(
				OS_SHEET_MAX_COLUMNS,
				Math.max(
					1,
					rows.reduce((max, row) => Math.max(max, row.length), 0),
				),
			);
			const formulas = new Map(
				sheet.formulas.map((entry) => [
					`${entry.row}:${entry.column}`,
					entry.formula,
				]),
			);
			return {
				id: `sheet-${index + 1}`,
				name: uniqueSheetName(sheet.name, used, index),
				columns: Array.from({ length: width }, (_, column) => ({
					id: `column-${column + 1}`,
					label: columnLabel(column),
					width: 120,
				})),
				rows: rows.map((row, rowIndex) =>
					Array.from({ length: width }, (_, column) =>
						workbookCell(
							row[column] ?? null,
							formulas.get(`${rowIndex}:${column}`),
						),
					),
				),
				frozenRows: 0,
				frozenColumns: 0,
			};
		});
		return projectWorkbook({ activeSheetId: sheets[0]!.id, sheets });
	}
	if (content.kind === "document") {
		const blocks = documentBlocks(content);
		return { kind: "document", blocks, richText: richTextFromBlocks(blocks) };
	}
	return {
		kind: "presentation",
		slides: content.slides.slice(0, OS_DECK_MAX_SLIDES).map((slide, index) => ({
			title: clip(slide.title || `Slide ${index + 1}`, 300),
			bullets: slide.text.slice(0, 30).map((line) => clip(line, 2_000)),
			...(slide.notes ? { notes: clip(slide.notes, 4_000) } : {}),
		})),
	};
}
