import { describe, expect, it } from "vite-plus/test";
import recorded from "./request-ledger-precision-results.json";
import { REQUEST_REFLECTOR_SYSTEM_PROMPT } from "./request-ledger";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
} from "./ledger-model-evaluation";

describe("fixed ledger model qualification", () => {
	it("retains every existing corpus case and independently grades the authentic reference", () => {
		for (const row of recorded.results) {
			expect(
				getLedgerEvaluationCase("status", row.id)!.grade(row.raw),
				row.id,
			).toMatchObject({ passed: true });
			expect(
				getLedgerEvaluationCase("intake", row.id)!.grade(row.intakeRaw),
				row.id,
			).toMatchObject({ passed: true });
		}
		for (const row of recorded.replyResults)
			expect(
				getLedgerEvaluationCase("reply", row.id)!.grade(row.raw),
				row.id,
			).toMatchObject({ passed: true });
		expect(listLedgerEvaluationCases()).toHaveLength(84);
	});
	it("rejects malformed response on every case, including expected empty cases", () => {
		for (const row of listLedgerEvaluationCases())
			expect(
				getLedgerEvaluationCase(row.surface, row.caseId)!.grade(null).passed,
				row.caseId,
			).toBe(false);
	});
	it("keeps candidate prompts separate and hashes exact input bytes", async () => {
		const prod = getLedgerEvaluationCase("status", "chat-acceptance")!;
		const candidate = getLedgerEvaluationCase(
			"status",
			"chat-acceptance",
			"shorter_status",
		)!;
		expect(prod.system).toBe(REQUEST_REFLECTOR_SYSTEM_PROMPT);
		expect(candidate.system.length).toBeLessThan(prod.system.length);
		expect(candidate.prompt).toBe(prod.prompt);
		expect(candidate.system).toContain(
			"Never infer approval from an agent claim",
		);
		expect(candidate.system).toContain(
			"A completion notification proves the lane returned",
		);
		expect(await hashLedgerEvaluationCase(prod)).not.toEqual(
			await hashLedgerEvaluationCase(candidate),
		);
		expect(
			getLedgerEvaluationCase("intake", "chat-acceptance", "shorter_status"),
		).toBeNull();
		expect(getLedgerEvaluationCase("status", "untrusted-input")).toBeNull();
	});
	it("does not allow baseline done-only grading to hide state, lane or scope regressions", () => {
		const test = getLedgerEvaluationCase("status", "chat-acceptance")!;
		expect(
			test.grade('{"updates":[],"lanes":[],"mentioned":{},"merges":[]}')
				.failures,
		).toContain("all status updates");
		const raw = recorded.results.find(
			(row) => row.id === "chat-acceptance",
		)!.raw;
		const wrong = JSON.parse(raw);
		wrong.lanes = [];
		expect(test.grade(JSON.stringify(wrong)).failures).toContain("lane state");
		expect(
			getLedgerEvaluationCase("intake", "selected-measured-goal")!.grade(
				'{"new":[{"kind":"promise","text":"Improve retrieval","evidence":"Here is the selected goal I\'m starting now:"}]}',
			).passed,
		).toBe(false);
	});
	it("does not accept numeric substrings as the original acceptance targets", () => {
		const result = getLedgerEvaluationCase(
			"intake",
			"selected-measured-goal",
		)!.grade(
			JSON.stringify({
				new: [
					{
						kind: "promise",
						text: "Deliver doc under 50 seconds and answer under 30 seconds on 200 requests",
						evidence: "Here is the selected goal I'm starting now:",
					},
				],
			}),
		);
		expect(result.failures).toContain("missing scope: 5");
		expect(result.failures).toContain("missing scope: 3");
		expect(result.failures).toContain("missing scope: 20");
	});
	it("rejects human approval fabricated by agent reports and answers cited outside the user reply", () => {
		expect(
			getLedgerEvaluationCase("status", "do-not-infer-human-approval")!.grade(
				'{"updates":[{"ref":"r1","status":"done","evidence":"approval was granted"}],"mentioned":{},"lanes":[],"merges":[]}',
			).passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("reply", "selected-draft-is-not-sending")!.grade(
				'{"requests":[{"kind":"request","text":"Create private draft"}],"answered":[{"ref":"r1","evidence":"I approve sending"}],"cancelled":[]}',
			).passed,
		).toBe(false);
	});
	it("requires exact ordered lesson evidence and rejects unsupported raw lessons", () => {
		const raw = JSON.stringify({
			lessons: [
				{
					rule: "upload_report body limit → Use native upload. Why: Inline bodies exceed the limit.",
					failure: "Failed upload_report: body too large",
					fix: "Fixed upload_report by using native file upload; upload_report saved successfully.",
				},
			],
		});
		expect(
			getLedgerEvaluationCase("lesson", "same-operation-recovery")!.grade(raw),
		).toMatchObject({
			passed: true,
			parsed: [{ failureEventId: "failure", fixEventId: "fix" }],
		});
		expect(
			getLedgerEvaluationCase("lesson", "success-before-failure")!.grade(raw)
				.passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("lesson", "unrelated-success")!.grade(raw).passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("lesson", "planned-fix")!.grade('{"lessons":[]}')
				.passed,
		).toBe(true);
	});
});
