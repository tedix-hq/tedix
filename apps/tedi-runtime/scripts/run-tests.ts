/**
 * The workspace's test suite, whole or a named subset.
 *
 * `bun scripts/run-tests.ts` runs everything `test:run` has always run, in the
 * same four lanes and order (standalone scripts run with cores minus one workers):
 *
 * 1. every `src/*.test.ts` as its own `bun run` process — they are node:assert
 *    scripts, not bun:test suites, and each wants a fresh module registry;
 * 2. the bun:test suites under `src/brain/`;
 * 3. the email ingress tests under vitest;
 * 4. the provider submission test under the workers config.
 *
 * `bun scripts/run-tests.ts <file>...` runs only the named files, each in its
 * lane. The pre-push gate passes the files whose import graph reaches the
 * change (scripts/ci/preflight-bun-test-selection.mjs), which turns 223
 * process spawns into the handful that can see it. A named file the full
 * suite never ran — a workerd test only `test:workers` covers — is skipped by
 * name, so a selection cannot widen the suite by accident.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, tmpdir } from "node:os";

const workspace = join(import.meta.dirname, "..");
const vp = join(workspace, "..", "..", "node_modules", ".bin", "vp");

/** Needs workerd for its provider SDK imports; `test:provider` runs it. */
const EXCLUDED = new Set(["src/model-generation.test.ts"]);
const EMAIL_TESTS = [
	"test/email-ingress.test.ts",
	"test/email-header-parsing.test.ts",
	"test/email-sender-policy.test.ts",
];
const PROVIDER_TESTS = ["test/pi-runtime/submissions.workerd.test.ts"];

function scriptTests(): string[] {
	return readdirSync(join(workspace, "src"))
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => `src/${name}`)
		.filter((file) => !EXCLUDED.has(file))
		.sort();
}

function brainTests(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(join(workspace, dir), {
			withFileTypes: true,
		})) {
			if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
			else if (entry.name.endsWith(".test.ts"))
				found.push(`${dir}/${entry.name}`);
		}
	};
	walk("src/brain");
	return found.sort();
}

function run(cmd: [string, ...string[]]): void {
	const result = spawnSync(cmd[0], cmd.slice(1), {
		cwd: workspace,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
	const requested = process.argv
		.slice(2)
		.map((file) => file.replace(/^\.\//, ""))
		.filter((file) => !file.startsWith("-"));
	const subset = requested.length > 0;
	const wanted = new Set(requested);
	const inLane = (lane: string[]) =>
		subset ? lane.filter((file) => wanted.has(file)) : lane;

	const scripts = inLane(scriptTests());
	const brain = inLane(brainTests());
	const email = inLane(EMAIL_TESTS);
	const provider = inLane(PROVIDER_TESTS);

	if (subset) {
		const covered = new Set([...scripts, ...brain, ...email, ...provider]);
		for (const file of requested) {
			if (!covered.has(file)) {
				console.log(`SKIP ${file} (not part of test:run)`);
			}
		}
	}

	const scriptExit = await runScriptTests(scripts, workspace);
	if (scriptExit !== 0) process.exit(scriptExit);
	if (brain.length) run(["bun", "test", ...(subset ? brain : ["src/brain/"])]);
	if (email.length) run([vp, "test", "run", ...email]);
	if (provider.length) {
		run([
			vp,
			"test",
			"run",
			"--config",
			"vitest.workers.config.ts",
			...provider,
		]);
	}
}

export async function runScriptTests(
	files: string[],
	workspace: string,
	concurrency = Math.max(1, availableParallelism() - 1),
	report: (output: string) => void = (output) => process.stdout.write(output),
): Promise<number> {
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error("concurrency must be a positive integer");
	const queue = files.values();
	const children = new Set<ReturnType<typeof spawn>>();
	let exitCode = 0;
	const stop = () => {
		exitCode = 1;
		for (const child of children) child.kill();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		await Promise.all(
			Array.from({ length: Math.min(concurrency, files.length) }, async () => {
				while (exitCode === 0) {
					const { value: file, done } = queue.next();
					if (done) break;
					const temp = mkdtempSync(join(tmpdir(), "tedix-runtime-test-"));
					try {
						const child = spawn(process.execPath, ["run", file], {
							cwd: workspace,
							env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
							stdio: ["ignore", "pipe", "pipe"],
						});
						children.add(child);
						let output = `RUN ${file}\n`;
						child.stdout.setEncoding("utf8").on("data", (chunk) => {
							output += chunk;
						});
						child.stderr.setEncoding("utf8").on("data", (chunk) => {
							output += chunk;
						});
						const code = await new Promise<number>((resolve) => {
							child.once("error", (error) => {
								output += `${error}\n`;
								resolve(1);
							});
							child.once("close", (code) => resolve(code ?? 1));
						});
						children.delete(child);
						if (code !== 0) exitCode = code;
						report(output);
					} finally {
						rmSync(temp, { recursive: true, force: true });
					}
				}
			}),
		);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
	return exitCode;
}
