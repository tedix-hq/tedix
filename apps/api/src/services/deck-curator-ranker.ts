import type * as z from "zod";
import type { AttentionViewInputSchema } from "@tedix/api-contract/schemas/attention";
import {
	DeckCuratorRankerConfigSchema,
	DeckRankExampleSchema,
	type DeckRankSignal,
} from "@tedix/api-contract/schemas/deck-curator";
import {
	retrieveDeckExamples,
	deckRankSignal,
	orderCuratedDeck,
	isCriticalDeckCard,
} from "@tedix/api-contract/utils/deck-curator";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { listLearningInteractions } from "@tedix/db/queries/learning-feedback";
import { reserveDeckRankingBudget } from "@tedix/db/queries/deck-curator-budget";
import { resolveAiGatewayTransport } from "@tedix/workers-ai/gateway-transport";
import { requireOrgId } from "../rpc/org-scope";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { loadDeckProjection } from "./attention-projection";
import { runDecisionCardCopyModel } from "./decision-card-copy-model";

/** Explicit paid operation. Ordinary Deck reads do not trigger model calls. */
export async function rankCurrentDeck(
	context: BaseContext,
	input: z.infer<typeof AttentionViewInputSchema>,
) {
	const organizationId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, organizationId);
	if (actor.type !== "user")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Rank your own Decisions using a verified recipient credential; a tedi cannot borrow its owner's inbox",
		);
	const projection = await loadDeckProjection(context, {
		...input,
		limit: 100,
	});
	if (!projection.complete || projection.cards.length > 100)
		throw createError(
			ErrorCodes.CONFLICT,
			"Decisions inventory is incomplete or exceeds this bounded ranking run",
		);
	const policy = await getDecisionLearningConfig(context.db, organizationId);
	const config = DeckCuratorRankerConfigSchema.parse(
		policy.deckCuratorRanker ?? {},
	);
	const critical = new Set(
		projection.cards
			.filter((card) => isCriticalDeckCard(card, projection.config.routing))
			.map((card) => card.id),
	);
	const signals: DeckRankSignal[] = [];
	let reservedMicros = 0;
	const events = config.enabled
		? await listLearningInteractions(context.db, {
				organizationId,
				personalScopeId: actor.id,
				scopeKind: "personal",
				scopeId: actor.id,
				surfaces: ["decision_deck", "decision_deck_action"],
				limit: policy.historyLimit,
			})
		: [];
	// Approval/rejection of an action is not a usefulness label. No training/audit proxies.
	const pool = events
		.filter((event) => event.actorType === "user" && event.actorId === actor.id)
		.flatMap((event) => {
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
			return parsed.success ? [parsed.data] : [];
		});
	const cohort = projection.cards.map((card) => ({
		id: card.id,
		title: card.label,
	}));
	const deadline = Date.now() + config.runTimeoutMs;
	for (const card of projection.cards) {
		const unchanged = (
			reason: DeckRankSignal["reason"],
			exampleIds: string[] = [],
		) =>
			signals.push({
				cardId: card.id,
				label: null,
				penalty: 0,
				reason,
				exampleIds,
			});
		if (critical.has(card.id)) {
			unchanged("critical");
			continue;
		}
		if (!config.enabled) {
			unchanged("disabled");
			continue;
		}
		if (Date.now() >= deadline) {
			unchanged("time_budget");
			continue;
		}
		const summary = (
			card.interaction?.request.prompt ??
			card.factory?.sourceText ??
			card.label
		).slice(0, 2000);
		const examples = retrieveDeckExamples(
			{ title: card.label, summary },
			pool,
			cohort,
		);
		if (examples.length !== 8) {
			unchanged(
				"insufficient_examples",
				examples.map((example) => example.id),
			);
			continue;
		}
		if (Date.now() >= deadline) {
			unchanged("time_budget");
			continue;
		}
		if (
			!resolveAiGatewayTransport(
				context.env,
				context.env.AI_GATEWAY_LLM_ID ?? "",
				"workers-ai",
			)
		) {
			unchanged("model_failed");
			continue;
		}
		if (
			reservedMicros + config.perCardReservationMicros >
				config.perRunReservationMicros ||
			!(await reserveDeckRankingBudget(context.db, {
				organizationId,
				amountMicros: config.perCardReservationMicros,
				dailyLimitMicros: config.dailyReservationMicros,
			}))
		) {
			unchanged("budget_exhausted");
			continue;
		}
		reservedMicros += config.perCardReservationMicros;
		const text = await runDecisionCardCopyModel(
			context,
			JSON.stringify({
				title: card.label.slice(0, 500),
				summary,
				examples: examples.map(({ title, summary, label }) => ({
					title,
					summary,
					label,
				})),
			}),
			{
				orgId: organizationId,
				source: "deck_curator_rank",
				model: config.model,
				maxTokens: 128,
				timeoutMs: Math.max(
					1,
					Math.min(config.timeoutMs, deadline - Date.now()),
				),
				system: config.instructions,
				rewriteInstruction:
					"Classify the current title and summary. Return the final JSON label only. /no_think",
			},
		);
		signals.push(deckRankSignal(card.id, text, examples, config));
	}
	return {
		cards: orderCuratedDeck(projection.cards, signals, critical),
		signals,
		reservedMicros,
		observedAt: projection.observedAt,
	};
}
