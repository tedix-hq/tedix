#!/usr/bin/env bun

/**
 * Wrangler config lint over every `apps/<app>/wrangler.jsonc` and every cf-CLI
 * `apps/<app>/cloudflare.config.ts` (converted to the wrangler shape `cf deploy`
 * uploads; see lintCfConfigModule for the rules that differ): compatibility_date
 * floor, env blocks that shrink replaced arrays, no secret-shaped literal `vars`,
 * SQLite-only DO migrations, crons need a `scheduled` handler (use `"crons": []`
 * to remove them), `@tedix/ssrf-guard` importers need `global_fetch_strictly_public`
 * in every env, and binding parity across envs. `--strict` exits 1 on errors.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

/**
 * Minimum `compatibility_date` allowed anywhere in the repo. Raise it only by
 * rolling every app forward, never below the current floor.
 */
const COMPAT_DATE_FLOOR = "2026-05-14";

const SECRET_NAME_PATTERN = /TOKEN|SECRET|KEY|PASSWORD/;

/** Arrays that wrangler env blocks replace (never merge) from the top level. */
const REPLACED_ARRAY_KEYS = ["compatibility_flags", "routes"] as const;

/** Every array-valued binding family accepted by the repo's config baseline. */
const BINDING_ARRAY_FAMILIES: Record<string, string> = {
	ai_search_namespaces: "ai_search",
	analytics_engine_datasets: "analytics_engine",
	artifacts: "artifacts",
	d1_databases: "d1",
	flagship: "flagship",
	kv_namespaces: "kv_namespace",
	r2_buckets: "r2_bucket",
	ratelimits: "ratelimit",
	send_email: "send_email",
	services: "service",
	worker_loaders: "worker_loader",
	workflows: "workflow",
};

/** Every object-valued singleton binding accepted by the config baseline. */
const BINDING_OBJECT_FAMILIES: Record<string, string> = {
	ai: "ai",
	browser: "browser",
	images: "images",
	version_metadata: "version_metadata",
};

/**
 * Compatibility flag required on any Worker that fetches a URL a remote party
 * chose. With it, global `fetch()` routes as if from the public Internet;
 * without it, a fetch at one of our own zones is handed straight to the zone's
 * origin, bypassing every Worker route and Cloudflare security setting on the
 * way.
 */
const STRICTLY_PUBLIC_FLAG = "global_fetch_strictly_public";

/** Importing this package is a Worker declaring it fetches untrusted URLs. */
const SSRF_GUARD_SPECIFIER = "@tedix/ssrf-guard";

const SSRF_GUARD_IMPORT_RE = /["']@tedix\/ssrf-guard["']/;

/**
 * A bare (global) `fetch(` whose first argument does not start with a string
 * literal. `.fetch(` member calls (service bindings, injected fetchers) are
 * excluded via the lookbehind; `globalThis.fetch(` counts as bare. Template
 * literals count as non-literal — in this codebase a backtick URL virtually
 * always interpolates. Textual heuristic, deliberately: it only feeds a
 * warning that asks "who chose this URL?", not a merge-blocking error.
 */
export const BARE_DYNAMIC_FETCH_RE =
	/(?<![.\w$])(?:globalThis\.)?fetch\(\s*(?!["'])/;

/** Does this source text contain a bare `fetch(` on a non-literal URL? */
export function sourceHasBareDynamicFetch(source: string): boolean {
	const executableSource = source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(comment, prefix: string) =>
				prefix + " ".repeat(comment.length - prefix.length),
		);
	const withoutHandlerDeclarations = executableSource
		.replace(/\b(?:async\s+)?fetch\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{/g, "")
		.replace(/\bfetch\s*\([^)]*\)\s*:\s*[^;{]+;/g, "");
	return BARE_DYNAMIC_FETCH_RE.test(withoutHandlerDeclarations);
}

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const TEST_FILE_RE = /\.(?:test|spec)\.|(?:^|\/)__tests__\//;

/** Declaration files carry type signatures (e.g. `fetch(input: ...)`), not code. */
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Structural view of the parts of wrangler's resolved `Config` this lint
 * reads. Wrangler's own `Config` type degrades to `any` here because its
 * declaration imports `@cloudflare/workers-utils` types that are bundled (not
 * installed), so a narrow local type keeps the script strictly typed.
 */
export interface ResolvedWranglerConfig {
	[key: string]: unknown;
	name?: string;
	main?: string;
	compatibility_date?: string;
	compatibility_flags?: string[];
	routes?: unknown[];
	triggers?: { crons?: string[] };
	vars?: Record<string, unknown>;
	definedEnvironments?: string[];
	migrations?: Array<{
		tag?: string;
		new_classes?: string[];
		new_sqlite_classes?: string[];
	}>;
}

export interface Finding {
	severity: "error" | "warning";
	file: string;
	message: string;
}

export interface NamedEnvironmentConfig {
	envName: string;
	config: ResolvedWranglerConfig;
}

const BINDING_PARITY_SEVERITY: Finding["severity"] = "error";

interface BindingParityException {
	file: string;
	envName: string;
	family: string;
	reason: string;
}

/** Narrow, reviewed differences between named deployment environments. */
export const BINDING_PARITY_EXCEPTIONS: readonly BindingParityException[] = [
	{
		file: "apps/tedi/cloudflare.config.ts",
		envName: "development",
		family: "artifacts",
		reason:
			"Artifacts has no local simulation; isolated `bun dev` omits it and `bun run dev:remote` binds the remote namespace",
	},
	{
		file: "apps/cms/cloudflare.config.ts",
		envName: "development",
		family: "artifacts",
		reason:
			"Artifacts has no local simulation; isolated `bun dev` omits it and `bun run dev:remote` binds the remote namespace",
	},
	{
		file: "apps/cms/cloudflare.config.ts",
		envName: "development",
		family: "service",
		reason:
			"isolated `bun dev` runs without apps/api or the CMS runtime; `bun run dev:remote` binds both services",
	},
	{
		file: "apps/docs/cloudflare.config.ts",
		envName: "development",
		family: "artifacts",
		reason:
			"Artifacts has no local simulation; isolated `bun dev` omits it and `bun run dev:remote` binds the remote namespace",
	},
	{
		file: "apps/docs/cloudflare.config.ts",
		envName: "development",
		family: "ai_search",
		reason:
			"AI Search has no local simulation; isolated `bun dev` omits it and `bun run dev:remote` binds the remote namespace",
	},
	{
		file: "apps/cms-runtime/cloudflare.config.ts",
		envName: "development",
		family: "ai_search",
		reason:
			"AI Search namespaces have no local simulation; isolated `bun dev` omits it and `bun run dev:remote` binds the remote namespace",
	},
	{
		file: "apps/cms-runtime/cloudflare.config.ts",
		envName: "development",
		family: "service",
		reason:
			"isolated `bun dev` runs without apps/api or the session broker; `bun run dev:remote` binds both production services",
	},
	{
		file: "apps/cms-runtime/cloudflare.config.ts",
		envName: "development",
		family: "cron",
		reason:
			"remote development shares production D1/R2 bindings; a cron there would double-run scheduled work against live tenant bundles",
	},
	{
		file: "apps/skill-runtime/cloudflare.config.ts",
		envName: "development",
		family: "cron",
		reason:
			"remote development shares production D1; a development cron would run a second skill-run reconciler against live runs",
	},
];

/**
 * Production is the only deploy target. A staging environment sharing its
 * D1/R2/queue bindings can double-run scheduled work against live data.
 */
export function checkNoStagingEnvironment(
	file: string,
	definedEnvironments: readonly string[] | undefined,
	findings: Finding[],
): void {
	if (!definedEnvironments?.includes("staging")) return;
	findings.push({
		severity: "error",
		file,
		message:
			`env "staging" is declared, but the staging deploy lane is retired. ` +
			`A staging env sharing production D1/R2/queue bindings can double-run scheduled work against live data. ` +
			`Fix in ${file}: remove the "staging" env. Production is the only deploy target.`,
	});
}

/**
 * The staging hazard is not the word "staging" — it is a side environment
 * that shares the production bindings while carrying either scheduled work
 * (crons double-run against live data) or the production script name (a
 * deploy of the env silently overwrites the live Worker). apps/cms-runtime
 * shipped exactly that shape as env "development" and the keyword check
 * above could not see it, so side envs are checked structurally too.
 */
export function checkSideEnvironmentDeployHazards(
	file: string,
	envName: string,
	topLevel: ResolvedWranglerConfig,
	envConfig: ResolvedWranglerConfig,
	findings: Finding[],
): void {
	if (envName === "production") return;
	const crons = envConfig.triggers?.crons ?? [];
	if (crons.length > 0) {
		findings.push({
			severity: "error",
			file,
			message:
				`env "${envName}" declares crons (${JSON.stringify(crons)}). Side environments share the ` +
				`production D1/R2/queue bindings, so deploying this env would double-run scheduled work ` +
				`against live data — the exact hazard that retired the staging lane. Fix in ${file}: ` +
				`remove "triggers" from env "${envName}"; local dev can invoke /__scheduled manually.`,
		});
	}
	// Wrangler derives "<top>-<env>" when an env declares no name, so a
	// resolved name equal to the top level can only be an explicit collision.
	if (envConfig.name !== undefined && envConfig.name === topLevel.name) {
		findings.push({
			severity: "error",
			file,
			message:
				`env "${envName}" resolves to script name "${envConfig.name}", identical to the top-level script name. ` +
				`Deploying this env would overwrite the production Worker in place. Fix in ${file}: ` +
				`remove "name" from env "${envName}" so wrangler derives a suffixed script name.`,
		});
	}
}

function readResolvedConfig(
	configPath: string,
	env?: string,
): ResolvedWranglerConfig {
	return unstable_readConfig(
		{ config: configPath, env },
		{ hideWarnings: true },
	) as ResolvedWranglerConfig;
}

function entryKey(entry: unknown): string {
	return typeof entry === "string" ? entry : JSON.stringify(entry);
}

function checkCompatDate(
	file: string,
	config: ResolvedWranglerConfig,
	findings: Finding[],
): void {
	const date = config.compatibility_date;
	if (!date) {
		findings.push({
			severity: "error",
			file,
			message:
				`missing "compatibility_date". Fix: add at the top level of ${file}:\n` +
				`    "compatibility_date": "${COMPAT_DATE_FLOOR}"`,
		});
		return;
	}
	if (date < COMPAT_DATE_FLOOR) {
		findings.push({
			severity: "error",
			file,
			message:
				`"compatibility_date": "${date}" is below the repo floor ${COMPAT_DATE_FLOOR}. Fix in ${file}:\n` +
				`    "compatibility_date": "${COMPAT_DATE_FLOOR}"`,
		});
	}
}

function checkEnvArrayReplacement(
	file: string,
	topLevel: ResolvedWranglerConfig,
	envName: string,
	envConfig: ResolvedWranglerConfig,
	findings: Finding[],
): void {
	for (const key of REPLACED_ARRAY_KEYS) {
		const topArray = topLevel[key] ?? [];
		const envArray = envConfig[key] ?? [];
		if (topArray.length === 0 || envArray.length >= topArray.length) continue;
		const envKeys = new Set(envArray.map(entryKey));
		const dropped = topArray.filter((entry) => !envKeys.has(entryKey(entry)));
		if (dropped.length === 0) continue;
		const droppedList = dropped.map(entryKey).join(", ");
		findings.push({
			severity: "warning",
			file,
			message:
				`env "${envName}" redefines "${key}" with fewer entries than the top level; wrangler env blocks REPLACE top-level arrays, so these entries are silently dropped in that env: ${droppedList}. ` +
				`Fix in ${file}: repeat the full array inside the env block:\n` +
				`    "env": { "${envName}": { "${key}": ${JSON.stringify(topArray)} } }\n` +
				`  (or remove "${key}" from the env block entirely to inherit the top level).`,
		});
	}
}

function checkSecretVars(
	file: string,
	scope: string,
	config: ResolvedWranglerConfig,
	seen: Set<string>,
	findings: Finding[],
): void {
	for (const [name, value] of Object.entries(config.vars ?? {})) {
		if (!SECRET_NAME_PATTERN.test(name)) continue;
		const isNonEmptyLiteral =
			typeof value === "string"
				? value.trim() !== ""
				: value !== undefined && value !== null;
		if (!isNonEmptyLiteral) continue;
		const dedupeKey = `${name}\0${JSON.stringify(value)}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		findings.push({
			severity: "error",
			file,
			message:
				`${scope} "vars" declares secret-shaped name "${name}" with a non-empty literal value. Secrets belong in the app's .env.example secret manifest (provider references), never in wrangler.jsonc. ` +
				`Fix in ${file}: delete the "${name}" entry from "vars" and declare it as a required secret in the same scope:\n` +
				`    "secrets": { "required": ["${name}"] }\n` +
				`  then add the provider reference to the app's .env.example and run: bunx wrangler types --env-interface CloudflareEnv`,
		});
	}
}

function checkSqliteOnlyMigrations(
	file: string,
	scope: string,
	config: ResolvedWranglerConfig,
	seen: Set<string>,
	findings: Finding[],
): void {
	for (const migration of config.migrations ?? []) {
		const kvClasses = migration.new_classes ?? [];
		if (kvClasses.length === 0) continue;
		const tag = migration.tag ?? "(untagged)";
		const dedupeKey = `${tag} ${kvClasses.join(",")}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		findings.push({
			severity: "error",
			file,
			message:
				`${scope} migration "${tag}" creates KV-backed Durable Object class(es) via "new_classes": ${kvClasses.join(", ")}. ` +
				`Cloudflare no longer provisions KV-backed DO namespaces on accounts without existing ones, so this deploy fails at upload time. ` +
				`Fix in ${file}: use "new_sqlite_classes" instead:\n` +
				`    { "tag": "${tag}", "new_sqlite_classes": ${JSON.stringify(kvClasses)} }\n` +
				`  (only safe for classes never deployed with the KV backend; a deployed class's storage backend cannot be changed by editing the migration).`,
		});
	}
}

/**
 * Error when cron triggers are declared but the entrypoint has no `scheduled`
 * handler. Deliberately conservative: it fires only when the entry source never
 * mentions `scheduled` AT ALL, so a handler that is imported, re-exported, or
 * delegated still counts. That trades false negatives (a file mentioning
 * `scheduled` only in a comment) for zero false positives — the check must
 * never block a deploy on a Worker that is in fact wired correctly.
 */
function checkCronHandler(
	file: string,
	configDir: string,
	scope: string,
	config: ResolvedWranglerConfig,
	seen: Set<string>,
	findings: Finding[],
): void {
	const crons = config.triggers?.crons ?? [];
	if (crons.length === 0) return;

	const main = config.main;
	if (!main) return; // no entrypoint to inspect (e.g. an assets-only Worker)
	const entryPath = isAbsolute(main) ? main : join(configDir, main);
	if (seen.has(entryPath)) return;
	seen.add(entryPath);
	if (!existsSync(entryPath)) return; // a missing entry is wrangler's error to raise

	if (/\bscheduled\b/.test(readFileSync(entryPath, "utf8"))) return;

	const entryRel = relative(REPO_ROOT, entryPath);
	findings.push({
		severity: "error",
		file,
		message:
			`${scope} declares "triggers.crons" (${crons.join(", ")}) but the entrypoint ${entryRel} never mentions "scheduled". ` +
			`Wrangler deploys the triggers anyway, so every tick fails at runtime with "Handler does not export a scheduled() function" — billed, retried, and visible only in the account error stream. ` +
			`Fix EITHER by exporting a handler from ${entryRel}:\n` +
			`    export default { fetch: app.fetch, async scheduled(event, env, ctx) { /* ... */ } }\n` +
			`  OR, if the schedule is owned elsewhere (e.g. the tedi runtime DO's Agents-SDK scheduler), delete "triggers" from ${file}.`,
	});
}

export interface SsrfSourceScan {
	/** First non-test source file importing `@tedix/ssrf-guard`, or null. */
	guardImporter: string | null;
	/** First non-test source file with a bare non-literal `fetch(`, or null. */
	dynamicFetchFile: string | null;
}

/**
 * One walk over a Worker's deployed local module graph feeding both halves of
 * the SSRF rule: the
 * first non-test file that imports `@tedix/ssrf-guard`, and the first with a
 * bare `fetch(` on a non-literal URL. Matches the quoted guard specifier
 * anywhere in the file rather than parsing import syntax, so `import`,
 * `import type`, `export ... from`, and dynamic `import()` all count — the
 * question is only whether this Worker's bundle reaches the guard, not how.
 */
function scanSsrfSources(entryPath: string | null): SsrfSourceScan {
	const scan: SsrfSourceScan = { guardImporter: null, dynamicFetchFile: null };
	const visited = new Set<string>();
	const resolveLocalImport = (
		from: string,
		specifier: string,
	): string | null => {
		if (!specifier.startsWith(".")) return null;
		const base = join(dirname(from), specifier);
		const candidates = [
			base,
			base.replace(/\.js$/, ".ts"),
			`${base}.ts`,
			`${base}.tsx`,
			join(base, "index.ts"),
			join(base, "index.tsx"),
		];
		return candidates.find((candidate) => existsSync(candidate)) ?? null;
	};
	const walk = (path: string): void => {
		if (scan.guardImporter && scan.dynamicFetchFile) return;
		if (visited.has(path) || TEST_FILE_RE.test(path)) return;
		visited.add(path);
		if (!SOURCE_FILE_RE.test(path) || DECLARATION_FILE_RE.test(path)) return;
		const source = readFileSync(path, "utf8");
		if (!scan.guardImporter && SSRF_GUARD_IMPORT_RE.test(source)) {
			scan.guardImporter = path;
		}
		if (!scan.dynamicFetchFile && sourceHasBareDynamicFetch(source)) {
			scan.dynamicFetchFile = path;
		}
		const specifiers = [
			...source.matchAll(
				/\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g,
			),
			...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
			...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
		];
		for (const match of specifiers) {
			const target = match[1] ? resolveLocalImport(path, match[1]) : null;
			if (target) walk(target);
		}
	};
	if (entryPath && existsSync(entryPath)) walk(entryPath);
	return scan;
}

/**
 * Require `global_fetch_strictly_public` on every Worker that imports the SSRF
 * guard. Runs against each RESOLVED scope (top level and every named env), so
 * an env block that inherits the top-level array passes while one that
 * redefines `compatibility_flags` without the flag fails — which is the whole
 * trap, since wrangler replaces that array instead of merging it.
 */
function checkStrictlyPublicFetch(
	file: string,
	scope: string,
	guardImporter: string | null,
	config: ResolvedWranglerConfig,
	findings: Finding[],
): void {
	if (!guardImporter) return;
	const flags = config.compatibility_flags ?? [];
	if (flags.includes(STRICTLY_PUBLIC_FLAG)) return;
	findings.push({
		severity: "error",
		file,
		message:
			`${scope} imports ${SSRF_GUARD_SPECIFIER} (${relative(REPO_ROOT, guardImporter)}) but omits the "${STRICTLY_PUBLIC_FLAG}" compatibility flag. ` +
			`That import means a remote party chooses a URL this Worker fetches, and the guard is only a pre-DNS hostname check — it cannot see a public hostname that resolves or rebinds to a private address, and it does not stop a fetch at one of our own zones from bypassing every Worker route and Cloudflare security setting straight to the origin. ` +
			`Fix in ${file}: add the flag to the top-level array AND to every "env" block that redefines it (env blocks REPLACE this array, they do not merge):\n` +
			`    "compatibility_flags": ${JSON.stringify([...flags, STRICTLY_PUBLIC_FLAG])}`,
	});
}

/**
 * The other half of rule 7: NOT importing the guard is not the escape hatch.
 * When a Worker's source contains a bare `fetch(` on a non-literal URL and it
 * neither imports `@tedix/ssrf-guard` nor carries the
 * `global_fetch_strictly_public` flag in this resolved scope, warn. Workers
 * that do import the guard are covered by the error-severity check above.
 * Warning-level because the textual pattern cannot tell a remote-chosen URL
 * from a computed-but-self-owned one; do NOT downgrade the importer check to
 * match.
 */
export function checkDynamicFetchContainment(
	file: string,
	scope: string,
	scan: SsrfSourceScan,
	config: ResolvedWranglerConfig,
	findings: Finding[],
): void {
	if (scan.guardImporter) return; // error-severity rule 7 owns this Worker
	if (!scan.dynamicFetchFile) return;
	const flags = config.compatibility_flags ?? [];
	if (flags.includes(STRICTLY_PUBLIC_FLAG)) return;
	findings.push({
		severity: "warning",
		file,
		message:
			`${scope} has a bare fetch() on a non-literal URL (${relative(REPO_ROOT, scan.dynamicFetchFile)}) but neither imports ${SSRF_GUARD_SPECIFIER} nor carries the "${STRICTLY_PUBLIC_FLAG}" compatibility flag. ` +
			`A computed URL reaching the global fetch is how a remote-chosen target slips out unvalidated, and skipping the guard import must not exempt a Worker from the containment flag. ` +
			`Fix in ${file}: route remote-chosen URLs through guardedFetch/validateUrl from ${SSRF_GUARD_SPECIFIER} AND add the flag (to the top-level array and every "env" block that redefines it):\n` +
			`    "compatibility_flags": ${JSON.stringify([...flags, STRICTLY_PUBLIC_FLAG])}\n` +
			`  If every computed URL here is provably self-owned (own zones, service bindings), adding the flag alone is acceptable.`,
	});
}

function bindingFamilyCounts(
	config: ResolvedWranglerConfig,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const [key, family] of Object.entries(BINDING_ARRAY_FAMILIES)) {
		const value = config[key];
		counts.set(family, Array.isArray(value) ? value.length : 0);
	}
	for (const [key, family] of Object.entries(BINDING_OBJECT_FAMILIES)) {
		const value = config[key];
		counts.set(
			family,
			typeof value === "object" && value !== null && !Array.isArray(value)
				? 1
				: 0,
		);
	}
	const durableObjects = config.durable_objects;
	const durableObjectBindings =
		typeof durableObjects === "object" && durableObjects !== null
			? (durableObjects as { bindings?: unknown }).bindings
			: undefined;
	counts.set(
		"durable_object",
		Array.isArray(durableObjectBindings) ? durableObjectBindings.length : 0,
	);
	const queues = config.queues;
	const queueConfig =
		typeof queues === "object" && queues !== null
			? (queues as { producers?: unknown; consumers?: unknown })
			: undefined;
	counts.set(
		"queue_producer",
		Array.isArray(queueConfig?.producers) ? queueConfig.producers.length : 0,
	);
	counts.set(
		"queue_consumer",
		Array.isArray(queueConfig?.consumers) ? queueConfig.consumers.length : 0,
	);
	const assets = config.assets;
	counts.set(
		"assets",
		typeof assets === "object" && assets !== null && !Array.isArray(assets)
			? 1
			: 0,
	);
	// Cron triggers are not bindings, but they share the same non-merge hazard
	// and an explicit empty array has deploy-time reconciliation semantics.
	counts.set("cron", config.triggers?.crons?.length ?? 0);
	return counts;
}

function isBindingParityException(
	file: string,
	envName: string,
	family: string,
): boolean {
	return BINDING_PARITY_EXCEPTIONS.some(
		(exception) =>
			exception.file === file &&
			exception.envName === envName &&
			exception.family === family,
	);
}

/**
 * Detect a binding family that one named deploy environment has fewer of than
 * another. Only named environments are compared: the top-level scope is local
 * development in this repo and intentionally has a different binding shape.
 */
export function checkNamedEnvironmentBindingParity(
	file: string,
	environments: readonly NamedEnvironmentConfig[],
	findings: Finding[],
	severity: Finding["severity"] = BINDING_PARITY_SEVERITY,
): void {
	if (environments.length < 2) return;

	const countsByEnvironment = environments.map(({ envName, config }) => ({
		envName,
		counts: bindingFamilyCounts(config),
	}));
	const families = new Set(
		countsByEnvironment.flatMap(({ counts }) => [...counts.keys()]),
	);

	for (const family of [...families].sort()) {
		const maximum = Math.max(
			...countsByEnvironment.map(({ counts }) => counts.get(family) ?? 0),
		);
		if (maximum === 0) continue;

		const referenceEnvironments = countsByEnvironment
			.filter(({ counts }) => (counts.get(family) ?? 0) === maximum)
			.map(({ envName }) => envName)
			.join('", "');
		for (const { envName, counts } of countsByEnvironment) {
			const actual = counts.get(family) ?? 0;
			if (actual >= maximum) continue;
			if (isBindingParityException(file, envName, family)) continue;
			findings.push({
				severity,
				file,
				message:
					`env "${envName}" declares ${actual} ${family} binding(s), fewer than env "${referenceEnvironments}" (${maximum}). ` +
					`Wrangler does not inherit bindings into named environments, so this silently removes the binding from that deployment. ` +
					`Fix in ${file}: repeat the missing ${family} binding(s) in env "${envName}", or add a narrowly documented entry to BINDING_PARITY_EXCEPTIONS when the difference is intentional.`,
			});
		}
	}
}

function lintConfig(
	configPath: string,
	findings: Finding[],
): ResolvedWranglerConfig | null {
	const file = relative(REPO_ROOT, configPath);
	let topLevel: ResolvedWranglerConfig;
	try {
		topLevel = readResolvedConfig(configPath);
	} catch (error) {
		findings.push({
			severity: "error",
			file,
			message: `wrangler failed to parse this config: ${error instanceof Error ? error.message : String(error)}`,
		});
		return null;
	}

	checkCompatDate(file, topLevel, findings);

	const secretSeen = new Set<string>();
	checkSecretVars(file, "top-level", topLevel, secretSeen, findings);

	const migrationSeen = new Set<string>();
	checkSqliteOnlyMigrations(
		file,
		"top-level",
		topLevel,
		migrationSeen,
		findings,
	);

	const configDir = dirname(configPath);
	const cronSeen = new Set<string>();
	checkCronHandler(file, configDir, "top-level", topLevel, cronSeen, findings);

	const main = topLevel.main;
	const entryPath = main
		? isAbsolute(main)
			? main
			: join(configDir, main)
		: null;
	const ssrfScan = scanSsrfSources(entryPath);
	checkStrictlyPublicFetch(
		file,
		"top-level",
		ssrfScan.guardImporter,
		topLevel,
		findings,
	);
	checkDynamicFetchContainment(file, "top-level", ssrfScan, topLevel, findings);
	checkNoStagingEnvironment(file, topLevel.definedEnvironments, findings);

	const namedEnvironmentConfigs: NamedEnvironmentConfig[] = [];

	for (const envName of topLevel.definedEnvironments ?? []) {
		let envConfig: ResolvedWranglerConfig;
		try {
			envConfig = readResolvedConfig(configPath, envName);
		} catch (error) {
			findings.push({
				severity: "error",
				file,
				message: `wrangler failed to resolve env "${envName}": ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		namedEnvironmentConfigs.push({ envName, config: envConfig });
		checkSideEnvironmentDeployHazards(
			file,
			envName,
			topLevel,
			envConfig,
			findings,
		);
		checkEnvArrayReplacement(file, topLevel, envName, envConfig, findings);
		checkSecretVars(file, `env "${envName}"`, envConfig, secretSeen, findings);
		checkSqliteOnlyMigrations(
			file,
			`env "${envName}"`,
			envConfig,
			migrationSeen,
			findings,
		);
		checkCronHandler(
			file,
			configDir,
			`env "${envName}"`,
			envConfig,
			cronSeen,
			findings,
		);
		checkStrictlyPublicFetch(
			file,
			`env "${envName}"`,
			ssrfScan.guardImporter,
			envConfig,
			findings,
		);
		checkDynamicFetchContainment(
			file,
			`env "${envName}"`,
			ssrfScan,
			envConfig,
			findings,
		);
	}

	checkNamedEnvironmentBindingParity(file, namedEnvironmentConfigs, findings);

	return topLevel;
}

// ---- cf-CLI apps (`cloudflare.config.ts`) ------------------------------------

/**
 * Modes a `cloudflare.config.ts` is evaluated in. `production` is the only
 * deploy target (`cf deploy --mode production` in every `deploy:production`
 * script). `development` is what `vite dev` passes and — because every config
 * here treats "not production" as development — also what a bare `cf deploy`
 * (mode `undefined`) would ship, so it is linted like a side environment.
 * `test` is deliberately excluded: it strips remote-only bindings (service
 * bindings, secrets) for vitest by design, so parity against it is noise.
 */
const CF_CONFIG_MODES = ["development", "production"] as const;

/** The subset of `@cloudflare/config` this lint calls. */
interface CloudflareConfigApi {
	resolveAndParseConfig(
		input: unknown,
		ctx: { mode: string | undefined; isPreview: boolean },
	): Promise<
		{ success: true; data: unknown } | { success: false; error: unknown }
	>;
	convertToWranglerConfig(parsed: unknown): unknown;
}

let cloudflareConfigApi: Promise<CloudflareConfigApi> | undefined;

/**
 * Load `@cloudflare/config` from the installed `cf` CLI's own dependency
 * graph, so the wrangler-shaped config this lint checks is produced by the
 * exact converter `cf deploy` uses — not a hand-written mapping that drifts
 * when cf adds a binding type. It is imported rather than called through its
 * `loadAndParseConfig`, which refuses to run under Bun; Bun imports the
 * TypeScript config module natively.
 */
function loadCloudflareConfigApi(): Promise<CloudflareConfigApi> {
	cloudflareConfigApi ??= (async () => {
		const cfPackage = Bun.resolveSync("cf/package.json", REPO_ROOT);
		const specifier = Bun.resolveSync("@cloudflare/config", cfPackage);
		return (await import(specifier)) as CloudflareConfigApi;
	})();
	return cloudflareConfigApi;
}

/**
 * Appended to every finding on a cf app: the rule messages speak wrangler
 * field names because that is the shape `cf deploy` converts the config to.
 */
const CF_FIELD_NOTE =
	" (cloudflare.config.ts spelling: compatibility_date → compatibilityDate, compatibility_flags → compatibilityFlags, " +
	'vars → bindings.text(), secrets.required → bindings.secret(), new_sqlite_classes → exports.durableObject({ storage: "sqlite" }), ' +
	"env blocks → the config function's `mode` branches.)";

/**
 * Resolve one mode of a `cloudflare.config.ts` default export to the wrangler
 * config `cf deploy` would upload. Returns null when the config declares no
 * Worker (e.g. a container-only config).
 */
export async function resolveCfConfigMode(
	configInput: unknown,
	mode: string,
): Promise<ResolvedWranglerConfig | null> {
	const api = await loadCloudflareConfigApi();
	const parsed = await api.resolveAndParseConfig(configInput, {
		mode,
		isPreview: false,
	});
	if (!parsed.success) {
		throw new Error(
			`@cloudflare/config rejected mode "${mode}": ${String(parsed.error)}`,
		);
	}
	const worker = (parsed.data as { worker?: unknown }).worker;
	if (worker === undefined || worker === null) return null;
	return api.convertToWranglerConfig(parsed.data) as ResolvedWranglerConfig;
}

/**
 * Lint a cf-CLI app. Every mode is converted to the wrangler shape and fed to
 * the same rules as `wrangler.jsonc` apps, with these deliberate differences:
 *
 * - Env array replacement (`checkEnvArrayReplacement`) does not apply: a cf
 *   config has no env blocks inheriting from a top level — each mode is the
 *   full output of the config function, so nothing is silently replaced.
 * - `checkNoStagingEnvironment` does not apply: a cf config has no declared
 *   env list to read. The deploy mode is fixed to `production` by the app's
 *   `deploy:production` script, and `development` is covered below.
 * - `development` is checked as a side environment against `production`
 *   (script-name collision, crons), because a bare `cf deploy` ships it.
 * - Binding parity compares `development` with `production`; `test` is
 *   excluded (see CF_CONFIG_MODES).
 */
export async function lintCfConfigModule(
	file: string,
	configDir: string,
	configInput: unknown,
	findings: Finding[],
): Promise<Map<string, ResolvedWranglerConfig>> {
	const cfFindings: Finding[] = [];
	const resolved = new Map<string, ResolvedWranglerConfig>();
	for (const mode of CF_CONFIG_MODES) {
		try {
			const config = await resolveCfConfigMode(configInput, mode);
			if (config) resolved.set(mode, config);
		} catch (error) {
			cfFindings.push({
				severity: "error",
				file,
				message: `failed to evaluate mode "${mode}": ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const secretSeen = new Set<string>();
	const migrationSeen = new Set<string>();
	const cronSeen = new Set<string>();
	const production = resolved.get("production");
	let ssrfScan: SsrfSourceScan | null = null;
	for (const [mode, config] of resolved) {
		const scope = `mode "${mode}"`;
		checkCompatDate(file, config, cfFindings);
		checkSecretVars(file, scope, config, secretSeen, cfFindings);
		checkSqliteOnlyMigrations(file, scope, config, migrationSeen, cfFindings);
		checkCronHandler(file, configDir, scope, config, cronSeen, cfFindings);
		const main = config.main;
		ssrfScan ??= scanSsrfSources(
			main ? (isAbsolute(main) ? main : join(configDir, main)) : null,
		);
		checkStrictlyPublicFetch(
			file,
			scope,
			ssrfScan.guardImporter,
			config,
			cfFindings,
		);
		checkDynamicFetchContainment(file, scope, ssrfScan, config, cfFindings);
		if (mode !== "production" && production) {
			checkSideEnvironmentDeployHazards(
				file,
				mode,
				production,
				config,
				cfFindings,
			);
		}
	}
	checkNamedEnvironmentBindingParity(
		file,
		[...resolved].map(([envName, config]) => ({ envName, config })),
		cfFindings,
	);

	// Mode-independent rules (compat date) fire once per mode; keep one.
	const seenMessages = new Set<string>();
	for (const finding of cfFindings) {
		if (seenMessages.has(finding.message)) continue;
		seenMessages.add(finding.message);
		findings.push({ ...finding, message: finding.message + CF_FIELD_NOTE });
	}
	return resolved;
}

async function lintCfConfig(
	configPath: string,
	findings: Finding[],
): Promise<void> {
	const file = relative(REPO_ROOT, configPath);
	let configInput: unknown;
	try {
		configInput = ((await import(configPath)) as { default?: unknown }).default;
	} catch (error) {
		findings.push({
			severity: "error",
			file,
			message: `failed to import this config: ${error instanceof Error ? error.message : String(error)}`,
		});
		return;
	}
	await lintCfConfigModule(file, dirname(configPath), configInput, findings);
}

async function main(): Promise<void> {
	const strict = process.argv.includes("--strict");
	const appsDir = join(REPO_ROOT, "apps");
	const apps = readdirSync(appsDir).sort();
	const configPaths = apps
		.map((app) => join(appsDir, app, "wrangler.jsonc"))
		.filter((path) => existsSync(path));
	const cfConfigPaths = apps
		.map((app) => join(appsDir, app, "cloudflare.config.ts"))
		.filter((path) => existsSync(path));

	const findings: Finding[] = [];
	for (const configPath of configPaths) {
		lintConfig(configPath, findings);
	}
	for (const configPath of cfConfigPaths) {
		await lintCfConfig(configPath, findings);
	}

	const errors = findings.filter(({ severity }) => severity === "error");
	const warnings = findings.filter(({ severity }) => severity === "warning");

	for (const finding of findings) {
		const label = finding.severity === "error" ? "ERROR" : "WARN";
		console.error(`[${label}] ${finding.file}: ${finding.message}`);
	}

	console.log(
		`wrangler config lint: ${configPaths.length} wrangler.jsonc + ${cfConfigPaths.length} cloudflare.config.ts configs checked, ${errors.length} error(s), ${warnings.length} warning(s)${strict ? " [strict]" : ""}`,
	);

	if (strict && errors.length > 0) {
		process.exit(1);
	}
	if (!strict && errors.length > 0) {
		console.log(
			"note: errors are non-fatal without --strict while pre-existing findings are burned down; CI should pass --strict once clean.",
		);
	}
}

if (import.meta.main) {
	await main();
}
