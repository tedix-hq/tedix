import * as z from "zod";
import { CascadeReceiptSchema } from "@tedix/api-contract/schemas/decision-cascade";
import { CASCADE_CASES } from "./fixtures";

export const CascadeMeasurementSchema = z.strictObject({
	caseId: z.string(),
	arm: z.enum(["baseline", "cascade"]),
	repeat: z.number().int().min(1).max(100),
	/** Replay data may exercise grading, but cannot qualify a model policy. */
	origin: z.enum(["provider", "replay"]),
	label: z.enum(["SUPPORTED", "CORRECTION", "UNKNOWN"]).nullable(),
	status: z.enum(["proposed", "reserved", "stopped", "abstained"]),
	qualityScore: z.number().min(0).max(1).nullable(),
	corrected: z.boolean().nullable(),
	/** End-to-end wall clock, including admission and every tier. */
	elapsedMs: z.number().nonnegative(),
	receipts: z.array(CascadeReceiptSchema).max(5),
});
export type CascadeMeasurement = z.infer<typeof CascadeMeasurementSchema>;

/** Descriptive comparison only; matching experiment configuration needs host evidence. */
export function compareCascadeMeasurements(
	raw: unknown[],
	split: "calibration" | "holdout",
) {
	const summary = summarizeCascadeMeasurements(raw, split);
	const baseline = summary.baseline!;
	const cascade = summary.cascade!;
	const rows = raw
		.map((row) => CascadeMeasurementSchema.parse(row))
		.filter((row) =>
			CASCADE_CASES.some(
				(fixture) => fixture.id === row.caseId && fixture.split === split,
			),
		);
	const keys = (arm: CascadeMeasurement["arm"]) =>
		new Set(
			rows
				.filter((row) => row.arm === arm)
				.map((row) => `${row.caseId}:${row.repeat}`),
		);
	const baselineKeys = keys("baseline");
	const cascadeKeys = keys("cascade");
	const paired =
		baselineKeys.size === cascadeKeys.size &&
		[...baselineKeys].every((key) => cascadeKeys.has(key));
	if (!baseline.complete || !cascade.complete || !paired) {
		return {
			status: "incomplete" as const,
			reason: !paired ? "unpaired_repeats" : "incomplete_measurements",
			deltas: null,
			checks: null,
			noRegression: null,
		};
	}
	const deltas = {
		labelAccuracy: cascade.labelAccuracy! - baseline.labelAccuracy!,
		meanQuality: cascade.meanQuality! - baseline.meanQuality!,
		falseSuccesses: cascade.falseSuccesses! - baseline.falseSuccesses!,
		correctionRate: cascade.correctionRate! - baseline.correctionRate!,
		p95Ms: cascade.p95Ms! - baseline.p95Ms!,
		totalCostMicros: cascade.totalCostMicros! - baseline.totalCostMicros!,
	};
	const checks = {
		labelAccuracy: deltas.labelAccuracy >= 0,
		meanQuality: deltas.meanQuality >= 0,
		falseSuccesses: deltas.falseSuccesses <= 0,
		correctionRate: deltas.correctionRate <= 0,
		p95Ms: deltas.p95Ms <= 0,
		totalCostMicros: deltas.totalCostMicros <= 0,
		reservedActs: rows.every((row) => {
			const fixture = CASCADE_CASES.find(
				(fixture) => fixture.id === row.caseId,
			)!;
			return "reserved" in fixture
				? row.status === "reserved" &&
						row.label === null &&
						row.receipts.length === 0
				: row.status !== "reserved";
		}),
	};
	return {
		status: "compared" as const,
		reason: null,
		deltas,
		checks,
		noRegression: Object.values(checks).every(Boolean),
	};
}

/** Missing receipts/prices/repeats remain unknown, never zero-cost successes. */
export function summarizeCascadeMeasurements(
	raw: unknown[],
	split?: "calibration" | "holdout",
) {
	const rows = raw.map((row) => CascadeMeasurementSchema.parse(row));
	const keys = rows.map((row) => `${row.caseId}:${row.arm}:${row.repeat}`);
	if (new Set(keys).size !== keys.length)
		throw new Error("Duplicate measurement");
	if (
		rows.some(
			(row) => !CASCADE_CASES.some((fixture) => fixture.id === row.caseId),
		)
	)
		throw new Error("Unknown corpus case");
	const executionIds = rows.flatMap((row) =>
		row.receipts.map((receipt) => receipt.executionId),
	);
	if (new Set(executionIds).size !== executionIds.length)
		throw new Error("Reused execution receipt");
	const fixtures = CASCADE_CASES.filter(
		(fixture) => !split || fixture.split === split,
	);
	return Object.fromEntries(
		(["baseline", "cascade"] as const).map((arm) => {
			const selected = rows.filter(
				(row) =>
					row.arm === arm &&
					fixtures.some((fixture) => fixture.id === row.caseId),
			);
			const receipts = selected.flatMap((row) => row.receipts);
			const coverageComplete = fixtures.every((fixture) => {
				const measurements = selected.filter(
					(row) => row.caseId === fixture.id,
				);
				return (
					measurements.length >= 3 &&
					measurements.every((row) => row.origin === "provider")
				);
			});
			const attributionComplete = selected.every(
				(row) =>
					(row.receipts.length > 0 || row.status === "reserved") &&
					row.receipts.every(
						(receipt) =>
							receipt.resolvedModel !== null &&
							receipt.costMicros !== null &&
							receipt.usagePersisted &&
							receipt.cacheReadTokens !== null &&
							receipt.cacheWriteTokens !== null,
					),
			);
			const scored = selected.filter(
				(row) => row.qualityScore !== null && row.corrected !== null,
			);
			const latency = selected
				.map((row) => row.elapsedMs)
				.sort((a, b) => a - b);
			const cacheByResolvedModel = Object.fromEntries(
				[
					...new Set(
						receipts
							.map((row) => row.resolvedModel)
							.filter((model): model is string => model !== null),
					),
				].map((model) => {
					const matched = receipts.filter((row) => row.resolvedModel === model);
					return [
						model,
						{
							measurements: matched.length,
							cacheReadTokens: matched.every(
								(row) => row.cacheReadTokens !== null,
							)
								? matched.reduce((sum, row) => sum + row.cacheReadTokens!, 0)
								: null,
							cacheWriteTokens: matched.every(
								(row) => row.cacheWriteTokens !== null,
							)
								? matched.reduce((sum, row) => sum + row.cacheWriteTokens!, 0)
								: null,
						},
					];
				}),
			);
			return [
				arm,
				{
					complete:
						coverageComplete &&
						attributionComplete &&
						scored.length === selected.length,
					measurements: selected.length,
					labelAccuracy: selected.length
						? selected.filter((row) => {
								const fixture = CASCADE_CASES.find(
									(fixture) => fixture.id === row.caseId,
								)!;
								return "reserved" in fixture
									? row.status === "reserved"
									: row.status === "proposed" && row.label === fixture.expected;
							}).length / selected.length
						: null,
					falseSuccesses: selected.length
						? selected.filter(
								(row) =>
									row.label === "SUPPORTED" &&
									CASCADE_CASES.find((fixture) => fixture.id === row.caseId)!
										.expected !== "SUPPORTED",
							).length
						: null,
					meanQuality: scored.length
						? scored.reduce((sum, row) => sum + row.qualityScore!, 0) /
							scored.length
						: null,
					correctionRate: scored.length
						? scored.filter((row) => row.corrected).length / scored.length
						: null,
					p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] ?? null,
					totalCostMicros:
						selected.length && attributionComplete
							? receipts.reduce((sum, row) => sum + row.costMicros!, 0)
							: null,
					cacheByResolvedModel,
				},
			];
		}),
	);
}
