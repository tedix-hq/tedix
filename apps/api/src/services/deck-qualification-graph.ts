import type { DbClient } from "@tedix/db/client";
import { getDeckDecisionContexts } from "@tedix/db/queries/decision-graph";
import {
	type DecisionGraphReader,
	enrichDecisionContexts,
} from "./decision-graph-reads";

/**
 * A bounded, read-only snapshot; graph writers and backfill own edge
 * mutations. D1 answers first; a configured graph reader then adds the
 * blocks reach score and duplicate communities.
 */
export async function deckQualificationGraph(
	db: DbClient,
	orgId: string,
	cards: readonly { id: string; workItemId?: string | null }[],
	graph: DecisionGraphReader | null = null,
) {
	const facts = await getDeckDecisionContexts(db, orgId, cards);
	await enrichDecisionContexts(graph, orgId, cards, facts);
	return facts;
}
