#!/usr/bin/env bun

/**
 * Remote D1 audit gate (`bun run lint:remote-d1`): every statement a script or
 * tool sends to remote D1 must go through `scripts/lib/remote-d1.ts`, which
 * records the actor, transport, database and a SQL fingerprint in
 * `.cache/remote-d1-audit.jsonl` before the call runs.
 *
 * Flagged shapes, in tracked sources:
 *
 *   - `["d1", "execute", <db>, ..., "--remote", ...]` argv literals
 *   - `["d1", "query", <uuid>, ..., "--sql"]` pinned-cf argv literals
 *   - a `/d1/database/<id>/query` REST endpoint string
 *   - a `wrangler d1 execute ... --remote` command string
 *
 * A file that merely *hands* remote-D1 argv to an audited runner may use a
 * `// remote-d1: <reason>` annotation on the line or in the three lines above
 * it. The exemption stays local so importing a helper cannot hide a separate
 * raw invocation elsewhere in the file.
 *
 *   bun scripts/lint-remote-d1.ts          # exit 0 clean, 1 findings
 *   bun scripts/lint-remote-d1.ts --json
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { detachedGitEnv } from "./oss/git-env.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Inline escape hatch: `// remote-d1: <reason>` on or above the match. */
const ANNOTATION = "remote-d1:";

/** The helper itself plus the lint own the flagged token sequences. */
const HELPER_FILES = new Set([
	"scripts/lib/remote-d1.ts",
	"scripts/lint-remote-d1.ts",
]);

const SCANNED_EXTENSIONS =
	/\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|sh|yml|yaml)$/;

export interface RemoteD1Finding {
	file: string;
	line: number;
	kind: string;
	snippet: string;
}

/**
 * Each pattern detects one remote-D1 invocation shape in (comment-masked)
 * source. Ranges are generous because argv arrays interleave constants and
 * flag names between the tokens.
 */
const PATTERNS: { kind: string; re: RegExp }[] = [
	{
		kind: "remote-d1 argv",
		re: /["'`]d1["'`][^\]]{0,800}?["'`]--remote(?:=true)?["'`]/g,
	},
	{
		kind: "cf-d1-query argv",
		re: /["'`]d1["'`]\s*,\s*["'`]query["'`][^\]]{0,300}?["'`]--sql["'`]/g,
	},
	{
		kind: "rest-d1-query endpoint",
		re: /d1\/database\/[^\n]{0,300}?(?:\/|["'`]\s*\+\s*["'`]\/)[^\n]{0,100}?query/g,
	},
	{
		kind: "wrangler-d1-execute-remote command string",
		re: /wrangler\s+d1\s+execute\b[^\n"'`]{0,200}?--remote(?:=true)?/g,
	},
];

/** Mask comments while preserving positions, newlines and string contents. */
function maskComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(line, prefix: string) =>
				prefix + " ".repeat(line.length - prefix.length),
		);
}

function lineNumber(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/**
 * Findings for one source file, already positioned. Exported so the unit test
 * can drive it against fixture text rather than needing files on disk.
 */
export function findRemoteD1Findings(
	file: string,
	text: string,
): RemoteD1Finding[] {
	if (HELPER_FILES.has(file)) return [];
	const masked = maskComments(text);
	const lines = text.split("\n");
	const findings: RemoteD1Finding[] = [];
	for (const { kind, re } of PATTERNS) {
		for (const match of masked.matchAll(re)) {
			const index = match.index ?? 0;
			const line = lineNumber(masked, index);
			const annotated = [line - 4, line - 3, line - 2, line - 1].some((i) =>
				(lines[i] ?? "").includes(ANNOTATION),
			);
			if (annotated) continue;
			findings.push({
				file,
				line,
				kind,
				snippet: match[0].replace(/\s+/g, " ").slice(0, 90),
			});
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

function listCandidateFiles(): string[] {
	const result = spawnSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
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
		.filter(
			(path) =>
				SCANNED_EXTENSIONS.test(path) &&
				!/\.(?:test|spec)\.[cm]?[tj]sx?$/.test(path) &&
				!path.endsWith(".d.ts"),
		);
}

if (import.meta.main) {
	let files: string[];
	try {
		files = listCandidateFiles();
	} catch (error) {
		console.error((error as Error).message);
		process.exit(2);
	}

	const findings: RemoteD1Finding[] = [];
	let scanned = 0;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(join(REPO_ROOT, file), "utf8");
		} catch {
			continue;
		}
		scanned += 1;
		findings.push(...findRemoteD1Findings(file, text));
	}

	if (process.argv.includes("--json")) {
		console.log(JSON.stringify({ scanned, findings }, null, 2));
		process.exit(findings.length > 0 ? 1 : 0);
	}

	if (findings.length === 0) {
		console.log(
			`remote-d1: OK — ${scanned} files scanned, every remote D1 call routes through the audited helper`,
		);
		process.exit(0);
	}

	console.error("unaudited remote D1 calls found:");
	for (const finding of findings) {
		console.error(
			`- ${relative(".", join(REPO_ROOT, finding.file))}:${finding.line}: ${finding.kind}: ${finding.snippet}`,
		);
	}
	console.error(
		"\nRemote D1 writes must leave an actor trail: route them through scripts/lib/remote-d1.ts\n" +
			"(wrangler d1 execute --remote, cf d1 query, and the REST /d1/database/<id>/query path),\n" +
			"or through packages/db/scripts/wrangler-command.ts's runWrangler, which audits them.\n" +
			`For a proven exception, annotate the line with \`// ${ANNOTATION} <reason>\`.`,
	);
	process.exit(1);
}
