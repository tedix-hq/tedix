/**
 * Shared Vite+ task and vitest settings for every package whose unit tests run under vitest,
 * imported by that package's `vite.config.ts`.
 *
 * Plain objects and structural types rather than `defineConfig` and Vite+'s own types, so a package
 * needs no resolvable `vite-plus` import of its own to declare a cached task.
 *
 * Two things here are load-bearing and both fail silently if they are dropped:
 *
 * 1. `sharedTestConfig`. A package-local `vite.config.ts` REPLACES the root config for vitest — it
 *    does not merge with it. Measured: a package with no local config resolves the root's
 *    `testTimeout: 20_000`; adding a `vite.config.ts` that declares only `run.tasks` drops the same
 *    suite to vitest's 5_000ms default. That is the exact bound the root config raised on purpose
 *    (see the comment there), so every config this helper serves must spread `sharedTestConfig`
 *    back in. Packages that own a `vitest.config.ts` are unaffected: vitest prefers that file and
 *    never reads `vite.config.ts`.
 *
 * 2. The scratch exclusions. Vite+ declines to cache a task that reads a path it also wrote, so
 *    without these almost nothing caches. They are workspace-wide rather than package-relative
 *    because tracking reaches past the package that owns the task: a sibling's scratch files would
 *    otherwise sit in this package's fingerprint and the packages would invalidate each other.
 */

import { readFileSync } from "node:fs";
import { parse, type ParseError } from "jsonc-parser";

/** A glob paired with the directory its pattern resolves against. */
export type GlobWithBase = {
	pattern: string;
	base: "package" | "workspace";
};

/** An entry in a task's `input`/`output` list. */
export type TrackingGlob = string | { auto: boolean } | GlobWithBase;

/** The subset of a Vite+ task this factory produces. */
export type VitestTask = {
	command: string | string[];
	input: TrackingGlob[];
	output: TrackingGlob[];
};

/**
 * The root config's deliberate timeouts, re-declared by every package config that would otherwise
 * shadow them. Kept here rather than in the root config so the two can never drift; the root
 * `vite.config.ts` imports this same object.
 */
export const sharedTestConfig = {
	testTimeout: 20_000,
	hookTimeout: 30_000,
} as const;

/**
 * Paths vitest and wrangler generate and read back on a later run, excluded from both the
 * fingerprint and the archived outputs:
 *
 * - `node_modules/.vite/vitest/<project-hash>/results.json` — per-file durations and pass/fail,
 *   read by vitest's sequencer to order failed-first. Its sibling `node_modules/.vite/deps` is a
 *   real transform cache, derived entirely from tracked sources.
 * - `node_modules/.vite-temp/*.config.ts.timestamp-*.mjs` — vite compiles a TS config to a temp
 *   module here and unlinks it. The name carries a timestamp, so every run writes a fresh path and
 *   no run could ever match a previous fingerprint.
 * - `.wrangler/**` — miniflare/vitest-plugin state and randomly named scratch bundles, all
 *   regenerated from tracked sources. Any sibling that ran `wrangler dev` would otherwise guarantee
 *   a miss here.
 * - `*.tsbuildinfo` — TypeScript's incremental stamp, derived from the sources already tracked.
 *
 * Dropping these from the fingerprint loses no invalidation: each is derived from files that stay
 * tracked. Vite+ names `node_modules/.vite-temp` as a path that "should not be inputs or outputs"
 * in its own automatic-data-tracking guide, so excluding them is the blessed shape.
 *
 * The list is not closed. When a task stops caching, `vp run --last-details` names the path it read
 * and wrote — add it here if it is shared, or at the call site if it is one package's own.
 */
const VITEST_SCRATCH_EXCLUSIONS: GlobWithBase[] = [
	{ pattern: "!**/node_modules/.vite/**", base: "workspace" },
	{ pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
	{ pattern: "!**/.wrangler/**", base: "workspace" },
	{ pattern: "!**/*.tsbuildinfo", base: "workspace" },
];

/**
 * The cached unit-test task for a package, given the vitest invocation its `test:run` script holds.
 * An array of commands runs in order and caches as one entry per command, so a package with codegen
 * ahead of its tests can replay the codegen and re-run only the tests.
 *
 * `extraExclusions` adds package-specific patterns — a package whose tests track a directory its own
 * build writes needs its own `!dist/**`, package-relative so a workspace-wide pattern cannot drop a
 * sibling's real input.
 */
export function vitestTask(
	command: string | string[],
	extraExclusions: GlobWithBase[] = [],
): VitestTask {
	const exclusions = [...VITEST_SCRATCH_EXCLUSIONS, ...extraExclusions];
	return {
		command,
		input: [{ auto: true }, ...exclusions],
		output: [{ auto: true }, ...exclusions],
	};
}

/**
 * A whole `vite.config.ts` default export for a package that needs no other Vite+ settings: the
 * cached `unit` task plus the root vitest timeouts this file would otherwise shadow.
 *
 * The task is named `unit` rather than `test:run` only because Vite+ forbids a task and a
 * package.json script sharing a name and every package still declares a `test:run` script. Once
 * those scripts are removed the task should take the `test:run` name and this alias should go.
 */
export function vitestTaskConfig(
	command: string | string[],
	extraExclusions: GlobWithBase[] = [],
): {
	test: typeof sharedTestConfig;
	run: { tasks: { unit: VitestTask } };
} {
	return {
		test: sharedTestConfig,
		run: { tasks: { unit: vitestTask(command, extraExclusions) } },
	};
}

/** The `test` block shared by every Node-environment package `vitest.config.ts`. */
export const nodeTestConfig = {
	globals: true,
	environment: "node",
	include: ["src/**/*.test.ts"],
} as const;

/**
 * A whole `vitest.config.ts` for a package whose unit tests run in a plain Node
 * environment. The caller wraps it in `defineConfig` from `vite-plus`, which
 * resolves from the package; this file stays free of that import on purpose.
 */
export function vitestNodeConfig(): { test: typeof nodeTestConfig } {
	return { test: nodeTestConfig };
}

/**
 * The top-level `compatibility_date` of an app's `wrangler.jsonc`, for workerd test configs that
 * declare Miniflare inline (to keep production bindings out) but must still run on the date the
 * Worker ships with.
 */
export function wranglerCompatibilityDate(configPath: string): string {
	const errors: ParseError[] = [];
	const config: unknown = parse(readFileSync(configPath, "utf8"), errors, {
		allowTrailingComma: true,
	});
	const date =
		config && typeof config === "object" && "compatibility_date" in config
			? config.compatibility_date
			: undefined;
	if (errors.length > 0 || typeof date !== "string") {
		throw new Error(
			`${configPath} has no readable top-level compatibility_date`,
		);
	}
	return date;
}

/** The options every Worker app passes to `cloudflareTest()`. */
export const workersPoolOptions = {
	remoteBindings: false,
	wrangler: { configPath: "./wrangler.jsonc" },
} as const;

/**
 * A whole `vitest.config.ts` for a Worker app whose tests run under
 * `@cloudflare/vitest-plugin` against the app's own `wrangler.jsonc`.
 * The plugin factory is a parameter because that package resolves from the app,
 * not from `scripts/`.
 */
export function vitestWorkersConfig<Plugin>(
	cloudflareTest: (options: typeof workersPoolOptions) => Plugin,
): { plugins: [Plugin]; test: { include: readonly string[] } } {
	return {
		plugins: [cloudflareTest(workersPoolOptions)],
		test: { include: ["src/**/*.test.ts"] },
	};
}
