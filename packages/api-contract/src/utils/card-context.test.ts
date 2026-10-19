import { expect, it } from "vite-plus/test";
import type { DeckCard } from "../schemas/attention";
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
import { canAskCardContext, nextContextSample } from "./card-context";

const decision = DecisionEnvelopeSchema.parse({
	version: 1,
	kind: "proposal",
	classId: "relationship.followup",
	proposal: "Save a follow-up task?",
	whyNow: "You met yesterday.",
	recommendation: "Save the task while the conversation is fresh.",
	reversibility: "two_way",
	blastRadius: "Your tasks only.",
	confidence: null,
	costOfWaiting: "You may forget the conversation.",
	reasoning: "The source is your meeting note.",
	options: [
		{
			id: "yes",
			label: "Save task",
			intent: "approve",
			consequence: "Saves a task; sends nothing.",
			cost: "No message is sent.",
		},
		{
			id: "no",
			label: "Skip task",
			intent: "reject",
			consequence: "No task is saved.",
			cost: "The follow-up stays open.",
		},
	],
});
function card(id: string): DeckCard {
	return {
		id,
		kind: "proposal",
		label: decision.proposal,
		project: "fictional",
		urgency: "later",
		source: "/work",
		requestedAt: "2026-10-19T00:00:00Z",
		dueAt: null,
		score: 0,
		decision,
	};
}

it("offers at most one context prompt per five distinct cards across reloads", () => {
	let state = {
		count: 0,
		seen: [] as string[],
		sampled: {} as Record<string, string>,
	};
	for (let i = 1; i <= 50; i++) {
		const current = card(String(i));
		state = nextContextSample(JSON.parse(JSON.stringify(state)), current);
		expect(nextContextSample(state, current)).toBe(state);
		expect(Object.keys(state.sampled).length).toBeLessThanOrEqual(
			Math.floor(i / 5),
		);
	}
	expect(Object.keys(state.sampled)).toHaveLength(10);
});
it("never samples protected, critical, irreversible or unclassified cards", () => {
	const base = card("five");
	for (const unsafe of [
		{ ...base, kind: "approval" },
		{ ...base, decision: null },
		{
			...base,
			decision: { ...decision, protectedEffects: ["money" as const] },
		},
		{ ...base, decision: { ...decision, reversibility: "one_way" as const } },
		{ ...base, decision: { ...decision, classId: "approval.credentials" } },
		{ ...base, label: "Replace the Firecrawl key for the radar?" },
		{
			...base,
			decision: {
				...decision,
				options: decision.options.map((option) => ({
					...option,
					effect: {
						kind: "publish_support" as const,
						ticketId: "10000000-0000-4000-8000-000000000001",
						expectedVersion: 1,
					},
				})),
			},
		},
	]) {
		expect(canAskCardContext(unsafe)).toBe(false);
		expect(
			nextContextSample({ count: 4, seen: [], sampled: {} }, unsafe).sampled,
		).toEqual({});
	}
});
