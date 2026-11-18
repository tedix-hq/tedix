import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cases } from "./cases";
import { regressions, summarize } from "./metrics";

function results() {
	return {
		results: {
			results: cases.flatMap((c) =>
				Array.from({ length: 3 }, (_, repeatIndex) => ({
					vars: { caseId: c.id },
					success: true,
					failureReason: 0,
					repeatIndex,
					score: 1,
				})),
			),
		},
	};
}

test("a regression cannot be hidden by other passing cases", () => {
	const baseline = summarize(results());
	const data = results();
	data.results.results[0]!.success = false;
	data.results.results[0]!.failureReason = 1;
	Object.assign(data.results.results[0]!, {
		error: "Exact-output assertion failed",
	});
	expect(regressions(baseline, summarize(data))).toEqual([cases[0]!.id]);
	expect(regressions(baseline, baseline)).toEqual([]);
});

test("missing, extra, unknown and errored trials fail closed", () => {
	const missing = results();
	missing.results.results.pop();
	expect(() => summarize(missing)).toThrow("Incomplete");
	const extra = results();
	extra.results.results.push(extra.results.results[0]!);
	expect(() => summarize(extra)).toThrow("duplicated");
	const unknown = results();
	unknown.results.results[0]!.vars.caseId = "unknown";
	expect(() => summarize(unknown)).toThrow("Unknown");
	const error = results();
	Object.assign(error.results.results[0]!, { error: "provider unavailable" });
	expect(() => summarize(error)).toThrow("errored");
	Object.assign(error.results.results[0]!, {
		success: false,
		failureReason: 2,
	});
	expect(() => summarize(error)).toThrow("errored");
	expect(() => summarize({})).toThrow("Missing");
});

test("changed cases and corrupted baseline counts require review", () => {
	const candidate = summarize(results());
	expect(() =>
		regressions({ ...candidate, caseHash: "stale" }, candidate),
	).toThrow("case set changed");
	const corrupt = structuredClone(candidate);
	corrupt.cases[cases[0]!.id]!.passes = 4;
	expect(() => regressions(corrupt, candidate)).toThrow("Invalid summary");
});

test("the local provider evaluates production source without a model", () => {
	const result = spawnSync(
		"bun",
		[new URL("adapter.ts", import.meta.url).pathname, "short-database-name"],
		{ encoding: "utf8", env: { ...process.env, AGENT_GATE_SELECTOR: "" } },
	);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual(["d2"]);
});
