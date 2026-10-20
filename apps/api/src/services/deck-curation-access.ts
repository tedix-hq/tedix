import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import {
	verifiedActiveWorkActor,
	verifiedActiveUserMembership,
} from "../rpc/routers/work-items-principal";
import { requireOrgId } from "../rpc/org-scope";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

export async function deckCurationAccess(
	context: BaseContext,
	scope: { recipientId: string; gadgetId: string },
) {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	const policy = await getDecisionLearningConfig(context.db, orgId);
	const grant = policy.deckCurators.find(
		(g) =>
			g.enabled &&
			g.recipientId === scope.recipientId &&
			g.gadgetId === scope.gadgetId &&
			(actor.type !== "tedi" || g.tediId === actor.id),
	);
	const ownUser =
		context.authType === "user" && !context.tediId
			? (await verifiedActiveUserMembership(context, orgId)).userId
			: null;
	if (!grant || (actor.type !== "tedi" && ownUser !== scope.recipientId))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"No active recipient and Deck scoped curation grant",
		);
	return { orgId, actor, grant, policy };
}
