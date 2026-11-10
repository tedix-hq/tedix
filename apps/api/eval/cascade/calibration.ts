import { createHash } from "node:crypto";
import * as z from "zod";
import {
	CascadeJudgmentSchema,
	DecisionCascadePolicySchema,
	type DecisionCascadePolicy,
} from "@tedix/api-contract/schemas/decision-cascade";
import { CASCADE_CASES, CASCADE_CORPUS_VERSION } from "./fixtures";

export const CascadeCalibrationSchema = z.strictObject({
	corpusDigest: z.string(),
	policyRevision: z.string(),
	judgmentModel: z.string(),
	observations: z.array(
		z.strictObject({
			caseId: z.string(),
			repeat: z.number().int().min(1).max(100),
			origin: z.enum(["provider", "replay"]),
			executionId: z.string().min(1),
			judgment: CascadeJudgmentSchema.nullable(),
			/** Host assessment of semantic support, not model self-certification. */
			citationsSupported: z.boolean(),
		}),
	),
});

export const cascadeCorpusDigest = createHash("sha256")
	.update(JSON.stringify(CASCADE_CASES))
	.digest("hex");

/** Select a judgment threshold only; prose quality and holdout remain separate. */
export function calibrateCascadeThreshold(
	raw: unknown,
	policyInput: DecisionCascadePolicy,
) {
	const policy = DecisionCascadePolicySchema.parse(policyInput);
	const input = CascadeCalibrationSchema.parse(raw);
	if (
		input.corpusDigest !== cascadeCorpusDigest ||
		input.policyRevision !== policy.revision ||
		input.judgmentModel !== policy.judgmentModel
	)
		throw new Error("Calibration corpus or policy mismatch");
	const fixtures = CASCADE_CASES.filter(
		(row) =>
			row.split === "calibration" &&
			!("reserved" in row) &&
			!("synthesis" in row),
	);
	const rows = input.observations;
	if (
		rows.some((row) => !fixtures.some((fixture) => fixture.id === row.caseId))
	)
		throw new Error("Only calibration judgment cases may select thresholds");
	if (
		new Set(rows.map((row) => `${row.caseId}:${row.repeat}`)).size !==
		rows.length
	)
		throw new Error("Duplicate calibration observation");
	if (new Set(rows.map((row) => row.executionId)).size !== rows.length)
		throw new Error("Reused calibration execution");
	const repeatIds = [...new Set(rows.map((row) => row.repeat))];
	const complete =
		repeatIds.length >= 3 &&
		fixtures.every((fixture) =>
			repeatIds.every((repeat) =>
				rows.some((row) => row.caseId === fixture.id && row.repeat === repeat),
			),
		);
	const candidates = [
		...new Set([
			0.5,
			1,
			...rows.flatMap((row) =>
				row.judgment && row.judgment.confidence >= 0.5
					? [row.judgment.confidence]
					: [],
			),
		]),
	].sort((a, b) => a - b);
	const sweep = candidates.map((minConfidence) => {
		const retained = rows.filter(
			(row) =>
				row.judgment &&
				row.judgment.confidence >= minConfidence &&
				row.citationsSupported &&
				row.judgment.citations.length === 1 &&
				row.judgment.citations[0]!.id === "source" &&
				row.judgment.citations[0]!.revision === "1" &&
				["SUPPORTED", "CORRECTION", "UNKNOWN"].includes(row.judgment.label),
		);
		const errors = retained.filter(
			(row) =>
				row.judgment!.label !==
				fixtures.find((fixture) => fixture.id === row.caseId)!.expected,
		);
		return {
			minConfidence,
			retained: retained.length,
			escalated: rows.length - retained.length,
			errors: errors.length,
			falseSuccesses: errors.filter(
				(row) => row.judgment!.label === "SUPPORTED",
			).length,
		};
	});
	// Maximize coverage with no observed label error; prefer the higher cutoff on ties.
	const selected = sweep
		.filter((row) => row.retained > 0 && row.errors === 0)
		.sort(
			(a, b) => b.retained - a.retained || b.minConfidence - a.minConfidence,
		)[0];
	const status = !complete
		? "incomplete"
		: rows.some((row) => row.origin !== "provider")
			? "replay_only"
			: !selected
				? "no_safe_threshold"
				: "selected";
	return {
		corpusVersion: CASCADE_CORPUS_VERSION,
		corpusDigest: cascadeCorpusDigest,
		policyRevision: policy.revision,
		judgmentModel: policy.judgmentModel,
		observationDigest: createHash("sha256")
			.update(JSON.stringify(input))
			.digest("hex"),
		status,
		observations: rows.length,
		repeats: repeatIds.length,
		minConfidence: status === "selected" ? selected!.minConfidence : null,
		sweep,
		activation: "off",
		holdoutStatus: "not_evaluated",
	};
}
