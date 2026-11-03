import { describe, expect, it } from "vite-plus/test";
import { CASCADE_CASES } from "./fixtures";
import {
	compareCascadeMeasurements,
	summarizeCascadeMeasurements,
	type CascadeMeasurement,
} from "./measurements";

// Synthetic provider-shaped rows exercise the gate, never supply measured results.
function pairedRows(): CascadeMeasurement[] {
	return CASCADE_CASES.flatMap((fixture) =>
		(["baseline", "cascade"] as const).flatMap((arm) =>
			[1, 2, 3].map((repeat) => ({
				caseId: fixture.id,
				arm,
				repeat,
				origin: "provider" as const,
				label: "reserved" in fixture ? null : fixture.expected,
				status:
					"reserved" in fixture ? ("reserved" as const) : ("proposed" as const),
				qualityScore: 1,
				corrected: false,
				elapsedMs: 20,
				receipts:
					"reserved" in fixture
						? []
						: [
								{
									executionId: `${fixture.id}-${arm}-${repeat}`,
									requestedModel: "configured-model",
									resolvedModel: "actual-model",
									latencyMs: 10,
									costMicros: 7,
									cacheReadTokens: 0,
									cacheWriteTokens: 0,
									usagePersisted: true,
								},
							],
			})),
		),
	);
}

describe("paired cascade comparison", () => {
	it("keeps an empty evaluation unknown", () => {
		expect(compareCascadeMeasurements([], "holdout")).toEqual({
			status: "incomplete",
			reason: "incomplete_measurements",
			deltas: null,
			checks: null,
			noRegression: null,
		});
	});
	it("compares all metrics with cascade-minus-baseline deltas", () => {
		const rows = pairedRows();
		for (const row of rows.filter((row) => row.arm === "cascade")) {
			row.elapsedMs = 10;
			for (const receipt of row.receipts) receipt.costMicros = 2;
		}
		expect(compareCascadeMeasurements(rows, "holdout")).toMatchObject({
			status: "compared",
			deltas: {
				labelAccuracy: 0,
				meanQuality: 0,
				falseSuccesses: 0,
				correctionRate: 0,
				p95Ms: -10,
				totalCostMicros: -135,
			},
			noRegression: true,
		});
	});
	it("rejects unmatched repeat identities even when both arms are complete", () => {
		const rows = pairedRows();
		for (const row of rows.filter((row) => row.arm === "cascade"))
			row.repeat += 3;
		const summary = summarizeCascadeMeasurements(rows, "holdout");
		expect(summary.baseline?.complete).toBe(true);
		expect(summary.cascade?.complete).toBe(true);
		expect(compareCascadeMeasurements(rows, "holdout")).toMatchObject({
			status: "incomplete",
			reason: "unpaired_repeats",
			deltas: null,
			noRegression: null,
		});
	});
	it.each(["quality", "correction", "latency", "cost", "falseSuccess"])(
		"does not hide %s regression behind savings elsewhere",
		(metric) => {
			const rows = pairedRows();
			for (const row of rows.filter((row) => row.arm === "cascade")) {
				if (metric === "quality") row.qualityScore = 0.5;
				if (metric === "correction") row.corrected = true;
				if (metric === "latency") row.elapsedMs = 30;
				if (metric === "falseSuccess" && row.caseId === "h02")
					row.label = "SUPPORTED";
				for (const receipt of row.receipts)
					receipt.costMicros = metric === "cost" ? 8 : 2;
			}
			expect(compareCascadeMeasurements(rows, "holdout").noRegression).toBe(
				false,
			);
		},
	);
	it("rejects equal reserved-act violations in both arms", () => {
		const rows = pairedRows();
		for (const row of rows.filter((row) => row.caseId === "h04")) {
			row.status = "proposed";
			row.label = "UNKNOWN";
			row.receipts = [
				{
					...rows[0]!.receipts[0]!,
					executionId: `reserved-${row.arm}-${row.repeat}`,
				},
			];
		}
		expect(compareCascadeMeasurements(rows, "holdout")).toMatchObject({
			status: "compared",
			deltas: { labelAccuracy: 0 },
			checks: { reservedActs: false },
			noRegression: false,
		});
	});
	it.each(["replay", "price", "quality"])(
		"keeps incomplete %s evidence unknown",
		(missing) => {
			const rows = pairedRows();
			if (missing === "replay") rows[0]!.origin = "replay";
			if (missing === "price") rows[0]!.receipts[0]!.costMicros = null;
			if (missing === "quality") rows[0]!.qualityScore = null;
			expect(compareCascadeMeasurements(rows, "calibration")).toMatchObject({
				status: "incomplete",
				noRegression: null,
				deltas: null,
			});
		},
	);
	it("keeps calibration regressions out of holdout comparison", () => {
		const rows = pairedRows();
		for (const row of rows.filter(
			(row) => row.arm === "cascade" && row.caseId.startsWith("c"),
		))
			row.qualityScore = 0;
		expect(compareCascadeMeasurements(rows, "calibration").noRegression).toBe(
			false,
		);
		expect(compareCascadeMeasurements(rows, "holdout").noRegression).toBe(true);
	});
});
