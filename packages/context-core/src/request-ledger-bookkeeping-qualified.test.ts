import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import certificate from "./request-ledger-bookkeeping-qualified-results.json";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
} from "./ledger-model-evaluation";
import { REQUEST_STATUS_REFLECTOR_SYSTEM_PROMPT } from "./request-ledger";

describe("qualified production ledger status", () => {
	it("binds the production prompt to all 41 fixed cases and three repetitions", async () => {
		expect(certificate.version).toBe(1);
		expect(Object.keys(certificate.features)).toEqual(["status"]);
		const selected = certificate.features.status;
		expect(selected.modelRef).toBe("azure-openai/gpt-6.1-sol");
		expect(selected.evaluatedPromptVariant).toBe("shorter_status");
		expect(
			createHash("sha256")
				.update(REQUEST_STATUS_REFLECTOR_SYSTEM_PROMPT)
				.digest("hex"),
		).toBe(selected.systemHash);
		const cases = listLedgerEvaluationCases().filter(
			(row) => row.surface === "status",
		);
		expect(cases).toHaveLength(41);
		expect(selected.cases.map((row) => row.caseId).sort()).toEqual(
			cases.map((row) => row.caseId).sort(),
		);
		let repetitions = 0;
		for (const row of selected.cases) {
			const fixture = getLedgerEvaluationCase(
				"status",
				row.caseId,
				"shorter_status",
			)!;
			expect(fixture.system, row.caseId).toBe(
				REQUEST_STATUS_REFLECTOR_SYSTEM_PROMPT,
			);
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
		expect(repetitions).toBe(123);
	});

	it("contains only sanitized synthetic status quality evidence", () => {
		expect(Object.keys(certificate).sort()).toEqual(["features", "version"]);
		expect(Object.keys(certificate.features)).toEqual(["status"]);
		expect(Object.keys(certificate.features.status).sort()).toEqual([
			"cases",
			"evaluatedPromptVariant",
			"modelRef",
			"systemHash",
		]);
		for (const row of certificate.features.status.cases) {
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
