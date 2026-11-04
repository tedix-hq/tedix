/**
 * Offline replay comparison of the Clef-flash project chooser (b8590b6a5)
 * against the previous filing path on the frozen fictional holdout cohort.
 * Deterministic scripted upstreams measure path behavior only; live model
 * accuracy, provider latency and provider cost need authorized paid replay.
 *
 *   bun apps/api/eval/request-filing/report.ts [--out results.json]
 *
 * `--out` writes the same report without harness wall-clock fields, so a
 * committed results file stays deterministic across machines.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { FILING_CASES, FILING_CORPUS_VERSION } from "./fixtures";
import { runFilingCase } from "./harness";
import { summarizeFilingArm } from "./measure";

const outcomes = (await Promise.all(FILING_CASES.map(runFilingCase))).flat();
const arm = (name: "baseline" | "candidate") =>
	outcomes.filter((row) => row.arm === name);
const cell = (name: "baseline" | "candidate", caseId: string) => {
	const row = arm(name).find((outcome) => outcome.caseId === caseId);
	return row
		? {
				status: row.status,
				projectId: row.projectId,
				suggestedProjectId: row.suggestedProjectId,
				confidence: row.confidence,
				factoryProposal: row.factoryProposal,
				actionable: row.actionable,
				workItemId: row.workItemId,
				createdWorkProjectId: row.createdWorkProjectId,
				error: row.error,
				calls: row.calls,
			}
		: null;
};
const report = {
	corpusVersion: FILING_CORPUS_VERSION,
	corpusDigest: createHash("sha256")
		.update(JSON.stringify(FILING_CASES))
		.digest("hex"),
	origin: "replay",
	candidate: "b8590b6a5",
	baseline: "f8efdebd3",
	policy: "request-filing.v1.json",
	holdout: {
		baseline: summarizeFilingArm(arm("baseline")),
		candidate: summarizeFilingArm(arm("candidate")),
	},
	cases: FILING_CASES.map((test) => ({
		id: test.id,
		kind: test.kind,
		expectedFiled: test.expectedFiled,
		note: test.note ?? null,
		baseline: cell("baseline", test.id),
		candidate: cell("candidate", test.id),
	})),
};
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
	const deterministic = structuredClone(report);
	for (const summary of Object.values(deterministic.holdout)) {
		delete (summary as Record<string, unknown>).harnessP50Ms;
		delete (summary as Record<string, unknown>).harnessP95Ms;
	}
	writeFileSync(
		process.argv[outIndex + 1]!,
		`${JSON.stringify(deterministic, null, 2)}\n`,
	);
}
console.log(JSON.stringify(report, null, 2));
