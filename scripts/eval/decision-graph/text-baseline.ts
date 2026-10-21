// Frozen pre-graph sweep for reproducible evaluation; never used by production.
// Source: packages/api-contract/src/utils/deck-pipeline.ts at 11420939c40d6a304b20b13e552fa3be1b382c1b.
import type {
	DeckPipelineConfig,
	DeckLearnedRule,
} from "@tedix/api-contract/schemas/deck-pipeline";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { deckCardExpired } from "@tedix/api-contract/utils/deck-ask";
import {
	deckSourceKey,
	subjectSimilarity,
	type SweepCard,
	type SweepAction,
} from "@tedix/api-contract/utils/deck-pipeline";
export const TEXT_BASELINE_SHA = "11420939c40d6a304b20b13e552fa3be1b382c1b";

export function planTextBaseline(input: {
	cards: readonly SweepCard[];
	now: Date;
	config: DeckPipelineConfig["sweep"];
	rules: readonly DeckLearnedRule[];
	/** Recently answered cards; feed the "already decided" rule. */
	answered?: readonly { id: string; sourceKey: string; subject: string }[];
}): { actions: SweepAction[]; proposals: SweepAction[] } {
	const { cards, now, config } = input;
	const actions = new Map<string, SweepAction>();
	const proposals: SweepAction[] = [];
	const add = (action: SweepAction) => {
		if (!actions.has(action.cardId)) actions.set(action.cardId, action);
	};
	for (const card of cards) {
		const decision = DecisionEnvelopeSchema.safeParse(
			card.metadata.decisionDeck,
		).data;
		const agentCard = card.creatorType !== "user";
		if (
			agentCard &&
			deckCardExpired({ decision, request: { expiresAt: card.expiresAt } }, now)
		) {
			add({
				cardId: card.id,
				reason: "expired",
				cause: "expired",
				note: "The ask passed its expiry and can no longer be acted on.",
				evidenceRefs: [`work-interaction:${card.id}`],
			});
			continue;
		}
		if (card.protected) continue;
		if (
			card.workItemId &&
			(card.workItemDisposition === "completed" ||
				card.workItemDisposition === "cancelled")
		) {
			add({
				cardId: card.id,
				reason: "handled_elsewhere",
				cause: "handled",
				workItemId: card.workItemId,
				note: `Its Work Item is ${card.workItemDisposition}.`,
				evidenceRefs: [`/work/items/${card.workItemId}`],
			});
			continue;
		}
	}

	// Newer supersedes older on an exact key: same agent, same Work Item (or
	// none; a learned duplicate rule drops this), same ask kind, same subject.
	const live = cards.filter((card) => !actions.has(card.id));
	const newestFirst = [...live].sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
	const duplicateRuleSources = new Set(
		input.rules
			.filter((rule) => rule.reason === "duplicate")
			.map((rule) => rule.sourceKey),
	);
	for (const [index, older] of newestFirst.entries()) {
		if (older.creatorType === "user" || actions.has(older.id)) continue;
		const source = deckSourceKey(older);
		const learned = duplicateRuleSources.has(source);
		const keeper = newestFirst
			.slice(0, index)
			.find(
				(newer) =>
					!actions.has(newer.id) &&
					newer.creatorType === older.creatorType &&
					newer.creatorId === older.creatorId &&
					newer.askKind === older.askKind &&
					(learned || (newer.workItemId ?? "") === (older.workItemId ?? "")) &&
					(!older.protected || newer.protected) &&
					subjectSimilarity(newer.subject, older.subject) >=
						config.duplicateSimilarity,
			);
		if (keeper)
			add({
				cardId: older.id,
				reason: "duplicate",
				cause: "duplicate",
				successorId: keeper.id,
				workItemId: keeper.workItemId ?? undefined,
				note: `Superseded by the newer card “${keeper.subject.slice(0, 120)}”.`,
				evidenceRefs: [`work-interaction:${keeper.id}`],
			});
	}

	// Learned rules never touch a protected ask; at most they lower it.
	for (const rule of input.rules) {
		for (const card of cards) {
			if (actions.has(card.id) || card.protected) continue;
			if (deckSourceKey(card) !== rule.sourceKey) continue;
			const base = {
				cardId: card.id,
				cause: "rule" as const,
				ruleId: rule.id,
				evidenceRefs: [`deck-rule:${rule.id}`],
			};
			if (rule.reason === "not_for_me" || rule.reason === "agent_could_do")
				add({ ...base, reason: "no_longer_relevant", note: rule.sentence });
			else if (rule.reason === "already_decided") {
				// A fuzzy match only proposes; settling needs a cited decision record.
				const match = input.answered?.find(
					(answered) =>
						answered.id !== card.id &&
						answered.sourceKey === rule.sourceKey &&
						subjectSimilarity(answered.subject, card.subject) >=
							config.duplicateSimilarity,
				);
				if (match)
					proposals.push({
						cardId: card.id,
						reason: "handled_elsewhere",
						cause: "rule",
						ruleId: rule.id,
						note: rule.sentence,
						evidenceRefs: [
							`deck-rule:${rule.id}`,
							`work-interaction:${match.id}`,
						],
					});
			}
			// "expired" rules act at create time: the card's due time becomes its expiry.
		}
	}
	return {
		actions: [...actions.values()].slice(0, config.maxRetirementsPerRun),
		proposals,
	};
}
