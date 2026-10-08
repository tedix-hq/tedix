import { describe, expect, it } from "vite-plus/test";
import {
	AgentTurnTriagePolicyInputSchema,
	AgentTurnTriagePolicySchema,
	LabelAgentReplyResultSchema,
	ProposeAgentReplyDraftInputSchema,
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
	it("exposes exactly the triage and reply-draft procedures", () => {
		expect(Object.keys(agentTurnTriageContract).sort()).toEqual([
			"getLessonEffectiveness",
			"getPolicy",
			"getReplyDraftAcceptance",
			"getReplyDraftLeaderboard",
			"getSessionLessons",
			"importSessionDecisions",
			"labelReply",
			"listLessons",
			"mineSessionLessons",
			"proposeReplyDraft",
			"requestReplyDraft",
			"triage",
			"updatePolicy",
		]);
	});

	it("defaults drafting off and eligibility to 90% over 50 drafts", () => {
		const stored = AgentTurnTriagePolicySchema.parse({
			enabled: true,
			model: "@cf/cloudflare/clef-flash",
			version: 3,
			questions: [question],
		});
		expect(stored.drafting).toEqual({
			enabled: false,
			examples: { enabled: true, count: 5 },
		});
		// A stored drafting block without examples gets the defaults.
		expect(
			AgentTurnTriagePolicySchema.parse({
				enabled: true,
				model: "@cf/cloudflare/clef-flash",
				version: 3,
				questions: [question],
				drafting: { enabled: true },
			}).drafting.examples,
		).toEqual({ enabled: true, count: 5 });
		expect(stored.eligibility).toEqual({ minRate: 0.9, minDrafts: 50 });
		expect(stored.autoSend).toEqual({ enabled: false, maxConsecutive: 3 });
		const base = {
			enabled: true,
			model: "@cf/cloudflare/clef-flash",
			questions: [question],
		};
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				drafting: { enabled: true, tediId: "not-a-uuid" },
			}).success,
		).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				drafting: { enabled: true, examples: { enabled: true, count: 0 } },
			}).success,
		).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				eligibility: { minRate: 1.2, minDrafts: 50 },
			}).success,
		).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				drafting: { enabled: true, autoSend: true },
			}).success,
		).toBe(false);
		for (const maxConsecutive of [-1, 11, 1.5])
			expect(
				AgentTurnTriagePolicyInputSchema.safeParse({
					...base,
					autoSend: { enabled: true, maxConsecutive },
				}).success,
			).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				autoSend: { enabled: true, maxConsecutive: 10 },
			}).success,
		).toBe(true);
	});

	it("validates the delivery gate and keeps it optional", () => {
		const base = {
			enabled: true,
			model: "@cf/cloudflare/clef-flash",
			questions: [question],
		};
		expect(
			AgentTurnTriagePolicyInputSchema.parse(base).deliveryGate,
		).toBeUndefined();
		const gate = (autoWhen: unknown, id = "needs_human") => ({
			...base,
			deliveryGate: {
				model: "@cf/cloudflare/clef-flash",
				questions: [{ id, instructions: "Needs the human?", autoWhen }],
			},
		});
		for (const autoWhen of [{ gte: 0.8 }, { lte: 0.3 }])
			expect(
				AgentTurnTriagePolicyInputSchema.safeParse(gate(autoWhen)).success,
			).toBe(true);
		for (const autoWhen of [{}, { gte: 1.1 }, { gte: 0.8, lte: 0.3 }])
			expect(
				AgentTurnTriagePolicyInputSchema.safeParse(gate(autoWhen)).success,
			).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse(gate({ lte: 0.3 }, "bad id"))
				.success,
		).toBe(false);
		expect(
			AgentTurnTriagePolicyInputSchema.safeParse({
				...base,
				deliveryGate: { model: "@cf/cloudflare/clef-flash", questions: [] },
			}).success,
		).toBe(false);
	});

	it("bounds reply drafts", () => {
		const draft = {
			requestId: "3f1b5d4e-8f6c-4a42-9b8e-1c2d3e4f5a6b",
			body: "x".repeat(6_000),
			rationale: "r".repeat(2_000),
			reversible: true,
		};
		expect(ProposeAgentReplyDraftInputSchema.safeParse(draft).success).toBe(
			true,
		);
		// The drafter must assert reversibility either way.
		const { reversible: _reversible, ...unasserted } = draft;
		expect(
			ProposeAgentReplyDraftInputSchema.safeParse(unasserted).success,
		).toBe(false);
		expect(
			ProposeAgentReplyDraftInputSchema.safeParse({
				...draft,
				body: "x".repeat(6_001),
			}).success,
		).toBe(false);
		expect(
			ProposeAgentReplyDraftInputSchema.safeParse({
				...draft,
				rationale: "r".repeat(2_001),
			}).success,
		).toBe(false);
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
