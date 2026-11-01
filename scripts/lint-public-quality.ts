#!/usr/bin/env bun

/**
 * Public quality gate. Every tracked text file is matched against the rules in
 * `public-quality-rules.json`: AI-generated filler in public prose (`slop`),
 * information that should not be public such as developer paths and private
 * links (`internal`), and behavior hardcoded in source that belongs in
 * configuration or D1 rows (`config`). Existing debt lives in
 * `public-quality-baseline.json`, which may only shrink; `--update-baseline`
 * rewrites it from the current findings. `--strict` exits 1 on a new finding
 * or a stale baseline entry.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RULES_PATH = "scripts/public-quality-rules.json";
export const BASELINE_PATH = "scripts/public-quality-baseline.json";

const TEXT_PATH =
	/\.(?:[cm]?[jt]sx?|astro|jsonc?|mdx?|ya?ml|toml|sh|txt|sql|css|html|svg|env\.example)$|(?:^|\/)(?:Dockerfile|AGENTS\.md|README\.md)$/i;
const MAX_FILE_BYTES = 1024 * 1024;

export type Category = "slop" | "internal" | "config";

export interface QualityRule {
	id: string;
	category: Category;
	message: string;
	pattern: string;
	flags?: string;
	/** Globs, or the name of a glob set declared at the top of the rules file. */
	include: string[];
	exclude?: string[];
	/** A line that also matches one of these is not a finding. */
	allow?: string[];
}

export interface RulesFile {
	rules: QualityRule[];
	[globSet: string]: unknown;
}

export interface Finding {
	path: string;
	line: number;
	rule: string;
	message: string;
}

interface CompiledRule {
	id: string;
	message: string;
	pattern: RegExp;
	include: Bun.Glob[];
	exclude: Bun.Glob[];
	allow: RegExp[];
}

function expandGlobs(file: RulesFile, names: string[]): string[] {
	return names.flatMap((name) => {
		const set = file[name];
		return Array.isArray(set) ? (set as string[]) : [name];
	});
}

export function compileRules(file: RulesFile): CompiledRule[] {
	return file.rules.map((rule) => ({
		id: rule.id,
		message: rule.message,
		pattern: new RegExp(rule.pattern, rule.flags ?? ""),
		include: expandGlobs(file, rule.include).map((glob) => new Bun.Glob(glob)),
		exclude: expandGlobs(file, rule.exclude ?? []).map(
			(glob) => new Bun.Glob(glob),
		),
		allow: (rule.allow ?? []).map((pattern) => new RegExp(pattern)),
	}));
}

export function readRules(root = REPO_ROOT): RulesFile {
	return JSON.parse(readFileSync(resolve(root, RULES_PATH), "utf8"));
}

function appliesTo(rule: CompiledRule, path: string): boolean {
	return (
		rule.include.some((glob) => glob.match(path)) &&
		!rule.exclude.some((glob) => glob.match(path))
	);
}

export function scanContent(
	path: string,
	content: string,
	rules: CompiledRule[],
): Finding[] {
	const applicable = rules.filter((rule) => appliesTo(rule, path));
	if (applicable.length === 0) return [];
	const findings: Finding[] = [];
	for (const [index, line] of content.split("\n").entries()) {
		for (const rule of applicable) {
			if (!rule.pattern.test(line)) continue;
			if (rule.allow.some((allow) => allow.test(line))) continue;
			findings.push({
				path,
				line: index + 1,
				rule: rule.id,
				message: rule.message,
			});
		}
	}
	return findings;
}

function trackedFiles(root: string): string[] {
	const result = spawnSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr.trim());
	return result.stdout.split("\0").filter(Boolean);
}

export function scanRepository(
	root = REPO_ROOT,
	rules = compileRules(readRules(root)),
): Finding[] {
	const findings: Finding[] = [];
	for (const path of trackedFiles(root)) {
		if (!TEXT_PATH.test(path) || path === RULES_PATH || path === BASELINE_PATH)
			continue;
		const absolute = resolve(root, path);
		let size: number;
		try {
			size = statSync(absolute).size;
		} catch {
			continue;
		}
		if (size > MAX_FILE_BYTES) continue;
		findings.push(...scanContent(path, readFileSync(absolute, "utf8"), rules));
	}
	return findings;
}

/** Baseline entries are `path<TAB>rule`; a line number would churn on every edit. */
export function baselineKey(finding: Pick<Finding, "path" | "rule">): string {
	return `${finding.path}\t${finding.rule}`;
}

export function readBaseline(root = REPO_ROOT): Set<string> {
	try {
		const file = JSON.parse(
			readFileSync(resolve(root, BASELINE_PATH), "utf8"),
		) as { findings?: string[] };
		return new Set(file.findings ?? []);
	} catch {
		return new Set();
	}
}

export function compareToBaseline(
	findings: Finding[],
	baseline: Set<string>,
): { fresh: Finding[]; stale: string[] } {
	const present = new Set(findings.map(baselineKey));
	return {
		fresh: findings.filter((finding) => !baseline.has(baselineKey(finding))),
		stale: [...baseline].filter((key) => !present.has(key)).sort(),
	};
}

export function renderReport(
	fresh: Finding[],
	stale: string[],
	total: number,
): string {
	const lines: string[] = [];
	for (const finding of fresh) {
		lines.push(
			`${finding.path}:${finding.line} [${finding.rule}] ${finding.message}`,
		);
	}
	for (const key of stale) {
		const [path, rule] = key.split("\t");
		lines.push(
			`${path} [${rule}] baseline entry no longer matches; remove it from ${BASELINE_PATH}`,
		);
	}
	lines.push(
		`public quality: ${fresh.length} new finding(s), ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"}, ${total} total match(es)`,
	);
	return lines.join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const strict = args.includes("--strict");
	const findings = scanRepository().sort(
		(a, b) => a.path.localeCompare(b.path) || a.line - b.line,
	);
	if (args.includes("--update-baseline")) {
		const keys = [...new Set(findings.map(baselineKey))].sort();
		writeFileSync(
			resolve(REPO_ROOT, BASELINE_PATH),
			`${JSON.stringify({ "//": "Existing public-quality debt, as path<TAB>rule. Remove an entry when you fix it; never add one to go green.", findings: keys }, null, "\t")}\n`,
		);
		console.log(`wrote ${keys.length} baseline entries to ${BASELINE_PATH}`);
		process.exit(0);
	}
	const { fresh, stale } = compareToBaseline(findings, readBaseline());
	console.log(renderReport(fresh, stale, findings.length));
	if (strict && (fresh.length > 0 || stale.length > 0)) process.exit(1);
}
