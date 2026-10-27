import { expect, it } from "vite-plus/test";
import { isFactsChangedReview } from "./deck-action-boundary";

const review = {
	kind: "question",
	creatorType: "system",
	creatorId: "tedix",
	metadata: {
		replacesDecisionId: "original",
		decisionDeck: {
			version: 1,
			kind: "question",
			classId: "decision-facts-changed",
			proposal: "Review updated facts for: Delete the database?",
			whyNow: "Facts changed",
			recommendation: "Request a new proposal",
			reversibility: "two_way",
			protectedEffects: [],
			blastRadius: "Review only",
			confidence: null,
			costOfWaiting: "No action",
			reasoning: "Earlier facts changed",
			options: [
				{
					id: "review",
					label: "Reviewed",
					intent: "approve",
					consequence: "Record review",
					cost: "No action approved",
				},
				{
					id: "dismiss",
					label: "Not needed",
					intent: "reject",
					consequence: "Close review",
					cost: "Earlier action blocked",
				},
			],
		},
	},
};
it("identifies an effect-free system review independently of the original action's text", () => {
	expect(isFactsChangedReview(review)).toBe(true);
});
it.each([
	{ approvalOperation: "approve" },
	{ protected: true },
	{ localImport: {} },
	{ protectedEffects: ["money"] },
	{ reversibility: "one_way" },
	{ riskLevel: "critical" },
	{ cardPresentation: { effectStatus: "unknown" } },
	{ replacesDecisionId: null },
	{ decisionDeck: {} },
	{
		decisionDeck: {
			...review.metadata.decisionDeck,
			protectedEffects: ["message"],
		},
	},
	{
		decisionDeck: {
			...review.metadata.decisionDeck,
			options: [
				{
					...review.metadata.decisionDeck.options[0],
					effect: {
						kind: "publish_docs",
						siteId: "11111111-1111-4111-8111-111111111111",
						buildId: "11111111-1111-4111-8111-111111111111",
					},
				},
				review.metadata.decisionDeck.options[1],
			],
		},
	},
])("rejects reviews carrying other authority: %j", (metadata) => {
	expect(
		isFactsChangedReview({
			...review,
			metadata: { ...review.metadata, ...metadata },
		}),
	).toBe(false);
});
it("does not treat an agent-authored class label as a system follow-up", () => {
	expect(
		isFactsChangedReview({ ...review, creatorType: "external_agent" }),
	).toBe(false);
});
