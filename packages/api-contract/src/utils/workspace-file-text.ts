import * as z from "zod";
import { officeCellText, spreadsheetColumnLabel } from "./office-file-blocks";
import type { OfficeFileContent } from "./office-file-read";

/**
 * The whole readable text of an uploaded file, kept beside the file when it is
 * uploaded so an agent can read any part of it later, a few lines at a time.
 * The API writes it; the workspace object reads it.
 */
export const WorkspaceFileTextSchema = z.object({
	status: z.enum([
		// The file's text is in `text`.
		"text",
		// A PDF whose pages hold no text, such as a scan.
		"no_text",
		// Not a kind of file that has text to read (an image, a video).
		"unsupported",
		"too_large",
		// The file could not be read: damaged, protected, or the reader failed.
		"failed",
		// The organization's data location rules do not allow the conversion.
		"not_allowed",
	]),
	text: z.string(),
});
export type WorkspaceFileText = z.infer<typeof WorkspaceFileTextSchema>;

/** Text past this length is not kept; a last line says so. */
export const WORKSPACE_FILE_TEXT_MAX_CHARS = 4_000_000;

export function workspaceFileTextKey(
	organizationId: string,
	workspaceId: string,
	resourceId: string,
	chatOnly?: true,
) {
	return `${chatOnly ? "workspace-chat-file-text" : "workspace-file-text"}/v1/${encodeURIComponent(organizationId)}/${workspaceId}/${resourceId}.json`;
}

const CUT_NOTE =
	"[The text of this file is longer than what is kept here. The rest is not available.]";
const INCOMPLETE_NOTE =
	"[The file is larger than what can be read. The text stops here.]";

/** Joins lines up to the kept length, ending with a note when some are dropped. */
export function boundedFileText(lines: Iterable<string>, incomplete = false) {
	const kept: string[] = [];
	let chars = 0;
	let cut = false;
	for (const line of lines) {
		if (chars + line.length + 1 > WORKSPACE_FILE_TEXT_MAX_CHARS) {
			cut = true;
			break;
		}
		kept.push(line);
		chars += line.length + 1;
	}
	while (kept.at(-1) === "") kept.pop();
	if (cut) kept.push("", CUT_NOTE);
	else if (incomplete) kept.push("", INCOMPLETE_NOTE);
	return kept.join("\n");
}

const TEXT_EXTENSIONS = new Set(
	(
		"txt text log md markdown mdx rst adoc tex json jsonl ndjson json5 yaml yml toml xml " +
		"ini cfg conf env properties html htm css scss less js mjs cjs jsx ts mts cts tsx " +
		"vue svelte astro py rb php go rs java kt swift c h cc cpp hpp cs m scala lua pl r " +
		"dart ex exs erl hs clj sh bash zsh fish ps1 bat sql graphql gql proto tf diff patch " +
		"srt vtt"
	).split(" "),
);

/** A declared type that names text: text/*, or JSON, XML, YAML, Markdown or script source. */
export function isTextMimeType(mimeType: string) {
	const mime = mimeType.toLowerCase();
	if (mime.startsWith("image/")) return false;
	return (
		mime.startsWith("text/") ||
		/\b(json|javascript|typescript|xml|yaml|toml|markdown)\b/.test(mime)
	);
}

/**
 * Whether a file is expected to hold plain text, by its name and then its
 * declared type. Browsers give many code and config files no type or a wrong
 * one, so the name comes first. The bytes still decide: see `decodeTextFile`.
 */
export function isTextFile(filename: string, mimeType?: string) {
	const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
	return (
		(extension !== undefined && TEXT_EXTENSIONS.has(extension)) ||
		(mimeType !== undefined && isTextMimeType(mimeType))
	);
}

/**
 * The text of a file's bytes, or null when they are not text: a zero byte or
 * anything that is not valid UTF-8. Nothing is guessed or replaced, so binary
 * content is never shown as garbled text. A leading byte order mark is dropped.
 */
export function decodeTextFile(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		return null;
	}
}

/** A text file's lines, kept up to the same length as any other file's text. */
export function plainFileText(text: string) {
	return boundedFileText(text.split(/\r\n|\r|\n/));
}

function tableLine(cells: string[]) {
	return `| ${cells.map((cell) => cell.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|")).join(" | ")} |`;
}

/**
 * Every row, paragraph and slide of a read file as lines of text. A sheet row
 * is one line that starts with its spreadsheet row number, under a line of
 * column letters, so a reader deep in the file can still name a cell.
 */
function* officeFileLines(content: OfficeFileContent): Generator<string> {
	if (content.kind === "sheet") {
		for (const sheet of content.sheets) {
			if (content.sheets.length > 1 || content.format === "xlsx") {
				yield `## ${sheet.name}`;
				yield "";
			}
			if (sheet.rows.length === 0) {
				yield "This sheet is empty.";
				yield "";
				continue;
			}
			const width = sheet.rows.reduce(
				(max, row) => Math.max(max, row.length),
				1,
			);
			yield tableLine([
				"Row",
				...Array.from({ length: width }, (_, column) =>
					spreadsheetColumnLabel(column),
				),
			]);
			for (const [index, row] of sheet.rows.entries())
				yield tableLine([String(index + 1), ...row.map(officeCellText)]);
			yield "";
		}
	} else if (content.kind === "document") {
		for (const block of content.blocks) {
			if (block.type === "table")
				for (const row of block.rows) yield tableLine(row);
			else if (block.type === "heading")
				yield `${"#".repeat(block.level)} ${block.text.replace(/\s*\n\s*/g, " ")}`;
			else yield* block.text.split("\n");
			yield "";
		}
	} else {
		for (const [index, slide] of content.slides.entries()) {
			yield slide.title
				? `## Slide ${index + 1}: ${slide.title.replace(/\s*\n\s*/g, " ")}`
				: `## Slide ${index + 1}`;
			for (const line of slide.text)
				yield `- ${line.replace(/\s*\n\s*/g, " ")}`;
			if (slide.notes)
				yield `Speaker notes: ${slide.notes.replace(/\s*\n\s*/g, " ")}`;
			yield "";
		}
	}
}

export function officeFileText(content: OfficeFileContent): string {
	return boundedFileText(officeFileLines(content), content.truncated);
}
