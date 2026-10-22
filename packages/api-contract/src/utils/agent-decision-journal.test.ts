import { describe, expect, it } from "vite-plus/test";
import {
	AgentDecisionJournalConfigSchema,
	RecordAgentDecisionInputSchema,
	type AgentDecision,
} from "../schemas/agent-decisions";
import {
	AGENT_DECISION_OUTCOME_SCHEMA,
	AGENT_DECISION_REVIEW_MAX_WORDS,
	AGENT_DECISION_SCHEMA,
	agentDecisionAskable,
	agentDecisionClassId,
	agentDecisionEnvelope,
	agentDecisionFeedItems,
	agentDecisionNeedsPerson,
	agentDecisionReviewText,
	agentDecisionsFromEvents,
	agentDecisionStandings,
	agentDisplayName,
} from "./agent-decision-journal";

const config = AgentDecisionJournalConfigSchema.parse({});
const input = RecordAgentDecisionInputSchema.parse({
	agentSession: "claude-code:0d9b2c1e-1111-4222-8333-444455556666",
	agentName: "Lead",
	decisionClass: "lane.pause",
	question: "Pause the slow review lane?",
	options: [
		{ id: "pause", label: "Pause it" },
		{ id: "keep", label: "Keep it running" },
	],
	chosen: "pause",
	reason: "It holds two slots and produced nothing for an hour.",
	reversibility: "two_way",
	confidence: 0.8,
});

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
	return {
		id: crypto.randomUUID(),
		classId: "agent:lead:lane.pause",
		decisionClass: "lane.pause",
		agent: { name: "Lead", harness: "claude-code", session: "claude-code:x" },
		question: "Pause the slow review lane?",
		chosen: { id: "pause", label: "Pause it" },
		options: [],
		reason: "Idle for an hour.",
		reversibility: "two_way",
		protectedEffects: [],
		confidence: 0.8,
		needsPerson: false,
		askable: false,
		workItemId: null,
		outputId: null,
		commitShas: [],
		priorDecisionId: null,
		occurredAt: "2026-10-22T02:00:00.000Z",
		outcome: null,
		...overrides,
	};
}

describe("agent decision journal rules", () => {
	it("names the learning class after the agent and decision class", () => {
		expect(agentDisplayName(input)).toBe("Lead");
		expect(agentDisplayName({ agentSession: "codex:abc" })).toBe("Codex");
		expect(agentDecisionClassId("Lead", "lane.pause")).toBe(
			"agent:lead:lane.pause",
		);
	});

	it("builds a display-only envelope whose chosen option is the approve intent", () => {
		const envelope = agentDecisionEnvelope(input, "agent:lead:lane.pause");
		expect(envelope.recommendation).toBe("Chose: Pause it");
		expect(
			envelope.options.filter((option) => option.intent === "approve"),
		).toEqual([expect.objectContaining({ id: "pause" })]);
		expect(envelope.options.every((option) => !option.effect)).toBe(true);
	});

	it("rejects a chosen option that was not considered", () => {
		expect(
			RecordAgentDecisionInputSchema.safeParse({ ...input, chosen: "other" })
				.success,
		).toBe(false);
	});

	it("asks a person about protected, hard-to-undo or unsure decisions", () => {
		expect(agentDecisionNeedsPerson(input)).toBe(false);
		expect(
			agentDecisionNeedsPerson({ ...input, protectedEffects: ["production"] }),
		).toBe(true);
		expect(
			agentDecisionNeedsPerson({ ...input, reversibility: "one_way" }),
		).toBe(true);
		expect(
			agentDecisionAskable({ needsPerson: false, confidence: 0.4 }, config),
		).toBe(true);
		expect(
			agentDecisionAskable({ needsPerson: false, confidence: null }, config),
		).toBe(false);
	});

	it("reads decisions with their latest outcome and skips malformed rows", () => {
		const id = crypto.randomUUID();
		const decisions = agentDecisionsFromEvents(
			[
				{
					id,
					eventKind: "decided",
					targetId: null,
					occurredAt: "2026-10-22T01:00:00.000Z",
					metadata: {
						schema: AGENT_DECISION_SCHEMA,
						classId: "agent:lead:lane.pause",
						decisionClass: "lane.pause",
						agent: { name: "Lead", harness: "claude-code", session: "s" },
						question: "Pause?",
						options: input.options,
						chosen: "pause",
						reason: "Idle",
						reversibility: "one_way",
						needsPerson: true,
						confidence: 0.9,
					},
				},
				{
					id: crypto.randomUUID(),
					eventKind: "decided",
					targetId: null,
					occurredAt: "2026-10-22T01:00:00.000Z",
					metadata: { schema: AGENT_DECISION_SCHEMA },
				},
				{
					id: crypto.randomUUID(),
					eventKind: "accepted",
					targetId: id,
					occurredAt: "2026-10-22T03:00:00.000Z",
					metadata: {
						schema: AGENT_DECISION_OUTCOME_SCHEMA,
						outcome: "worked",
						by: "agent",
						evidence: "Queue drained",
					},
				},
				{
					id: crypto.randomUUID(),
					eventKind: "undone",
					targetId: id,
					occurredAt: "2026-10-22T05:00:00.000Z",
					metadata: {
						schema: AGENT_DECISION_OUTCOME_SCHEMA,
						outcome: "reverted",
						by: "person",
						evidence: "Restarted by hand",
					},
				},
			],
			config,
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			id,
			askable: true,
			chosen: { id: "pause", label: "Pause it" },
			outcome: { outcome: "reverted", by: "person" },
		});
	});

	it("earns a class only after enough outcomes that worked since the last correction", () => {
		const worked = (at: string) =>
			decision({
				outcome: { outcome: "worked", by: "agent", evidence: "ok", at },
			});
		const five = ["01", "02", "03", "04", "05"].map((h) =>
			worked(`2026-10-22T${h}:00:00.000Z`),
		);
		expect(agentDecisionStandings(five, config)[0]).toMatchObject({
			status: "earned",
			streak: 5,
			worked: 5,
		});
		const corrected = [
			...five,
			decision({
				outcome: {
					outcome: "reverted",
					by: "person",
					evidence: "wrong lane",
					at: "2026-10-22T06:00:00.000Z",
				},
			}),
		];
		expect(agentDecisionStandings(corrected, config)[0]).toMatchObject({
			status: "corrected",
			streak: 0,
			corrections: 1,
		});
		expect(agentDecisionStandings([decision()], config)[0]?.status).toBe(
			"learning",
		);
	});

	it("uses the agent display name and singular grammar in class standings", () => {
		const row = decision({
			classId: "agent:review-lead:review.routing",
			decisionClass: "review.routing",
			agent: {
				name: "Review Lead",
				harness: "codex",
				session: "codex:fixture",
			},
		});
		expect(agentDecisionStandings([row], { earnedAfter: 1 })[0]?.sentence).toBe(
			"Review Lead — review.routing: 0 of 1 decision has an outcome; 1 more that works earns trust.",
		);
		expect(
			agentDecisionStandings([row, row], { earnedAfter: 2 })[0]?.sentence,
		).toBe(
			"Review Lead — review.routing: 0 of 2 decisions have an outcome; 2 more that work earn trust.",
		);
		const worked = {
			...row,
			outcome: {
				outcome: "worked" as const,
				by: "agent" as const,
				evidence: "ok",
				at: "2026-10-22T03:00:00.000Z",
			},
		};
		expect(
			agentDecisionStandings([worked], { earnedAfter: 1 })[0]?.sentence,
		).toBe("Review Lead — review.routing: 1 decision in a row worked.");
		expect(
			agentDecisionStandings(
				[{ ...worked, outcome: { ...worked.outcome, outcome: "reverted" } }],
				config,
			)[0]?.sentence,
		).toBe("Review Lead — review.routing: the latest decision was undone.");
	});

	it("keeps the review to at most 60 words, grouped by class", () => {
		const many = [
			...Array.from({ length: 6 }, () => decision()),
			...Array.from({ length: 4 }, () =>
				decision({
					decisionClass: "deploy.canary",
					classId: "agent:lead:deploy.canary",
					question:
						"Run the canary on the new storage path before the morning traffic arrives in every region we serve?",
					chosen: { id: "run", label: "Run the canary now" },
					askable: true,
					needsPerson: true,
				}),
			),
		];
		const text = agentDecisionReviewText(many);
		expect(text.split(/\s+/).length).toBeLessThanOrEqual(
			AGENT_DECISION_REVIEW_MAX_WORDS,
		);
		expect(text).toContain("Lead made 10 decisions");
		expect(text).toContain("6 lane.pause, 4 deploy.canary");
		expect(agentDecisionReviewText([decision()])).toContain("None needs you.");
	});

	it("shows askable decisions one by one and digests the rest, never as asks", () => {
		const items = agentDecisionFeedItems([
			decision({
				askable: true,
				needsPerson: true,
				workItemId: crypto.randomUUID(),
			}),
			decision(),
			decision({ decisionClass: "fix.choice" }),
		]);
		expect(items).toHaveLength(2);
		expect(
			items.every((item) => !item.needsAction && item.kind === "result"),
		).toBe(true);
		expect(items[0]?.sentence).toMatch(/^Decided by Lead: Pause it/);
		expect(items[0]?.importance).toBe("high");
		expect(items[1]).toMatchObject({
			importance: "low",
			sentence: expect.stringContaining("2 routine decisions"),
		});
	});
});
