import { DeckPipelineConfigSchema } from "@tedix/api-contract/schemas/deck-pipeline";
import { DecisionContextSchema } from "@tedix/api-contract/schemas/decision-graph";
import { classifyDeckAsk } from "@tedix/api-contract/utils/deck-qualification";
import { planDeckSweep } from "@tedix/api-contract/utils/deck-pipeline";
import { compareDecisionFreshness } from "@tedix/api-contract/utils/deck-projection";
import { deckAsk } from "@tedix/api-contract/utils/deck-ask";
import { compareDeckOrders } from "@tedix/api-contract/utils/deck-rule-rank";
import { planTextBaseline, TEXT_BASELINE_SHA } from "./text-baseline";

/** Calls the landed sweep, without persisting its plan. */
export function productionComparison(
	cards,
	contexts,
	now,
	rawConfig,
	timeZone,
	answered = [],
) {
	const config = DeckPipelineConfigSchema.parse(rawConfig);
	const qualified = cards.map((card) => {
		const graph = contexts[card.id]
			? DecisionContextSchema.parse(contexts[card.id])
			: undefined;
		if (graph && graph.cardId !== card.id)
			throw new Error("Context/card mismatch");
		// A historical card's own response is an outcome, not a repeated earlier ask.
		if (
			graph?.priorDecision?.edge.kind === "card_answers" &&
			graph.priorDecision.edge.from.id === card.id
		)
			delete graph.priorDecision;
		return { ...card, ...classifyDeckAsk(card, config.qualification), graph };
	});
	const actions = planDeckSweep({
		cards: qualified,
		now,
		timeZone,
		config: config.sweep,
		qualification: config.qualification,
		rules: config.rules,
	}).actions;
	const text = planTextBaseline({
		cards,
		now,
		config: config.sweep,
		rules: config.rules,
		answered,
	});
	const candidates = actions.flatMap((action) => {
		const card = qualified.find((c) => c.id === action.cardId);
		const prior = card?.graph?.priorDecision;
		const rule =
			action.reason === "already_decided"
				? "already_decided"
				: ["duplicate", "superseded"].includes(action.reason)
					? "duplicate"
					: action.reason === "expired" && action.note.startsWith("Withdrawn:")
						? "stale"
						: null;
		return rule
			? [
					{
						cardId: action.cardId,
						rule,
						linkedId:
							action.successorId ??
							prior?.node.id ??
							card.workItemId ??
							card.id,
						evidence: action.evidenceRefs[0] ?? null,
					},
				]
			: [];
	});
	const removed = new Set([...actions, ...text.actions].map((a) => a.cardId));
	const survivors = qualified
		.filter((c) => !removed.has(c.id) && c.graph)
		.map((c) => ({
			...c,
			...deckAsk(
				{ ...c, request: c, workItem: { disposition: c.workItemDisposition } },
				now,
				{ timeZone, qualification: config.qualification },
			),
			blocksCount: 0,
		}))
		.filter(
			(c) =>
				c.actionable &&
				!(
					config.qualification.alreadyDecided &&
					c.graph.priorDecision &&
					c.responseKind !== "task"
				) &&
				!(config.qualification.graphDuplicates && c.graph.supersededBy),
		);
	const before = [...survivors]
		.sort((a, b) => compareDecisionFreshness(a, b, now, timeZone))
		.map((c) => c.id);
	const after = [...survivors]
		.map((c) => ({
			...c,
			blocksCount: config.qualification.rankBlocked ? c.graph.blocksCount : 0,
		}))
		.sort((a, b) => compareDecisionFreshness(a, b, now, timeZone))
		.map((c) => c.id);
	return {
		textBaselineSha: TEXT_BASELINE_SHA,
		text,
		actions,
		candidates,
		ranking: {
			...compareDeckOrders(before, after),
			moved: before.filter((id, i) => after[i] !== id).length,
			before,
			after,
		},
	};
}
