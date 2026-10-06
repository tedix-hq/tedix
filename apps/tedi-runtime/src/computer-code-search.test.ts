import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerEnvironmentController } from "./computer-environment";
import {
	CODE_SEARCH_TEXT_CHARS,
	buildCodeSearchCommand,
	normalizeCodeSearchInput,
	parseCodeSearchOutput,
	type CodeSearchInput,
} from "./computer-code-search";

const values = new Map<string, unknown>();
const store = {
	delete: async (key: string) => values.delete(key),
	get: async <T>(key: string) => values.get(key) as T | undefined,
	put: async <T>(key: string, value: T) => {
		values.set(key, value);
	},
};
const commands: string[] = [];
const outputs = new Map<string, { stdout: string; stderr: string }>();
let searchStdout = "";
let searchStderr = "";

const scripted = (_command: string) => {
	return { stdout: searchStdout, stderr: searchStderr };
};
const actions = {
	open: async () => ({ ok: true, leaseId: "lease-search" }),
	close: async () => ({ ok: true }),
	status: async () => ({
		ok: true,
		readiness: { toolsReady: true, repoReady: true },
		repoSync: { workdir: "/home/tedi/workstation/repo" },
	}),
	files: async () => ({ ok: true }),
	start: async (
		_environment: unknown,
		input: { command: string; processId: string },
	) => {
		commands.push(input.command);
		outputs.set(input.processId, scripted(input.command));
		return { ok: true };
	},
	read: async (_environment: unknown, id: string) => ({
		ok: true,
		terminal: true,
		exitCode: 0,
		...(outputs.get(id) ?? { stdout: "", stderr: "" }),
	}),
	wait: async (_environment: unknown, id: string) => ({
		ok: true,
		terminal: true,
		exitCode: 0,
		...(outputs.get(id) ?? { stdout: "", stderr: "" }),
	}),
	cancel: async () => ({ ok: true, terminal: true, canceled: true }),
};
const record = (value: unknown) => value as Record<string, unknown>;
const longLine = "x".repeat(CODE_SEARCH_TEXT_CHARS + 1_500);
const rgLines = [
	JSON.stringify({
		type: "match",
		data: {
			path: { text: "apps/api/src/a.ts" },
			lines: { text: "const flawed = compute()\n" },
			line_number: 12,
		},
	}),
	JSON.stringify({
		type: "match",
		data: {
			path: { text: "apps/os/src/b.ts" },
			lines: { text: longLine },
			line_number: 40,
		},
	}),
	JSON.stringify({
		type: "match",
		data: {
			path: { text: "apps/os/src/c.ts" },
			lines: { text: "const flawed = compute()\n" },
			line_number: 7,
		},
	}),
	JSON.stringify({
		type: "end",
		data: { path: { text: "apps/api/src/a.ts" }, binary_offset: null },
	}),
	JSON.stringify({
		type: "end",
		data: { path: { text: "packages/db/fixture.bin" }, binary_offset: 42 },
	}),
	JSON.stringify({
		type: "summary",
		data: {
			stats: { matches: 180, matched_lines: 180, searches_with_match: 12 },
		},
	}),
].join("\n");

const computer = new ComputerEnvironmentController(
	store,
	"search-scope",
	actions,
);
await computer.open("repository");

// Counts describe every match; only the match array is truncated. A model that
// fixes two of 180 occurrences must be able to see the other 178 exist.
searchStdout = rgLines;
searchStderr = "rg: packages/db/generated.ts: No such file or directory";
const first = record(
	await computer.codeSearch({ pattern: "compute\\(", limit: 2 }),
);
assert.equal(first.engine, "rg");
assert.equal(first.totalMatches, 180);
assert.equal(first.filesWithMatches, 12);
assert.equal(first.truncated, true);
assert.deepEqual(
	(first.matches as { file: string; line: number }[]).map(
		(match) => `${match.file}:${match.line}`,
	),
	["apps/api/src/a.ts:12", "apps/os/src/b.ts:40"],
	"the match array respects limit while the counts stay whole",
);
assert.match(
	String(first.hint),
	/180 matches across 12 files; showing 2/,
	"a truncated result must say how much it is not showing",
);
const longMatch = (first.matches as { text: string }[])[1]!;
assert.ok(
	longMatch.text.length < longLine.length &&
		longMatch.text.startsWith("x".repeat(CODE_SEARCH_TEXT_CHARS)),
	"each match line is bounded to a preview",
);
assert.deepEqual(
	first.errors,
	[
		{
			file: "packages/db/generated.ts",
			error: "No such file or directory",
		},
		{
			file: "packages/db/fixture.bin",
			error: "binary file: matches were not printed",
		},
	],
	"skipped and unreadable files surface so an undercount cannot be silent",
);

// Omitting paths searches the whole repository.
const wholeRepo = commands.at(-1)!;
assert.match(wholeRepo, /^rg --json /, "ripgrep is the engine when installed");
assert.match(
	wholeRepo,
	/-- '\.'$|-- '\.' \|/,
	"omitted paths search the tree root",
);
assert.match(
	wholeRepo,
	/awk -v limit=2 /,
	"one invocation is bounded in the pipe",
);

// An array of paths is ONE invocation, deduplicated.
commands.length = 0;
const arrayed = record(
	await computer.codeSearch({
		pattern: "compute\\(",
		paths: ["apps/api", "apps/os", "apps/api"],
	}),
);
assert.equal(
	commands.length,
	1,
	"an array of paths costs one ripgrep invocation, not one per path",
);
assert.equal(
	(commands[0]!.match(/'apps\/api'/g) ?? []).length,
	1,
	"repeated paths are deduplicated",
);
assert.match(commands[0]!, /-- 'apps\/api' 'apps\/os' \|/);
assert.deepEqual(arrayed.paths, ["apps/api", "apps/os"]);

assert.equal(
	values.has("search-scope:search-engine"),
	false,
	"search requires no engine discovery or cached engine state",
);

// Exercise the guaranteed native rg binary, including quotes, paths and totals.
const directory = mkdtempSync(join(tmpdir(), "tedix-code-search-"));
try {
	const file = "one 'quoted'.ts";
	writeFileSync(join(directory, file), "needle:first\nother\nneedle:second\n");
	writeFileSync(join(directory, "two.ts"), "NEEDLE:third\n");
	const search = (input: CodeSearchInput) => {
		const normalized = normalizeCodeSearchInput(input);
		const result = spawnSync(
			"bash",
			["-c", buildCodeSearchCommand(normalized)],
			{ cwd: directory, encoding: "utf8" },
		);
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		return parseCodeSearchOutput(
			result.stdout,
			result.stderr,
			normalized.limit,
		);
	};
	assert.deepEqual(
		search({ pattern: "needle:", literal: true, paths: [file] }),
		{
			matches: [
				{ file, line: 1, text: "needle:first" },
				{ file, line: 3, text: "needle:second" },
			],
			totalMatches: 2,
			filesWithMatches: 1,
			truncated: false,
			errors: [],
		},
	);
	const capped = search({
		pattern: "^needle:",
		ignoreCase: true,
		paths: [file, "two.ts", file],
		limit: 1,
	});
	assert.equal(capped.matches.length, 1);
	assert.ok(
		[
			{ file, line: 1, text: "needle:first" },
			{ file: "two.ts", line: 1, text: "NEEDLE:third" },
		].some(
			(match) => JSON.stringify(match) === JSON.stringify(capped.matches[0]),
		),
		"parallel ripgrep may visit either file first; the capped match must be its first matching line",
	);
	assert.deepEqual(
		{ ...capped, matches: [] },
		{
			matches: [],
			totalMatches: 3,
			filesWithMatches: 2,
			truncated: true,
			errors: [],
		},
	);
	assert.deepEqual(search({ pattern: "absent", paths: [file] }), {
		matches: [],
		totalMatches: 0,
		filesWithMatches: 0,
		truncated: false,
		errors: [],
	});
} finally {
	rmSync(directory, { recursive: true, force: true });
}

console.log("code_search returns bounded structured matches with whole counts");
