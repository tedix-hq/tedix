#!/usr/bin/env bun

/**
 * Static checks for the two D1 failure classes that pass every local test
 * (`bun run lint:d1`). Both are syntactic and complement `createD1Facade()`,
 * which catches them at runtime only for tested queries.
 *
 *   bun scripts/lint-d1.ts          # exit 0 clean, 1 findings, 2 could not run
 *   bun scripts/lint-d1.ts --json   # one JSON document per check
 */

/**
 * DUPLICATE OUTPUT COLUMNS: D1 returns object rows, so two entries of a joined
 * `.select({...})` that resolve to the same column name collapse and shift every
 * later field. Use `prefixedColumns()` or an explicit `sql\`...\`.as("name")` alias.
 */

/**
 * BOUND PARAMETERS: D1 allows 100 bound parameters per statement, so every
 * `inArray(col, x)` in `packages/db` must be visibly bounded (array literal,
 * `chunkForBoundParams()` chunk, slice window, or constant) or carry a
 * `// bound-params: <reason>` annotation up to three lines above the site.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { detachedGitEnv } from "./oss/git-env.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Duplicate output columns ────────────────────────────────────────────────

/**
 * Receivers that are never a Drizzle table object, so a `<receiver>.<prop>`
 * match against them is noise rather than a column reference.
 */
const NON_TABLE_RECEIVERS = new Set([
	"sql",
	"count",
	"countDistinct",
	"sum",
	"avg",
	"min",
	"max",
	"Number",
	"String",
	"Boolean",
	"Math",
	"JSON",
	"Object",
	"Array",
	"db",
	"input",
	"row",
	"z",
	"eq",
	"and",
	"or",
	"not",
	"params",
	"options",
	"opts",
	"args",
	"ctx",
	"context",
	"env",
]);

export interface ColumnFinding {
	file: string;
	line: number;
	column: string;
	receivers: string[];
}

/** Split on separators that sit at nesting depth zero and outside strings. */
function splitColumnsTopLevel(source: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let current = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] as string;
		const previous = index > 0 ? source[index - 1] : "";
		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if ("([{".includes(char)) {
			depth += 1;
		} else if (")]}".includes(char)) {
			depth -= 1;
		} else if (char === separator && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

/** Index of the brace closing the one that opens at `openIndex`. */
function matchBrace(source: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/**
 * Findings for one source file.
 *
 * Exported so the unit test can drive it against fixture text rather than
 * needing files on disk.
 */
export function findDuplicateOutputColumns(
	file: string,
	text: string,
): ColumnFinding[] {
	const findings: ColumnFinding[] = [];

	// Identifiers bound to a prefixedColumns() result already carry unique
	// output names, so references through them are safe by construction.
	const prefixed = new Set(
		[
			...text.matchAll(
				/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*prefixedColumns\(/g,
			),
		].map((match) => match[1] as string),
	);

	let cursor = 0;
	for (;;) {
		const selectIndex = text.indexOf(".select({", cursor);
		if (selectIndex === -1) break;
		const open = text.indexOf("{", selectIndex);
		const close = matchBrace(text, open);
		if (close === -1) break;

		const block = text.slice(open + 1, close);
		// Only joined statements can collide across tables. Look ahead from the
		// end of the projection for a join in the same chain.
		const tail = text.slice(close, close + 2000);
		if (/\.(inner|left|right|full)Join\(/.test(tail)) {
			const byColumn = new Map<string, Set<string>>();
			for (const entry of splitColumnsTopLevel(block, ",")) {
				// An explicit alias sets the output name directly — always safe.
				if (/\.as\(/.test(entry)) continue;
				const match = entry.match(
					/:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/,
				);
				if (!match) continue;
				const receiver = match[1] as string;
				const property = match[2] as string;
				if (NON_TABLE_RECEIVERS.has(receiver) || prefixed.has(receiver)) {
					continue;
				}
				const receivers = byColumn.get(property) ?? new Set<string>();
				receivers.add(receiver);
				byColumn.set(property, receivers);
			}
			for (const [column, receivers] of byColumn) {
				if (receivers.size < 2) continue;
				findings.push({
					file,
					line: text.slice(0, open).split("\n").length,
					column,
					receivers: [...receivers].sort(),
				});
			}
		}
		cursor = close;
	}

	return findings;
}

function listColumnCandidateFiles(): string[] {
	const { spawnSync } =
		require("node:child_process") as typeof import("node:child_process");
	const result = spawnSync(
		"git",
		["ls-files", "apps/**/*.ts", "packages/**/*.ts"],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			env: detachedGitEnv(),
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.status !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr}`);
	}
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"));
}

function columnsMain(): number {
	const asJson = process.argv.includes("--json");
	let files: string[];
	try {
		files = listColumnCandidateFiles();
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}

	const findings: ColumnFinding[] = [];
	let scanned = 0;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(`${REPO_ROOT}${file}`, "utf8");
		} catch {
			continue;
		}
		if (!text.includes(".select({")) continue;
		scanned += 1;
		findings.push(...findDuplicateOutputColumns(file, text));
	}

	if (asJson) {
		console.log(JSON.stringify({ scanned, findings }, null, 2));
		return findings.length > 0 ? 1 : 0;
	}

	if (findings.length === 0) {
		console.log(
			`duplicate-output-columns: OK — ${scanned} projection-bearing files, no joined select shares an output name`,
		);
		return 0;
	}

	console.error("duplicate output columns found:");
	for (const finding of findings) {
		console.error(
			`- ${relative(".", finding.file)}:${finding.line}: "${finding.column}" selected from ${finding.receivers.join(" and ")}`,
		);
	}
	console.error(
		"\nD1 collapses same-named output columns and every later field decodes into the wrong slot.\n" +
			'Fix with prefixedColumns(table, "prefix") or an explicit sql`…`.as("unique_name").',
	);
	return 1;
}

// ── Bound parameters ────────────────────────────────────────────────────────

/** Inline escape hatch: `// bound-params: <reason>` just above the site. */
const ANNOTATION = "bound-params:";

export interface BoundParamsFinding {
	file: string;
	line: number;
	argument: string;
}

/** Index of the paren closing the one at `openIndex`, string-aware. */
function matchParen(source: string, openIndex: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let index = openIndex; index < source.length; index += 1) {
		const char = source[index] as string;
		const previous = index > 0 ? source[index - 1] : "";
		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if ("([{".includes(char)) {
			depth += 1;
		} else if (")]}".includes(char)) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** Split on commas that sit at nesting depth zero and outside strings. */
function splitArgsTopLevel(source: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let current = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] as string;
		const previous = index > 0 ? source[index - 1] : "";
		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if ("([{".includes(char)) {
			depth += 1;
		} else if (")]}".includes(char)) {
			depth -= 1;
		} else if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

/**
 * Identifiers in `text` that hold chunked values: loop/callback bindings over
 * a `chunkForBoundParams()` result, directly or through an intermediate
 * chunk-list variable.
 */
function collectChunkIdentifiers(text: string): Set<string> {
	// Variables holding the chunk LIST (an array of chunks). `chunk()` is the
	// equivalent work-items helper (packages/db/src/queries/work-items/guards.ts).
	const chunkLists = new Set(
		[
			...text.matchAll(
				/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:chunkForBoundParams|chunk)\s*\(/g,
			),
		].map((match) => match[1] as string),
	);

	const chunks = new Set<string>();

	// for (const chunk of chunkForBoundParams(...)) — with or without an
	// intermediate chunk-list variable.
	for (const match of text.matchAll(
		/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+((?:chunkForBoundParams|chunk)\s*\(|[A-Za-z_$][\w$]*)/g,
	)) {
		const binding = match[1] as string;
		const source = (match[2] as string).trim();
		if (/^(?:chunkForBoundParams|chunk)\s*\($/.test(source)) {
			chunks.add(binding);
		} else if (chunkLists.has(source)) {
			chunks.add(binding);
		}
	}

	// The hand-rolled window idiom: `const batch = ids.slice(i, i + SIZE)`.
	// Window arithmetic (`+`/`*` in the end index) marks a genuine chunk; a
	// bare `.slice(0, cap)` does not qualify.
	for (const match of text.matchAll(
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$.]*\.slice\s*\(([^()]*)\)/g,
	)) {
		if (isSliceWindow(match[2] as string)) chunks.add(match[1] as string);
	}

	// chunkForBoundParams(...).map((chunk) => ...) / .flatMap((chunk) => ...)
	for (const match of text.matchAll(/chunkForBoundParams\s*(\()/g)) {
		const open = match.index + match[0].length - 1;
		const close = matchParen(text, open);
		if (close === -1) continue;
		const tail = text.slice(close + 1);
		const callback = tail.match(
			/^\s*\.(?:map|flatMap)\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*[),]/,
		);
		if (callback) chunks.add(callback[1] as string);
	}

	// chunkListVar.map((chunk) => ...) / .flatMap((chunk) => ...)
	for (const listName of chunkLists) {
		for (const match of text.matchAll(
			new RegExp(
				`\\b${listName}\\s*\\.(?:map|flatMap)\\s*\\(\\s*\\(?\\s*([A-Za-z_$][\\w$]*)\\s*[),]`,
				"g",
			),
		)) {
			chunks.add(match[1] as string);
		}
	}

	return chunks;
}

/**
 * True when a `.slice(start, end)` argument list is window arithmetic
 * (`i, i + SIZE`) rather than a bare cap (`0, 200`). A bare cap silently
 * drops everything past it and can still exceed the parameter budget once
 * other bound params join the statement.
 */
function isSliceWindow(argsSource: string): boolean {
	const args = splitArgsTopLevel(argsSource);
	if (args.length !== 2) return false;
	return /[+*]/.test(args[1] as string);
}

/**
 * `const X = [...]` array-literal bindings, module- or function-scoped —
 * bounded by construction. An EMPTY literal is excluded: `const rows = []` is
 * the accumulator idiom and says nothing about its final size.
 */
function collectConstArrayLiterals(text: string): Set<string> {
	return new Set(
		[
			...text.matchAll(
				/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*(?:Object\.freeze\s*\(\s*)?\[\s*(?!\])/gm,
			),
		].map((match) => match[1] as string),
	);
}

/**
 * Findings for one source file.
 *
 * Exported so the unit test can drive it against fixture text rather than
 * needing files on disk.
 */
export function findUnboundedInArrays(
	file: string,
	text: string,
): BoundParamsFinding[] {
	const findings: BoundParamsFinding[] = [];
	const chunkIdentifiers = collectChunkIdentifiers(text);
	const constArrays = collectConstArrayLiterals(text);
	const lines = text.split("\n");

	const isBoundedIdentifier = (name: string): boolean =>
		chunkIdentifiers.has(name) ||
		name === "chunk" ||
		name.endsWith("Chunk") ||
		constArrays.has(name) ||
		// Imported bounded constants are SCREAMING_SNAKE_CASE by repo
		// convention (enum value lists, status sets).
		/^[A-Z][A-Z0-9_]{2,}$/.test(name);

	const isBoundedExpression = (raw: string): boolean => {
		const expression = raw.trim();
		if (expression.startsWith("[")) {
			// Array literal: bounded unless it spreads an unbounded identifier.
			for (const spread of expression.matchAll(
				/\.\.\.\s*(new\b|[A-Za-z_$][\w$]*)/g,
			)) {
				const target = (spread[1] as string).trim();
				if (target === "new" || !isBoundedIdentifier(target)) return false;
			}
			return true;
		}
		// An inline slice window (`ids.slice(i, i + SIZE)`) is the hand-rolled
		// chunk idiom; a bare cap (`ids.slice(0, 200)`) is not.
		const sliceCall = expression.lastIndexOf(".slice");
		if (sliceCall !== -1) {
			const open = expression.indexOf("(", sliceCall);
			if (open !== -1) {
				const close = matchParen(expression, open);
				if (
					close === expression.length - 1 &&
					isSliceWindow(expression.slice(open + 1, close))
				) {
					return true;
				}
			}
		}
		const identifier = expression.match(/^([A-Za-z_$][\w$]*)\s*$/);
		if (identifier) return isBoundedIdentifier(identifier[1] as string);
		// Member/call chain: bounded when its ROOT is a bounded identifier
		// (`chunk.map((row) => row.id)`); `input.ids`, `x.slice(0, n)` are not.
		const chain = expression.match(/^([A-Za-z_$][\w$]*)\s*[.[]/);
		if (chain) return isBoundedIdentifier(chain[1] as string);
		return false;
	};

	for (const match of text.matchAll(/\binArray\s*(\()/g)) {
		const open = match.index + match[0].length - 1;
		const close = matchParen(text, open);
		if (close === -1) continue;
		const args = splitArgsTopLevel(text.slice(open + 1, close));
		if (args.length < 2) continue;
		const valuesArgument = (args[1] as string).trim();
		if (isBoundedExpression(valuesArgument)) continue;

		const line = text.slice(0, match.index).split("\n").length;
		// Accept the annotation on the same line or in the up-to-three lines
		// above it — enough room for a two-line comment above a wrapped
		// conditional without letting an annotation drift far from its site.
		const annotated = [line - 4, line - 3, line - 2, line - 1].some((index) =>
			(lines[index] ?? "").includes(ANNOTATION),
		);
		if (annotated) continue;

		findings.push({
			file,
			line,
			argument: valuesArgument.replace(/\s+/g, " ").slice(0, 80),
		});
	}

	return findings;
}

function listBoundParamsCandidateFiles(): string[] {
	const { spawnSync } =
		require("node:child_process") as typeof import("node:child_process");
	const result = spawnSync("git", ["ls-files", "packages/db/**/*.ts"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: detachedGitEnv(),
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr}`);
	}
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"));
}

function boundParamsMain(): number {
	const asJson = process.argv.includes("--json");
	let files: string[];
	try {
		files = listBoundParamsCandidateFiles();
	} catch (error) {
		console.error((error as Error).message);
		return 2;
	}

	const findings: BoundParamsFinding[] = [];
	let scanned = 0;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(`${REPO_ROOT}${file}`, "utf8");
		} catch {
			continue;
		}
		if (!text.includes("inArray(")) continue;
		scanned += 1;
		findings.push(...findUnboundedInArrays(file, text));
	}

	if (asJson) {
		console.log(JSON.stringify({ scanned, findings }, null, 2));
		return findings.length > 0 ? 1 : 0;
	}

	if (findings.length === 0) {
		console.log(
			`bound-params: OK — ${scanned} inArray-bearing files, no unbounded lists`,
		);
		return 0;
	}

	console.error("unbounded inArray() lists found:");
	for (const finding of findings) {
		console.error(
			`- ${relative(".", finding.file)}:${finding.line}: inArray(…, ${finding.argument})`,
		);
	}
	console.error(
		"\nD1 caps bound parameters at 100 per statement; an unchunked IN() list over caller data fails in production only.\n" +
			"Fix with chunkForBoundParams(list, ≤50) from packages/db/src/utils/batch.ts and merge per-chunk rows,\n" +
			`or, when the list is provably bounded by construction, annotate the preceding line with \`// ${ANNOTATION} <reason>\`.`,
	);
	return 1;
}

if (import.meta.main) {
	const columns = columnsMain();
	const boundParams = boundParamsMain();
	process.exit(Math.max(columns, boundParams));
}
