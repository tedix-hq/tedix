import { hasFactEvidence } from "@tedix/api-contract/utils/fact-evidence";
import { describe, expect, test } from "vite-plus/test";
import {
	type EvidencePayload,
	feedbackSignalsFromEvidence,
	parseEvidencePayload,
} from "../../services/brain-feedback";
import { isIdempotentRationaleCompletion } from "./rationale-records";

describe("rationale record memory feedback", () => {
	test("creates feedback from referenced facts", () => {
		expect(
			feedbackSignalsFromEvidence({ factIds: ["a", "b"] }, "success"),
		).toEqual([{ factIds: ["a", "b"], signal: "used" }]);
	});

	test("extracts retrieved fact evidence from nested provenance", () => {
		expect(
			feedbackSignalsFromEvidence(
				{
					provenance: {
						retrievedFacts: [
							{ factId: "a", score: 0.9 },
							{ factId: "b", score: 0.7 },
						],
					},
				},
				"success",
			),
		).toEqual([{ factIds: ["a", "b"], signal: "used" }]);
	});

	test("parses stringified evidence before deciding whether facts are present", () => {
		const evidence = JSON.stringify({
			provenance: {
				retrievedFacts: [{ factId: "fact-from-json", score: 0.9 }],
			},
		});

		expect(hasFactEvidence(evidence)).toBe(true);
		expect(
			feedbackSignalsFromEvidence(parseEvidencePayload(evidence), "success"),
		).toEqual([{ factIds: ["fact-from-json"], signal: "used" }]);
	});

	test("extracts historical facts arrays without treating metadata ids as facts", () => {
		expect(
			feedbackSignalsFromEvidence(
				{
					metadata: {
						id: "work-item-id",
						facts: [{ id: "fact-a" }, { factId: "fact-b" }],
					},
				},
				"success",
			),
		).toEqual([{ factIds: ["fact-a", "fact-b"], signal: "used" }]);
	});

	test("honors explicit used and ignored fact sets", () => {
		expect(
			feedbackSignalsFromEvidence(
				{
					retrievedFacts: [
						{ factId: "a", score: 0.9 },
						{ factId: "b", score: 0.7 },
						{ factId: "c", score: 0.3 },
					],
					usedFactIds: ["a"],
					ignoredFactIds: ["b"],
				},
				"success",
			),
		).toEqual([
			{ factIds: ["a"], signal: "used" },
			{ factIds: ["c"], signal: "used" },
			{ factIds: ["b"], signal: "not_used" },
		]);
	});

	test("treats duplicate rationale completion with the same terminal status as idempotent", () => {
		expect(isIdempotentRationaleCompletion("success", "success")).toBe(true);
		expect(isIdempotentRationaleCompletion("failure", "failure")).toBe(true);
		expect(isIdempotentRationaleCompletion("partial", "partial")).toBe(true);
		expect(isIdempotentRationaleCompletion("pending", "success")).toBe(false);
		expect(isIdempotentRationaleCompletion("success", "failure")).toBe(false);
	});
});
