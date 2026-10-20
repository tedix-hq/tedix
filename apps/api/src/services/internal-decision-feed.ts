import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { listHandledInternalDecisionCards } from "@tedix/db/queries/work-items/card-revisions";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import type { BaseContext } from "../rpc/orpc";

export async function internalDecisionFeed(
	context: BaseContext,
	orgId: string,
	projectId?: string,
) {
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type !== "user") return [];
	const rows = await listHandledInternalDecisionCards(context.db, {
		orgId,
		recipientId: actor.id,
		projectId,
		limit: 100,
	});
	return rows.flatMap((request): ActivityFeedItem[] => {
		const parsed = DeckCurationStateSchema.safeParse(request.metadata.curation);
		const handled = parsed.success ? parsed.data.internalTask : undefined;
		if (!parsed.success || !handled || !parsed.data.revision) return [];
		return [
			{
				id: `internal-decision:${request.id}`,
				kind: "result",
				actor: "Agent",
				actorIdentity: { type: handled.actorType, id: handled.actorId },
				sentence: "Handled for you: created an internal follow-up task.",
				source: `/work/items/${handled.taskId}`,
				projectId: request.projectId,
				workItemId: handled.taskId,
				tediId: handled.actorType === "tedi" ? handled.actorId : null,
				classId: handled.classId,
				at: handled.handledAt,
				dueAt: null,
				importance: "normal",
				needsAction: false,
				stalled: false,
				done: true,
				explanation: `${parsed.data.reason}\nSource: /work/interactions/${request.id}`,
				reactions: ["why"],
				internalDecisionUndo: {
					requestId: request.id,
					expectedRequestVersion: request.version,
					expectedRevision: parsed.data.revision,
					restoreRevision: 1,
				},
			},
		];
	});
}
