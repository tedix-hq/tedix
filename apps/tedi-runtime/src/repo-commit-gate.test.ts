import assert from "node:assert/strict";
import {
	buildRepoCommitGateCommand,
	classifyRepoCommitGateResult,
} from "./repo-commit-gate";

// A tedi's repo_commit never reaches the pre-push hook, so the gate command
// must cover the same checks a human push would run.
{
	const command = buildRepoCommitGateCommand([
		"apps/tedi-runtime/src/do.ts",
		"apps/tedi/src/routes/admin/workstation.ts",
	]);
	assert.equal(
		command,
		"bun scripts/ci/preflight-gates.mjs --files apps/tedi-runtime/src/do.ts apps/tedi/src/routes/admin/workstation.ts",
	);
}

// A path must never become a flag or a second command.
{
	assert.equal(buildRepoCommitGateCommand(["--all"]), null);
	assert.equal(buildRepoCommitGateCommand(["a.ts; rm -rf /"]), null);
	assert.equal(buildRepoCommitGateCommand(["--all", "src/a.ts"]), null);
	assert.equal(buildRepoCommitGateCommand([]), null);
}

// A failing gate refuses the publish and carries its own output as the reason.
{
	const verdict = classifyRepoCommitGateResult({
		exitCode: 1,
		stdout: "✗ format:check (Oxfmt)",
		stderr: "",
	});
	assert.equal(verdict.ok, false);
	assert.equal(verdict.ran, true);
	assert.match(verdict.output, /format:check/);
}

{
	const verdict = classifyRepoCommitGateResult({ exitCode: 0, stdout: "ok" });
	assert.equal(verdict.ok, true);
	assert.equal(verdict.ran, true);
}

// A repo_commit proposal cannot publish when its only gate never ran.
{
	for (const result of [
		{ requestTimedOut: true, waitedMs: 120_000 },
		{ ok: false, error: "workstation exec timed out" },
		{ status: "running", executionId: "abc" },
	]) {
		const verdict = classifyRepoCommitGateResult(result);
		assert.equal(verdict.ok, false, JSON.stringify(result));
		assert.equal(verdict.ran, false, JSON.stringify(result));
	}
}

console.log("repo-commit-gate: command construction and verdicts pass");
