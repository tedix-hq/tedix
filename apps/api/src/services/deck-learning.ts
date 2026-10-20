import type * as z from "zod";
import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import type {
	MarkDeckCardNotUsefulInputSchema,
	RemoveDeckRuleInputSchema,
} from "@tedix/api-contract/schemas/deck-pipeline";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { deckAskKind } from "@tedix/api-contract/utils/deck-ask";
import {
	deckHidingClassKey,
	deckSourceKey,
	deriveDeckRule,
	notUsefulRetirement,
} from "@tedix/api-contract/utils/deck-pipeline";
import { deckInteractionKind } from "@tedix/api-contract/utils/deck-projection";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { listLearningInteractions } from "@tedix/db/queries/learning-feedback";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { setDeckPipelineLearned } from "@tedix/db/queries/work-items/deck-sweep";
import { requireOrgId } from "../rpc/org-scope";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { cardOriginalBody } from "./card-revisions";
import { appendCuration } from "./deck-curation";
import {
	observedLearningActor,
	recordObservedLearningInteraction,
} from "./learning-interaction-recorder";

/**
 * S6: the recipient's "Not useful" chip. It retires the card (never answers
 * it), joins the ranker's retrieval pool at once as a NOISE label, and three
 * identical reasons from one source become a removable D1 rule. Declining a
 * card ("No") is a different signal and never passes through here.
 */
export async function markDeckCardNotUseful(
	context: BaseContext,
	input: z.infer<typeof MarkDeckCardNotUsefulInputSchema>,
) {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	const request = await getWorkInteraction(context.db, {
		orgId,
		interactionId: input.requestId,
	});
	if (
		!request ||
		request.targetType !== "user" ||
		actor.type !== "user" ||
		request.targetId !== actor.id
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the card's recipient can mark it not useful",
		);
	if (
		request.status !== "open" ||
		(input.expectedRequestVersion !== undefined &&
			request.version !== input.expectedRequestVersion)
	)
		throw createError(ErrorCodes.CONFLICT, "Reload the open card");
	const decision = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	).data;
	const kind = deckInteractionKind(request.kind, request.metadata);
	const sourceKey = deckSourceKey(request);
	const classKey = deckHidingClassKey(
		deckAskKind({ kind, decision, request: { metadata: request.metadata } }),
		sourceKey,
	);
	const prior = DeckCurationStateSchema.safeParse(request.metadata.curation);
	const learner = observedLearningActor(context);
	const clientEventId = `deck-not-useful:${request.id}:${request.version}`;
	await recordObservedLearningInteraction(context, {
		organizationId: orgId,
		clientEventId,
		eventKind: "rejected",
		surface: "decision_deck",
		targetType: "work_interaction",
		targetId: request.id,
		metadata: {
			decisionChoice: "not_useful",
			labelSource: "recipient",
			reasonChip: input.reason,
			sourceKey,
			classKey,
			wouldHide: prior.success
				? (prior.data.shadow?.wouldHide ?? false)
				: false,
			cardId: request.id,
			cardTitle: request.subject.slice(0, 500),
			cardSummary: cardOriginalBody(request).slice(0, 2000),
			...(input.note ? { reason: input.note } : {}),
		},
	});

	// A message draft leaves through its own review flow; the label still counts.
	let undo = null;
	if (request.metadata.schema !== "tedix.outbound.v1") {
		const successor =
			input.reason === "duplicate" && input.successorId
				? await getWorkInteraction(context.db, {
						orgId,
						interactionId: input.successorId,
					})
				: null;
		const reason =
			input.reason === "duplicate" &&
			!(
				successor?.status === "open" &&
				successor.id !== request.id &&
				successor.targetId === request.targetId
			)
				? "no_longer_relevant"
				: notUsefulRetirement(input.reason);
		const revision = await appendCuration(context, {
			orgId,
			actor,
			request,
			expectedRevision: Number(request.metadata.cardRevision ?? 0),
			body: cardOriginalBody(request),
			state: DeckCurationStateSchema.parse({
				schema: "tedix.deck-curation.v1",
				status: "cancelled",
				successorId: reason === "duplicate" ? (successor?.id ?? null) : null,
				penalty: prior.success ? prior.data.penalty : 0,
				reason: `Not useful: ${input.reason.replaceAll("_", " ")}${input.note ? `. ${input.note}` : ""}`,
				evidenceRefs: [`learning:${clientEventId}`],
				model: prior.success ? prior.data.model : null,
				exampleIds: prior.success ? prior.data.exampleIds : [],
				retirement: { reason, workItemId: null },
				notUseful: { reason: input.reason, sourceKey, classKey },
				...(prior.success && prior.data.shadow
					? { shadow: prior.data.shadow }
					: {}),
			}),
		});
		undo = {
			requestId: request.id,
			expectedRequestVersion: request.version + 1,
			expectedRevision: revision.revision,
			restoreRevision: revision.revision - 1,
		};
	}

	const config = (await getDecisionLearningConfig(context.db, orgId))
		.deckPipeline;
	const history = learner.actorId
		? await listLearningInteractions(context.db, {
				organizationId: orgId,
				personalScopeId: learner.actorId,
				scopeKind: "personal",
				scopeId: learner.actorId,
				surfaces: ["decision_deck"],
				eventKind: "rejected",
				limit: 500,
			})
		: [];
	const evidenceIds = [
		...new Set([
			...history
				.filter(
					(event) =>
						event.metadata?.reasonChip === input.reason &&
						event.metadata?.sourceKey === sourceKey,
				)
				.map((event) => event.clientEventId),
			clientEventId,
		]),
	];
	const rule = deriveDeckRule({
		recipientId: request.targetId!,
		sourceKey,
		reason: input.reason,
		evidenceIds,
		existing: config.rules,
		threshold: config.ruleAfterReasons,
		now: new Date(),
	});
	if (rule)
		await setDeckPipelineLearned(context.db, orgId, {
			rules: [...config.rules, rule].slice(-100),
			hidingClasses: config.hidingClasses,
		});
	return {
		requestId: request.id,
		reason: input.reason,
		retired: undo !== null,
		learningEventId: clientEventId,
		rule,
		undo,
	};
}

/** Learned rules are config: the person can remove any of their own. */
export async function removeDeckRule(
	context: BaseContext,
	input: z.infer<typeof RemoveDeckRuleInputSchema>,
) {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type !== "user")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the person a rule serves can remove it",
		);
	const config = (await getDecisionLearningConfig(context.db, orgId))
		.deckPipeline;
	const mine = (rule: (typeof config.rules)[number]) =>
		rule.recipientId === actor.id;
	const removed = config.rules.some(
		(rule) => rule.id === input.ruleId && mine(rule),
	);
	const rules = config.rules.filter(
		(rule) => !(rule.id === input.ruleId && mine(rule)),
	);
	if (removed)
		await setDeckPipelineLearned(context.db, orgId, {
			rules,
			hidingClasses: config.hidingClasses,
		});
	return { removed, rules: rules.filter(mine) };
}
