import { describe, expect, it } from "vite-plus/test";
import {
	assessDelegatedAnswerCriteriaWithJev,
	buildDelegatedAnswerQuestions,
	buildGoalAnswerQuestion,
	interpretDelegatedAnswer,
	interpretGoalAnswer,
} from "./jev-goal-assessment";

const childEvidence = {
	finalAssistantMessage:
		"I found three invoices and listed their IDs: 1, 2, 3.",
	toolCalls: [{ name: "list_invoices" }],
};

describe("Jev semantic answer assessment", () => {
	it("bounds untrusted goal text and abstains on empty answers", () => {
		expect(
			buildGoalAnswerQuestion({ condition: "done", answer: " " }),
		).toBeNull();
		const request = buildGoalAnswerQuestion({
			condition: "List the invoice IDs",
			answer: "1, 2, and 3",
		});
		expect(request?.questions.met.type).toBe("noul");
		expect(request?.state).toContain("List the invoice IDs");
	});

	it("requires confident Noul for semantic goal completion", () => {
		expect(interpretGoalAnswer({ type: "noul", noul: 0.9 })).toBe(true);
		expect(interpretGoalAnswer({ type: "noul", noul: 0.8 })).toBe(false);
		expect(interpretGoalAnswer(undefined)).toBe(false);
	});

	it("asks independently about each delegated answer criterion", () => {
		const request = buildDelegatedAnswerQuestions({
			runId: "run-1",
			criteria: ["lists all invoice IDs", "explains the due date"],
			childEvidence,
		});
		expect(Object.keys(request?.questions ?? {})).toEqual([
			"criterion0",
			"criterion1",
		]);
		expect(request?.state).toContain("list_invoices");
		expect(
			buildDelegatedAnswerQuestions({
				runId: "run-1",
				criteria: ["lists invoices"],
				childEvidence: { ...childEvidence, toolCalls: [] },
			}),
		).toBeNull();
		expect(
			buildDelegatedAnswerQuestions({
				runId: "run-1",
				criteria: Array.from({ length: 9 }, (_, index) => `criterion ${index}`),
				childEvidence,
			}),
		).toBeNull();
	});

	it("distinguishes a clear miss from uncertain or complete coverage", () => {
		expect(
			interpretDelegatedAnswer(
				{
					criterion0: { type: "noul", noul: 0.9 },
					criterion1: { type: "noul", noul: 0.1 },
				},
				2,
			),
		).toBe(false);
		expect(
			interpretDelegatedAnswer(
				{
					criterion0: { type: "noul", noul: 0.9 },
					criterion1: { type: "noul", noul: 0.7 },
				},
				2,
			),
		).toBeNull();
		expect(
			interpretDelegatedAnswer(
				{
					criterion0: { type: "noul", noul: 0.9 },
					criterion1: { type: "noul", noul: 0.95 },
				},
				2,
			),
		).toBe(true);
	});

	it("attributes post-hoc assessment to the exact run and keeps provider failure uncertain", async () => {
		let captured: Record<string, unknown> | undefined;
		const input = {
			db: {} as never,
			env: {} as never,
			context: { organizationId: "org-1" },
			runId: "run-1",
			criteria: ["lists invoice IDs"],
			childEvidence,
		};
		const assessed = await assessDelegatedAnswerCriteriaWithJev({
			...input,
			judge: (async (request: Record<string, unknown>) => {
				captured = request;
				return { answers: { criterion0: { type: "noul", noul: 0.95 } } };
			}) as never,
		});
		expect(assessed).toBe(true);
		expect(captured?.context).toEqual({
			organizationId: "org-1",
			runId: "run-1",
		});
		expect(captured?.source).toBe("kernel:delegated-answer-assessment");
		await expect(
			assessDelegatedAnswerCriteriaWithJev({
				...input,
				judge: (async () => {
					throw new Error("provider down");
				}) as never,
			}),
		).resolves.toBeNull();
	});
});
