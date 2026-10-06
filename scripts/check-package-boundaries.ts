#!/usr/bin/env bun

/**
 * Repository architecture boundary checks.
 *
 * Keep this intentionally small and explicit: it enforces hard repo hygiene
 * rules that are easy to regress during fast agent pushes and awkward to catch
 * with TypeScript or Oxlint alone — tracked-path hygiene, the D1 transaction
 * ban, the plane/model boundary, and TypeScript config consistency.
 */

import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "./oss/git-env.ts";
import { existsSync, readFileSync } from "node:fs";

const TRACKED_PATH_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /(^|\/)\.dev\.vars$/,
		reason:
			"Worker secrets must not be committed; declare provider references in .env.example.",
	},
	{
		pattern: /(^|\/)wrangler\.toml$/,
		reason: "Worker config must use wrangler.jsonc, not wrangler.toml.",
	},
	{ pattern: /(^|\/)\.DS_Store$/, reason: "macOS metadata is local-only." },
	{
		pattern: /(^|\/)__pycache__(\/|$)/,
		reason: "Python bytecode cache is local-only.",
	},
	{ pattern: /\.pyc$/, reason: "Python bytecode cache is local-only." },
	{
		pattern: /(^|\.)codex-tmp(\/|$)/,
		reason: "Coding-agent scratch state is local-only.",
	},
	{ pattern: /(^|\/)\.pi(\/|$)/, reason: "Pi harness state is local-only." },
	{
		pattern: /(^|\/)docs\/(archive|scratch)(\/|$)/,
		reason: "Current docs do not keep tracked archive/scratch folders.",
	},
];

const TEXT_EXTENSIONS = new Set([
	".astro",
	".cjs",
	".css",
	".cts",
	".js",
	".json",
	".jsonc",
	".jsx",
	".md",
	".mjs",
	".mts",
	".sh",
	".ts",
	".tsx",
	".txt",
	".yaml",
	".yml",
]);

function gitLsFiles(): string[] {
	const result = spawnSync("git", ["ls-files"], {
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || "git ls-files failed");
	}
	return result.stdout.split("\n").filter(Boolean).sort();
}

function extension(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot);
}

function isTextFile(path: string): boolean {
	return TEXT_EXTENSIONS.has(extension(path));
}

function readText(path: string): string | null {
	if (!isTextFile(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function lineNumber(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (text.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

const files = gitLsFiles();
const failures: string[] = [];

for (const file of files) {
	for (const { pattern, reason } of TRACKED_PATH_DENY_PATTERNS) {
		if (pattern.test(file)) failures.push(`${file}: ${reason}`);
	}
}

// D1 refuses BEGIN/SAVEPOINT (Cloudflare error 7500), and Drizzle's D1 driver
// implements `.transaction()` by emitting a literal `begin` — so the call throws
// against a real database. It is uniquely invisible in testing: Miniflare keeps
// the statements on one SQLite handle, so they pass, and Drizzle's own D1 suite
// runs its transaction tests green. Three call sites reached production this way.
// `db.batch()` is D1's transaction primitive.
//
// Scoped to D1-backed code only. `.transaction()` is correct on
// drizzle-orm/durable-sqlite, where the DO owns its own SQLite instance.
const D1_TRANSACTION_SCOPES = [
	"packages/db/src/",
	"apps/api/src/",
	"apps/mcp/src/",
	"apps/tedi/src/",
	"apps/skill-runtime/src/",
];
// This test asserts that the call still fails, which is the guard the fix rests
// on. It is the one place the string is supposed to appear.
const D1_TRANSACTION_ALLOWLIST = new Set([
	"packages/db/src/queries/organizations-provisioning.test.ts",
]);
const d1TransactionPattern = /\bdb\s*\.\s*transaction\s*\(/g;
for (const file of files.filter((path) => /\.[cm]?tsx?$/.test(path))) {
	if (!D1_TRANSACTION_SCOPES.some((prefix) => file.startsWith(prefix))) {
		continue;
	}
	if (file.includes("durable-sqlite")) continue;
	if (D1_TRANSACTION_ALLOWLIST.has(file)) continue;
	const raw = readText(file);
	if (!raw) continue;
	// Comments explaining *why* the call is banned would otherwise trip the ban.
	const text = raw
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(line, prefix) => prefix + " ".repeat(line.length - prefix.length),
		);
	for (const match of text.matchAll(d1TransactionPattern)) {
		failures.push(
			`${file}:${lineNumber(text, match.index ?? 0)} calls db.transaction(), which D1 rejects ` +
				"(BEGIN is not permitted, Cloudflare error 7500). Use db.batch() — D1 wraps a batch " +
				"in an implicit transaction.",
		);
	}
}

// Planes run only mechanical, policy-as-data transitions; the kernel is the one
// place a model decides (docs/decisions/agentic-kernel-architecture.md).
// packages/db is the plane layer, so it must never reach a model runtime.
const PLANE_MODEL_IMPORT =
	/(?:from|import\s*\()\s*["'](?:ai|@ai-sdk\/[^"']+|@cloudflare\/ai-chat|@earendil-works\/(?:pi-ai|pi-durable)|agents\/harness\/pi|@tedix\/workers-ai)["']|\bAI\.run\s*\(/g;
for (const file of files.filter(
	(path) =>
		path.startsWith("packages/db/src/") &&
		/\.[cm]?tsx?$/.test(path) &&
		!/\.test\.[cm]?tsx?$/.test(path),
)) {
	const text = readText(file);
	if (!text) continue;
	for (const match of text.matchAll(PLANE_MODEL_IMPORT)) {
		failures.push(
			`${file}:${lineNumber(text, match.index ?? 0)} reaches a model runtime from the DB plane layer; ` +
				"model decisions belong to the kernel or a tedi turn, never to packages/db.",
		);
	}
}

// TypeScript config consistency: a small set of hard invariants, not a
// normalization of every option. `@tedix/tsconfig` owns baseline compiler
// behaviour; leaf configs may add framework types, JSX, paths, and output
// details.
const APPROVED_TSCONFIG_EXTENDS = new Set([
	"@tedix/tsconfig/astro.json",
	"@tedix/tsconfig/base.json",
	"@tedix/tsconfig/cloudflare.json",
	"@tedix/tsconfig/node.json",
	"@tedix/tsconfig/react-library.json",
]);
const GENERATED_OR_VENDOR_SEGMENT =
	/(^|\/)(?:\.astro|\.wrangler|dist|node_modules)\//;
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

for (const file of files) {
	if (/\.tsbuildinfo(?:\.json)?$/.test(file)) {
		failures.push(
			`${file}: TypeScript build info is generated state and must not be tracked.`,
		);
	}
}
const workspaceDirs = files
	.filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file))
	.map((file) => file.slice(0, -"/package.json".length));
for (const dir of workspaceDirs) {
	const tsconfigPath = `${dir}/tsconfig.json`;
	if (!existsSync(tsconfigPath)) {
		const hasTs = files.some(
			(file) =>
				file.startsWith(`${dir}/`) &&
				/\.[cm]?[tj]sx?$/.test(file) &&
				!GENERATED_OR_VENDOR_SEGMENT.test(file),
		);
		if (hasTs) {
			failures.push(
				`${dir}: package has tracked TypeScript source but no tsconfig.json.`,
			);
		}
		continue;
	}
	const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as JsonObject;
	if (typeof tsconfig.extends !== "string") {
		failures.push(
			`${tsconfigPath}: must extend one shared @tedix/tsconfig preset.`,
		);
	} else if (!APPROVED_TSCONFIG_EXTENDS.has(tsconfig.extends)) {
		failures.push(
			`${tsconfigPath}: extends ${tsconfig.extends}; expected one of ${[...APPROVED_TSCONFIG_EXTENDS].join(", ")}.`,
		);
	}
	const options = isObject(tsconfig.compilerOptions)
		? tsconfig.compilerOptions
		: {};
	const lower = (value: unknown) => String(value).toLowerCase();
	if (options.strict === false) {
		failures.push(
			`${tsconfigPath}: compilerOptions.strict=false is not allowed (strict mode is a workspace invariant).`,
		);
	}
	if (options.isolatedModules === false) {
		failures.push(
			`${tsconfigPath}: compilerOptions.isolatedModules=false is not allowed (Workers/Bun tooling needs it).`,
		);
	}
	if ("module" in options && lower(options.module) === "commonjs") {
		failures.push(
			`${tsconfigPath}: compilerOptions.module=CommonJS is not allowed (Tedix packages are ESM).`,
		);
	}
	if (
		"moduleResolution" in options &&
		["classic", "node", "node10", "node16", "nodenext"].includes(
			lower(options.moduleResolution),
		)
	) {
		failures.push(
			`${tsconfigPath}: compilerOptions.moduleResolution=${String(options.moduleResolution)} is not allowed (use Bundler resolution via the shared tsconfig).`,
		);
	}
	const paths = isObject(options.paths) ? options.paths : {};
	for (const [alias, targets] of Object.entries(paths)) {
		if (alias !== "@/*") {
			failures.push(
				`${tsconfigPath}: path alias ${alias} is not allowed; use workspace package imports or the local @/* alias.`,
			);
		}
		if (!Array.isArray(targets)) continue;
		for (const target of targets) {
			if (typeof target === "string" && target.startsWith("../")) {
				failures.push(
					`${tsconfigPath}: path alias ${alias} points outside its package (${target}); use a workspace package export instead.`,
				);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("package boundary check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(
	`package boundary check passed (${files.length} tracked files checked)`,
);
