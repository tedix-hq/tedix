import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import {
	appendCardRevision,
	listCardRevisions,
} from "@tedix/db/queries/work-items/card-revisions";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { cardOriginalBody } from "./card-revisions";
import { executeInternalDecisionTask } from "./internal-decision-task";

/** A policy-owned task is created before its ask is superseded. No person answers it. */
export async function handleInternalDecision(
	context: BaseContext,
	request: NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>,
	expectedRevision: number,
) {
	const actor = await verifiedActiveWorkActor(context, request.orgId);
	if (actor.type !== "tedi" && actor.type !== "external_agent")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An owning agent must handle this action",
		);
	const decision = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	const effect = decision.success
		? decision.data.options.find((option) => option.intent === "approve")
				?.effect
		: undefined;
	if (
		request.targetType !== "user" ||
		!effect ||
		effect.kind !== "create_owner_task"
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A supported internal action is required",
		);
	const current = await getWorkInteraction(context.db, {
		orgId: request.orgId,
		interactionId: request.id,
	});
	if (
		!current ||
		current.version !== request.version ||
		current.status !== "open"
	)
		throw createError(ErrorCodes.CONFLICT, "Reload the open action");
	let history = await listCardRevisions(context.db, request.orgId, request.id);
	if ((history.at(-1)?.revision ?? 0) !== expectedRevision)
		throw createError(ErrorCodes.CONFLICT, "Reload the latest action revision");
	const receipt = await executeInternalDecisionTask(context, request, effect);
	if (!history.length) {
		const initial = await appendCardRevision(context.db, {
			orgId: request.orgId,
			requestId: request.id,
			expectedVersion: request.version,
			expectedRevision: 0,
			body: cardOriginalBody(request),
			cause: "initial",
			actorType: request.creatorType,
			actorId: request.creatorId,
		});
		if (!initial)
			throw createError(
				ErrorCodes.CONFLICT,
				"The action changed; retry using its saved task receipt",
			);
		history = [initial];
	}
	const curation = DeckCurationStateSchema.parse({
		schema: "tedix.deck-curation.v1",
		revision: history.at(-1)!.revision + 1,
		draftBody: cardOriginalBody(request),
		status: "cancelled",
		successorId: null,
		penalty: 0,
		reason:
			"Internal task handled by the agent under organization autonomy policy; sending remains reserved for the owner.",
		evidenceRefs: [`/work/items/${receipt.taskId}`],
		model: null,
		exampleIds: [],
		internalTask: {
			taskId: receipt.taskId,
			classId: receipt.classId,
			policyPack: receipt.policyPack,
			actorType: actor.type,
			actorId: actor.id,
			handledAt: new Date().toISOString(),
		},
	});
	const revision = await appendCardRevision(context.db, {
		orgId: request.orgId,
		requestId: request.id,
		expectedVersion: request.version,
		expectedRevision: history.at(-1)!.revision,
		body: cardOriginalBody(request),
		cause: "agent_rewrite",
		actorType: actor.type,
		actorId: actor.id,
		actorSessionId: actor.sessionId,
		instruction: JSON.stringify(curation),
		curation,
	});
	if (!revision)
		throw createError(
			ErrorCodes.CONFLICT,
			"The action changed; its internal task receipt is retained for recovery",
		);
	return revision;
}
