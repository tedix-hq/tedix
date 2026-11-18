import { createHash } from "node:crypto";
import { cases } from "./cases";

export const caseHash = createHash("sha256")
	.update(JSON.stringify(cases))
	.digest("hex");
export const repeats = 3;
export interface Summary {
	caseHash: string;
	repeats: number;
	cases: Record<string, { trials: number; passes: number }>;
}

export function summarize(data: unknown): Summary {
	const parsed = data as {
		results?: {
			results?: {
				vars?: { caseId?: string };
				success?: boolean;
				error?: string;
				failureReason?: number;
				repeatIndex?: number;
				response?: { error?: string };
				score?: number;
			}[];
		};
	};
	const rows = parsed?.results?.results;
	if (!Array.isArray(rows)) throw new Error("Missing promptfoo result rows");
	const summary: Summary = {
		caseHash,
		repeats,
		cases: Object.fromEntries(
			cases.map((c) => [c.id, { trials: 0, passes: 0 }]),
		),
	};
	const seen = new Set<string>();
	for (const row of rows) {
		const entry = row.vars?.caseId && summary.cases[row.vars.caseId];
		if (!entry) throw new Error("Unknown result case");
		if (
			row.failureReason !== (row.success ? 0 : 1) ||
			(row.error && row.success) ||
			row.response?.error ||
			typeof row.success !== "boolean" ||
			!Number.isFinite(row.score)
		)
			throw new Error("Invalid or errored trial");
		const key = `${row.vars!.caseId}:${row.repeatIndex}`;
		if (
			!Number.isInteger(row.repeatIndex) ||
			row.repeatIndex! < 0 ||
			row.repeatIndex! >= repeats ||
			seen.has(key)
		)
			throw new Error("Incomplete or duplicated trials");
		seen.add(key);
		entry.trials++;
		entry.passes += Number(row.success);
	}
	for (const entry of Object.values(summary.cases)) {
		if (entry.trials !== repeats)
			throw new Error("Incomplete or duplicated trials");
	}
	return summary;
}

export function regressions(baseline: Summary, candidate: Summary): string[] {
	for (const summary of [baseline, candidate]) {
		if (
			summary.caseHash !== caseHash ||
			summary.repeats !== repeats ||
			Object.keys(summary.cases).sort().join() !==
				cases
					.map((c) => c.id)
					.sort()
					.join()
		)
			throw new Error(
				"Baseline/candidate case set changed; review and recapture explicitly",
			);
		for (const row of Object.values(summary.cases)) {
			if (
				row.trials !== repeats ||
				!Number.isInteger(row.passes) ||
				row.passes < 0 ||
				row.passes > repeats
			)
				throw new Error("Invalid summary counts");
		}
	}
	return cases
		.filter((c) => candidate.cases[c.id]!.passes < baseline.cases[c.id]!.passes)
		.map((c) => c.id);
}
