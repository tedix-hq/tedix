import {
	GetDecisionContextOutputSchema,
	type DecisionGraphChainStep,
	type DecisionGraphNode,
} from "@tedix/api-contract/schemas/decision-graph";
import type { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import type { infer as Infer } from "zod";

export const GITHUB_CARD_ID = "d5000000-0000-4000-8000-000000000001";
const card: DecisionGraphNode = { kind: "deck_card", id: GITHUB_CARD_ID };
const work: DecisionGraphNode = {
	kind: "work_item",
	id: "d5000000-0000-4000-8000-000000000002",
};
const at = "2026-10-20T15:30:00.000Z";

function step(
	id: string,
	kind: DecisionGraphChainStep["edge"]["kind"],
	from: DecisionGraphNode,
	node: DecisionGraphNode,
	note: string,
	hop: number,
): DecisionGraphChainStep {
	return {
		node,
		hop,
		edge: {
			id,
			kind,
			from,
			to: node,
			note,
			source: "fixture",
			confidence: 1,
			evidenceRef: null,
			occurredAt: at,
			createdAt: at,
		},
	};
}

const instruction = step(
	"instruction",
	"decided_by",
	work,
	{ kind: "owner_instruction", id: "rotate-leftover-credentials" },
	"Rotate leftover credentials",
	2,
);
export const GITHUB_DECISION_CONTEXT = GetDecisionContextOutputSchema.parse({
	context: {
		cardId: GITHUB_CARD_ID,
		chain: [
			step("source", "card_from_work", card, work, "Audit GitHub access", 1),
			instruction,
			step(
				"audit",
				"evidence",
				work,
				{ kind: "output", id: "d5000000-0000-4000-8000-000000000003" },
				"Access audit complete",
				2,
			),
			step(
				"system",
				"involves",
				card,
				{ kind: "system", id: "github" },
				"GitHub",
				1,
			),
			step(
				"credential",
				"involves",
				work,
				{ kind: "credential", id: "old-deploy-key" },
				"Old deploy key",
				2,
			),
		],
		priorDecision: { node: instruction.node, edge: instruction.edge },
		duplicates: [],
		blocksCount: 2,
	},
	explanation:
		'You decided this on 20 Oct: "Rotate leftover credentials" → from Work "Audit GitHub access" → Access audit complete → involves GitHub, Old deploy key → 2 items wait on this',
});

export const GITHUB_CARD: Infer<typeof WorkInteractionInboxRowSchema> = {
	request: {
		id: GITHUB_CARD_ID,
		orgId: "d5000000-0000-4000-8000-000000000004",
		workItemId: work.id,
		caseId: null,
		projectId: null,
		creatorType: "user",
		creatorId: "fictional-robin",
		creatorSessionId: null,
		requestedFromType: "user",
		requestedFromId: "fictional-morgan",
		kind: "question",
		state: "open",
		subject: "Review the GitHub access audit?",
		prompt: "The audit is complete. Review the remaining access changes.",
		metadata: {},
		version: 1,
		requestedAt: at,
		dueAt: null,
		expiresAt: null,
		resolvedAt: null,
	},
	effectiveState: "open",
	canRespond: true,
	canCancel: false,
	workItem: null,
	responseCount: 0,
};

export function decisionGraphFixture(cardId: string) {
	return cardId === GITHUB_CARD_ID
		? GITHUB_DECISION_CONTEXT
		: GetDecisionContextOutputSchema.parse({
				context: { cardId, chain: [], duplicates: [], blocksCount: 0 },
				explanation: "No earlier decision or linked Work found.",
			});
}
