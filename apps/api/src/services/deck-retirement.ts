import type * as z from "zod";
import {
	DeckCurationStateSchema,
	type MergeDeckCardsInputSchema,
	type RetireDeckCardInputSchema,
} from "@tedix/api-contract/schemas/deck-curation";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { deckCardExpired } from "@tedix/api-contract/utils/deck-ask";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../rpc/org-scope";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { cardOriginalBody, cardOwningTedi } from "./card-revisions";
import { appendCuration, criticalDeckRequest } from "./deck-curation";

type RetireInput = z.input<typeof RetireDeckCardInputSchema>;
type Request = NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>;

const normalized = (value: string | null | undefined) =>
	(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function liveCard(
	request: Request | null | undefined,
	recipientId: string | null,
) {
	return (
		!!request &&
		request.status === "open" &&
		request.targetType === "user" &&
		!!recipientId &&
		request.targetId === recipientId &&
		!(request.expiresAt && request.expiresAt <= new Date().toISOString())
	);
}

/** One ask: the same Work Item, or the same question when neither is filed. */
function sameAsk(a: Request, b: Request) {
	if (a.workItemId || b.workItemId) return a.workItemId === b.workItemId;
	return normalized(a.subject) === normalized(b.subject);
}

function protectedCard(request: Request) {
	return (
		criticalDeckRequest(request) ||
		credentialCard(`${request.subject} ${request.prompt}`, request.metadata)
	);
}

export async function retireDeckCard(context: BaseContext, raw: RetireInput) {
	const input = { ...raw, evidenceRefs: raw.evidenceRefs ?? [] };
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	const request = await getWorkInteraction(context.db, {
		orgId,
		interactionId: input.requestId,
	});
	if (!request || request.targetType !== "user")
		throw createError(ErrorCodes.NOT_FOUND, "Card not found");
	const recipient = actor.type === "user" && request.targetId === actor.id;
	const creator =
		request.creatorType === actor.type && request.creatorId === actor.id;
	const owningTedi =
		actor.type === "tedi" &&
		(await cardOwningTedi(context, request)) === actor.id;
	const curator =
		actor.type === "tedi" &&
		(await getDecisionLearningConfig(context.db, orgId)).deckCurators.some(
			(g) =>
				g.enabled &&
				g.tediId === actor.id &&
				g.recipientId === request.targetId,
		);
	if (!recipient && !creator && !owningTedi && !curator)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the card's recipient, its owning agent or a delegated curator can retire it",
		);
	if (
		request.status !== "open" ||
		(input.expectedRequestVersion !== undefined &&
			request.version !== input.expectedRequestVersion)
	)
		throw createError(ErrorCodes.CONFLICT, "Reload the open card");
	if (request.metadata.schema === "tedix.outbound.v1")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Use the outbound review flow to discard a message draft",
		);
	if (input.reason === "duplicate" && !input.successorId)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A duplicate names the card that keeps the ask",
		);
	if (input.reason === "superseded" && !input.successorId && !input.workItemId)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A superseded card names its successor card or Work Item",
		);
	const isProtected = protectedCard(request);
	if (input.successorId) {
		const successor = await getWorkInteraction(context.db, {
			orgId,
			interactionId: input.successorId,
		});
		if (
			!successor ||
			successor.id === request.id ||
			!liveCard(successor, request.targetId)
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Successor must be a different live card for the same recipient",
			);
		if (input.reason === "duplicate" && !sameAsk(request, successor))
			throw createError(
				ErrorCodes.CONFLICT,
				"A duplicate must share the kept card's Work Item or ask",
			);
		if (isProtected && !protectedCard(successor))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"A protected card merges only into a protected card",
			);
	}
	if (
		input.workItemId &&
		!(await getWorkItemById(context.db, input.workItemId, orgId))
	)
		throw createError(ErrorCodes.BAD_REQUEST, "Work Item not found");
	if (!recipient) {
		// A protected ask stays with the person unless an agent's own duplicate
		// folds into a card that keeps the same protected ask, or the agent's ask
		// has passed its hard expiry and can no longer be acted on.
		const agentCard = request.creatorType !== "user";
		const agentDuplicate = input.reason === "duplicate" && agentCard;
		const agentExpired =
			input.reason === "expired" &&
			agentCard &&
			deckCardExpired(
				{
					decision:
						DecisionEnvelopeSchema.safeParse(request.metadata.decisionDeck)
							.data ?? null,
				},
				new Date(),
			);
		if (isProtected && !agentDuplicate && !agentExpired)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Critical cards need their recipient to retire them",
			);
		if (!input.evidenceRefs.length)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Agents cite evidence when they retire a card",
			);
	}
	const prior = DeckCurationStateSchema.safeParse(request.metadata.curation);
	const state = DeckCurationStateSchema.parse({
		schema: "tedix.deck-curation.v1",
		status: "cancelled",
		successorId: input.successorId ?? null,
		penalty: prior.success ? prior.data.penalty : 0,
		reason: input.note,
		evidenceRefs: input.evidenceRefs,
		model: prior.success ? prior.data.model : null,
		exampleIds: prior.success ? prior.data.exampleIds : [],
		retirement: {
			reason: input.reason,
			workItemId: input.workItemId ?? null,
		},
	});
	const revision = await appendCuration(context, {
		orgId,
		actor,
		request,
		expectedRevision: Number(request.metadata.cardRevision ?? 0),
		body: cardOriginalBody(request),
		state,
	});
	return {
		requestId: request.id,
		reason: input.reason,
		revision: revision.revision,
		undo: {
			requestId: request.id,
			expectedRequestVersion: request.version + 1,
			expectedRevision: revision.revision,
			restoreRevision: revision.revision - 1,
		},
	};
}

export async function mergeDeckCards(
	context: BaseContext,
	input: z.input<typeof MergeDeckCardsInputSchema>,
) {
	if (new Set(input.duplicateIds).size !== input.duplicateIds.length)
		throw createError(ErrorCodes.BAD_REQUEST, "List each duplicate once");
	if (input.duplicateIds.includes(input.keepId))
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The kept card cannot also be a duplicate",
		);
	const orgId = requireOrgId(context);
	const keep = await getWorkInteraction(context.db, {
		orgId,
		interactionId: input.keepId,
	});
	if (!keep || !liveCard(keep, keep.targetId))
		throw createError(ErrorCodes.CONFLICT, "The kept card must be live");
	const retired = [];
	for (const requestId of input.duplicateIds)
		retired.push(
			await retireDeckCard(context, {
				requestId,
				reason: "duplicate",
				successorId: keep.id,
				workItemId: keep.workItemId ?? undefined,
				note: input.note,
				evidenceRefs: input.evidenceRefs,
			}),
		);
	return { keptId: keep.id, retired };
}
