import type { DbClient } from "@tedix/db/client";
import {
	countBlocked,
	findPriorDecision,
	getDecisionContext,
} from "@tedix/db/queries/decision-graph";
import type { DecisionContext } from "@tedix/api-contract/schemas/decision-graph";

/** A bounded, read-only snapshot; graph writers and backfill own edge mutations. */
export async function deckQualificationGraph(
	db: DbClient,
	orgId: string,
	cards: readonly { id: string; workItemId?: string | null }[],
) {
	const facts = new Map<string, DecisionContext>();
	for (let offset = 0; offset < cards.length; offset += 4) {
		await Promise.all(
			cards.slice(offset, offset + 4).map(async (card) => {
				const context = await getDecisionContext(db, orgId, card.id, {
					maxHops: 4,
				});
				// Canonical Work FKs cover edge backfill lag; answered duplicates carry the same decision.
				if (card.workItemId || context.duplicates.length) {
					context.priorDecision =
						(await findPriorDecision(db, orgId, [
							card.id,
							...(card.workItemId ? [card.workItemId] : []),
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
	return facts;
}
