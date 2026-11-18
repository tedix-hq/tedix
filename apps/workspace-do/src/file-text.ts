/**
 * Reading an uploaded file's text in parts. A long file is never put in front
 * of the model whole: it would be sent again on every later step and could
 * alone fill the model's context. The model gets whole lines up to a fixed
 * size and the line to continue from, and can search for the lines it needs.
 */
import type { WorkspaceFileText } from "@tedix/api-contract/utils/workspace-file-text";

/**
 * Text that attached files may put into one message, shared between them.
 * It is the size of one tool result, so an attachment costs no more than a read.
 */
export const FILE_TEXT_INLINE_CHARS = 32 * 1024;
/** With less room than this left in a message, a file is named, not started. */
export const FILE_TEXT_MIN_INLINE_CHARS = 1_000;
/**
 * One read returns at most this much, counted as it is written into the tool
 * result (a line break or quote there takes two characters), so a part and
 * its line numbers always fit under the 32K tool result limit.
 */
export const FILE_TEXT_PART_CHARS = 28_000;
/** A search stops at this many matching lines and says where to go on. */
export const FILE_TEXT_SEARCH_MATCHES = 100;
/** Each matching line is shown as this many characters around the match. */
export const FILE_TEXT_SEARCH_LINE_CHARS = 240;

export interface FileTextPart {
	text: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	/** The line to continue from; null when the part reaches the end. */
	nextStartLine: number | null;
	/** Set when one line was too long to show whole. */
	note?: string;
}

/** A final line break does not start another line. */
export function fileTextLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

const plainLength = (line: string) => line.length;
/** The length of a piece of text inside a JSON tool result. */
export const encodedLength = (line: string) => JSON.stringify(line).length - 2;

function wholeNumber(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a whole number from 1`);
	return value;
}

/**
 * Whole lines from `startLine` (default 1), at most `lineCount` of them, that
 * fit in `maxChars`. A part always holds at least one line: a first line too
 * long to fit is cut, with a note giving its length.
 */
export function readTextPart(
	lines: readonly string[],
	window: { startLine?: unknown; lineCount?: unknown },
	maxChars: number,
	length: (line: string) => number = plainLength,
): FileTextPart {
	const total = lines.length;
	const first = wholeNumber(window.startLine, "startLine") ?? 1;
	const count = wholeNumber(window.lineCount, "lineCount") ?? total;
	if (total === 0 && first === 1)
		return {
			text: "",
			startLine: 1,
			endLine: 0,
			totalLines: 0,
			nextStartLine: null,
		};
	if (first > total)
		throw new Error(
			`startLine ${first} is past the end of the file, which has ${total} line${total === 1 ? "" : "s"}.`,
		);
	const limit = Math.min(total, first - 1 + count);
	const head = lines[first - 1]!;
	if (length(head) > maxChars) {
		let shown = Math.min(head.length, maxChars);
		while (shown > 0 && length(head.slice(0, shown)) > maxChars)
			shown -= Math.max(1, length(head.slice(0, shown)) - maxChars);
		// Never split a character that takes two code units.
		const code = head.charCodeAt(shown - 1);
		if (code >= 0xd800 && code <= 0xdbff) shown -= 1;
		return {
			text: head.slice(0, shown),
			startLine: first,
			endLine: first,
			totalLines: total,
			nextStartLine: first < total ? first + 1 : null,
			note: `Line ${first} is ${head.length} characters long; only its first ${shown} are shown.`,
		};
	}
	const shown = [head];
	let chars = length(head);
	let last = first;
	while (last < limit) {
		const next = lines[last]!;
		// The line break that joins it counts too.
		const cost = length(next) + length("\n");
		if (chars + cost > maxChars) break;
		shown.push(next);
		chars += cost;
		last += 1;
	}
	return {
		text: shown.join("\n"),
		startLine: first,
		endLine: last,
		totalLines: total,
		nextStartLine: last < total ? last + 1 : null,
	};
}

export interface FileTextSearch {
	totalLines: number;
	matches: Array<{ line: number; text: string }>;
	/** Set when the search stopped early; search again from this line. */
	nextStartLine: number | null;
}

/** Lines that contain `query`, ignoring case, from `startLine` on. */
export function searchTextLines(
	lines: readonly string[],
	input: { query?: unknown; startLine?: unknown },
): FileTextSearch {
	if (typeof input.query !== "string" || !input.query.trim())
		throw new Error("A search needs text");
	const query = input.query.toLowerCase();
	const first = wholeNumber(input.startLine, "startLine") ?? 1;
	const matches: FileTextSearch["matches"] = [];
	for (let index = first - 1; index < lines.length; index += 1) {
		const line = lines[index]!;
		const at = line.toLowerCase().indexOf(query);
		if (at < 0) continue;
		if (matches.length === FILE_TEXT_SEARCH_MATCHES)
			return { totalLines: lines.length, matches, nextStartLine: index + 1 };
		const from = Math.max(
			0,
			Math.min(
				at - Math.floor((FILE_TEXT_SEARCH_LINE_CHARS - query.length) / 2),
				line.length - FILE_TEXT_SEARCH_LINE_CHARS,
			),
		);
		const to = Math.min(line.length, from + FILE_TEXT_SEARCH_LINE_CHARS);
		matches.push({
			line: index + 1,
			text: `${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`,
		});
	}
	return { totalLines: lines.length, matches, nextStartLine: null };
}

/** Why a file has no text to read, in words the model can pass on. */
export function fileTextUnavailable(stored: WorkspaceFileText | null): string {
	switch (stored?.status) {
		case "no_text":
			return "This PDF has no readable text. It is probably a scan or made of images, and text in images cannot be read here.";
		case "unsupported":
			return "This file has no text to read here. Plain text, Markdown, JSON, code and config files, spreadsheets (CSV, XLSX), Word (DOCX), PowerPoint (PPTX) and PDF files can be read; images, video and other files that are not text cannot.";
		case "too_large":
			return "This file is too large to read as text here. The limits are 10 MB for text files, spreadsheets, Word and PowerPoint files and 2 MB for PDF files.";
		case "not_allowed":
			return "This PDF's text cannot be read here: the organization's data location rules do not allow the conversion.";
		case "failed":
			return "The text of this file could not be read. The file may be damaged or protected.";
		default:
			return "The whole text of this file was not kept when it was uploaded, so it cannot be read in parts here. Ask the person to upload the file again.";
	}
}
