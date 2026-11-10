import { describe, expect, it } from "vite-plus/test";
import candidate from "@tedix/api-contract/assets/decision-cascade.v1.json";
import { DecisionCascadePolicySchema } from "@tedix/api-contract/schemas/decision-cascade";
import { CASCADE_CASES } from "./fixtures";
import {
	calibrateCascadeThreshold,
	cascadeCorpusDigest,
	type CascadeCalibrationSchema,
} from "./calibration";
import type * as z from "zod";

const policy = DecisionCascadePolicySchema.parse(candidate);
function observations(): z.infer<typeof CascadeCalibrationSchema> {
	return {
		corpusDigest: cascadeCorpusDigest,
		policyRevision: policy.revision,
		judgmentModel: policy.judgmentModel,
		observations: CASCADE_CASES.filter(
			(row) =>
				row.split === "calibration" &&
				!("reserved" in row) &&
				!("synthesis" in row),
		).flatMap((row) =>
			[1, 2, 3].map((repeat) => ({
				caseId: row.id,
				repeat,
				origin: "provider" as const,
				executionId: `${row.id}-${repeat}`,
				judgment: {
					label: row.expected,
					confidence: 0.95,
					citations: [{ id: "source", revision: "1" }],
				},
				citationsSupported: true,
			})),
		),
	};
}

describe("offline judgment threshold selection (synthetic observations)", () => {
	it("selects coverage without accepting a lower-confidence false success", () => {
		const input = observations();
		input.observations.find((row) => row.caseId === "c02")!.judgment = {
			label: "SUPPORTED",
			confidence: 0.8,
			citations: [{ id: "source", revision: "1" }],
		};
		expect(calibrateCascadeThreshold(input, policy)).toMatchObject({
			status: "selected",
			minConfidence: 0.95,
			activation: "off",
			holdoutStatus: "not_evaluated",
			sweep: expect.arrayContaining([
				{
					minConfidence: 0.8,
					retained: 24,
					escalated: 0,
					errors: 1,
					falseSuccesses: 1,
				},
				{
					minConfidence: 0.95,
					retained: 23,
					escalated: 1,
					errors: 0,
					falseSuccesses: 0,
				},
			]),
		});
	});
	it.each([
		"empty",
		"missing",
		"replay",
		"unavailable",
		"unsupported",
		"wrong",
	])("never selects a threshold from %s observations", (kind) => {
		const input = observations();
		if (kind === "empty") input.observations = [];
		if (kind === "missing") input.observations.pop();
		for (const row of input.observations) {
			if (kind === "replay") row.origin = "replay";
			if (kind === "unavailable") row.judgment = null;
			if (kind === "unsupported") row.citationsSupported = false;
			if (kind === "wrong") row.judgment!.label = "WRONG";
		}
		expect(calibrateCascadeThreshold(input, policy).minConfidence).toBeNull();
	});
	it.each([
		"holdout",
		"reserved",
		"synthesis",
		"duplicate",
		"execution",
		"corpus",
		"policy",
		"model",
	])("rejects %s contamination", (kind) => {
		const input = observations();
		if (kind === "holdout") input.observations[0]!.caseId = "h01";
		if (kind === "reserved") input.observations[0]!.caseId = "c10";
		if (kind === "synthesis") input.observations[0]!.caseId = "c09";
		if (kind === "duplicate") input.observations.push(input.observations[0]!);
		if (kind === "execution")
			input.observations[1]!.executionId = input.observations[0]!.executionId;
		if (kind === "corpus") input.corpusDigest = "other";
		if (kind === "policy") input.policyRevision = "other";
		if (kind === "model") input.judgmentModel = "other";
		expect(() => calibrateCascadeThreshold(input, policy)).toThrow();
	});
	it("rejects wrong-label decisions even at confidence one", () => {
		const input = observations();
		for (const row of input.observations) {
			row.judgment!.confidence = 1;
			row.judgment!.label =
				row.judgment!.label === "SUPPORTED" ? "CORRECTION" : "SUPPORTED";
		}
		expect(calibrateCascadeThreshold(input, policy)).toMatchObject({
			status: "no_safe_threshold",
			minConfidence: null,
		});
	});
});
