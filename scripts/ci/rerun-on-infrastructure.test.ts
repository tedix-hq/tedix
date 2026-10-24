import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { infrastructureFailure } from "./rerun-on-infrastructure.mjs";

test("treats only fixture start failures and slow-runner timeouts as infrastructure", () => {
	for (const fixture of [
		"Error: Fixture server http://127.0.0.1:4000/: not ready within 90000ms. Last response: none",
		"Error: Fixture server http://127.0.0.1:4000/: exited early with code 1. Last response",
		"error: Avatar fixture did not start",
		"Error: Feed test server did not start",
		"Shell fixture server did not serve the SPA entry within 20000ms",
	]) {
		expect(infrastructureFailure(fixture)).toBeString();
		for (const output of [
			`AssertionError: wrong colour\n${fixture}`,
			`${fixture}\nAssertionError: wrong colour`,
		])
			expect(
				infrastructureFailure(output, { installSeconds: "80" }),
			).toBeUndefined();
	}

	const timeout = "TimeoutError: waitForFunction: Timeout 30000ms exceeded.";
	expect(
		infrastructureFailure(timeout, { installSeconds: "9" }),
	).toBeUndefined();
	expect(infrastructureFailure(timeout)).toBeUndefined();
	expect(infrastructureFailure(timeout, { installSeconds: "80" })).toContain(
		"slow runner",
	);
	expect(
		infrastructureFailure(`${timeout}\nAssertionError: chip clipped`, {
			installSeconds: "80",
		}),
	).toBeUndefined();
	for (const output of [
		"AssertionError: 1 controls are clipped or leave their content column",
		"Error: Sample card not found",
		"",
	])
		expect(
			infrastructureFailure(output, { installSeconds: "80" }),
		).toBeUndefined();
});

test("reruns once on an infrastructure failure and records it, never on a test failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "infra-rerun-"));
	const counter = join(dir, "count");
	const summary = join(dir, "summary.md");
	const suite = join(dir, "suite.sh");
	const runSuite = (body: string) => {
		writeFileSync(counter, "0");
		writeFileSync(summary, "");
		writeFileSync(
			suite,
			`n=$(($(cat "${counter}") + 1)); echo $n > "${counter}"\n${body}\n`,
		);
		const result = spawnSync(
			"node",
			[
				join(import.meta.dirname, "rerun-on-infrastructure.mjs"),
				"--",
				"bash",
				suite,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_STEP_SUMMARY: summary,
					FROZEN_INSTALL_SECONDS: "9",
				},
			},
		);
		return {
			status: result.status,
			attempts: Number(readFileSync(counter, "utf8")),
			summary: readFileSync(summary, "utf8"),
			stdout: result.stdout,
		};
	};
	try {
		const flaky = runSuite(
			'if [ "$n" = 1 ]; then echo "Feed test server did not start" >&2; exit 1; fi',
		);
		expect(flaky).toMatchObject({ status: 0, attempts: 2 });
		expect(flaky.stdout).toContain("::warning title=Infrastructure rerun::");
		expect(flaky.summary).toContain("Infrastructure rerun passed.");

		const broken = runSuite(
			'echo "Feed test server did not start" >&2; exit 3',
		);
		expect(broken).toMatchObject({ status: 3, attempts: 2 });
		expect(broken.summary).toContain("failed again (exit 3)");

		const failing = runSuite('echo "AssertionError: wrong colour" >&2; exit 1');
		expect(failing).toMatchObject({ status: 1, attempts: 1, summary: "" });
		const mixed = runSuite(
			'if [ "$n" = 1 ]; then echo "AssertionError: wrong colour" >&2; echo "Feed test server did not start" >&2; exit 7; fi',
		);
		expect(mixed).toMatchObject({ status: 7, attempts: 1, summary: "" });
		expect(mixed.stdout).not.toContain("::warning");

		const passing = runSuite("exit 0");
		expect(passing).toMatchObject({ status: 0, attempts: 1, summary: "" });
	} finally {
		rmSync(dir, { recursive: true });
	}
});
