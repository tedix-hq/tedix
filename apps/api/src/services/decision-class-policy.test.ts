import { describe, expect, it } from "vite-plus/test";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { learnedClassDelivery } from "./decision-class-policy";
const decision = DecisionEnvelopeSchema.parse({
	version: 1,
	kind: "decision",
	classId: "filing",
	proposal: "File the receipt?",
	whyNow: "Ready",
	recommendation: "File",
	reversibility: "two_way",
	blastRadius: "One folder",
	confidence: 1,
	costOfWaiting: "None",
	reasoning: "Reversible",
	options: [
		{
			id: "yes",
			label: "Approve",
			intent: "approve",
			consequence: "Filed",
			cost: "None",
		},
		{
			id: "no",
			label: "Not this",
			intent: "reject",
			consequence: "Unchanged",
			cost: "None",
		},
	],
});
const events = Array.from({ length: 5 }, (_, i) => ({
	id: `${i}`,
	clientEventId: `decision-capture:${i}`,
	actorType: "user" as const,
	actorId: "fictional-user",
	targetId: `request-${i}`,
	metadata: {
		decisionClass: "filing",
		decisionChoice: "approve",
		feedbackSignal: "approve-as-is",
	},
	occurredAt: `2026-10-17T10:0${i}:00Z`,
}));
const input = {
	metadata: { decisionDeck: decision },
	policies: {
		filing: { autoApprove: true, unchangedThreshold: 5, auditSampleRate: 0.1 },
	},
	events,
	userId: "fictional-user",
	sample: 0.5,
};
describe("earned class delivery", () => {
	it("promotes after five distinct unchanged human approvals and keeps random audits", () => {
		expect(learnedClassDelivery(input)).toBe("auto");
		expect(learnedClassDelivery({ ...input, sample: 0.05 })).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				events: [...events.slice(0, 4), events[0]!],
			}),
		).toBe("review");
	});
	it("demotes immediately on rejection or correction", () => {
		for (const decisionChoice of ["reject", "change", "delegate"])
			expect(
				learnedClassDelivery({
					...input,
					events: [
						...events,
						{
							...events[0]!,
							id: "new",
							targetId: "new",
							occurredAt: "2026-10-18T10:00:00Z",
							metadata: {
								decisionClass: "filing",
								decisionChoice,
								feedbackSignal: "rejected",
							},
						},
					],
				}),
			).toBe("review");
	});
	it("never borrows another person's evidence or promotes protected, expired or unknown work", () => {
		expect(learnedClassDelivery({ ...input, userId: "other-person" })).toBe(
			"review",
		);
		expect(learnedClassDelivery({ ...input, policies: {} })).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				metadata: {
					decisionDeck: { ...decision, protectedEffects: ["production"] },
				},
			}),
		).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				metadata: { decisionDeck: { ...decision, reversibility: "unknown" } },
			}),
		).toBe("review");
	});
});
