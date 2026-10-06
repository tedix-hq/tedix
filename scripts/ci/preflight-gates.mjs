#!/usr/bin/env node

/**
 * The pre-push gate: the repository's validation runs here, before a push,
 * rather than in a post-push pipeline. Runs from `.githooks/pre-push`.
 *
 * WHY THESE GATES. Each one is here because of a regression that reached main
 * and was first seen after the push — the comment on each gate names its
 * regression. Three set the pattern: a `vitest` import where
 * the repo requires `vite-plus/test` (the suite passes, only the lint rejects
 * it — `lint:repo`); a `TediEnv`
 * missing a property (vitest does not type-check, so
 * only `tsc` sees it); an actionlint SC2016 that a machine without shellcheck
 * reports as clean. Nothing runs after the push any more, so they run here.
 *
 * THREE DELIBERATE PROPERTIES.
 *
 * 1. Scoped by changed path, because an unscoped gate is a slow gate and a slow
 *    gate gets bypassed. Only the gates whose inputs changed run. The slow
 *    whole-repo scans (knip dead code) are not here at all: `bun run lint:deep`
 *    is the explicit lane for those, before a large refactor.
 *
 * 2. A gate whose TOOL is missing warns and does not block; a gate that RUNS
 *    and fails does block. Missing shellcheck must not make the repo
 *    unpushable, but it must also never read as "clean" — that exact silence is
 *    what let the SC2016 reach main.
 *
 * 3. Concise progress, specific failures. Pipes receive phase start/finish
 *    lines so a running gate cannot look like a hung push. A
 *    failure prints the gate's name, the first lines of its output, the path of
 *    the full log, and the one command that fixes it when the gate knows it.
 *    Nobody has to read a screenful of nested type paths to learn which gate
 *    failed, and nobody is asked to guess which regenerate command a stale
 *    artifact wants.
 *
 * Usage: preflight-gates.mjs [--base <sha> --head <sha>] [--all] [--files <path>...]
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	affectedWorkspaces,
	relatedTestTargetsByWorkspace,
	testRunnerFor,
} from "./preflight-test-targets.mjs";
import { typeCheckTargets } from "./preflight-typecheck-targets.mjs";
import { formatCheckCommand } from "./preflight-format-targets.mjs";
import {
	contentionAdvice,
	describeLoadPressure,
	readLoadPressure,
} from "../lib/machine-load.ts";
import { detachedGitEnv } from "../oss/git-env.ts";
import {
	defaultPushBase,
	parsePushRanges,
	selectPushRangeFiles,
} from "./push-range-selection.mjs";

const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	cwd: process.cwd(),
	encoding: "utf8",
	env: detachedGitEnv(),
}).stdout?.trim();

const args = new Set(process.argv.slice(2));
const runAll = args.has("--all");
const pushRanges = parsePushRanges(process.argv.slice(2));
// An explicit file list, for a caller that holds the change set but has not
// written a commit yet — the tedi push gate reads the paths it is about to
// publish straight off the workstation checkout.
const filesIndex = process.argv.indexOf("--files");
const fileArguments =
	filesIndex === -1
		? undefined
		: process.argv.slice(filesIndex + 1).filter((a) => !a.startsWith("--"));

function changedFiles() {
	if (runAll) return null;
	if (fileArguments?.length) return fileArguments;
	if (pushRanges.length) return selectPushRangeFiles(repoRoot, pushRanges);
	// No base (no upstream, no origin/main) means a full scan.
	const base = defaultPushBase(repoRoot);
	if (!base) return null;
	return selectPushRangeFiles(repoRoot, [{ base, head: "HEAD" }]);
}

const files = changedFiles();
const formatCommand = formatCheckCommand(repoRoot, {
	ranges: pushRanges,
	all: runAll,
});
const touched = (predicate) => files === null || files.some(predicate);
const has = (bin) =>
	spawnSync("command", ["-v", bin], { shell: true }).status === 0;

/**
 * The D1 gate shells out to `node ../../node_modules/jiti/lib/jiti-cli.mjs`,
 * because the schema checker needs `node:sqlite` and Bun has no such module.
 *
 * With no real node on PATH that command does NOT fail cleanly. `bun run`
 * injects its own `node` shim into a package script's PATH, so jiti executes
 * under Bun, transpiles the checker into a base64 `data:` URL, and Bun rejects
 * it with `NameTooLong while resolving package 'data:text/javascript;base64,…'`
 * followed by a screenful of encoded source. Nothing in that names the cause,
 * and it has cost repeated investigations.
 *
 * `spawnSync` does NOT see the shim (it resolves against the real PATH), so an
 * ENOENT here is an honest answer to "is there a node".
 */
function hasRealNode() {
	const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
	return probe.error === undefined && probe.status === 0;
}

const NODE_REQUIRED_HINT =
	"refusing to run: no `node` on PATH.\n" +
	"This gate runs the schema checker through jiti under Node, because it\n" +
	"needs `node:sqlite`, which Bun does not provide. Without a real node,\n" +
	"`bun run` substitutes its own shim and the failure surfaces as an\n" +
	"unreadable `NameTooLong` data-URL error instead of this message.\n" +
	"Install Node, or put an existing one on PATH for this command:\n" +
	"  PATH=/path/to/node/bin:$PATH git push";

const workflowsTouched = touched((f) => f.startsWith(".github/"));
const dbTouched = touched((f) => f.startsWith("packages/db/"));
const scriptsTouched = touched((f) => f.startsWith("scripts/"));
const privateExportManifestPresent = existsSync(
	`${repoRoot}/scripts/oss/public-files.json`,
);

// Starter templates install from their own lockfiles. Their production builds
// belong to changes in those templates, not every run of the script test suite.
const cmsTedixTemplateTouched = touched((f) =>
	f.startsWith("apps/cms/templates/tedix/"),
);
const cmsMarketingTemplateTouched = touched((f) =>
	f.startsWith("apps/cms/templates/marketing/"),
);

// Build the public widget when its source or dependencies change.
const widgetBundleTouched = touched(
	(f) =>
		f === "bun.lock" ||
		f.startsWith("apps/widget/src/") ||
		f.startsWith("packages/chat-transport/src/") ||
		f.startsWith("packages/webmcp-core/src/") ||
		f.startsWith("packages/mcp/src/") ||
		f.startsWith("packages/design-tokens/src/"),
);

/**
 * `worker-configuration.d.ts` is generated from `wrangler.jsonc` by the
 * installed wrangler, so those two plus the generator and the lockfile (a
 * wrangler bump changes the output) are its whole input set. Used to run
 * unscoped inside `lint:repo` — a `wrangler types` spawn per app on every push.
 */
const workerTypesTouched = touched(
	(f) =>
		f === "bun.lock" ||
		f.endsWith("/wrangler.jsonc") ||
		f.endsWith("/worker-configuration.d.ts") ||
		f === "scripts/generate-worker-types.ts",
);
// Deferred until the workspace graph below is built: type-checking only the
// workspace that OWNS a changed file has the same blind spot the test gate had.
// A consumer-only break — renaming an export nothing inside the package uses —
// type-checks clean in the package and fails in every consumer.
let typeCheckedWorkspaces = [];

/**
 * The tests covering the changed files. Each workspace's own vitest config is
 * what gives a Workers app its workerd pool and a package its aliases; a single
 * root `vitest related` run cannot load those projects (`cloudflare:workers`
 * and `bun:test` imports fail). Tests under scripts/ are bun:test programs and
 * run through bun. Deleted paths are excluded: a removed file has no dependents
 * left to find.
 *
 * Which workspaces get asked — the owner AND the workspaces that depend on a
 * changed package — lives in preflight-test-targets.mjs with its own test.
 */
const relatedTestTargets = (files ?? []).filter(
	(f) =>
		/^(apps|packages|scripts)\//.test(f) &&
		/\.(ts|tsx|js|mjs)$/.test(f) &&
		existsSync(`${repoRoot}/${f}`),
);
const manifestCache = new Map();
const readWorkspaceManifest = (workspaceDir) => {
	if (manifestCache.has(workspaceDir)) return manifestCache.get(workspaceDir);
	let manifest = null;
	try {
		const raw = JSON.parse(
			readFileSync(`${repoRoot}/${workspaceDir}/package.json`, "utf8"),
		);
		const deps = new Set();
		for (const field of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
		]) {
			for (const name of Object.keys(raw[field] ?? {})) deps.add(name);
		}
		manifest = {
			name: raw.name,
			deps,
			testScript: raw.scripts?.["test:run"] ?? raw.scripts?.test ?? "",
		};
	} catch {
		// A workspace without a readable package.json simply never matches.
		manifest = null;
	}
	manifestCache.set(workspaceDir, manifest);
	return manifest;
};
/** Which lane a workspace's tests run in. See preflight-test-targets.mjs. */
const workspaceTestRunner = (workspaceDir) =>
	testRunnerFor(
		readWorkspaceManifest(workspaceDir),
		existsSync(`${repoRoot}/${workspaceDir}/vitest.config.ts`) ||
			existsSync(`${repoRoot}/${workspaceDir}/vite.config.ts`),
	);
const isTestableWorkspace = (workspaceDir) =>
	workspaceTestRunner(workspaceDir) !== null;
const workspaceDirs = ["apps", "packages"].flatMap((root) => {
	try {
		return readdirSync(`${repoRoot}/${root}`, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => `${root}/${entry.name}`);
	} catch {
		return [];
	}
});
const relatedByWorkspace = relatedTestTargetsByWorkspace(relatedTestTargets, {
	isTestableWorkspace,
	readManifest: readWorkspaceManifest,
	workspaceDirs,
});
typeCheckedWorkspaces = [
	...new Set([
		...typeCheckTargets(files, (workspaceDir) =>
			existsSync(`${repoRoot}/${workspaceDir}`),
		),
		...affectedWorkspaces(files, {
			isRelevantWorkspace: (workspaceDir) =>
				existsSync(`${repoRoot}/${workspaceDir}/package.json`),
			readManifest: readWorkspaceManifest,
			workspaceDirs,
		}),
	]),
].sort();
const changedScriptTests = relatedTestTargets.filter((f) =>
	/^scripts\/.*\.test\.(ts|mjs|js)$/.test(f),
);

// A migration file is not a test target, so `vitest related` maps it to nothing
// on its own; any change under the migration directory runs the packages/db
// migration suite.
const migrationsTouched = (files ?? []).some((f) =>
	/^packages\/db\/drizzle\//.test(f),
);
// A patch edit without its provenance hash blocks the OSS export of main.
const thirdPartySourcesTouched = (files ?? []).some(
	(f) =>
		/(^|\/)patches\//.test(f) || f === "scripts/oss/third-party-sources.json",
);

const TYPE_ERROR_FIX =
	"adapt the code to the type error — after a dependency bump, to the new API";

/**
 * `fix` is the ONE command that resolves the gate when the gate knows it (a
 * string, or a function of the gate's output when the output decides); a gate
 * whose failure needs a diagnosis has none, and its own output is the
 * diagnosis.
 */
const gates = [
	{
		/*
		 * FIRST, and unconditional. Several gates compare bytes produced by a
		 * tool: `vp fmt` bundles a specific Oxfmt, so a node_modules that has
		 * drifted from the lockfile makes format:check fail on files that are
		 * correctly formatted. The obvious response — run the formatter —
		 * rewrites them with the wrong version and ships the regression.
		 *
		 * The lockfile gate below proves bun.lock agrees with the manifests; it
		 * cannot see node_modules. This closes that gap, and unlike a bespoke
		 * assertion it also REPAIRS the drift, across every package rather than
		 * a hand-listed few. ~300ms when already satisfied.
		 */
		name: "node_modules matches the lockfile",
		when: true,
		cmd: ["bun", "install", "--frozen-lockfile"],
		fix: "bun install   (then commit the regenerated bun.lock)",
		// Nothing below is trustworthy until this passes, so the run stops here.
		fatal: true,
	},
	{
		// Only reached once the install gate proved node_modules is the
		// lockfile's, so the formatter's answer is the right one and `vp fmt` is
		// safe to run.
		name: "format:check (Oxfmt)",
		when: formatCommand !== null,
		cmd: formatCommand,
		fix: "bun run format",
	},
	{
		name: "lint:code (Oxlint errors)",
		when: true,
		cmd: ["bun", "run", "lint:code"],
	},
	{
		name: "lint:repo (architecture boundaries)",
		when: true,
		cmd: ["bun", "run", "lint:repo"],
	},
	{
		// Sherif catches a package declared at two versions across members;
		// check-deps.mjs adds catalog escapes and a manifest edited without
		// regenerating bun.lock, which breaks `bun install --frozen-lockfile` on
		// a clean checkout of main.
		name: "lint:deps (Sherif + catalog escape + lockfile drift)",
		when: true,
		cmd: ["bun", "run", "lint:deps"],
		fix: 'use "catalog:" for catalog-declared deps; after a manifest edit run bun install and commit bun.lock',
	},
	{
		// Deliberately the host's own actionlint rather than downloading the
		// pinned release: a hook that fetches and executes a binary is a worse
		// trade than asking for `brew install actionlint`.
		name: "actionlint",
		when: workflowsTouched,
		cmd: ["actionlint", "-color=false"],
		requires: "actionlint",
		requiresHint: "brew install actionlint",
	},
	{
		name: "generated Worker types are current",
		when: workerTypesTouched,
		cmd: ["bun", "run", "types:check"],
		fix: "bun run types:generate",
	},
	{
		name: "D1 schema, history, chain, destructive-DDL",
		when: dbTouched,
		cmd: ["bun", "run", "--cwd", "packages/db", "db:migrate:check"],
		// Diagnose the environment BEFORE the gate can fail incomprehensibly.
		precondition: () => (hasRealNode() ? null : NODE_REQUIRED_HINT),
	},
	{
		name: "widget build",
		when: widgetBundleTouched,
		cmd: ["bun", "run", "--cwd", "apps/widget", "build"],
	},
	{
		// `scripts/` is not a workspace, so the per-workspace sweep below never
		// sees it. Scoped to the tree it covers.
		name: "type-check scripts/",
		when: scriptsTouched,
		cmd: ["bun", "run", "type-check:scripts"],
		fix: TYPE_ERROR_FIX,
	},
	...typeCheckedWorkspaces.map((workspaceDir) => ({
		name: `type-check ${workspaceDir}`,
		when: true,
		cmd: ["bun", "run", "--cwd", workspaceDir, "type-check"],
		optional: true, // not every workspace defines one
		// apps/cms type-checks behind its template snapshot; a stale snapshot is
		// a regenerate, not a type error.
		fix: (output) =>
			/snapshot:template/.test(output)
				? `bun run --cwd ${workspaceDir} snapshot:template`
				: TYPE_ERROR_FIX,
	})),
	...[...relatedByWorkspace.entries()]
		.filter(([workspace]) => workspaceTestRunner(workspace) === "bun")
		.map(([workspace]) => ({
			name: `tests (${workspace})`,
			when: true,
			cwd: repoRoot,
			// bun:test has no `related` query, so the workspace's own suite is the
			// smallest honest unit. Its test:run script is what the workspace says
			// runs it — never a command reconstructed here.
			cmd: ["bun", "run", "--cwd", workspace, "test:run"],
			fix: "fix the failing test, or the code it covers — never delete the assertion to go green",
		})),
	...[...relatedByWorkspace.entries()]
		.filter(([workspace]) => workspaceTestRunner(workspace) === "vitest")
		.map(([workspace, targets]) => ({
			name: `tests related to the changed files (${workspace})`,
			when: true,
			cwd: `${repoRoot}/${workspace}`,
			cmd: [
				`${repoRoot}/node_modules/.bin/vp`,
				"test",
				"related",
				...targets,
				"--run",
			],
			// vp shells out to node; without a real one it dies as `env: node: No
			// such file or directory`, which reads as a broken repo rather than a
			// broken PATH.
			precondition: () => (hasRealNode() ? null : NODE_REQUIRED_HINT),
			fix: "fix the failing test, or the code it covers — never delete the assertion to go green",
		})),
	{
		// Scans the pushed range's published files and commit identities.
		name: "OSS secret and customer-identity scan",
		when: true,
		cmd: [
			"bun",
			"scripts/oss/secret-scan.ts",
			"--public",
			...(privateExportManifestPresent ? ["--require-private-rules"] : []),
			// Commit messages and identities in the pushed range publish too.
			...pushRanges.flatMap(({ base, head }) => [
				"--base",
				base,
				"--head",
				head,
			]),
			...(files === null ? [] : ["--paths", ...files]),
		],
		fix: "remove the value from the published file — never relax the pattern; a reviewed synthetic fixture earns a hash-bound entry in scripts/oss/secret-scan-allowlist.json; a commit finding is fixed by rewording or re-signing that unpushed commit",
	},
	{
		name: "changed script tests",
		when: changedScriptTests.length > 0,
		cmd: ["bun", "test", ...changedScriptTests],
		fix: "fix the failing test, or the code it covers — never delete the assertion to go green",
	},
	{
		name: "third-party patch provenance",
		when: thirdPartySourcesTouched,
		cmd: ["bun", "scripts/oss/third-party-provenance.ts", "--strict"],
		fix: "update the patch's sha256 in scripts/oss/third-party-sources.json to the file you committed",
	},
	{
		name: "migration gates for a changed migration",
		when: migrationsTouched,
		cmd: [
			"bun",
			"run",
			"--cwd",
			"packages/db",
			"test:run",
			"scripts/check-migrations.test.ts",
			"scripts/check-migrations-cascade.test.ts",
			"scripts/migration-integrity.test.ts",
		],
		fix: "fix the migration the gate names — a destructive rebuild needs a reviewed directive; applied migrations are never edited",
	},
	{
		name: "CMS Tedix starter template build",
		when: cmsTedixTemplateTouched,
		cmd: ["bun", "run", "cms:template:tedix:build"],
	},
	{
		name: "CMS marketing starter template build",
		when: cmsMarketingTemplateTouched,
		cmd: ["bun", "run", "cms:template:marketing:build"],
	},
];

const SHOWN_LINES = 12;
const isTerminal = Boolean(process.stderr.isTTY);
const active = gates.filter((gate) => gate.when);
const startedAll = Date.now();
const failures = [];
const warnings = [];
let ran = 0;
let logDir;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const formatDuration = (ms) => {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
};
// A transient status line while a gate runs, only on a terminal, replaced by
// the next one and cleared before the summary. Pipes need a durable start
// line BEFORE spawnSync blocks: otherwise a slow install looks like a hung push.
const progress = (text) => {
	if (isTerminal) process.stderr.write(`\r\x1b[K${text}`);
	else if (text) writeSync(2, `${text}: started\n`);
};
const finishProgress = (name, outcome, started) => {
	if (!isTerminal)
		writeSync(
			2,
			`pre-push: ${name}: ${outcome}${started === undefined ? "" : ` in ${formatDuration(Date.now() - started)}`}\n`,
		);
};

// actionlint runs shellcheck over every `run:` block ONLY when shellcheck is on
// PATH, and says nothing when it is not. That silence is not cosmetic: it is
// exactly how the SC2016 in work-item-contrib-opener.yml passed locally and
// red-mained every deploy. Warn on the weaker configuration explicitly.
if (workflowsTouched && has("actionlint") && !has("shellcheck")) {
	warnings.push(
		"actionlint ran WITHOUT shellcheck, so no `run:` block was shell-linted — brew install shellcheck",
	);
}

function writeLog(gate, output) {
	logDir ??= mkdtempSync(join(tmpdir(), "pre-push-"));
	const path = join(
		logDir,
		`${gate.name
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase()}.log`,
	);
	writeFileSync(path, `${output}\n`);
	return path;
}

for (const [index, gate] of active.entries()) {
	if (gate.requires && !has(gate.requires)) {
		warnings.push(`skipped ${gate.name}: tool missing — ${gate.requiresHint}`);
		finishProgress(gate.name, "skipped (tool missing)");
		continue;
	}
	progress(`pre-push: ${gate.name} (${index + 1}/${active.length})`);
	const started = Date.now();
	// A gate may refuse before running when the environment guarantees an
	// unreadable failure. Reported as a failure, not a skip: the gate genuinely
	// did not verify anything.
	const blocked = gate.precondition?.();
	if (blocked) {
		ran += 1;
		failures.push({ gate, output: blocked, ms: Date.now() - started });
		finishProgress(gate.name, "failed (precondition)", started);
		continue;
	}
	const result = spawnSync(gate.cmd[0], gate.cmd.slice(1), {
		cwd: gate.cwd ?? repoRoot,
		stdio: "pipe",
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	const output = stripAnsi(
		`${result.stdout ?? ""}${result.stderr ?? ""}`,
	).trimEnd();
	// A missing script is not a failure for the per-workspace type-check sweep.
	if (gate.optional && /Script not found|Missing script/i.test(output)) {
		finishProgress(gate.name, "skipped (script missing)", started);
		continue;
	}
	finishProgress(gate.name, result.status === 0 ? "passed" : "failed", started);
	ran += 1;
	if (result.status !== 0) {
		failures.push({ gate, output, ms: Date.now() - started });
		if (gate.fatal) {
			warnings.push(
				`stopped after "${gate.name}": the remaining gates compare bytes from the installed toolchain and would mislead until it matches the lockfile`,
			);
			break;
		}
	}
}
progress("");

for (const { gate, output, ms } of failures) {
	const lines = output.split("\n");
	const shown = lines.slice(0, SHOWN_LINES);
	console.error(`\n✗ ${gate.name} (${formatDuration(ms)})`);
	for (const line of shown) console.error(`    ${line}`);
	if (lines.length > SHOWN_LINES) {
		console.error(
			`    ... ${lines.length - SHOWN_LINES} more lines, full log: ${writeLog(gate, output)}`,
		);
	}
	const fix = typeof gate.fix === "function" ? gate.fix(output) : gate.fix;
	if (fix) console.error(`  fix: ${fix}`);
}
for (const warning of warnings) console.error(`\n⚠ ${warning}`);

const scope = files === null ? "all files" : `${files.length} changed file(s)`;
const elapsed = formatDuration(Date.now() - startedAll);
const pressure = readLoadPressure();
const pressureNote = describeLoadPressure(pressure);
const suffix = pressureNote ? ` — ${pressureNote}` : "";

if (failures.length === 0) {
	console.log(
		`pre-push: ${ran} gates passed in ${elapsed} (${scope})${suffix}`,
	);
	process.exit(0);
}

console.error(
	`\npre-push: ${failures.length} of ${ran} gates failed in ${elapsed} (${scope})${suffix}\n` +
		"These gates are the repository's validation; fix the failures before pushing.\n" +
		"Bypass: git push --no-verify",
);
// A contended machine fails gates that a quiet one passes, and the two look
// identical from here. Say so before anyone "fixes" a gate that was fine.
const advice = contentionAdvice(pressure);
if (advice) console.error(advice);
process.exit(1);
