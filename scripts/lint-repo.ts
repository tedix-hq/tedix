#!/usr/bin/env bun

/**
 * `bun run lint:repo`: runs every repository lint gate below in parallel and
 * reports EVERY failure with that gate's own output, then exits 1 if any
 * failed. A `&&` chain stops at the first failure and hides the rest, so a
 * push that breaks two invariants learns about them one round trip at a time.
 *
 * The gates only read the tree (the two with baselines write only under
 * `--update-baseline`), so running them concurrently is safe. Add a gate here,
 * not to package.json; each one's header states its rule.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GATES: string[][] = [
	["check-package-boundaries.ts"],
	["lint-import-cycles.ts"],
	["lint-db-access.ts"],
	["check-package-exports.ts"],
	["lint-wrangler.ts", "--strict"],
	["lint-loader-sandbox.ts", "--strict"],
	["lint-kumo.ts"],
	["lint-d1.ts"],
	["lint-authz.ts", "--strict"],
	["lint-worker-route-authz.ts", "--strict"],
	["lint-contracts.ts"],
	["lint-os.ts"],
	["lint-vite-plus-imports.ts"],
];

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Result = { name: string; code: number; output: string; ms: number };

function run([script, ...args]: string[]): Promise<Result> {
	const name = [`scripts/${script}`, ...args].join(" ");
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [`scripts/${script}`, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		const done = (code: number) =>
			resolve({
				name,
				code,
				output: output.trimEnd(),
				ms: Date.now() - started,
			});
		child.on("error", (error) => {
			output += `\n${error.message}`;
			done(1);
		});
		child.on("close", (code) => done(code ?? 1));
	});
}

const startedAll = Date.now();
const results = await Promise.all(GATES.map(run));
const failed = results.filter((result) => result.code !== 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

for (const { name, code, ms } of results) {
	if (code === 0) console.log(`ok   ${name} (${seconds(ms)})`);
}
for (const { name, code, output, ms } of failed) {
	console.error(`\nFAIL ${name} (exit ${code}, ${seconds(ms)})`);
	if (output) console.error(output.replace(/^/gm, "  "));
}

const elapsed = seconds(Date.now() - startedAll);
if (failed.length) {
	console.error(
		`\nlint:repo: ${failed.length} of ${results.length} gates failed in ${elapsed}`,
	);
	process.exit(1);
}
console.log(`lint:repo: ${results.length} gates passed in ${elapsed}`);
