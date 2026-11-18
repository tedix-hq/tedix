import { describe, expect, it } from "vite-plus/test";
import certificate from "./request-ledger-intake-qualified-results.json";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
} from "./ledger-model-evaluation";

describe("qualified production ledger intake", () => {
	it("binds the selected model to all 35 fixed cases and three actual repetitions", async () => {
		expect(certificate.version).toBe(1);
		expect(Object.keys(certificate.features)).toEqual(["intake"]);
		const selected = certificate.features.intake;
		expect(selected.modelRef).toBe("azure-openai/gpt-6.1-sol");
		expect(selected.evaluatedPromptVariant).toBe("production");
		const cases = listLedgerEvaluationCases().filter(
			(row) => row.surface === "intake",
		);
		expect(cases).toHaveLength(35);
		expect(selected.cases.map((row) => row.caseId)).toEqual(
			cases.map((row) => row.caseId),
		);
		let repetitions = 0;
		for (const row of selected.cases) {
			const fixture = getLedgerEvaluationCase(
				"intake",
				row.caseId,
				"production",
			)!;
			expect(await hashLedgerEvaluationCase(fixture), row.caseId).toEqual({
				systemHash: selected.systemHash,
				inputHash: row.inputHash,
			});
			expect(
				row.repetitions.map((repetition) => repetition.repetition),
				row.caseId,
			).toEqual([0, 1, 2]);
			for (const repetition of row.repetitions) {
				expect(typeof repetition.raw).toBe("string");
				expect(
					fixture.grade(repetition.raw),
					`${row.caseId}:${repetition.repetition}`,
				).toMatchObject({ passed: true });
				repetitions++;
			}
		}
		expect(repetitions).toBe(105);
	});
	it("contains only sanitized synthetic quality evidence", () => {
		expect(Object.keys(certificate).sort()).toEqual(["features", "version"]);
		expect(Object.keys(certificate.features.intake).sort()).toEqual([
			"cases",
			"evaluatedPromptVariant",
			"modelRef",
			"systemHash",
		]);
		for (const row of certificate.features.intake.cases) {
			expect(Object.keys(row).sort()).toEqual([
				"caseId",
				"inputHash",
				"repetitions",
			]);
			for (const repetition of row.repetitions)
				expect(Object.keys(repetition).sort()).toEqual(["raw", "repetition"]);
		}
		expect(JSON.stringify(certificate)).not.toMatch(
			/providerRequestId|evaluationId|organizationId|accountId|\/Users\//,
		);
	});
});
