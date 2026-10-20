import type { DeckCard } from "../schemas/attention";
import {
	classifyDeckCard,
	type DeckRoutingPolicy,
} from "../schemas/os-decision-deck";
import { humanReservedActionClasses } from "./approval-policy";
import type {
	DeckCuratorRankerConfig,
	DeckRankExample,
	DeckRankSignal,
} from "../schemas/deck-curator";

const normalize = (value: string) =>
	value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const words = (value: string) =>
	normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Latest explicit verdict wins; retrieval excludes the entire current cohort. */
export function retrieveDeckExamples(
	card: { title: string; summary: string },
	pool: readonly DeckRankExample[],
	cohort: readonly { id: string; title: string }[],
) {
	const ids = new Set(cohort.map((item) => item.id));
	const titles = new Set(cohort.map((item) => normalize(item.title)));
	const seenIds = new Set<string>();
	const seenTitles = new Set<string>();
	const eligible = [...pool]
		.sort(
			(a, b) =>
				b.decidedAt.localeCompare(a.decidedAt) || a.id.localeCompare(b.id),
		)
		.filter((item) => {
			const title = normalize(item.title);
			if (
				ids.has(item.cardId) ||
				titles.has(title) ||
				seenIds.has(item.cardId) ||
				seenTitles.has(title)
			)
				return false;
			seenIds.add(item.cardId);
			seenTitles.add(title);
			return true;
		});
	const documents = eligible.map((item) =>
		words(`${item.title} ${item.summary}`),
	);
	const query = words(`${card.title} ${card.summary}`);
	const frequency = new Map<string, number>();
	for (const tokens of [...documents, query])
		for (const token of new Set(tokens))
			frequency.set(token, (frequency.get(token) ?? 0) + 1);
	const vector = (tokens: string[]) => {
		const result = new Map<string, number>();
		for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
		for (const [token, count] of result)
			result.set(
				token,
				count *
					(Math.log(
						(documents.length + 2) / ((frequency.get(token) ?? 0) + 1),
					) +
						1),
			);
		return result;
	};
	const q = vector(query);
	const norm = (v: Map<string, number>) => Math.hypot(...v.values());
	const qNorm = norm(q);
	return eligible
		.map((example, index) => {
			const v = vector(documents[index]!);
			const dot = [...q].reduce(
				(sum, [token, value]) => sum + value * (v.get(token) ?? 0),
				0,
			);
			return { example, similarity: dot / (qNorm * norm(v) || 1) };
		})
		.sort(
			(a, b) =>
				b.similarity - a.similarity || a.example.id.localeCompare(b.example.id),
		)
		.slice(0, 8)
		.map(({ example }) => example);
}

/** Self-reported probability is deliberately unused: bake-off coverage was incomplete. */
export function deckRankSignal(
	cardId: string,
	text: string | null,
	examples: readonly DeckRankExample[],
	config: DeckCuratorRankerConfig,
): DeckRankSignal {
	let label: "VALUABLE" | "NOISE" | null = null;
	try {
		const value = JSON.parse(text ?? "null");
		if (value?.label === "VALUABLE" || value?.label === "NOISE")
			label = value.label;
	} catch {
		/* Malformed final output leaves the original rank intact. */
	}
	const lower = label === "NOISE" && 0 < config.threshold;
	return {
		cardId,
		label,
		penalty: lower ? -config.noisePenalty : 0,
		reason: !label
			? "model_failed"
			: lower
				? "ranked_lower"
				: label === "NOISE"
					? "threshold_retained"
					: "valuable",
		exampleIds: examples.map((item) => item.id),
	};
}

/** Preserve every input card; policy protection takes precedence over all model signals. */
export function orderCuratedDeck<T extends { id: string; score: number }>(
	cards: readonly T[],
	signals: readonly DeckRankSignal[],
	critical: ReadonlySet<string>,
) {
	const byId = new Map(signals.map((signal) => [signal.cardId, signal]));
	return cards
		.map((card, index) => ({
			card,
			index,
			score:
				card.score +
				(critical.has(card.id)
					? 0
					: Math.min(0, byId.get(card.id)?.penalty ?? 0)),
		}))
		.sort(
			(a, b) =>
				Number(critical.has(b.card.id)) - Number(critical.has(a.card.id)) ||
				b.score - a.score ||
				a.index - b.index,
		)
		.map(({ card, score }) => ({ ...card, score }));
}

export function isCriticalDeckCard(
	card: Partial<DeckCard>,
	routing?: DeckRoutingPolicy,
) {
	const request = card.interaction?.request;
	const decision = card.decision;
	return (
		card.kind === "approval" ||
		card.kind === "outbound" ||
		card.factory?.policyCritical === true ||
		Boolean(decision?.protectedEffects.length) ||
		request?.metadata.approvalOperation !== undefined ||
		Boolean(request?.metadata.localImport) ||
		(request?.metadata.protectedEffects !== undefined &&
			(!Array.isArray(request.metadata.protectedEffects) ||
				request.metadata.protectedEffects.length > 0)) ||
		humanReservedActionClasses(`${card.label}\n${request?.prompt ?? ""}`)
			.length > 0 ||
		classifyDeckCard(
			{
				kind: card.kind ?? "question",
				classId:
					decision?.classId ??
					String(request?.metadata.decisionClass ?? card.kind),
				risk: String(request?.metadata.riskLevel ?? ""),
				action: request?.prompt ?? card.label ?? "",
				protectedEffects: decision?.protectedEffects,
				needsPerson: true,
			},
			routing,
		).reason === "critical"
	);
}
