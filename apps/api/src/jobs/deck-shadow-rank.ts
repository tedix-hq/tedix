import type { DbClient } from "@tedix/db/client";
import type { DecisionLearningConfig } from "@tedix/api-contract/schemas/decision-learning";
import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import {
	DeckCuratorRankerConfigSchema,
	DeckRankExampleSchema,
	type DeckRankExample,
} from "@tedix/api-contract/schemas/deck-curator";
import {
	currentDeckCuration,
	deckRankSignal,
	orderCuratedDeck,
	retrieveDeckExamples,
} from "@tedix/api-contract/utils/deck-curator";
import {
	compareDeckOrders,
	ruleRankDeck,
} from "@tedix/api-contract/utils/deck-rule-rank";
import {
	deckHidingClassKey,
	deckSourceKey,
	type SweepCard,
} from "@tedix/api-contract/utils/deck-pipeline";
import { listLearningInteractions } from "@tedix/db/queries/learning-feedback";
import { reserveDeckRankingBudget } from "@tedix/db/queries/deck-curator-budget";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { runClef } from "../lib/clef";
import { cardOriginalBody } from "../services/card-revisions";
import { appendCuration } from "../services/deck-curation";
import { runDecisionCardCopyModel } from "../services/decision-card-copy-model";

/** Recipient's own usefulness labels first, then curator-supplied examples. */
export async function deckRankPool(
	db: DbClient,
	orgId: string,
	learningScopeIds: readonly string[],
	supplied: readonly DeckRankExample[],
) {
	const pool: DeckRankExample[] = [];
	for (const scopeId of new Set(learningScopeIds)) {
		const events = await listLearningInteractions(db, {
			organizationId: orgId,
			personalScopeId: scopeId,
			scopeKind: "personal",
			scopeId,
			surfaces: ["decision_deck"],
			limit: 300,
		});
		for (const event of events) {
			const m = event.metadata;
			const label =
				m?.decisionChoice === "useful"
					? "VALUABLE"
					: m?.decisionChoice === "not_useful"
						? "NOISE"
						: null;
			const parsed = DeckRankExampleSchema.safeParse({
				id: event.id,
				cardId: m?.cardId ?? event.targetId,
				title: m?.cardTitle,
				summary: m?.cardSummary,
				label,
				labelSource: "recipient",
				evidenceRef: `learning:${event.id}`,
				decidedAt: event.occurredAt,
			});
			if (parsed.success) pool.push(parsed.data);
		}
	}
	return [
		...pool,
		...supplied.map((example) => ({
			...example,
			labelSource: example.labelSource ?? ("supplied" as const),
		})),
	];
}

/**
 * Model order as the live Deck applies it (penalties only, protected first)
 * beside the deterministic rule order, so the model ranker has a baseline to beat.
 */
export function compareShadowRanking(
	cards: readonly SweepCard[],
	penalties: ReadonlyMap<string, number>,
	now: Date,
	timeZone: string,
) {
	const ruleOrder = ruleRankDeck(
		cards.map((card) => ({ ...card, critical: card.protected })),
		now,
		timeZone,
	).map(({ card }) => card.id);
	const modelOrder = orderCuratedDeck(
		cards.map((card) => ({
			id: card.id,
			score: 0,
			overdue: !!card.dueAt && Date.parse(card.dueAt) < now.getTime(),
		})),
		[...penalties].map(([cardId, penalty]) => ({
			cardId,
			label: null,
			penalty,
			reason: "valuable" as const,
			exampleIds: [],
		})),
		new Set(cards.filter((card) => card.protected).map((card) => card.id)),
	).map((card) => card.id);
	return { ruleOrder, modelOrder, ...compareDeckOrders(ruleOrder, modelOrder) };
}

/**
 * S3 in shadow: Qwen's label (never its probability) lowers rank only; Clef's
 * NOISE probability is logged as the second key. Nothing is hidden here.
 * Each card is labelled once per revision, within the organization's budget.
 * The result also carries the rule order and its distance from the model order.
 */
export async function shadowRankDeck(input: {
	db: DbClient;
	env: CloudflareEnv;
	orgId: string;
	learning: DecisionLearningConfig;
	cards: readonly SweepCard[];
	pool: readonly DeckRankExample[];
	now: Date;
	limit: number;
	timeZone?: string;
}) {
	const ranker = DeckCuratorRankerConfigSchema.parse(
		input.learning.deckCuratorRanker ?? {},
	);
	const secondKey = input.learning.deckPipeline.secondKey;
	const counts = {
		ranked: 0,
		insufficient: 0,
		skipped: 0,
		disabled: 0,
		budget: 0,
		modelFailed: 0,
		writeFailed: 0,
		// Rule-baseline comparison; integer sums stay meaningful across recipients.
		ruleCompared: 0,
		ruleTopOverlap: 0,
		ruleTopSize: 0,
		ruleDiscordantPairs: 0,
		rulePairs: 0,
	};
	if (!ranker.enabled || input.limit <= 0) {
		counts.disabled = input.cards.length;
		return { ...counts, ruleOrder: [], modelOrder: [] };
	}
	const penalties = new Map<string, number>();
	for (const card of input.cards) {
		const penalty = currentDeckCuration(card.metadata)?.penalty;
		if (penalty) penalties.set(card.id, penalty);
	}
	const cohort = input.cards.map((card) => ({
		id: card.id,
		title: card.subject,
	}));
	const deadline = Date.now() + ranker.runTimeoutMs;
	for (const card of input.cards) {
		if (counts.ranked >= input.limit || Date.now() >= deadline) break;
		if (card.protected) continue;
		const current = currentDeckCuration(card.metadata);
		if (current?.shadow) continue;
		const summary = (card.prompt || card.subject).slice(0, 2000);
		const examples = retrieveDeckExamples(
			{ title: card.subject, summary },
			input.pool,
			cohort,
		);
		if (examples.length !== 8) {
			counts.insufficient += 1;
			continue;
		}
		if (
			!(await reserveDeckRankingBudget(input.db, {
				organizationId: input.orgId,
				amountMicros: ranker.perCardReservationMicros,
				dailyLimitMicros: ranker.dailyReservationMicros,
			}))
		) {
			counts.budget += 1;
			break;
		}
		const text = await runDecisionCardCopyModel(
			{ env: input.env },
			JSON.stringify({
				title: card.subject.slice(0, 500),
				summary,
				examples: examples.map(({ title, summary, label }) => ({
					title,
					summary,
					label,
				})),
			}),
			{
				orgId: input.orgId,
				source: "deck_curator_rank",
				model: ranker.model,
				maxTokens: 128,
				timeoutMs: Math.max(
					1,
					Math.min(ranker.timeoutMs, deadline - Date.now()),
				),
				system: ranker.instructions,
				rewriteInstruction:
					"Classify the current title and summary. Return the final JSON label only. /no_think",
			},
		);
		const signal = deckRankSignal(card.id, text, examples, ranker);
		if (!signal.label) {
			counts.modelFailed += 1;
			continue;
		}
		penalties.set(card.id, signal.penalty);
		let secondKeyNoise: number | null = null;
		if (signal.label === "NOISE") {
			const clef = await runClef(input.env, {
				modelId: secondKey.model,
				surface: "deck_curator_second_key",
				timeoutMs: secondKey.timeoutMs,
				state: { title: card.subject.slice(0, 500), summary },
				questions: {
					value: {
						type: "choice",
						instructions:
							"Does this card deserve the owner's minute? Classify the card; it grants no authority.",
						criteria: {
							VALUABLE:
								"A critical approval or a concrete decision the owner must make.",
							NOISE:
								"Routine, duplicate or agent-handleable work with no owner decision.",
						},
					},
				},
			});
			const answer = clef.ok ? clef.answers.value : undefined;
			secondKeyNoise =
				answer?.type === "choice" ? (answer.probabilities.NOISE ?? null) : null;
		}
		const request = await getWorkInteraction(input.db, {
			orgId: input.orgId,
			interactionId: card.id,
		});
		if (!request || request.status !== "open") continue;
		try {
			await appendCuration(
				{ db: input.db },
				{
					orgId: input.orgId,
					actor: { type: "system", id: "deck-pipeline" },
					request,
					expectedRevision: Number(request.metadata.cardRevision ?? 0),
					body: cardOriginalBody(request),
					state: DeckCurationStateSchema.parse({
						schema: "tedix.deck-curation.v1",
						status: "open",
						successorId: null,
						penalty: signal.penalty,
						reason: signal.reason,
						evidenceRefs: examples.map((example) => example.evidenceRef),
						model: ranker.model,
						exampleIds: signal.exampleIds,
						shadow: {
							label: signal.label,
							secondKeyNoise,
							wouldHide:
								signal.label === "NOISE" &&
								secondKeyNoise !== null &&
								secondKeyNoise >= secondKey.threshold,
							classKey: deckHidingClassKey(card.askKind, deckSourceKey(card)),
							at: input.now.toISOString(),
						},
					}),
				},
			);
			counts.ranked += 1;
		} catch {
			counts.writeFailed += 1;
		}
	}
	const comparison = compareShadowRanking(
		input.cards,
		penalties,
		input.now,
		input.timeZone ?? "UTC",
	);
	if (comparison.ruleOrder.length > 1) {
		counts.ruleCompared = 1;
		counts.ruleTopOverlap = comparison.topOverlap;
		counts.ruleTopSize = comparison.topK;
		counts.ruleDiscordantPairs = comparison.discordant;
		counts.rulePairs = comparison.pairs;
	}
	return {
		...counts,
		ruleOrder: comparison.ruleOrder,
		modelOrder: comparison.modelOrder,
	};
}
