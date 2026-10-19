import policy from "../assets/card-context.v1.json";
import type { DeckCard } from "../schemas/attention";
import { classifyDeckCard } from "../schemas/os-decision-deck";
import { credentialCard } from "./card-secrets";

export type ContextChip = keyof typeof policy.chips;

/** Missing risk information is not evidence that a card is safe to sample. */
export function canAskCardContext(card: DeckCard) {
	const decision = card.decision;
	if (
		!decision ||
		decision.reversibility !== "two_way" ||
		decision.protectedEffects.length ||
		card.interaction?.request.metadata.secureAction ||
		credentialCard(
			`${card.label} ${card.interaction?.request.prompt ?? ""}`,
			card.interaction?.request.metadata,
		) ||
		decision.options.some(
			(option) =>
				option.effect && !policy.sampleableEffects.includes(option.effect.kind),
		) ||
		["approval", "outbound"].includes(card.kind)
	)
		return false;
	return (
		classifyDeckCard({
			kind: card.kind,
			classId: decision.classId,
			needsPerson: true,
			risk: String(card.interaction?.request.metadata.riskLevel ?? ""),
			action: card.label,
		}).reason !== "critical"
	);
}

/** A strict interval rather than random sampling: no refresh can increase the rate. */
export function nextContextSample(
	state: { count: number; seen: string[]; sampled: Record<string, string> },
	card: DeckCard,
) {
	if (state.seen.includes(card.id)) return state;
	const count = state.count + 1;
	return {
		...state,
		count,
		seen: [...state.seen, card.id],
		sampled:
			count % policy.sampleEvery === 0 && canAskCardContext(card)
				? { ...state.sampled, [card.id]: card.decision!.classId }
				: state.sampled,
	};
}
