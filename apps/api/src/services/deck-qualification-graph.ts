import type { DbClient } from "@tedix/db/client";
import {
	countBlocked,
	findPriorDecision,
	getDecisionContext,
} from "@tedix/db/queries/decision-graph";
import type { DecisionContext } from "@tedix/api-contract/schemas/decision-graph";
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
	const facts = new Map<string, DecisionContext>();
	for (let offset = 0; offset < cards.length; offset += 4) {
		await Promise.all(
			cards.slice(offset, offset + 4).map(async (card) => {
				const context = await getDecisionContext(db, orgId, card.id, {
					maxHops: 4,
				});
				// An answered same_as card carries the same decision; a shared Work does not.
				if (context.duplicates.length) {
					context.priorDecision =
						(await findPriorDecision(db, orgId, [
							card.id,
							...context.duplicates,
						])) ?? context.priorDecision;
				}
				if (card.workItemId)
					context.blocksCount = Math.max(
						context.blocksCount,
						await countBlocked(db, orgId, card.workItemId),
					);
				facts.set(card.id, context);
			}),
		);
	}
	await enrichDecisionContexts(graph, orgId, cards, facts);
	return facts;
}
