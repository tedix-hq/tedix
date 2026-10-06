#!/usr/bin/env bun
/**
 * One generator for every `worker-configuration.d.ts` in the monorepo.
 *
 * Why this exists
 * ---------------
 * Type generation used to sit inside each app's `dev` script, so 16 of 20 apps
 * re-ran `wrangler types` on every dev boot and restart. That put a process
 * spawn per app on the startup critical path AND let the committed files drift:
 * when the `types` scripts gained `--strict-vars=false`, the committed bytes
 * predated the flag, so every boot rewrote eight tracked files and left the
 * checkout dirty. Generation is a build step with a `--check` gate, not a dev
 * step.
 *
 * The recipe was also inconsistent — four apps chained a per-app
 * `scripts/postprocess-types.ts` and the rest did not. Auditing those four
 * against wrangler 4.126 output (2026-08-28) found only two live behaviours,
 * both encoded below; see POSTPROCESS RATIONALE.
 *
 * Usage
 * -----
 *   bun scripts/generate-worker-types.ts                # regenerate everything
 *   bun scripts/generate-worker-types.ts email tedi     # regenerate two apps
 *   bun scripts/generate-worker-types.ts --check        # non-mutating drift gate
 *   bun scripts/generate-worker-types.ts --concurrency=2
 *
 * `--check` never writes `worker-configuration.d.ts`. It generates to a sibling
 * temp file, compares, deletes the temp, and exits non-zero listing every
 * drifted workspace. The temp file has to be a SIBLING rather than live in a
 * scratch dir: wrangler emits `mainModule: typeof import("./src/index")`
 * relative to the output file, so generating anywhere else would produce a
 * different (and permanently "drifted") relative path.
 */

import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Workspace groups scanned for a `wrangler.jsonc`. Discovery is by scan, not a
 * curated list, so a new Worker app is picked up for free. */
export const WORKSPACE_GROUPS = ["apps", "packages"] as const;

/**
 * cf-CLI apps (`cloudflare.config.ts`, no `wrangler.jsonc`) are not scanned:
 * `cf workers types` writes their gitignored `.cloudflare/types/index.d.ts`,
 * and each one's package `type-check` runs `bun run types` first.
 *
 * Workspaces that carry a `wrangler.jsonc` but deliberately own no generated
 * `worker-configuration.d.ts`. Explicit data with a reason, not a silent skip:
 * a workspace that is absent from this map AND has a wrangler config WILL be
 * generated, which is what keeps new apps covered automatically.
 */
export const UNGENERATED_WORKSPACES: ReadonlyMap<string, string> = new Map([
	[
		"packages/db",
		// Migrations-only config: no `main`, no Worker entrypoint, no Env to type.
		// The wrangler.jsonc exists purely to point `wrangler d1 migrations` at
		// the production database.
		"migrations-only wrangler config with no Worker entrypoint",
	],
]);

/**
 * How one workspace's types are produced.
 *
 * `presync` runs before wrangler (Astro apps only). `narrowEnvironmentLiteral`
 * is the surviving half of apps/api's postprocessor — see POSTPROCESS
 * RATIONALE.
 */
export type WorkerTypesRecipe = {
	readonly wranglerArgs: readonly string[];
	readonly presync?: {
		readonly args: readonly string[];
		readonly env: Readonly<Record<string, string>>;
	};
	readonly narrowEnvironmentLiteral: boolean;
};

/**
 * The canonical invocation. Every Worker app used exactly this before the
 * consolidation; `--strict-vars=false` keeps `vars` typed as `string` rather
 * than as the literal committed in wrangler.jsonc, so a var value can change
 * without a type break.
 */
const CANONICAL_WRANGLER_ARGS = [
	"types",
	"--env-interface",
	"CloudflareEnv",
	"--strict-vars=false",
] as const;

/**
 * Astro apps (landing, widget) genuinely need a different recipe, so the
 * difference is encoded here rather than left as a special case in a shell
 * chain:
 *
 * 1. No `--env-interface CloudflareEnv`. Astro's Cloudflare adapter types
 *    `App.Locals.runtime.env` against the default `Env` interface; renaming the
 *    generated interface would break every `locals.runtime.env` access.
 * 2. `astro sync` must run first so `.astro/types.d.ts` exists — wrangler types
 *    lands in a project whose Astro ambient types are otherwise missing, and
 *    `astro check`/tsc then fail on the app's own generated content types.
 * 3. `*_INSPECTOR_PORT=0` is passed because each app's astro.config reads it to
 *    place the dev inspector. Pinning 0 lets the OS choose a free port, so a
 *    sync running next to a live `bun dev` (or two syncs in this script's own
 *    concurrent pool) cannot collide on a fixed inspector port.
 */
const ASTRO_WORKSPACES: ReadonlyMap<string, string> = new Map([
	["apps/landing", "LANDING_INSPECTOR_PORT"],
	["apps/mcp-ui", "MCP_UI_INSPECTOR_PORT"],
]);

/**
 * POSTPROCESS RATIONALE — why only one app keeps a postprocess step.
 *
 * Four apps (api, mcp, session-broker, skill-runtime) chained a per-app
 * `scripts/postprocess-types.ts`. They had already diverged into three
 * different programs. Read against actual wrangler 4.126 output:
 *
 * - api/mcp/skill-runtime inlined `Cloudflare.Env` into `CloudflareEnv` to work
 *   around the type-shadowing bug in workers-sdk#10020. That code is DEAD.
 *   Wrangler now emits `interface CloudflareEnv extends __BaseEnv_CloudflareEnv
 *   {}` where `__BaseEnv_CloudflareEnv` is a plain top-level interface, not a
 *   namespace member, so the shadowing the workaround targeted no longer
 *   exists and their `extends Cloudflare.Env` regex never matches. Porting it
 *   would carry a no-op forward. Not ported.
 *
 * - api ALSO narrows `ENVIRONMENT: string` to the literal union. That one is
 *   live and load-bearing: it is present in the committed
 *   apps/api/worker-configuration.d.ts, and apps/api's runtime models the only
 *   two deployable lanes as literals. Wrangler widens the var to `string`
 *   because it is declared in both the base and production env blocks. This is
 *   genuinely app-scoped, so it stays app-scoped — as data on the api recipe,
 *   invoked from here instead of from a fourth package.json chain.
 *
 * - session-broker's script was not an env inliner at all: it stripped trailing
 *   whitespace and had its own `--check`. That is applied to EVERY workspace
 *   here. The whitespace comes from upstream workerd runtime types (5 lines,
 *   identical in every app), it is cosmetic, and normalizing it in one place is
 *   what makes the generated bytes deterministic enough for `--check` to be a
 *   real gate. `**\/worker-configuration.d.ts` is already format-ignored in the
 *   root vite.config.ts, so this does not fight the formatter.
 */
export function postprocessWorkerTypes(
	recipe: WorkerTypesRecipe,
	generated: string,
): string {
	const narrowed = recipe.narrowEnvironmentLiteral
		? generated.replaceAll(
				"ENVIRONMENT: string;",
				'ENVIRONMENT: "development" | "production";',
			)
		: generated;
	// `[^\S\n]` rather than `[ \t]` so this is byte-for-byte the `line.trimEnd()`
	// session-broker's normalizer performed — a carriage return or other exotic
	// trailing whitespace must not survive here when it would not have survived
	// there. Narrowing the class would silently weaken the check being replaced.
	return narrowed.replace(/[^\S\n]+$/gm, "");
}

/** Resolve the recipe for a `group/name` workspace path. */
export function resolveRecipe(workspace: string): WorkerTypesRecipe {
	const inspectorPortVar = ASTRO_WORKSPACES.get(workspace);
	if (inspectorPortVar) {
		return {
			wranglerArgs: ["types", "--strict-vars=false"],
			presync: {
				args: ["astro", "sync"],
				env: { [inspectorPortVar]: "0" },
			},
			narrowEnvironmentLiteral: false,
		};
	}
	return {
		wranglerArgs: [...CANONICAL_WRANGLER_ARGS],
		// See POSTPROCESS RATIONALE: apps/api is the only workspace whose
		// committed types narrow ENVIRONMENT to the two deployable lanes.
		narrowEnvironmentLiteral: workspace === "apps/api",
	};
}

/** Every `group/name` under WORKSPACE_GROUPS that has a wrangler.jsonc. */
export function scanWorkspacesWithWranglerConfig(repoRoot: string): string[] {
	const found: string[] = [];
	for (const group of WORKSPACE_GROUPS) {
		const groupDir = join(repoRoot, group);
		let entries: Dirent[];
		try {
			entries = readdirSync(groupDir, { withFileTypes: true });
		} catch {
			continue; // group absent in this checkout
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (!existsSync(join(groupDir, entry.name, "wrangler.jsonc"))) continue;
			found.push(`${group}/${entry.name}`);
		}
	}
	return found.sort();
}

/**
 * Apply the ungenerated-workspace map and the optional CLI name filter.
 * A requested name may be given bare (`tedi-runtime`) or qualified (`apps/tedi-runtime`);
 * an unknown or explicitly ungenerated name is an error rather than an empty
 * run, because silently generating nothing is indistinguishable from success.
 */
export function selectWorkspaces(
	scanned: readonly string[],
	requested: readonly string[],
): string[] {
	const generatable = scanned.filter(
		(workspace) => !UNGENERATED_WORKSPACES.has(workspace),
	);
	if (requested.length === 0) return [...generatable];

	const selected: string[] = [];
	for (const name of requested) {
		const match = generatable.find(
			(workspace) => workspace === name || workspace.endsWith(`/${name}`),
		);
		if (match) {
			if (!selected.includes(match)) selected.push(match);
			continue;
		}
		const reason = [...UNGENERATED_WORKSPACES].find(
			([workspace]) => workspace === name || workspace.endsWith(`/${name}`),
		);
		throw new Error(
			reason
				? `${name}: no generated worker types (${reason[1]})`
				: `${name}: no workspace with a wrangler.jsonc`,
		);
	}
	return selected;
}

/**
 * Drop the argv and content hash from the "Generated by Wrangler" banner.
 *
 * The banner embeds the exact argv, including the output path. `--check`
 * generates to a sibling temp filename, so its banner can never byte-match the
 * committed one; comparing normalized banners is what makes the check honest
 * about real content drift instead of failing on its own invocation.
 */
export function normalizeGeneratedBanner(text: string): string {
	return text.replace(
		/^\/\/ Generated by Wrangler by running `wrangler types[^`]*`(?: \(hash: [0-9a-f]+\))?$/m,
		"// Generated by Wrangler by running `wrangler types`",
	);
}

/** True when the committed bytes differ from freshly generated ones. */
export function hasWorkerTypesDrift(
	committed: string | null,
	generated: string,
): boolean {
	if (committed === null) return true;
	return (
		normalizeGeneratedBanner(committed) !== normalizeGeneratedBanner(generated)
	);
}

/** Run `limit` tasks at a time; wrangler types spawns a process per workspace. */
export async function mapWithConcurrency<Item, Result>(
	items: readonly Item[],
	limit: number,
	run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
	// Filled by index, never pushed, so the results keep the input order even
	// though the workers finish out of order.
	const results: Result[] = [];
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			for (;;) {
				const index = next++;
				const item = items[index];
				if (item === undefined) return;
				results[index] = await run(item);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

type CommandResult = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Everything is spawned through `bunx` per root AGENTS.md ("Avoid
 * Bun.spawn(["wrangler", ...]); use bunx wrangler").
 */
function runCommand(
	args: readonly string[],
	cwd: string,
	extraEnv: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("bunx", [...args], {
			cwd,
			env: { ...process.env, ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		// A spawn failure never emits "close", so surface it as the real cause
		// instead of letting the caller report an empty wrangler failure.
		child.on("error", (error) => {
			rejectPromise(
				new Error(`could not run \`${args.join(" ")}\`: ${error.message}`),
			);
		});
		// Wrangler can finish generating types before its update check exits.
		// Accept its completion banner if the process exceeds the deadline.
		const deadline = setTimeout(() => {
			const finished = /Remember to rerun 'wrangler types'/.test(
				`${stdout}${stderr}`,
			);
			child.kill();
			resolvePromise({
				code: finished ? 0 : null,
				stdout,
				stderr: finished
					? stderr
					: `${stderr}\nwrangler did not exit within ${WRANGLER_EXIT_DEADLINE_MS / 1000}s and never reported completion (network to the npm registry is the usual cause)`,
			});
		}, WRANGLER_EXIT_DEADLINE_MS);
		child.on("close", (code) => {
			clearTimeout(deadline);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

const WRANGLER_EXIT_DEADLINE_MS = 45_000;

export const TYPES_BASENAME = "worker-configuration.d.ts";
/** Sibling temp target for --check; removed in a finally. */
export const CHECK_BASENAME = "worker-configuration.check.d.ts";

type WorkspaceOutcome =
	| { readonly workspace: string; readonly status: "ok" | "written" }
	| { readonly workspace: string; readonly status: "drifted" }
	| {
			readonly workspace: string;
			readonly status: "failed";
			readonly detail: string;
	  };

async function generateOne(
	repoRoot: string,
	workspace: string,
	checkOnly: boolean,
): Promise<WorkspaceOutcome> {
	const dir = join(repoRoot, workspace);
	const typesPath = join(dir, TYPES_BASENAME);
	const outPath = join(dir, checkOnly ? CHECK_BASENAME : TYPES_BASENAME);
	const recipe = resolveRecipe(workspace);

	try {
		if (recipe.presync) {
			const sync = await runCommand(
				recipe.presync.args,
				dir,
				recipe.presync.env,
			);
			if (sync.code !== 0) {
				return {
					workspace,
					status: "failed",
					detail: `${recipe.presync.args.join(" ")} exited ${sync.code}\n${sync.stderr.trim()}`,
				};
			}
		}

		// In generate mode the output path is left implicit so the banner matches
		// what the retired per-app `types` scripts produced; --check must name its
		// temp target, which normalizeGeneratedBanner then neutralizes.
		const wranglerArgs = checkOnly
			? ["wrangler", ...recipe.wranglerArgs, CHECK_BASENAME]
			: ["wrangler", ...recipe.wranglerArgs];
		const result = await runCommand(wranglerArgs, dir);
		if (result.code !== 0) {
			return {
				workspace,
				status: "failed",
				detail: `${wranglerArgs.join(" ")} exited ${result.code}\n${(result.stderr || result.stdout).trim()}`,
			};
		}

		const raw = readFileSync(outPath, "utf8");
		const next = postprocessWorkerTypes(recipe, raw);

		if (checkOnly) {
			const committed = existsSync(typesPath)
				? readFileSync(typesPath, "utf8")
				: null;
			return hasWorkerTypesDrift(committed, next)
				? { workspace, status: "drifted" }
				: { workspace, status: "ok" };
		}

		if (next !== raw) writeFileSync(outPath, next, "utf8");
		return { workspace, status: "written" };
	} catch (error) {
		return {
			workspace,
			status: "failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (checkOnly) rmSync(outPath, { force: true });
	}
}

export function parseConcurrency(argv: readonly string[]): number {
	const flag = argv.find((arg) => arg.startsWith("--concurrency="));
	if (!flag) return 4;
	const value = Number(flag.slice("--concurrency=".length));
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${flag}: expected a positive integer`);
	}
	return value;
}

async function main(): Promise<number> {
	const repoRoot = resolve(import.meta.dir, "..");
	const argv = process.argv.slice(2);
	const checkOnly = argv.includes("--check");
	const concurrency = parseConcurrency(argv);
	const requested = argv.filter((arg) => !arg.startsWith("-"));

	const workspaces = selectWorkspaces(
		scanWorkspacesWithWranglerConfig(repoRoot),
		requested,
	);
	if (workspaces.length === 0) {
		console.error("no workspaces with a wrangler.jsonc found");
		return 1;
	}

	const outcomes = await mapWithConcurrency(
		workspaces,
		concurrency,
		(workspace) => generateOne(repoRoot, workspace, checkOnly),
	);

	const drifted: string[] = [];
	const failed: WorkspaceOutcome[] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "failed") {
			failed.push(outcome);
			console.error(`fail ${outcome.workspace}\n${outcome.detail}`);
			continue;
		}
		if (outcome.status === "drifted") {
			drifted.push(outcome.workspace);
			console.error(`drift ${outcome.workspace}/${TYPES_BASENAME}`);
			continue;
		}
		console.log(
			`${outcome.status === "ok" ? "ok   " : "gen  "}${outcome.workspace}`,
		);
	}

	if (drifted.length > 0) {
		console.error(
			`\n${drifted.length} workspace(s) have stale worker types; run: bun scripts/generate-worker-types.ts ${drifted
				.map((workspace) => workspace.split("/")[1])
				.join(" ")}`,
		);
	}
	return failed.length > 0 || drifted.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main());
}
