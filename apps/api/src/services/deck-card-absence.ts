import { cardIsDue } from "@tedix/api-contract/utils/card-schedule";
import { interactionDeckRoute } from "@tedix/api-contract/utils/deck-projection";
import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import type { DeckRoutingPolicy } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	getWorkInteraction,
	getWorkInteractionAttention,
} from "@tedix/db/queries/work-items/interactions";
import { outboundInteractionOverlays } from "@tedix/db/queries/work-items/outbound";
import { listDecisionCardPresentations } from "@tedix/db/queries/work-items/card-presentation";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../rpc/org-scope";
import { requestOutput } from "../rpc/routers/work-interactions";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import type { BaseContext } from "../rpc/orpc";

const GENERIC = "Card is not in your current Deck";

function nestedField(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/**
 * Card actions reach a request by id while Deck reads apply the inbox,
 * schedule, triage and routing filters. When a live request addressed to the
 * caller is absent from the projection, say which filter kept it out.
 */
export async function explainDeckCardAbsence(
	context: BaseContext,
	cardId: string,
	options: {
		projectId?: string;
		timeZone?: string;
		routing?: DeckRoutingPolicy;
		model?: DecisionLearningModel;
	} = {},
): Promise<string> {
	const orgId = requireOrgId(context);
	const [actor, request] = await Promise.all([
		verifiedActiveWorkActor(context, orgId),
		getWorkInteraction(context.db, { orgId, interactionId: cardId }),
	]);
	if (
		!request ||
		request.targetType !== actor.type ||
		request.targetId !== actor.id
	)
		return GENERIC;
	const now = new Date();
	const observedAt = now.toISOString();
	const state =
		request.status === "open" &&
		request.expiresAt !== null &&
		request.expiresAt <= observedAt
			? "expired"
			: request.status;
	if (state !== "open")
		return `The card already closed (${state}); it is no longer in your Deck`;
	const m = request.metadata;
	const notification = nestedField(m.notification, "state");
	if (notification === "suppressed")
		return "Its update was already handled, so its notification was withdrawn";
	if (notification === "deferred" || notification === "bundled")
		return "Its notification is held for your next digest";
	const snoozed = nestedField(m.followThrough, "snoozedUntil");
	if (typeof snoozed === "string" && snoozed > observedAt)
		return `You snoozed it until ${snoozed}`;
	if (
		options.projectId &&
		request.projectId !== options.projectId &&
		(!request.workItemId ||
			(await getWorkItemById(context.db, request.workItemId, orgId))
				?.projectId !== options.projectId)
	)
		return "It is filed under a different project than this Deck view";
	const [attention, outbound, presentations] = await Promise.all([
		getWorkInteractionAttention(context.db, {
			orgId,
			interactionId: cardId,
		}),
		outboundInteractionOverlays(context.db, orgId, [cardId]),
		listDecisionCardPresentations(context.db, {
			orgId,
			personId: actor.type === "user" ? actor.id : null,
			requests: [request],
		}),
	]);
	const overlay = outbound[0];
	const r = requestOutput(
		overlay
			? {
					...request,
					subject: overlay.subject,
					metadata: {
						...request.metadata,
						schema: "tedix.outbound.v1",
						outboundWorkItemId: overlay.workItemId,
						outboundStatus: overlay.status,
					},
				}
			: request,
		attention,
		null,
		presentations[0]?.presentation,
	);
	const rm = r.metadata;
	if (!cardIsDue(r, now, options.timeZone))
		return "It is scheduled to appear later";
	if (
		rm.schema === "tedix.decision-capture.v1" &&
		nestedField(rm.attention, "kind") === "fyi"
	)
		return "It was triaged as an update, not an ask";
	if (
		rm.schema === "tedix.outbound.v1" &&
		["reviewing", "feedback"].includes(String(rm.outboundStatus))
	)
		return "It is still in outbound review";
	const { decision, route } = interactionDeckRoute(
		r,
		options.model,
		options.routing,
		now,
	);
	if (route.destination !== "deck")
		return rm.decisionDeck !== undefined && !decision
			? `Its decision envelope failed validation, so it routes to your Feed (${route.reason})`
			: `It routes to your Feed, not your Deck (${route.reason})`;
	return GENERIC;
}
