import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	evidenceDirVariable,
	shardEvidenceDir,
	uploadShardEvidence,
} from "./upload-artifact.mjs";

// A frozen install normally takes about 10 s; one past this marks a slow runner.
export const slowInstallSeconds = 45;

const fixtureNotStarted = [
	/Fixture server \S+: (?:not ready within \d+ms|exited early with code)/,
	/\bfixture did not start\b/i,
	/\bserver did not start\b/i,
	/did not serve the SPA entry within \d+ms/,
];

// run-specs reports a crash after startup: every spec still queued is NOT RUN.
const fixtureExitedMidSuite = /fixture server exited (?:with code )?\d+/;

// The reason a failed browser suite deserves one more attempt, or undefined
// when the failure may be the code under test. Assertion failures never
// qualify; a Playwright timeout qualifies only on a runner that was already
// measured as slow before any test ran.
export function infrastructureFailure(output, { installSeconds } = {}) {
	if (/AssertionError/.test(output)) return undefined;
	if (fixtureNotStarted.some((pattern) => pattern.test(output)))
		return "the fixture server did not become ready";
	if (fixtureExitedMidSuite.test(output))
		return "the fixture server exited mid-suite";
	if (
		Number(installSeconds) > slowInstallSeconds &&
		/TimeoutError: .*Timeout \d+ms exceeded/.test(output)
	)
		return `a Playwright timeout on a slow runner (frozen install took ${installSeconds}s)`;
	return undefined;
}

// Specs run-specs reported as failed, from its per-spec result lines.
const failedSpec =
	/^\[run-specs\] FAIL \(exit \d+\)[^\n]*?\s(\S+\.spec\.ts)\s*$/gm;
export const flakeRerunMaxSpecs = 3;

// A narrow browser failure (one to three specs, the rest passed) gets one
// recorded rerun: a flake passes the second time, a regression fails twice
// and fails the job as before. A broad failure never reruns; it is the code.
export function flakyFailure(output) {
	const specs = [...new Set([...output.matchAll(failedSpec)].map((m) => m[1]))];
	if (specs.length === 0 || specs.length > flakeRerunMaxSpecs) return undefined;
	return {
		specs,
		reason: `${specs.length} spec(s) failed on the first attempt: ${specs.join(", ")}`,
	};
}

function run(command) {
	return new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: ["inherit", "pipe", "pipe"],
			env: {
				...process.env,
				// Arms the browser-tests preload; relative to the workspace cwd.
				[evidenceDirVariable]:
					process.env[evidenceDirVariable] ?? shardEvidenceDir,
			},
		});
		let output = "";
		const keep = (stream, target) =>
			stream.on("data", (chunk) => {
				target.write(chunk);
				output = (output + chunk).slice(-1_000_000);
			});
		keep(child.stdout, process.stdout);
		keep(child.stderr, process.stderr);
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolve({ code: code ?? (signal ? 1 : 0), output }),
		);
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	// node scripts/ci/rerun-on-infrastructure.mjs -- <command...>
	const command = process.argv.slice(process.argv.indexOf("--") + 1);
	if (!command.length)
		throw new Error("Usage: rerun-on-infrastructure.mjs -- <command>");
	const first = await run(command);
	const reason =
		first.code === 0
			? undefined
			: infrastructureFailure(first.output, {
					installSeconds: process.env.FROZEN_INSTALL_SECONDS,
				});
	const flake =
		reason || first.code === 0 ? undefined : flakyFailure(first.output);
	if (!reason && !flake) {
		if (first.code !== 0) await uploadShardEvidence(process.env);
		process.exit(first.code);
	}
	const kind = reason ? "Infrastructure rerun" : "Flake check";
	const note = reason
		? `Infrastructure rerun: \`${command.join(" ")}\` failed because of ${reason}; running it once more.`
		: `Flake check: ${flake.reason}; running it once more to separate a flake from a regression.`;
	console.log(`::warning title=${kind}::${note}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${note}\n`);
	const second = await run(command);
	const verdict =
		second.code === 0
			? reason
				? "passed"
				: `passed: FLAKY ${flake.specs.join(", ")} (fix the flake; this commit is not the cause)`
			: `failed again (exit ${second.code})`;
	console.log(
		`::${second.code === 0 && !reason ? "warning title=Flaky browser spec" : "notice"}::${kind} ${verdict}`,
	);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${kind} ${verdict}.\n`);
	if (second.code !== 0) await uploadShardEvidence(process.env);
	process.exit(second.code);
}
