import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import type { BaseContext } from "../rpc/orpc";

export async function queueDeckCuration(
	context: BaseContext,
	card: {
		orgId: string;
		targetType: string | null;
		targetId: string | null;
		status: string;
	},
	actor: { type: string; id: string },
) {
	if (card.targetType !== "user" || card.status !== "open") return;
	try {
		const config = await getDecisionLearningConfig(context.db, card.orgId);
		for (const grant of config.deckCurators) {
			if (
				!grant.enabled ||
				!grant.trigger?.enabled ||
				grant.recipientId !== card.targetId ||
				(actor.type === "tedi" && actor.id === grant.tediId)
			)
				continue;
			if (!context.env.AUTOMATION_EVENTS)
				throw new Error("Automation queue unavailable");
			const seconds = grant.trigger.debounceSeconds;
			await context.env.AUTOMATION_EVENTS.send(
				{
					kind: "skill_workflow",
					organizationId: card.orgId,
					tediId: grant.tediId,
					skillId: grant.trigger.skillId,
					params: {
						recipientId: grant.recipientId,
						gadgetId: grant.gadgetId,
						source: "recipient_card_changed",
					},
					idempotencyKey: `deck-curation:${grant.tediId}:${grant.gadgetId}:${Math.floor(Date.now() / (seconds * 1000))}`,
					source: "deck-curation-trigger",
				},
				{ delaySeconds: seconds },
			);
		}
	} catch (error) {
		// The card is already committed; scheduled sweeps recover a missed wake.
		console.warn("deck curation trigger unavailable", {
			orgId: card.orgId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
