import { describe, expect, it } from "vite-plus/test";
import {
	AgentTurnTriagePolicyInputSchema,
	LabelAgentReplyResultSchema,
	TriageAgentTurnInputSchema,
	TriageResultSchema,
} from "../schemas/agent-turn-triage";
import { agentTurnTriageContract } from "./agent-turn-triage";

const question = {
	id: "blocker_or_failure",
	instructions: "Does the agent report a blocker?",
	urgentWhen: { gte: 0.5 },
};

describe("agentTurnTriageContract", () => {
	it("exposes exactly the four triage procedures", () => {
		expect(Object.keys(agentTurnTriageContract).sort()).toEqual([
			"getPolicy",
			"labelReply",
			"triage",
			"updatePolicy",
		]);
	});

	it("bounds triage text at 20000 characters", () => {
		expect(
			TriageAgentTurnInputSchema.safeParse({ text: "x".repeat(20_000) })
				.success,
		).toBe(true);
		expect(
			TriageAgentTurnInputSchema.safeParse({ text: "x".repeat(20_001) })
				.success,
		).toBe(false);
	});

	it("pins the shared TriageResult shape", () => {
		const result = {
			status: "ok",
			urgency: "now",
			labels: { blocker_or_failure: 0.9 },
			urgentLabels: ["blocker_or_failure"],
			model: "@cf/cloudflare/clef-flash",
			policyVersion: 1,
			latencyMs: 120,
		};
		expect(TriageResultSchema.parse(result)).toEqual(result);
		expect(
			TriageResultSchema.safeParse({ ...result, labels: { x: 1.5 } }).success,
		).toBe(false);
		expect(
			TriageResultSchema.safeParse({ ...result, urgency: "soon" }).success,
		).toBe(false);
	});

	it("validates policy limits, ids, models, and server-owned version", () => {
		const policy = {
			enabled: true,
			model: "@cf/cloudflare/clef",
			questions: [question],
		};
		expect(AgentTurnTriagePolicyInputSchema.safeParse(policy).success).toBe(
			true,
		);
		for (const bad of [
			{ ...policy, model: "@cf/meta/llama" },
			{ ...policy, questions: [] },
			{ ...policy, questions: [question, question] },
			{ ...policy, questions: [{ ...question, id: "has space" }] },
			{ ...policy, questions: [{ ...question, urgentWhen: { gte: 2 } }] },
			{
				...policy,
				questions: Array.from({ length: 33 }, (_, i) => ({
					...question,
					id: `q${i}`,
				})),
			},
			{ ...policy, version: 9 },
		]) {
			expect(AgentTurnTriagePolicyInputSchema.safeParse(bad).success).toBe(
				false,
			);
		}
	});

	it("restricts reply labels to the fixed vocabulary", () => {
		const ok = { status: "ok", label: "fan-out", p: 0.6, model: "m" };
		expect(LabelAgentReplyResultSchema.safeParse(ok).success).toBe(true);
		expect(
			LabelAgentReplyResultSchema.safeParse({ ...ok, label: "other" }).success,
		).toBe(false);
	});
});
