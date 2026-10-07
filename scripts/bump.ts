// One dependency workflow for humans and agents. NCU owns version selection;
// the existing pre-push runner owns validation. Full output stays in run logs.
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { detachedGitEnv } from "./oss/git-env";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
	console.log(`Usage: bun scripts/bump.ts [--interactive | --check | --verify] [ncu options]

Default: update to latest releases, including majors, prepare, and validate.
--interactive  Preselect patches and filter incompatible peer upgrades.
--check        Show available updates without changing files.
--verify       Prepare and validate existing changes without querying versions.
Other options (e.g. --filter, --target) are passed to NCU.
Full logs and a JSON result are saved in the printed temporary directory.`);
	process.exit(0);
}
const check = args.includes("--check");
const verify = args.includes("--verify");
const interactive = args.includes("--interactive") || args.includes("-i");
if ([check, verify, interactive].filter(Boolean).length > 1) {
	console.error("Choose only one of --check, --verify, or --interactive.");
	process.exit(1);
}
const ncuArgs = args.filter(
	(arg) => !["--check", "--verify", "-u", "--upgrade"].includes(arg),
);
const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
	env: detachedGitEnv(),
});
if (rootResult.status !== 0) throw new Error("Run bump inside a Git checkout.");
const root = rootResult.stdout.trim();
const templates = ["apps/cms/templates/tedix", "apps/cms/templates/marketing"];
const logDir = mkdtempSync(join(tmpdir(), "tedix-bump-"));
const reportPath = join(logDir, "result.json");
const report: {
	status: "running" | "passed" | "failed";
	changedFiles: string[];
	preExistingFiles: string[];
	newlyChangedFiles: string[];
	updates: Record<string, unknown>;
	deferredSelections: {
		file: string;
		name: string;
		selected: string;
		retained: string;
		reason: string;
	}[];
	alignedOverrides: { name: string; from: string; to: string }[];
	selectionBackup?: string;
	error?: string;
	steps: {
		name: string;
		command: string[];
		log: string;
		exitCode: number | null;
		signal: string | null;
		durationMs: number;
	}[];
} = {
	status: "running",
	changedFiles: [],
	preExistingFiles: [],
	newlyChangedFiles: [],
	updates: {},
	deferredSelections: [],
	alignedOverrides: [],
	steps: [],
};
const saveReport = () =>
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`bump: logs and result: ${logDir}`);
saveReport();

function changedFiles() {
	return [
		["diff", "--name-only", "-z", "HEAD"],
		["ls-files", "--others", "--exclude-standard", "-z"],
	].flatMap((command) => {
		const result = spawnSync("git", command, {
			cwd: root,
			env: detachedGitEnv(),
			encoding: "utf8",
		});
		if (result.status !== 0)
			throw new Error(`git ${command.join(" ")} failed: ${result.stderr}`);
		return result.stdout.split("\0").filter(Boolean);
	});
}

const preExistingFiles = changedFiles();
const preExistingSet = new Set(preExistingFiles);
report.preExistingFiles = preExistingFiles;
if (preExistingFiles.length) {
	console.log(
		`bump: ${preExistingFiles.length} existing changed file(s)${check ? " in checkout" : " will also be checked"}:`,
	);
	for (const file of preExistingFiles.slice(0, 12)) console.log(`  ${file}`);
	if (preExistingFiles.length > 12)
		console.log(`  …and ${preExistingFiles.length - 12} more in result.json`);
}
saveReport();

const vitestFamily = (name: string) =>
	name === "vitest" || name.startsWith("@vitest/");

// The catalog `vitest`, the root `@vitest/*` overrides, and the Vitest that
// vite-plus bundles are one family: the Cloudflare Worker pool resolves worker
// modules through Vite, so a mismatched member breaks every workerd suite at
// load time even when the catalog Vitest itself is in the pool's peer range.
function vitestWorkerPool() {
	const rootManifest = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as { catalog?: Record<string, string>; overrides?: Record<string, string> };
	const version = rootManifest.catalog?.vitest;
	const consumerManifestPath = join(root, "apps/tedi-runtime/package.json");
	if (!version || !existsSync(consumerManifestPath)) return null;
	const consumer = JSON.parse(readFileSync(consumerManifestPath, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	if (
		!consumer.dependencies?.["@cloudflare/vitest-plugin"] &&
		!consumer.devDependencies?.["@cloudflare/vitest-plugin"]
	)
		return null;
	const poolManifestPath = join(
		root,
		"apps/tedi-runtime/node_modules/@cloudflare/vitest-plugin/package.json",
	);
	if (!existsSync(poolManifestPath))
		throw new Error(
			"Worker test pool is declared but not installed in apps/tedi-runtime; rerun bun install.",
		);
	const pool = JSON.parse(readFileSync(poolManifestPath, "utf8")) as {
		version?: string;
		peerDependencies?: Record<string, string>;
	};
	const peers = Object.entries(pool.peerDependencies ?? {}).filter(([name]) =>
		vitestFamily(name),
	);
	const required = pool.peerDependencies?.vitest;
	const overrides = Object.fromEntries(
		Object.entries(rootManifest.overrides ?? {}).filter(([name]) =>
			name.startsWith("@vitest/"),
		),
	);
	return {
		version,
		required,
		poolVersion: pool.version ?? "installed",
		overrides,
		vitePlus: rootManifest.catalog?.["vite-plus"],
		compatible: (candidate: string) =>
			peers.every(([, range]) => Bun.semver.satisfies(candidate, range)),
	};
}

// The Vitest bundled by the installed vite-plus. `current` is false while
// node_modules still holds a different vite-plus than the catalog selects, in
// which case the next install decides and the bundle is not judged yet.
function vitePlusBundle(catalogVitePlus: string | undefined) {
	const manifestPath = join(root, "node_modules/vite-plus/package.json");
	if (!existsSync(manifestPath)) return null;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		version?: string;
		dependencies?: Record<string, string>;
	};
	const vitest = manifest.dependencies?.vitest;
	if (!vitest || !manifest.version) return null;
	return {
		version: manifest.version,
		vitest,
		current:
			!catalogVitePlus ||
			Bun.semver.satisfies(manifest.version, catalogVitePlus),
	};
}

function checkVitestWorkerPool() {
	const pool = vitestWorkerPool();
	if (!pool) return;
	const { version, required, poolVersion } = pool;
	if (required && !pool.compatible(version)) {
		throw new Error(
			`Vitest ${version} is outside @cloudflare/vitest-plugin ${poolVersion}'s peer range ${required}. Select a compatible Vitest version before running Worker tests.`,
		);
	}
	const misaligned = Object.entries(pool.overrides).filter(
		([, pinned]) => pinned !== version,
	);
	if (misaligned.length) {
		throw new Error(
			`Root overrides ${misaligned.map(([name, pinned]) => `${name}@${pinned}`).join(", ")} do not match the catalog Vitest ${version}. The @vitest family moves together.`,
		);
	}
	const bundle = vitePlusBundle(pool.vitePlus);
	if (bundle?.current && required && !pool.compatible(bundle.vitest)) {
		throw new Error(
			`Vite+ ${bundle.version} bundles Vitest ${bundle.vitest}, outside @cloudflare/vitest-plugin ${poolVersion}'s peer range ${required}. Hold Vite+ until the Worker pool supports that Vitest major.`,
		);
	}
}

function emdashEncryptionWired() {
	const manifestPath = join(root, "apps/cms-runtime/package.json");
	if (!existsSync(manifestPath)) return true;
	const entryPath = join(root, "apps/cms-runtime/src/index.ts");
	const configPath = join(root, "apps/cms-runtime/cloudflare.config.ts");
	const examplePath = join(root, "apps/cms-runtime/.env.example");
	// The deployed modes declare the key as a Worker secret; cf deletes any live
	// secret the config does not declare.
	const declaresSecret =
		existsSync(configPath) &&
		/\bEMDASH_ENCRYPTION_KEY:\s*bindings\.secret\(\)/.test(
			readFileSync(configPath, "utf8"),
		);
	return (
		existsSync(entryPath) &&
		readFileSync(entryPath, "utf8").includes("EMDASH_ENCRYPTION_KEY") &&
		existsSync(examplePath) &&
		readFileSync(examplePath, "utf8").includes("EMDASH_ENCRYPTION_KEY") &&
		declaresSecret
	);
}

function checkEmdashEncryptionWiring() {
	const manifestPath = join(root, "apps/cms-runtime/package.json");
	if (!existsSync(manifestPath)) return;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const range = manifest.dependencies?.emdash;
	const match = range?.match(/^[~^]?(\d+)\.(\d+)\.(\d+)/);
	if (!match) return;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major === 0 && minor < 39) return;
	if (!emdashEncryptionWired()) {
		throw new Error(
			`Emdash ${range} needs EMDASH_ENCRYPTION_KEY in cms-runtime/.env.example, as a bindings.secret() in cms-runtime/cloudflare.config.ts, and the tenant env wiring in src/index.ts. Verify production secret provisioning and a secret-setting write/read separately before release.`,
		);
	}
}

function emdashNeedsWiring() {
	const path = join(root, "apps/cms-runtime/package.json");
	if (!existsSync(path) || emdashEncryptionWired()) return false;
	const manifest = JSON.parse(readFileSync(path, "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const version = manifest.dependencies?.emdash?.match(/^[~^]?(\d+)\.(\d+)/);
	return Boolean(
		version && Number(version[1]) === 0 && Number(version[2]) >= 39,
	);
}

const originalManifests: Record<string, string> = {};
// Reverts selections the repo cannot take yet and aligns the @vitest overrides
// with the catalog Vitest. Returns the manifests it rewrote in this call, so a
// caller that already installed knows to install again.
function deferIncompatibleSelections() {
	const pool = vitestWorkerPool();
	const deferVitest = Boolean(pool?.required && !pool.compatible(pool.version));
	const bundle = pool ? vitePlusBundle(pool.vitePlus) : null;
	const deferVitePlus = Boolean(
		pool?.required && bundle?.current && !pool.compatible(bundle.vitest),
	);
	const alignOverrides = Boolean(
		pool &&
		Object.values(pool.overrides).some((pinned) => pinned !== pool.version),
	);
	const deferEmdash = emdashNeedsWiring();
	const rewritten: string[] = [];
	if (!deferVitest && !deferVitePlus && !alignOverrides && !deferEmdash)
		return rewritten;
	const manifests = new Set(
		changedFiles().filter((file) => file.endsWith("package.json")),
	);
	if (deferVitest || deferVitePlus || alignOverrides)
		manifests.add("package.json");
	const format = { formattingOptions: { insertSpaces: false, tabSize: 1 } };
	for (const file of manifests) {
		const baseline = spawnSync("git", ["show", `HEAD:${file}`], {
			cwd: root,
			env: detachedGitEnv(),
			encoding: "utf8",
		});
		if (baseline.status !== 0) continue;
		const previous = JSON.parse(baseline.stdout) as Record<
			string,
			Record<string, string>
		>;
		const original = readFileSync(join(root, file), "utf8");
		let source = original;
		const current = JSON.parse(source) as Record<
			string,
			Record<string, string>
		>;
		for (const section of [
			"catalog",
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			for (const [name, selected] of Object.entries(current[section] ?? {})) {
				const rootCatalog = file === "package.json" && section === "catalog";
				const reason =
					deferVitest && rootCatalog && name === "vitest"
						? "Worker pool peer range"
						: deferVitePlus &&
							  rootCatalog &&
							  (name === "vite-plus" || name === "vite")
							? "Vite+ bundles Vitest outside the Worker pool peer range"
							: deferEmdash &&
								  (name === "emdash" || name.startsWith("@emdash-cms/"))
								? "CMS encryption wiring"
								: null;
				if (!reason) continue;
				const retained = previous[section]?.[name];
				if (!retained || retained === selected) continue;
				if (name === "vitest" && pool?.required && !pool.compatible(retained))
					continue;
				source = applyEdits(
					source,
					modify(source, [section, name], retained, format),
				);
				report.deferredSelections.push({
					file,
					name,
					selected,
					retained,
					reason,
				});
				console.log(
					`bump: deferred ${name} ${selected} → ${retained} in ${file} (${reason})`,
				);
			}
		}
		if (file === "package.json") {
			const catalogVitest = (
				JSON.parse(source) as { catalog?: Record<string, string> }
			).catalog?.vitest;
			for (const [name, pinned] of Object.entries(current.overrides ?? {})) {
				if (!name.startsWith("@vitest/") || !catalogVitest) continue;
				if (pinned === catalogVitest) continue;
				source = applyEdits(
					source,
					modify(source, ["overrides", name], catalogVitest, format),
				);
				report.alignedOverrides.push({ name, from: pinned, to: catalogVitest });
				console.log(
					`bump: aligned override ${name} ${pinned} → ${catalogVitest} (Vitest family follows the catalog)`,
				);
			}
		}
		if (source !== original) {
			originalManifests[file] ??= original;
			rewritten.push(file);
			writeFileSync(join(root, file), source);
		}
	}
	if (Object.keys(originalManifests).length) {
		report.selectionBackup = join(logDir, "deferred-manifests.json");
		writeFileSync(
			report.selectionBackup,
			`${JSON.stringify(originalManifests, null, 2)}\n`,
		);
		saveReport();
		console.log(`bump: original selections saved in ${report.selectionBackup}`);
	}
	checkVitestWorkerPool();
	checkEmdashEncryptionWiring();
	return rewritten;
}

function describeCommand(command: string[]) {
	const filesIndex = command.indexOf("--files");
	return filesIndex < 0
		? command.join(" ")
		: `${command.slice(0, filesIndex).join(" ")} --files (${command.length - filesIndex - 1} paths; full command in result.json)`;
}

async function run(name: string, command: string[], visible = false) {
	const log = join(logDir, `${report.steps.length + 1}.log`);
	const fd = openSync(log, "w");
	const started = Date.now();
	let stdout = "";
	console.log(`bump: ${name}…`);
	const step: (typeof report.steps)[number] = {
		name,
		command,
		log,
		exitCode: null,
		signal: null,
		durationMs: 0,
	};
	report.steps.push(step);
	saveReport();
	// A visible step owns the terminal (interactive ncu prompts); progress lines
	// would scroll the prompt away and read as work in progress.
	const timer = visible
		? undefined
		: setInterval(
				() =>
					console.log(
						`bump: ${name}… ${Math.round((Date.now() - started) / 1000)}s`,
					),
				30_000,
			);
	try {
		const result = await new Promise<{
			code: number | null;
			signal: string | null;
		}>((resolve, reject) => {
			const child = spawn(command[0]!, command.slice(1), {
				cwd: root,
				stdio: visible ? "inherit" : ["ignore", "pipe", fd],
				env: visible
					? process.env
					: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
			});
			child.stdout?.on("data", (data: Buffer) => {
				writeSync(fd, data);
				if (command.includes("--jsonUpgraded")) stdout += data.toString();
			});
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		step.exitCode = result.code;
		step.signal = result.signal;
		if (result.code !== 0) {
			throw new Error(
				`${name} failed (${result.signal ?? `exit ${result.code}`}). Command: ${describeCommand(command)}`,
			);
		}
		console.log(`bump: ${name}: passed`);
		return stdout;
	} catch (error) {
		const output = readFileSync(log, "utf8").trim();
		if (name === "Validate with pre-push gates") {
			const failures = [...output.matchAll(/^✗ (.+)$/gm)].map((match) =>
				match[1]!.trim(),
			);
			if (failures.length)
				console.error(`bump: blocked by ${failures.join("; ")}`);
		}
		if (output) console.error(output.split("\n").slice(-40).join("\n"));
		console.error(
			visible ? "See the command output above." : `Full output: ${log}`,
		);
		throw error;
	} finally {
		clearInterval(timer);
		closeSync(fd);
		step.durationMs = Date.now() - started;
		saveReport();
	}
}

async function update(name: string, command: string[]) {
	const output = await run(name, command, interactive);
	if (!interactive) {
		const upgrades: Record<string, unknown> = JSON.parse(output);
		report.updates[name] = upgrades;
		for (const [key, value] of Object.entries(upgrades)) {
			if (
				typeof value === "object" &&
				value !== null &&
				!Object.keys(value).length
			)
				continue;
			console.log(
				`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
			);
		}
	}
}

try {
	if (!check) deferIncompatibleSelections();
	if (!verify) {
		const holdEmdash = interactive && !emdashEncryptionWired();
		// NCU evaluates peers within each manifest. The catalog's Vitest pin and
		// the Worker pool declaration live in different manifests.
		const pool = interactive ? vitestWorkerPool() : null;
		const nextVitestMajor = pool?.version.match(/^(\d+)/);
		const holdVitest = Boolean(
			pool?.required &&
			nextVitestMajor &&
			!pool.compatible(`${Number(nextVitestMajor[1]) + 1}.0.0`),
		);
		if (holdVitest)
			console.log(
				`bump: holding Vitest and Vite+ (which bundles Vitest) until @cloudflare/vitest-plugin supports the next major (currently ${pool!.required}).`,
			);
		if (holdEmdash)
			console.log(
				"bump: holding Emdash updates until cms-runtime encryption wiring is ready (see apps/cms-runtime/.env.example).",
			);
		const options = [
			"--packageManager",
			"bun",
			// This script runs `bun install` itself after every update step. Left at
			// its default, interactive ncu ends with a "Run bun install?" prompt
			// that waits for an answer the step never asks the user for.
			"--install",
			"never",
			"--target",
			"latest",
			...(interactive ? ["--interactiveSelect", "patch"] : []),
			...(interactive ? ["--peer"] : []),
			...(holdEmdash || holdVitest
				? [
						"--reject",
						[
							...(holdEmdash ? ["emdash", "@emdash-cms/*"] : []),
							...(holdVitest ? ["vitest", "vite-plus", "vite"] : []),
						].join(","),
					]
				: []),
			...ncuArgs,
			...(check ? [] : ["--upgrade"]),
			...(interactive ? [] : ["--jsonUpgraded"]),
		];
		await update("Workspaces and catalog", [
			"bunx",
			"--no-install",
			"ncu",
			"--workspaces",
			...options,
		]);
		for (const template of templates) {
			await update(`CMS template ${template}`, [
				"bunx",
				"--no-install",
				"ncu",
				"--packageFile",
				`${template}/package.json`,
				...options,
			]);
		}
		if (!check) deferIncompatibleSelections();
	}
	const dependencyChanges = changedFiles().some((file) =>
		/(^|\/)(package\.json|bun\.lock)$/.test(file),
	);
	if (!check && (verify || dependencyChanges)) {
		deferIncompatibleSelections();
		await run("Install workspace dependencies", ["bun", "install"]);
		// Only an installed vite-plus reveals the Vitest it bundles; a selection
		// that overshoots the Worker pool is reverted and installed again.
		if (deferIncompatibleSelections().length)
			await run("Install deferred selections", ["bun", "install"]);
		checkVitestWorkerPool();
		for (const template of templates) {
			await run(`Install ${template}`, ["bun", "install", "--cwd", template]);
		}
		checkEmdashEncryptionWiring();
		if (
			changedFiles().some((file) =>
				/^(apps\/cms(?:-runtime)?|packages\/emdash-[^/]+)\/package\.json$/.test(
					file,
				),
			)
		) {
			await run("Check Emdash release compatibility", [
				"bun",
				"run",
				"cms:emdash-release:validate",
			]);
		}
		await run("Refresh CMS template snapshot", [
			"bun",
			"run",
			"--cwd",
			"apps/cms",
			"snapshot:template",
		]);
		if (changedFiles().includes("bun.lock")) {
			await run("Refresh Worker types", ["bun", "run", "types:generate"]);
		}
		report.changedFiles = changedFiles();
		// A shared lockfile/catalog update can affect consumers whose manifests
		// did not change. Ask the same gate runner to check those workspaces too.
		const scope = new Set(report.changedFiles);
		if (scope.has("bun.lock") || !scope.size) {
			const manifests = spawnSync(
				"git",
				[
					"ls-files",
					"-z",
					"package.json",
					":(glob)apps/*/package.json",
					":(glob)packages/*/package.json",
				],
				{ cwd: root, env: detachedGitEnv(), encoding: "utf8" },
			);
			if (manifests.status !== 0)
				throw new Error("Could not enumerate dependency consumers.");
			for (const file of manifests.stdout.split("\0").filter(Boolean))
				scope.add(file);
		}
		if (scope.size) {
			await run("Validate with pre-push gates", [
				"bun",
				"scripts/ci/preflight-gates.mjs",
				"--files",
				...scope,
			]);
		}
	} else if (!check) {
		console.log("bump: no dependency changes; nothing to install or validate.");
	}
	report.changedFiles = changedFiles();
	report.status = "passed";
	console.log(
		`bump: ${check ? "check complete" : "complete"}. Result: ${reportPath}`,
	);
} catch (error) {
	report.status = "failed";
	report.error = error instanceof Error ? error.message : String(error);
	console.error(`bump: ${report.error}`);
	console.error(
		"Changes are retained. Fix the reported failure, then run bun run bump:verify.",
	);
	process.exitCode = 1;
} finally {
	report.changedFiles = changedFiles();
	report.newlyChangedFiles = report.changedFiles.filter(
		(file) => !preExistingSet.has(file),
	);
	saveReport();
}
