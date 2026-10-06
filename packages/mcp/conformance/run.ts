/**
 * Conformance runner: starts `serve.ts` (Tedix `mountMcp()` + fixture), runs
 * the official `@modelcontextprotocol/conformance` CLI against it, and exits
 * with the CLI's combined exit code.
 *
 * Two passes are required because `--spec-version 2026-07-28` filters OUT the
 * `[extension]` scenarios (verified with `conformance list --spec-version
 * 2026-07-28`):
 *   1. the full 2026-07-28 suite (`--spec-version 2026-07-28`), baselined via
 *      `--expected-failures conformance/baseline.yml`;
 *   2. each `tasks-*` extension scenario explicitly via `--scenario`.
 */
// Pinned exact version: the baseline (baseline.yml) is calibrated against this
// release's scenario set — a floating `@alpha` tag would let upstream scenario
// changes break CI without a repo change. Bump deliberately: update the pin,
// re-run, and re-calibrate the baseline.
const CONFORMANCE_PACKAGE = "@modelcontextprotocol/conformance@0.2.0-alpha.11";
const SPEC_VERSION = "2026-07-28";

/** SEP-2663 tasks-extension scenarios (marked `[extension]` in `list`). */
const EXTENSION_SCENARIOS = [
	"tasks-lifecycle",
	"tasks-capability-negotiation",
	"tasks-wire-fields",
	"tasks-request-state-removal",
	"tasks-mrtr-input",
	"tasks-request-headers",
	"tasks-dispatch-and-envelope",
	"tasks-required-task-error",
	"tasks-mrtr-composition",
];

// alpha.11 still marks `tasks-status-notifications` SKIPPED while its upstream
// harness is rewritten for `subscriptions/listen`. Do not run a zero-assertion
// scenario and report it as conformance. Tedix owns executable coverage at the
// hosted boundary in `apps/mcp/src/subscriptions.test.ts` and production in
// `scripts/mcp/modern-conformance.ts` until upstream publishes a real check.

const dir = import.meta.dir;
const port = Number(process.env.PORT ?? "3921");
const url = `http://localhost:${port}/mcp`;
const baseline = `${dir}/baseline.yml`;
const verbose = process.argv.includes("--verbose");

const serverProc = Bun.spawn(["bun", `${dir}/serve.ts`], {
	env: { ...process.env, PORT: String(port) },
	stdout: "inherit",
	stderr: "inherit",
});

async function waitForReady(timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { method: "OPTIONS" });
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`conformance fixture did not become ready on ${url}`);
}

function runConformance(args: string[]): number {
	const proc = Bun.spawnSync(
		[
			"bunx",
			CONFORMANCE_PACKAGE,
			"server",
			"--url",
			url,
			"--expected-failures",
			baseline,
			...(verbose ? ["--verbose"] : []),
			...args,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	return proc.exitCode ?? 1;
}

let exitCode = 1;
try {
	await waitForReady();

	console.log(`\n=== conformance: ${SPEC_VERSION} suite ===\n`);
	// --suite all: the default "active" suite additionally filters out the
	// draft-tagged 2026-07-28 scenarios (server-stateless, caching,
	// http-header-validation, input-required-result-*, ...); "all" +
	// --spec-version runs every scenario applicable to 2026-07-28.
	exitCode = runConformance(["--suite", "all", "--spec-version", SPEC_VERSION]);

	for (const scenario of EXTENSION_SCENARIOS) {
		console.log(`\n=== conformance: ${scenario} (extension) ===\n`);
		const code = runConformance(["--scenario", scenario]);
		exitCode = Math.max(exitCode, code);
	}
} finally {
	serverProc.kill();
}

process.exit(exitCode);
