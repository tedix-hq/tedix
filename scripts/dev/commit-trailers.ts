/**
 * The commit-msg hook: keep provenance trailers in one final paragraph.
 *
 * WHY. Git reads trailers from the last paragraph only, and the pre-push
 * secret scan (scripts/oss/secret-scan.ts, rule `commit-trailer`) requires
 * `Work-Item:` and `Agent-Session:` there. Lane harnesses often commit with
 * one `-m` per trailer, which puts a blank line between them; the scan then
 * refused the push and the lane's finished fix never landed (Work 5c20c5a6,
 * 47b29112, 85352c57). This hook joins trailing paragraphs that hold only
 * provenance trailers. It never edits a trailer's value, never drops or
 * dedupes one, and leaves every other message untouched, so the scan's
 * checks on ids, duplicates and secrets still apply to what was written.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PROVENANCE_TRAILER =
	/^(?:Work-Item|Agent-Session|Co-Authored-By|Claude-Session|Signed-off-by|Ops-Overlay):[ \t]*\S/i;

/** Git's own comment lines (`#`) end the message it keeps; leave them as they are. */
export function joinTrailerParagraphs(message: string): string {
	const lines = message.split("\n");
	let end = lines.length;
	while (
		end > 0 &&
		(lines[end - 1]?.trim() === "" || /^#/.test(lines[end - 1] ?? ""))
	)
		end--;
	const body = lines.slice(0, end);
	const tail = lines.slice(end);
	const paragraphs: string[][] = [[]];
	for (const line of body) {
		if (line.trim() === "") {
			if ((paragraphs.at(-1) ?? []).length > 0) paragraphs.push([]);
		} else paragraphs.at(-1)?.push(line);
	}
	if ((paragraphs.at(-1) ?? []).length === 0) paragraphs.pop();
	let first = paragraphs.length;
	// Never fold the subject (paragraph 0) into the trailers.
	while (
		first > 1 &&
		(paragraphs[first - 1] ?? []).every((line) => PROVENANCE_TRAILER.test(line))
	)
		first--;
	if (paragraphs.length - first < 2) return message;
	const kept = paragraphs
		.slice(0, first)
		.map((paragraph) => paragraph.join("\n"));
	const trailers = paragraphs.slice(first).flat().join("\n");
	return [[...kept, trailers].join("\n\n"), ...tail].join("\n");
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: commit-trailers.ts <commit message file>");
		process.exit(2);
	}
	const message = readFileSync(file, "utf8");
	const joined = joinTrailerParagraphs(message);
	if (joined !== message) writeFileSync(file, joined);
}
