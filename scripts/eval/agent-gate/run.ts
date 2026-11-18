import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { regressions, summarize, type Summary } from "./metrics";

const root = fileURLToPath(new URL("./", import.meta.url));
const mode = process.argv[2] ?? "check";
if (!["check", "capture"].includes(mode))
	throw new Error("Usage: run.ts [check|capture]");
mkdirSync(`${root}.runs`, { recursive: true });
const output = `${root}.runs/${Date.now()}.json`;
const run = spawnSync(
	"bunx",
	[
		"promptfoo@0.126.0",
		"eval",
		"-c",
		`${root}config.ts`,
		"--no-cache",
		"--no-write",
		"--no-table",
		"-o",
		output,
	],
	{
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			PROMPTFOO_DISABLE_TELEMETRY: "1",
			PROMPTFOO_DISABLE_UPDATE: "1",
			PROMPTFOO_PASS_RATE_THRESHOLD: "100",
			PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
		},
	},
);
if (run.error || (run.status !== 0 && run.status !== 100))
	throw new Error(`promptfoo failed: ${run.error?.message ?? run.status}`);
const summary = summarize(JSON.parse(readFileSync(output, "utf8")));
writeFileSync(
	`${root}.runs/latest-summary.json`,
	`${JSON.stringify(summary, null, 2)}\n`,
);
if (mode === "capture") {
	if (process.env.CI || process.env.AGENT_GATE_SELECTOR || run.status !== 0)
		throw new Error("Capture requires passing current source outside CI");
	writeFileSync(
		`${root}baseline.json`,
		`${JSON.stringify(summary, null, 2)}\n`,
		{ flag: "wx" },
	);
	console.log("Captured baseline; review before committing.");
} else {
	const baseline = JSON.parse(
		readFileSync(`${root}baseline.json`, "utf8"),
	) as Summary;
	const failed = regressions(baseline, summary);
	console.log(JSON.stringify({ output, regressions: failed, summary }));
	if (failed.length || run.status !== 0) process.exit(1);
}
