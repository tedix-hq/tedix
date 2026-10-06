/**
 * Pure-logic regression for live-turn scoring (Slice B of closing the harness
 * learning loop). The running isolate scores its OWN turns deterministically
 * (no model judge) so the active harness version accumulates a real meanScore
 * from production episodes. This guards the rubric: a clean success grounded by
 * an answer/tool result passes; a hard failure or an ungrounded empty turn does
 * not; the score is a deterministic [0,1] blend; and the eval ids are stable so
 * queue retries stay idempotent.
 */
import { describe, expect, it } from "vite-plus/test";
import {
	gradeTurn,
	LIVE_TURN_EVAL_LANE,
	LIVE_TURN_TASK_SET_ID,
	liveTurnEvalIds,
} from "./harness-version.js";

describe("gradeTurn", () => {
	it("passes a successful, answer-grounded turn with a perfect score", () => {
		const g = gradeTurn({
			outcome: "success",
			assistantText: "Here is the answer you asked for.",
			toolResultCount: 0,
		});
		expect(g.passed).toBe(true);
		expect(g.score).toBe(1);
		expect(g.gates).toEqual({ task_success: true, grounding: true });
	});

	it("passes a successful turn grounded only by a tool result (empty answer)", () => {
		const g = gradeTurn({
			outcome: "success",
			assistantText: "",
			toolResultCount: 2,
		});
		expect(g.passed).toBe(true);
		expect(g.score).toBe(1);
		expect(g.gates.grounding).toBe(true);
	});

	it("fails a hard failure outcome even with grounded content", () => {
		const g = gradeTurn({
			outcome: "failure",
			assistantText: "partial output before the crash",
			toolResultCount: 1,
		});
		expect(g.passed).toBe(false);
		expect(g.gates.task_success).toBe(false);
		// Grounding still credited (it did real work) → partial 0.4, not 0.
		expect(g.gates.grounding).toBe(true);
		expect(g.score).toBeCloseTo(0.4, 10);
	});

	it("fails when an unrecovered error occurred despite a success label", () => {
		const g = gradeTurn({
			outcome: "success",
			assistantText: "answer",
			toolResultCount: 0,
			unrecoveredError: true,
		});
		expect(g.passed).toBe(false);
		expect(g.gates.task_success).toBe(false);
		// success credit is withheld; grounding (answer) still credited → 0.4.
		expect(g.score).toBeCloseTo(0.4, 10);
	});

	it("fails an ungrounded turn (no answer, no tool result)", () => {
		const g = gradeTurn({
			outcome: "success",
			assistantText: "   ",
			toolResultCount: 0,
		});
		expect(g.passed).toBe(false);
		expect(g.gates.grounding).toBe(false);
		// success credited but no grounding → 0.6.
		expect(g.score).toBeCloseTo(0.6, 10);
	});

	it("scores a hard fail with no grounding as zero", () => {
		const g = gradeTurn({
			outcome: "failure",
			assistantText: "",
			toolResultCount: 0,
			unrecoveredError: true,
		});
		expect(g.passed).toBe(false);
		expect(g.score).toBe(0);
		expect(g.gates).toEqual({ task_success: false, grounding: false });
	});

	it("does not pass non-success terminal states (partial/aborted/escalated)", () => {
		for (const outcome of [
			"partial",
			"aborted",
			"escalated",
			"unknown",
		] as const) {
			const g = gradeTurn({
				outcome,
				assistantText: "some answer",
				toolResultCount: 1,
			});
			expect(g.passed).toBe(false);
			expect(g.gates.task_success).toBe(false);
		}
	});
});

describe("liveTurnEvalIds", () => {
	it("derives stable, deterministic result/run ids on the validation lane", () => {
		const a = liveTurnEvalIds("hv_01", "tedi_cto:chat:msg-7");
		const b = liveTurnEvalIds("hv_01", "tedi_cto:chat:msg-7");
		// Stable across calls → conflict-do-nothing writes stay idempotent on retry.
		expect(a).toEqual(b);
		expect(a.resultId).toBe(
			`her_hv_01_${LIVE_TURN_EVAL_LANE}_tedi_cto:chat:msg-7`,
		);
		expect(a.runId).toBe(
			`hrun_hv_01_${LIVE_TURN_EVAL_LANE}_tedi_cto:chat:msg-7`,
		);
		expect(LIVE_TURN_EVAL_LANE).toBe("validation");
		expect(LIVE_TURN_TASK_SET_ID).toBe("live-turn-v1");
	});

	it("distinguishes different versions and runs", () => {
		expect(liveTurnEvalIds("hv_01", "r1").resultId).not.toBe(
			liveTurnEvalIds("hv_02", "r1").resultId,
		);
		expect(liveTurnEvalIds("hv_01", "r1").resultId).not.toBe(
			liveTurnEvalIds("hv_01", "r2").resultId,
		);
	});
});
