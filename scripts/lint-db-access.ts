#!/usr/bin/env bun

/**
 * Database access boundary (`bun run lint:db-access`): shared D1 statements live
 * in `packages/db`; application code neither builds Drizzle statements nor runs
 * raw D1 SQL except in storage owners listed in `scripts/db-access-exceptions.json`.
 * Durable Object-local SQLite is out of scope unless it uses a Drizzle adapter,
 * which must be recorded as `do-local-sqlite`. Also enforces the Drizzle package rules.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detachedGitEnv } from "./oss/git-env.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MANIFEST_PATH = join(REPO_ROOT, "scripts/db-access-exceptions.json");

export type StoragePlane =
	| "platform-d1"
	| "edge-enforcement-d1"
	| "app-owned-d1-adapter"
	| "provisioning-control-plane"
	| "runtime-enforcement-d1"
	| "do-local-sqlite";

export type ExceptionDisposition = "approved";

export type DrizzleException = {
	storagePlane: StoragePlane;
	disposition: ExceptionDisposition;
	owner: string;
	binding: string;
	reason: string;
};

export type DirectD1Exception = {
	storagePlane: Exclude<StoragePlane, "do-local-sqlite">;
	disposition: ExceptionDisposition;
	owner: string;
	binding: string;
	reason: string;
};

export type DbAccessManifest = {
	drizzleOutsideDb: Record<string, DrizzleException>;
	directD1: Record<string, DirectD1Exception>;
};

export type SourceFile = { path: string; text: string };

const SOURCE_FILE_RE = /\.[cm]?[tj]sx?$/;
const TEST_FILE_RE =
	/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\/)test-[^/]+\.[cm]?[tj]sx?$|\.(?:test|spec)\.[cm]?[tj]sx?$/;
const DRIZZLE_IMPORT_RE =
	/(?:from\s+["']|import\s*\(\s*["'])drizzle-orm(?:\/[a-z0-9-]+)?["']/g;
const DB_BUILDING_SURFACE_IMPORT_RE =
	/(?:from\s+["']|import\s*\(\s*["'])@tedix\/db\/(?:client|schema(?:\/[a-z0-9-]+)?)["']/g;

// Covers the normal DbClient names used in app code. Drizzle imports are also
// detected independently, so a renamed receiver cannot create an unregistered
// storage owner. Counts are diagnostics, not allowances.
const DRIZZLE_BUILDER_RE =
	/\b(?:context\.db|db|[A-Za-z_$][\w$]*(?:Db|DB))\s*\.\s*(?:select|insert|update|delete|query|execute|batch)\s*(?:\(|\.)/g;

const PREPARE_RECEIVER_RE =
	/\b((?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*prepare\s*\(/g;
const PLATFORM_BINDING_CALL_RE =
	/\b(?:(?:(?:this\.)?env|c\.env|context\.env|params(?:\.[A-Za-z_$][\w$]*)*\.env)\.[A-Z][A-Z0-9_]*|bindings\.(?:platformDb|db|d1))\s*\.\s*(?:batch|exec|dump|withSession)\s*\(/g;
const D1_SESSION_CALL_RE = /\bd1\s*\.\s*withSession\s*\(/g;
const D1_ADAPTER_CLASS_RE = /\bclass\s+[A-Za-z_$][\w$]*D1[A-Za-z_$]*\b/;
const D1_ADAPTER_METHOD_RE =
	/^\s*(?:async\s+)?(?:prepare|batch|exec|dump|withSession)\s*(?:<[^>]+>)?\s*\(/gm;

function countMatches(text: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	return [...text.matchAll(pattern)].length;
}

/** Mask comments and string bodies while preserving positions and newlines. */
function maskNonCode(source: string): string {
	let state: "code" | "line" | "block" | "single" | "double" | "template" =
		"code";
	let escaped = false;
	let output = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		const next = source[index + 1] ?? "";
		if (state === "code") {
			if (char === "/" && next === "/") {
				state = "line";
				output += "  ";
				index += 1;
			} else if (char === "/" && next === "*") {
				state = "block";
				output += "  ";
				index += 1;
			} else if (char === "'") {
				state = "single";
				output += " ";
			} else if (char === '"') {
				state = "double";
				output += " ";
			} else if (char === "`") {
				state = "template";
				output += " ";
			} else {
				output += char;
			}
			continue;
		}
		if (char === "\n") {
			output += "\n";
			if (state === "line") state = "code";
			continue;
		}
		if (state === "block" && char === "*" && next === "/") {
			output += "  ";
			index += 1;
			state = "code";
			continue;
		}
		if (state === "single" || state === "double" || state === "template") {
			const closing = state === "single" ? "'" : state === "double" ? '"' : "`";
			if (!escaped && char === closing) state = "code";
			escaped = !escaped && char === "\\";
			if (char !== "\\") escaped = false;
		}
		output += " ";
	}
	return output;
}

function maskComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(line, prefix: string) =>
				prefix + " ".repeat(line.length - prefix.length),
		);
}

/**
 * Every production `.prepare()` is D1 unless the file talks to a different
 * SQLite entirely: `drizzle-orm/durable-sqlite`, or `node:sqlite`'s
 * `DatabaseSync`, which the migration-chain and live-drift tooling uses to
 * replay the reviewed migration files into an in-memory database. Neither
 * reaches the shared D1 this policy exists to protect, so counting them is a
 * violation that cannot be fixed by routing through `@tedix/db/queries/*` —
 * there is no D1 in the file to route.
 */
function countD1PrepareCalls(source: string): number {
	if (source.includes("drizzle-orm/durable-sqlite")) return 0;
	if (/from\s+["']node:sqlite["']/.test(source)) return 0;
	return countMatches(maskNonCode(source), PREPARE_RECEIVER_RE);
}

function countD1AdapterCalls(source: string): number {
	if (!D1_ADAPTER_CLASS_RE.test(source)) return 0;
	return countMatches(source, D1_ADAPTER_METHOD_RE);
}

function lineNumber(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

function isProductionSource(path: string): boolean {
	return (
		SOURCE_FILE_RE.test(path) &&
		!TEST_FILE_RE.test(path) &&
		!path.endsWith(".d.ts")
	);
}

function validateReason(
	section: string,
	path: string,
	entry: { reason?: unknown; storagePlane?: unknown; disposition?: unknown },
	failures: string[],
): void {
	if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
		failures.push(
			`${section}.${path}: exception reason must explain why the storage owner is approved.`,
		);
	}
	const planes: StoragePlane[] = [
		"platform-d1",
		"edge-enforcement-d1",
		"app-owned-d1-adapter",
		"provisioning-control-plane",
		"runtime-enforcement-d1",
		"do-local-sqlite",
	];
	if (!planes.includes(entry.storagePlane as StoragePlane)) {
		failures.push(`${section}.${path}: invalid or missing storagePlane.`);
	}
	if (entry.disposition !== "approved") {
		failures.push(`${section}.${path}: invalid or missing disposition.`);
	}
	const metadata = entry as { owner?: unknown; binding?: unknown };
	if (
		typeof metadata.owner !== "string" ||
		metadata.owner.trim() === "" ||
		!metadata.owner.includes(":")
	) {
		failures.push(
			`${section}.${path}: owner must identify an app/package and purpose (for example packages/db:billing-settlement).`,
		);
	}
	if (typeof metadata.binding !== "string" || metadata.binding.trim() === "") {
		failures.push(
			`${section}.${path}: binding must identify the concrete database receiver or adapter.`,
		);
	}
}

function validateSorted(
	section: string,
	record: Record<string, unknown>,
	failures: string[],
): void {
	const keys = Object.keys(record);
	const sorted = [...keys].sort();
	if (keys.some((key, index) => key !== sorted[index])) {
		failures.push(
			`${section}: manifest paths must remain lexicographically sorted for review.`,
		);
	}
}

export function analyzeDbAccessPolicy(
	files: SourceFile[],
	manifest: DbAccessManifest,
): string[] {
	const failures: string[] = [];
	const production = files.filter((file) => isProductionSource(file.path));

	const drizzleActual = new Map<
		string,
		{ importCalls: number; builderCalls: number }
	>();
	for (const file of production) {
		if (file.path.startsWith("packages/db/")) continue;
		const importCalls = countMatches(file.text, DRIZZLE_IMPORT_RE);
		const code = maskNonCode(file.text);
		const builderCalls = countMatches(code, DRIZZLE_BUILDER_RE);
		const importsDbBuildingSurface =
			countMatches(file.text, DB_BUILDING_SURFACE_IMPORT_RE) > 0;
		// Builder syntax without a Drizzle import is still boundary debt: DbClient
		// and schema imports can otherwise construct statements in app consumers.
		const builderWithoutImport = importsDbBuildingSurface && builderCalls > 0;
		if (importCalls > 0 || builderWithoutImport) {
			drizzleActual.set(file.path, {
				importCalls,
				builderCalls:
					importCalls > 0 || builderWithoutImport ? builderCalls : 0,
			});
		}
	}

	validateSorted("drizzleOutsideDb", manifest.drizzleOutsideDb, failures);
	for (const [path, entry] of Object.entries(manifest.drizzleOutsideDb)) {
		validateReason("drizzleOutsideDb", path, entry, failures);
		if (entry.storagePlane === "do-local-sqlite") {
			const file = production.find((candidate) => candidate.path === path);
			if (file && !file.text.includes("drizzle-orm/durable-sqlite")) {
				failures.push(
					`${path}: do-local-sqlite exception is invalid without a drizzle-orm/durable-sqlite import.`,
				);
			}
		}
		const actual = drizzleActual.get(path);
		if (!actual) {
			failures.push(
				`${path}: stale Drizzle exception; no app-layer import or builder remains.`,
			);
			continue;
		}
		drizzleActual.delete(path);
	}
	for (const [path, actual] of drizzleActual) {
		failures.push(
			`${path}: app-layer Drizzle access is not permitted (imports=${actual.importCalls}, builders=${actual.builderCalls}); move the statement to @tedix/db/queries/* or add a reviewed storage-plane exception.`,
		);
	}

	const directD1Actual = new Map<
		string,
		{ prepareCalls: number; bindingCalls: number; adapterCalls: number }
	>();
	for (const file of production) {
		const code = maskNonCode(file.text);
		const prepareCalls = countD1PrepareCalls(file.text);
		const bindingCalls =
			countMatches(code, PLATFORM_BINDING_CALL_RE) +
			countMatches(code, D1_SESSION_CALL_RE);
		const adapterCalls = countD1AdapterCalls(file.text);
		if (prepareCalls > 0 || bindingCalls > 0 || adapterCalls > 0) {
			directD1Actual.set(file.path, {
				prepareCalls,
				bindingCalls,
				adapterCalls,
			});
		}
	}

	validateSorted("directD1", manifest.directD1, failures);
	for (const [path, entry] of Object.entries(manifest.directD1)) {
		validateReason("directD1", path, entry, failures);
		if (entry.storagePlane === "do-local-sqlite") {
			failures.push(
				`${path}: direct D1 exceptions cannot use the do-local-sqlite plane.`,
			);
		}
		const actual = directD1Actual.get(path);
		if (!actual) {
			failures.push(
				`${path}: stale direct-D1 exception; no raw binding call remains.`,
			);
			continue;
		}
		directD1Actual.delete(path);
	}
	for (const [path, actual] of directD1Actual) {
		failures.push(
			`${path}: direct D1 access is not permitted (prepare=${actual.prepareCalls}, binding=${actual.bindingCalls}, adapter=${actual.adapterCalls}); use @tedix/db/queries/* or add a reviewed storage-plane exception.`,
		);
	}

	return failures;
}

// ── Drizzle package architecture ────────────────────────────────────────────

/*
 * Structural guardrails for the shared Drizzle package.
 *
 * Query modules are leaf imports, not aggregation barrels. Persistence modules
 * return database-native rows/results and leave transport normalization to the
 * owning app. Persisted JSON must use a JSON-safe type rather than `unknown`.
 */
export type DbArchitectureSource = { path: string; text: string };

const QUERY_SOURCE_PREFIX = "packages/db/src/queries/";
const SCHEMA_SOURCE_PREFIX = "packages/db/src/schema/";
const QUERY_REEXPORT_RE =
	/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']\.\//g;
const TRANSPORT_MAPPER_RE =
	/\b(?:function|const)\s+[A-Za-z_$][\w$]*(?:RowToContract|RowsToContract|ToContractRow)\b/g;
const DEPRECATED_GET_TABLE_COLUMNS_RE = /\bgetTableColumns\b/g;
const STANDALONE_DRIZZLE_ZOD_RE = /(?:from\s+|import\s*\()["']drizzle-zod["']/g;
const DOWNLOAD_ON_DEMAND_DRIZZLE_KIT_RE =
	/\b(?:bunx|bun\s+x|pnpm\s+dlx|yarn\s+dlx|npx\s+(?:-y|--yes))\s+(?:--\S+\s+)*drizzle-kit\b/g;
const UNSAFE_JSON_TYPE_RE =
	/\{\s*mode\s*:\s*["']json["']\s*\}\)\s*\.\$type<(?:(?!>\s*\(\s*\))[\s\S])*\bunknown\b(?:(?!>\s*\(\s*\))[\s\S])*>\s*\(\s*\)/g;

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(line, prefix: string) =>
				prefix + " ".repeat(line.length - prefix.length),
		);
}

export function analyzeDbArchitecture(files: DbArchitectureSource[]): string[] {
	const failures: string[] = [];
	const rootManifestFile = files.find((file) => file.path === "package.json");
	const dbManifestFile = files.find(
		(file) => file.path === "packages/db/package.json",
	);
	if (rootManifestFile && dbManifestFile) {
		const rootManifest = JSON.parse(rootManifestFile.text) as {
			catalog?: Record<string, string>;
		};
		const dbManifest = JSON.parse(dbManifestFile.text) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const ormVersion = rootManifest.catalog?.["drizzle-orm"];
		const kitVersion = dbManifest.devDependencies?.["drizzle-kit"];
		if (
			!ormVersion ||
			dbManifest.dependencies?.["drizzle-orm"] !== "catalog:" ||
			kitVersion !== ormVersion
		) {
			failures.push(
				"package.json + packages/db/package.json: drizzle-orm must use the exact root catalog pin and drizzle-kit must match it exactly.",
			);
		}
	}
	const splitQueryDomains = new Set(
		files
			.map((file) => file.path)
			.filter((path) => path.startsWith(QUERY_SOURCE_PREFIX))
			.map((path) => path.slice(QUERY_SOURCE_PREFIX.length).split("/"))
			.filter((parts) => parts.length > 1)
			.map(([domain]) => domain),
	);

	for (const file of files) {
		for (const match of file.text.matchAll(DOWNLOAD_ON_DEMAND_DRIZZLE_KIT_RE)) {
			failures.push(
				`${file.path}:${lineNumber(file.text, match.index ?? 0)} uses download-on-demand Drizzle Kit; run the project-installed pinned binary instead.`,
			);
		}

		if (file.path === "packages/db/package.json") {
			const manifest = JSON.parse(file.text) as {
				exports?: Record<string, unknown>;
			};
			if (manifest.exports && "./queries" in manifest.exports) {
				failures.push(
					`${file.path}: the aggregate ./queries package export is forbidden; expose exact query leaves.`,
				);
			}
			continue;
		}
		if (!file.path.endsWith(".ts") || file.path.endsWith(".test.ts")) continue;
		const source = stripComments(file.text);
		const queryRelativePath = file.path.startsWith(QUERY_SOURCE_PREFIX)
			? file.path.slice(QUERY_SOURCE_PREFIX.length)
			: undefined;
		if (
			queryRelativePath &&
			!queryRelativePath.includes("/") &&
			splitQueryDomains.has(queryRelativePath.slice(0, -3))
		) {
			failures.push(
				`${file.path}: a root query module cannot coexist with its split domain folder; consumers must import capability leaves.`,
			);
		}

		if (
			file.path === `${QUERY_SOURCE_PREFIX}index.ts` ||
			(file.path.startsWith(QUERY_SOURCE_PREFIX) &&
				file.path.endsWith("/index.ts"))
		) {
			failures.push(
				`${file.path}: query index modules are forbidden; expose and import direct leaf modules.`,
			);
		}

		if (file.path.startsWith(QUERY_SOURCE_PREFIX)) {
			for (const match of source.matchAll(QUERY_REEXPORT_RE)) {
				failures.push(
					`${file.path}:${lineNumber(source, match.index ?? 0)} re-exports a sibling query module; import the owning leaf module directly instead of creating a domain barrel.`,
				);
			}
			for (const match of source.matchAll(TRANSPORT_MAPPER_RE)) {
				failures.push(
					`${file.path}:${lineNumber(source, match.index ?? 0)} defines a DB-to-contract mapper; return persistence rows/results and normalize in the owning app.`,
				);
			}
		}

		for (const match of source.matchAll(DEPRECATED_GET_TABLE_COLUMNS_RE)) {
			failures.push(
				`${file.path}:${lineNumber(source, match.index ?? 0)} uses deprecated getTableColumns(); Drizzle v1 uses getColumns().`,
			);
		}

		for (const match of source.matchAll(STANDALONE_DRIZZLE_ZOD_RE)) {
			failures.push(
				`${file.path}:${lineNumber(source, match.index ?? 0)} imports standalone drizzle-zod; Drizzle v1 validators live at drizzle-orm/zod.`,
			);
		}

		if (file.path.startsWith(SCHEMA_SOURCE_PREFIX)) {
			for (const match of source.matchAll(UNSAFE_JSON_TYPE_RE)) {
				failures.push(
					`${file.path}:${lineNumber(source, match.index ?? 0)} types persisted JSON with unknown; use a domain type, JsonValue, or Record<string, JsonValue>.`,
				);
			}
		}
	}

	return failures;
}

function trackedFiles(pathspecs: readonly string[]): SourceFile[] {
	const result = spawnSync(
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			...pathspecs,
		],
		{ cwd: REPO_ROOT, encoding: "utf8", env: detachedGitEnv() },
	);
	if (result.status !== 0)
		throw new Error(result.stderr || "git ls-files failed");
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.filter((path) => {
			const absolutePath = join(REPO_ROOT, path);
			return existsSync(absolutePath) && statSync(absolutePath).isFile();
		})
		.sort()
		.map((path) => ({
			path,
			text: readFileSync(join(REPO_ROOT, path), "utf8"),
		}));
}

if (import.meta.main) {
	const manifest = JSON.parse(
		readFileSync(MANIFEST_PATH, "utf8"),
	) as DbAccessManifest;
	const sourceFiles = trackedFiles(["apps", "packages"]);
	const accessFailures = analyzeDbAccessPolicy(sourceFiles, manifest);
	const dbFiles = trackedFiles([
		"packages/db/src/queries",
		"packages/db/src/schema",
		"packages/db/scripts",
		".github/workflows",
		"package.json",
		"packages/db/package.json",
	]);
	const architectureFailures = analyzeDbArchitecture(dbFiles);
	if (accessFailures.length > 0) {
		console.error("database access policy check failed:");
		for (const failure of accessFailures) console.error(`- ${failure}`);
	}
	if (architectureFailures.length > 0) {
		console.error("database architecture check failed:");
		for (const failure of architectureFailures) console.error(`- ${failure}`);
	}
	if (accessFailures.length > 0 || architectureFailures.length > 0) {
		process.exit(1);
	}
	console.log(
		`database access and architecture checks passed (${sourceFiles.length} source files, ${dbFiles.length} DB files checked)`,
	);
}
