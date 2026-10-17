import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "@tedix/api-contract/schemas/os-decision-deck";

export const DECISION_DECK_EXAMPLES: DecisionEnvelope[] = [
	{
		kind: "outbound",
		classId: "supplier-replies",
		proposal: "Send Morgan the revised delivery date?",
		recommendation: "Offer Friday, without promising a discount.",
		protectedEffects: ["message"],
	},
	{
		kind: "proposal",
		classId: "filing-corrections",
		proposal: "File this request under Supplier review?",
		recommendation: "Keep the original request and link it to Supplier review.",
		tasteOrStrategy: true,
		reversibility: "two_way",
	},
	{
		kind: "question",
		classId: "brief-questions",
		proposal: "Which outcome matters most for this project?",
		recommendation:
			"Prioritize a smaller release with a clear customer benefit.",
		tasteOrStrategy: true,
	},
	{
		kind: "approval",
		classId: "production-releases",
		proposal: "Release the change after the staged check?",
		recommendation: "Use a staged release with a rollback checkpoint.",
		protectedEffects: ["production"],
	},
	{
		kind: "decision",
		classId: "social-tone",
		proposal: "Use a short customer story for the next post?",
		recommendation: "Use one concrete example and omit unsupported claims.",
		tasteOrStrategy: true,
		reversibility: "two_way",
	},
	{
		kind: "adr",
		classId: "schema-migrations",
		proposal: "Backfill before removing the old column?",
		recommendation:
			"Add the new field, backfill and verify readers before removing the old field.",
		protectedEffects: ["data", "contract"],
	},
].map((example) =>
	DecisionEnvelopeSchema.parse({
		version: 1,
		whyNow: "The next step needs this choice; the proposed action has not run.",
		reversibility: "one_way",
		blastRadius: "One fictional Acme project; this is a practice card.",
		confidence: 0.8,
		costOfWaiting: "The next step waits; no existing service is interrupted.",
		reasoning:
			"Prefer a bounded next step with evidence. The alternative is to wait for more context.",
		lessons: [],
		options: [
			{
				id: "approve",
				label: "Approve",
				intent: "approve",
				consequence: "Record agreement with the recommendation.",
				cost: "The proposed work still needs to be carried out.",
			},
			{
				id: "reject",
				label: "Not this",
				intent: "reject",
				consequence: "Ask for a different recommendation.",
				cost: "Another review cycle.",
			},
			{
				id: "delegate",
				label: "Decide for me",
				intent: "delegate",
				consequence:
					"Let the responsible tedi choose within its existing authority.",
				cost: "Review the resulting receipt.",
			},
			{
				id: "later",
				label: "Later",
				intent: "later",
				consequence: "Leave the decision open.",
				cost: "The next step waits.",
			},
		],
		...example,
	}),
);
