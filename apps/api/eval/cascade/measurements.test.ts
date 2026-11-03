import { describe, expect, it } from "vite-plus/test";
import { CASCADE_CASES, cascadeCaseInput } from "./fixtures";
import {
	summarizeCascadeMeasurements,
	type CascadeMeasurement,
} from "./measurements";

function measured(
	arm: CascadeMeasurement["arm"],
	repeat: number,
): CascadeMeasurement {
	return {
		caseId: "h02",
		arm,
		repeat,
		origin: "provider",
		label: "SUPPORTED",
		status: "proposed",
		qualityScore: 0,
		corrected: true,
		elapsedMs: 20,
		receipts: [
			{
				executionId: `${arm}-${repeat}`,
				requestedModel: "cloudflare/auto",
				resolvedModel: repeat % 2 ? "actual-small" : "actual-large",
				latencyMs: 10,
				costMicros: 7,
				cacheReadTokens: 12,
				cacheWriteTokens: 0,
				usagePersisted: true,
			},
		],
	};
}

describe("fixed cascade measurement grading", () => {
	it("freezes disjoint calibration and holdout cases and keeps gold out of prompts", () => {
		expect(
			CASCADE_CASES.filter((row) => row.split === "calibration"),
		).toHaveLength(10);
		expect(CASCADE_CASES.filter((row) => row.split === "holdout")).toHaveLength(
			10,
		);
		expect(new Set(CASCADE_CASES.map((row) => row.id)).size).toBe(20);
		for (const row of CASCADE_CASES)
			expect(cascadeCaseInput(row)).not.toHaveProperty("expected");
	});
	it("empty measurements report unknown cost/quality and cannot qualify", () => {
		const results = summarizeCascadeMeasurements([]);
		expect(results.baseline).toMatchObject({
			complete: false,
			totalCostMicros: null,
			meanQuality: null,
			p95Ms: null,
		});
		expect(results.cascade).toMatchObject({
			complete: false,
			totalCostMicros: null,
		});
	});
	it("counts false success, correction, all paid calls and actual resolved cache models", () => {
		const results = summarizeCascadeMeasurements([
			measured("cascade", 1),
			measured("cascade", 2),
			measured("cascade", 3),
		]);
		expect(results.cascade).toMatchObject({
			complete: false,
			falseSuccesses: 3,
			correctionRate: 1,
			totalCostMicros: 21,
			labelAccuracy: 0,
			cacheByResolvedModel: {
				"actual-small": { measurements: 2, cacheReadTokens: 24 },
				"actual-large": { measurements: 1, cacheReadTokens: 12 },
			},
		});
	});
	it("does not treat unknown price as free or a repeated receipt as a new measurement", () => {
		const row = measured("cascade", 1);
		row.receipts[0]!.costMicros = null;
		expect(
			summarizeCascadeMeasurements([row]).cascade?.totalCostMicros,
		).toBeNull();
		expect(() => summarizeCascadeMeasurements([row, row])).toThrow(
			"Duplicate measurement",
		);
		expect(() =>
			summarizeCascadeMeasurements([row, { ...row, repeat: 2 }]),
		).toThrow("Reused execution receipt");
	});
	it("never blends calibration measurements into holdout scores", () => {
		const row = { ...measured("cascade", 1), caseId: "c01" };
		expect(
			summarizeCascadeMeasurements([row], "holdout").cascade?.measurements,
		).toBe(0);
		expect(
			summarizeCascadeMeasurements([row], "calibration").cascade?.measurements,
		).toBe(1);
	});
	it("replay cannot qualify even with complete labels, receipts and three repeats", () => {
		const rows = CASCADE_CASES.flatMap((fixture) =>
			[1, 2, 3].map((repeat) => ({
				...measured("cascade", repeat),
				caseId: fixture.id,
				origin: "replay",
				receipts: [
					{
						...measured("cascade", repeat).receipts[0]!,
						executionId: `${fixture.id}-${repeat}`,
					},
				],
			})),
		);
		expect(summarizeCascadeMeasurements(rows).cascade?.complete).toBe(false);
	});
});
