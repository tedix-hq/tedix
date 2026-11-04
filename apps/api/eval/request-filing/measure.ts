import type { ArmOutcome } from "./harness";
import { FILING_CASES, type FilingCase } from "./fixtures";

export interface ArmSummary {
	cases: number;
	filed: number;
	pending: number;
	errors: number;
	/** Terminal state matches the gold label: right filing or right abstention. */
	correct: number;
	accuracy: number | null;
	/** Auto-filed to a project other than the gold answer (or when none fit). */
	wrongProjectFilings: number;
	/** A gold filing the arm failed to apply (pending or error). */
	missedCorrectFilings: number;
	factoryProposals: number;
	actionableFilings: number;
	workAttached: number;
	createdWorkItems: number;
	upstreamNone: number;
	upstreamUnclear: number;
	calls: { chooser: number; writer: number; scorer: number; total: number };
	/** All model calls scaled per 1000 requests, including failed cases. */
	callsPer1000: number;
	writerCallsPer1000: number;
	chooserCallsPer1000: number;
	scorerCallsPer1000: number;
	/** Calls spent on cases whose arm ended in an error. */
	failedCaseCallsPer1000: number;
	/** Harness wall-clock percentiles; never provider latency. */
	harnessP50Ms: number | null;
	harnessP95Ms: number | null;
}

const rate = (n: number, total: number) => (total ? n / total : null);
const per1000 = (n: number, total: number) => Math.round((n / total) * 1000);
const percentile = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
};

function correct(outcome: ArmOutcome, test: FilingCase) {
	return outcome.status === "filed"
		? outcome.projectId === test.expectedFiled && test.expectedFiled !== null
		: test.expectedFiled === null;
}

export function summarizeFilingArm(outcomes: ArmOutcome[]): ArmSummary {
	const byCase = new Map(FILING_CASES.map((test) => [test.id, test]));
	const total = outcomes.length;
	const calls = {
		chooser: outcomes.reduce((sum, row) => sum + row.calls.chooser, 0),
		writer: outcomes.reduce((sum, row) => sum + row.calls.writer, 0),
		scorer: outcomes.reduce((sum, row) => sum + row.calls.scorer, 0),
		total: 0,
	};
	calls.total = calls.chooser + calls.writer + calls.scorer;
	const filed = outcomes.filter((row) => row.status === "filed");
	const errored = outcomes.filter((row) => row.status === "error");
	const upstream = (kind: "NONE" | "UNCLEAR") =>
		FILING_CASES.filter(
			(test) =>
				test.upstream.project === kind &&
				outcomes.some((row) => row.caseId === test.id),
		).length;
	return {
		cases: total,
		filed: filed.length,
		pending: outcomes.filter((row) => row.status === "pending").length,
		errors: errored.length,
		correct: outcomes.filter(
			(row) => byCase.has(row.caseId) && correct(row, byCase.get(row.caseId)!),
		).length,
		get accuracy() {
			return rate(this.correct, total);
		},
		wrongProjectFilings: filed.filter(
			(row) => row.projectId !== byCase.get(row.caseId)?.expectedFiled,
		).length,
		missedCorrectFilings: outcomes.filter(
			(row) =>
				row.status !== "filed" &&
				byCase.get(row.caseId)?.expectedFiled !== null,
		).length,
		factoryProposals: outcomes.filter((row) => row.factoryProposal).length,
		actionableFilings: filed.filter((row) => row.actionable).length,
		workAttached: outcomes.filter((row) => row.workItemId !== null).length,
		createdWorkItems: outcomes.filter(
			(row) => row.createdWorkProjectId !== null,
		).length,
		upstreamNone: upstream("NONE"),
		upstreamUnclear: upstream("UNCLEAR"),
		calls,
		callsPer1000: per1000(calls.total, total),
		writerCallsPer1000: per1000(calls.writer, total),
		chooserCallsPer1000: per1000(calls.chooser, total),
		scorerCallsPer1000: per1000(calls.scorer, total),
		failedCaseCallsPer1000: per1000(
			errored.reduce(
				(sum, row) =>
					sum + row.calls.chooser + row.calls.writer + row.calls.scorer,
				0,
			),
			total,
		),
		harnessP50Ms: percentile(
			outcomes.map((row) => row.elapsedMs),
			0.5,
		),
		harnessP95Ms: percentile(
			outcomes.map((row) => row.elapsedMs),
			0.95,
		),
	};
}
