/**
 * Decision graph: typed links between Deck cards, decisions, owner
 * instructions, Work, Outputs, people, systems and credential metadata.
 *
 * Node ids are existing row ids. A credential node is metadata only; no value
 * ever enters this graph.
 */

import * as z from "zod";

export const DECISION_GRAPH_NODE_KINDS = [
	"deck_card",
	"decision",
	"owner_instruction",
	"work_item",
	"output",
	"person",
	"system",
	"credential",
	/** An agent that decided on its own (`agent:<actor slug>`). */
	"agent",
	/** A commit SHA cited as evidence. */
	"commit",
] as const;
export type DecisionGraphNodeKind = (typeof DECISION_GRAPH_NODE_KINDS)[number];

export const DECISION_GRAPH_EDGE_KINDS = [
	"card_from_work",
	"card_answers",
	"decided_by",
	"supersedes",
	"same_as",
	"blocks",
	"involves",
	"evidence",
	/** decision → the Work, Output or card it was about. */
	"about",
	/** decision → an earlier decision it builds on. */
	"depends_on",
] as const;
export type DecisionGraphEdgeKind = (typeof DECISION_GRAPH_EDGE_KINDS)[number];

/** Allowed endpoint kinds per edge kind (from → to). */
export const DECISION_GRAPH_EDGE_ENDPOINTS: Record<
	DecisionGraphEdgeKind,
	{
		from: readonly DecisionGraphNodeKind[];
		to: readonly DecisionGraphNodeKind[];
	}
> = {
	card_from_work: { from: ["deck_card"], to: ["work_item"] },
	card_answers: { from: ["deck_card"], to: ["decision"] },
	decided_by: {
		from: ["work_item", "deck_card", "decision"],
		to: ["decision", "owner_instruction", "agent"],
	},
	supersedes: {
		from: ["deck_card", "work_item", "decision"],
		to: ["deck_card", "work_item", "decision"],
	},
	same_as: { from: ["deck_card"], to: ["deck_card"] },
	blocks: { from: ["work_item", "deck_card"], to: ["work_item"] },
	involves: {
		from: ["work_item", "deck_card"],
		to: ["person", "system", "credential"],
	},
	evidence: {
		from: ["decision", "work_item"],
		to: ["output", "work_item", "commit"],
	},
	about: { from: ["decision"], to: ["work_item", "output", "deck_card"] },
	depends_on: { from: ["decision"], to: ["decision"] },
};

export const DECISION_GRAPH_MAX_HOPS = 4;

export const DecisionGraphNodeKindSchema = z.enum(DECISION_GRAPH_NODE_KINDS);
export const DecisionGraphEdgeKindSchema = z.enum(DECISION_GRAPH_EDGE_KINDS);

export const DecisionGraphNodeSchema = z.object({
	kind: DecisionGraphNodeKindSchema,
	id: z.string(),
});
export type DecisionGraphNode = z.infer<typeof DecisionGraphNodeSchema>;

export const DecisionGraphEdgeSchema = z.object({
	id: z.string(),
	kind: DecisionGraphEdgeKindSchema,
	from: DecisionGraphNodeSchema,
	to: DecisionGraphNodeSchema,
	/** Where the fact came from, e.g. `deck`, `approval`, `backfill`. */
	source: z.string(),
	confidence: z.number().min(0).max(1),
	evidenceRef: z.string().nullable(),
	/** Short plain-English label for the target, e.g. the instruction text. */
	note: z.string().nullable(),
	/** When the linked fact happened (ISO 8601). */
	occurredAt: z.string(),
	createdAt: z.string(),
});
export type DecisionGraphEdge = z.infer<typeof DecisionGraphEdgeSchema>;

export const DecisionGraphChainStepSchema = z.object({
	node: DecisionGraphNodeSchema,
	edge: DecisionGraphEdgeSchema,
	hop: z.number().int().min(1).max(DECISION_GRAPH_MAX_HOPS),
});
export type DecisionGraphChainStep = z.infer<
	typeof DecisionGraphChainStepSchema
>;

export const DecisionGraphLinkSchema = z.object({
	node: DecisionGraphNodeSchema,
	edge: DecisionGraphEdgeSchema,
});
export type DecisionGraphLink = z.infer<typeof DecisionGraphLinkSchema>;

export const DecisionContextSchema = z.object({
	cardId: z.string(),
	chain: z.array(DecisionGraphChainStepSchema),
	priorDecision: DecisionGraphLinkSchema.optional(),
	supersededBy: DecisionGraphLinkSchema.optional(),
	duplicates: z.array(z.string()),
	blocksCount: z.number().int().min(0),
	/**
	 * Items reachable over blocks edges (direct and indirect, bounded walk),
	 * from the graph database. Absent when the graph is not configured or
	 * did not answer; then blocksCount is the only signal.
	 */
	blocksReach: z.number().int().min(0).optional(),
});
export type DecisionContext = z.infer<typeof DecisionContextSchema>;

export const GetDecisionContextInputSchema = z.strictObject({
	cardId: z.string().min(1).max(200),
	maxHops: z
		.number()
		.int()
		.min(1)
		.max(DECISION_GRAPH_MAX_HOPS)
		.default(DECISION_GRAPH_MAX_HOPS),
});
export type GetDecisionContextInput = z.infer<
	typeof GetDecisionContextInputSchema
>;

export const GetDecisionContextOutputSchema = z.object({
	context: DecisionContextSchema,
	/** One plain-English line, e.g. "You decided this on 20 Oct → …". */
	explanation: z.string(),
});
export type GetDecisionContextOutput = z.infer<
	typeof GetDecisionContextOutputSchema
>;
