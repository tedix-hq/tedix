import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	flakyFailure,
	infrastructureFailure,
} from "./rerun-on-infrastructure.mjs";

test("treats only fixture start failures and slow-runner timeouts as infrastructure", () => {
	for (const fixture of [
		"Error: Fixture server http://127.0.0.1:4000/: not ready within 90000ms. Last response: none",
		"Error: Fixture server http://127.0.0.1:4000/: exited early with code 1. Last response",
		"error: Avatar fixture did not start",
		"Error: Feed test server did not start",
		"Shell fixture server did not serve the SPA entry within 20000ms",
		"[run-specs] fixture server exited with code 1",
		"[run-specs] NOT RUN (fixture server exited 1)  browser-tests/a.spec.ts",
		"browser-tests/a.spec.ts  FAIL (fixture server exited 1; spec exit 2)",
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

function runSuite(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "infra-rerun-"));
	const counter = join(dir, "count");
	const summary = join(dir, "summary.md");
	const suite = join(dir, "suite.sh");
	try {
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
	} finally {
		rmSync(dir, { recursive: true });
	}
}

const infrastructurePass = runSuite(
	'if [ "$n" = 1 ]; then echo "Feed test server did not start" >&2; exit 1; fi',
);
const infrastructureFailureTwice = runSuite(
	'echo "Feed test server did not start" >&2; exit 3',
);
const assertionFailure = runSuite(
	'echo "AssertionError: wrong colour" >&2; exit 1',
);
const mixedFailure = runSuite(
	'if [ "$n" = 1 ]; then echo "AssertionError: wrong colour" >&2; echo "Feed test server did not start" >&2; exit 7; fi',
);
const passingSuite = runSuite("exit 0");
const narrow =
	'echo "AssertionError: wrong colour" >&2; echo "[run-specs] FAIL (exit 1) 5.8s  browser-tests/a.spec.ts"';
const narrowFlake = runSuite(`if [ "$n" = 1 ]; then ${narrow}; exit 1; fi`);
const narrowRegression = runSuite(`${narrow}; exit 1`);
const broadFailure = runSuite(
	'for s in a b c d; do echo "[run-specs] FAIL (exit 1) 1s  browser-tests/$s.spec.ts"; done; exit 1',
);

test("reruns an infrastructure failure once and records a pass", () => {
	expect(infrastructurePass).toMatchObject({ status: 0, attempts: 2 });
	expect(infrastructurePass.stdout).toContain(
		"::warning title=Infrastructure rerun::",
	);
	expect(infrastructurePass.summary).toContain("Infrastructure rerun passed.");
});

test("keeps an infrastructure failure when its rerun also fails", () => {
	expect(infrastructureFailureTwice).toMatchObject({ status: 3, attempts: 2 });
	expect(infrastructureFailureTwice.summary).toContain("failed again (exit 3)");
});

test("never reruns a test assertion failure", () => {
	expect(assertionFailure).toMatchObject({
		status: 1,
		attempts: 1,
		summary: "",
	});
});

test("never reruns mixed infrastructure and assertion output", () => {
	expect(mixedFailure).toMatchObject({ status: 7, attempts: 1, summary: "" });
	expect(mixedFailure.stdout).not.toContain("::warning");
});

test("never reruns a passing suite", () => {
	expect(passingSuite).toMatchObject({ status: 0, attempts: 1, summary: "" });
});

test("names a narrow failure that passes its rerun as a flake", () => {
	expect(narrowFlake).toMatchObject({ status: 0, attempts: 2 });
	expect(narrowFlake.stdout).toContain("::warning title=Flake check::");
	expect(narrowFlake.stdout).toContain("FLAKY browser-tests/a.spec.ts");
	expect(narrowFlake.summary).toContain("Flake check passed: FLAKY");
});

test("keeps a narrow failure when its rerun also fails", () => {
	expect(narrowRegression).toMatchObject({ status: 1, attempts: 2 });
	expect(narrowRegression.summary).toContain("failed again (exit 1)");
});

test("never reruns a broad spec failure", () => {
	expect(broadFailure).toMatchObject({ status: 1, attempts: 1, summary: "" });
});

test("names one to three failed specs as a possible flake, never a broad failure", () => {
	const line = (name: string) =>
		`[run-specs] FAIL (exit 1) 2.1s  browser-tests/${name}.spec.ts`;
	expect(flakyFailure(`${line("a")}\n${line("a")}`)?.specs).toEqual([
		"browser-tests/a.spec.ts",
	]);
	expect(
		flakyFailure([line("a"), line("b"), line("c")].join("\n"))?.specs,
	).toHaveLength(3);
	expect(
		flakyFailure([line("a"), line("b"), line("c"), line("d")].join("\n")),
	).toBeUndefined();
	expect(flakyFailure("AssertionError: wrong colour")).toBeUndefined();
	expect(
		flakyFailure("[run-specs] PASS 1.0s  browser-tests/a.spec.ts"),
	).toBeUndefined();
});
