/**
 * Repo-wide structured code search for the selected computer.
 *
 * Without it every search is a shell round trip of plain `grep`/`find`/`ls`,
 * and a defect with many occurrences gets fixed only at the sites someone
 * named. One bounded,
 * structured tool removes both costs — the round trip and the undercount — so
 * long as three properties hold: omitting `paths` searches the whole tree, an
 * array of paths is one invocation, and skipped files are reported rather than
 * silently dropped.
 */
import { COMPUTER_EXECUTION_STREAM_CHARS } from "./computer-execution-model-output";
import { z } from "zod";

export const CODE_SEARCH_DEFAULT_LIMIT = 100;
export const CODE_SEARCH_MAX_LIMIT = 500;
/**
 * One match line is a preview, not a file read. Derived from the shared
 * execution stream budget so the two bounds move together.
 */
export const CODE_SEARCH_TEXT_CHARS = COMPUTER_EXECUTION_STREAM_CHARS / 20;
export const CODE_SEARCH_TOOL_DESCRIPTION =
	"Search code on the selected computer with ONE structured ripgrep pass. Use this INSTEAD of running grep, rg, find or ls -R through exec: a shell search costs a round trip and returns unstructured text, this returns { matches: [{ file, line, text }], totalMatches, filesWithMatches, truncated, errors }. Omitting paths searches THE WHOLE REPOSITORY, which is usually what you want; pass an ARRAY of paths to cover several places in one call instead of one call each. pattern is a regular expression unless literal is true. Counts are never truncated: totalMatches and filesWithMatches describe every match while matches shows at most limit, so a truncated result still tells you how much is out there, and errors lists files that could not be searched so a silent undercount is impossible. SWEEP CONTRACT: when you fix a defect, first search for every sibling occurrence of the same flaw, fix the class and not just the reported site, and state in your answer how many occurrences you found and how many you changed.";

export const codeSearchInputSchema = z.object({
	pattern: z
		.string()
		.min(1)
		.describe("Regular expression, or an exact string when literal is true."),
	paths: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe(
			"File or directory paths relative to the repository root. OMIT to search the whole repository; pass an array to search several paths in one invocation.",
		),
	literal: z
		.boolean()
		.optional()
		.describe("Treat pattern as an exact string instead of a regex."),
	ignoreCase: z.boolean().optional(),
	glob: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe(
			"Filename filter, e.g. *.ts. A leading ! excludes. Applies to the whole search.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(CODE_SEARCH_MAX_LIMIT)
		.optional()
		.describe(
			`Maximum matches returned (default ${CODE_SEARCH_DEFAULT_LIMIT}). Counts are reported in full regardless.`,
		),
});
export type CodeSearchInput = z.infer<typeof codeSearchInputSchema>;

export interface CodeSearchMatch {
	file: string;
	line: number;
	text: string;
}
export interface CodeSearchError {
	file: string;
	error: string;
}
export interface CodeSearchOutcome {
	matches: CodeSearchMatch[];
	totalMatches: number;
	filesWithMatches: number;
	truncated: boolean;
	errors: CodeSearchError[];
}

export interface NormalizedCodeSearch {
	pattern: string;
	paths: string[];
	globs: string[];
	literal: boolean;
	ignoreCase: boolean;
	limit: number;
}

const list = (value: string | string[] | undefined): string[] =>
	(Array.isArray(value) ? value : value === undefined ? [] : [value])
		.map((entry) => entry.trim())
		.filter(Boolean);

/** An array of paths is deduplicated here so it stays cheaper than separate calls. */
export function normalizeCodeSearchInput(
	input: CodeSearchInput,
): NormalizedCodeSearch {
	const paths = [...new Set(list(input.paths))];
	return {
		pattern: input.pattern,
		paths: paths.length ? paths : ["."],
		globs: [...new Set(list(input.glob))],
		literal: input.literal === true,
		ignoreCase: input.ignoreCase === true,
		limit: Math.min(
			Math.max(Math.trunc(input.limit ?? CODE_SEARCH_DEFAULT_LIMIT), 1),
			CODE_SEARCH_MAX_LIMIT,
		),
	};
}

export const shellQuote = (value: string) =>
	"'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * One ripgrep invocation, bounded by an awk filter that keeps every
 * total. Truncating the match stream must never truncate the counts.
 */
export function buildCodeSearchCommand(search: NormalizedCodeSearch): string {
	const targets = search.paths.map(shellQuote).join(" ");
	const flags = [
		"--json",
		"--hidden",
		"--no-config",
		"--max-columns",
		"2000",
		"--glob",
		shellQuote("!.git/**"),
		...(search.literal ? ["--fixed-strings"] : []),
		...(search.ignoreCase ? ["--ignore-case"] : []),
		...search.globs.flatMap((glob) => ["--glob", shellQuote(glob)]),
	].join(" ");
	const bound = `awk -v limit=${search.limit} '/"type":"match"/ { n++; if (n <= limit) print; next } /"type":"summary"/ { print; next } /"type":"end"/ { if ($0 !~ /"binary_offset":null/) print }'`;
	return `rg ${flags} -e ${shellQuote(search.pattern)} -- ${targets} | ${bound}`;
}
const boundText = (value: string): string => {
	const text = value.replace(/\r?\n$/, "");
	return text.length <= CODE_SEARCH_TEXT_CHARS
		? text
		: `${text.slice(0, CODE_SEARCH_TEXT_CHARS)} [... ${text.length - CODE_SEARCH_TEXT_CHARS} characters omitted ...]`;
};

/** A file the search could not read is reported, never silently dropped. */
export function parseCodeSearchErrors(stderr: string): CodeSearchError[] {
	const errors: CodeSearchError[] = [];
	for (const raw of String(stderr ?? "").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const parsed = /^(?:rg|awk):\s*(.+?):\s*(.+)$/.exec(line);
		errors.push(
			parsed
				? { file: parsed[1]!, error: parsed[2]! }
				: { file: "", error: line },
		);
	}
	return errors;
}

export function parseCodeSearchOutput(
	stdout: string,
	stderr: string,
	limit: number,
): CodeSearchOutcome {
	const matches: CodeSearchMatch[] = [];
	const errors = parseCodeSearchErrors(stderr);
	const files = new Set<string>();
	let totalMatches: number | undefined;
	let filesWithMatches: number | undefined;
	for (const line of String(stdout ?? "").split("\n")) {
		if (!line.trim()) continue;

		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const data = (event.data ?? {}) as Record<string, unknown>;
		const file = String(
			((data.path ?? {}) as Record<string, unknown>).text ?? "",
		);
		if (event.type === "match") {
			files.add(file);
			const text = ((data.lines ?? {}) as Record<string, unknown>).text;
			if (matches.length < limit)
				matches.push({
					file,
					line: Number(data.line_number ?? 0),
					text: boundText(
						typeof text === "string"
							? text
							: "[line omitted: binary or oversized]",
					),
				});
			continue;
		}
		if (
			event.type === "end" &&
			data.binary_offset !== null &&
			data.binary_offset !== undefined
		)
			errors.push({ file, error: "binary file: matches were not printed" });
		if (event.type === "summary") {
			const stats = (data.stats ?? {}) as Record<string, unknown>;
			totalMatches = Number(stats.matches ?? 0);
			filesWithMatches = Number(stats.searches_with_match ?? 0);
		}
	}
	const counted =
		totalMatches === undefined || Number.isNaN(totalMatches)
			? matches.length
			: totalMatches;
	const countedFiles =
		filesWithMatches === undefined || Number.isNaN(filesWithMatches)
			? files.size
			: filesWithMatches;
	const total = Math.max(counted, matches.length);
	return {
		matches,
		totalMatches: total,
		filesWithMatches: Math.max(
			countedFiles,
			new Set(matches.map((match) => match.file)).size,
		),
		truncated: total > matches.length,
		errors,
	};
}

/** Shape the model reads: counts first, then the bounded sample. */
export function codeSearchResult(
	search: NormalizedCodeSearch,
	outcome: CodeSearchOutcome,
): Record<string, unknown> {
	return {
		ok: true,
		engine: "rg",
		pattern: search.pattern,
		paths: search.paths,
		limit: search.limit,
		...outcome,
		...(outcome.truncated
			? {
					hint: `${outcome.totalMatches} matches across ${outcome.filesWithMatches} files; showing ${outcome.matches.length}. Narrow the pattern or raise limit before concluding a sweep.`,
				}
			: {}),
	};
}
