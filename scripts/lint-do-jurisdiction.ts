#!/usr/bin/env bun

/**
 * Durable Object jurisdiction lint.
 *
 * A Durable Object only stays inside a jurisdiction when the code asks for it:
 * `namespace.jurisdiction("eu").idFromName(name)` and the unrestricted
 * `namespace.idFromName(name)` resolve DIFFERENT objects, and feeding an id
 * from one into the other's `get` misroutes or rejects. Every addressing call
 * — `idFromName`, `idFromString`, `newUniqueId`, `getByName`, and direct
 * `jurisdiction()` selection — must therefore go through
 * `@tedix/worker-kit/durable-objects`, which applies `env.DO_JURISDICTION`
 * (eu on the EU installation, unset elsewhere so existing ids stay stable).
 *
 * This gate scans apps/* /src and packages/* /src and rejects any addressing
 * call outside that module. Bracket-notation access (`ns["idFromName"](x)`)
 * is rejected too — it bypasses the method-name scan with identical effect.
 * Test files, generated `.d.ts` declarations, and code carried inside string
 * literals (generated Worker/plugin source, which runs in another isolate and
 * cannot share this helper) are out of scope. Run directly to print findings;
 * `--strict` (what `lint:repo` uses) exits 1 on any finding.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOTS = ["apps", "packages"] as const;

/**
 * The one module permitted to address Durable Object namespaces directly.
 * Everything else goes through its exports.
 */
const HELPER_MODULE = "packages/worker-kit/src/durable-objects.ts";

const BANNED_METHODS = [
	"idFromName",
	"idFromString",
	"newUniqueId",
	"getByName",
	"jurisdiction",
] as const;

const METHOD_CALL_RE = new RegExp(
	`\\.(${BANNED_METHODS.join("|")})\\s*\\(`,
	"g",
);
const BRACKET_RE = new RegExp(
	`\\[\\s*["'](${BANNED_METHODS.join("|")})["']\\s*\\]`,
	"g",
);

const SKIPPED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".wrangler",
	".turbo",
	".next",
	"coverage",
	"templates",
]);

const TEST_FILE_RE = /(?:^|[/\\])(?:test|tests|fixtures|__tests__)[/\\]/i;
const DECLARATION_RE = /\.(?:test|spec)\.ts$|\.d\.ts$/;

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly method: string;
}

function isScanned(path: string): boolean {
	if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
	if (DECLARATION_RE.test(path)) return false;
	if (TEST_FILE_RE.test(path)) return false;
	return true;
}

/**
 * Blank out comments and the CONTENTS of string/template literals, preserving
 * offsets and newlines, so detection fires only on executable syntax — not on
 * doc comments describing addressing or on generated code carried as data.
 */
export function maskSource(source: string, blankStrings: boolean): string {
	const out = source.split("");
	const blank = (from: number, to: number): void => {
		for (let i = from; i < to && i < out.length; i++) {
			if (out[i] !== "\n") out[i] = " ";
		}
	};
	type Frame =
		| { readonly kind: "template" }
		| { kind: "code"; readonly interpolation: boolean; depth: number };
	const stack: Frame[] = [{ kind: "code", interpolation: false, depth: 0 }];

	let i = 0;
	while (i < source.length) {
		const top = stack[stack.length - 1];
		const char = source[i];
		const next = source[i + 1];

		if (top?.kind === "template") {
			if (char === "\\") {
				if (blankStrings) blank(i, i + 2);
				i += 2;
				continue;
			}
			if (char === "`") {
				stack.pop();
				i += 1;
				continue;
			}
			if (char === "$" && next === "{") {
				stack.push({ kind: "code", interpolation: true, depth: 0 });
				i += 2;
				continue;
			}
			if (blankStrings) blank(i, i + 1);
			i += 1;
			continue;
		}
		if (!top || top.kind !== "code") break;

		if (char === "/" && next === "/") {
			let end = source.indexOf("\n", i);
			if (end === -1) end = source.length;
			blank(i, end);
			i = end;
			continue;
		}
		if (char === "/" && next === "*") {
			const close = source.indexOf("*/", i + 2);
			const end = close === -1 ? source.length : close + 2;
			blank(i, end);
			i = end;
			continue;
		}
		if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") {
					j += 2;
					continue;
				}
				if (source[j] === char || source[j] === "\n") break;
				j += 1;
			}
			if (blankStrings) blank(i + 1, j);
			i = j + 1;
			continue;
		}
		if (char === "`") {
			stack.push({ kind: "template" });
			i += 1;
			continue;
		}
		if (char === "{") {
			top.depth += 1;
			i += 1;
			continue;
		}
		if (char === "}") {
			if (top.depth === 0 && top.interpolation) stack.pop();
			else top.depth -= 1;
			i += 1;
			continue;
		}
		i += 1;
	}
	return out.join("");
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++) {
		if (source[i] === "\n") line += 1;
	}
	return line;
}

/** Every banned addressing call in one source file (masked view). */
export function findBypasses(source: string): readonly Finding[] {
	const structural = maskSource(source, true);
	const commentsOnly = maskSource(source, false);
	const findings: Finding[] = [];

	for (const match of structural.matchAll(METHOD_CALL_RE)) {
		findings.push({
			file: "",
			line: lineOf(source, match.index),
			method: match[1]!,
		});
	}
	for (const match of commentsOnly.matchAll(BRACKET_RE)) {
		findings.push({
			file: "",
			line: lineOf(source, match.index),
			method: `["${match[1]!}"]`,
		});
	}
	return findings.sort((a, b) => a.line - b.line);
}

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry)) yield* walk(path);
		} else if (isScanned(path)) {
			yield path;
		}
	}
}

export function collectFindings(repoRoot = REPO_ROOT): readonly Finding[] {
	const findings: Finding[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of walk(join(repoRoot, root))) {
			const rel = relative(repoRoot, file).replaceAll("\\", "/");
			if (rel === HELPER_MODULE) continue;
			let source: string;
			try {
				source = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const finding of findBypasses(source)) {
				findings.push({ ...finding, file: rel });
			}
		}
	}
	return findings;
}

if (import.meta.main) {
	const strict = process.argv.includes("--strict");
	const findings = collectFindings();
	if (findings.length === 0) {
		console.log(
			"lint-do-jurisdiction: no Durable Object addressing outside " +
				"@tedix/worker-kit/durable-objects",
		);
	} else {
		console.error(
			"Durable Object namespace addressed outside @tedix/worker-kit/durable-objects:",
		);
		for (const finding of findings) {
			console.error(`  ${finding.file}:${finding.line}  .${finding.method}(`);
		}
		console.error(
			`\n${findings.length} bypass(es). Route every idFromName / idFromString / ` +
				"newUniqueId / getByName / jurisdiction() through the durable-objects " +
				"helper so env.DO_JURISDICTION applies.",
		);
	}
	process.exit(strict && findings.length > 0 ? 1 : 0);
}
