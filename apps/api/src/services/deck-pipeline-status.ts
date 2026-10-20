import type { DecisionLearningConfig } from "@tedix/api-contract/schemas/decision-learning";
import { deckPipelineStatus } from "@tedix/api-contract/utils/deck-pipeline";
import { getDeckSweepReceipt } from "@tedix/db/queries/work-items/deck-sweep";
import { requireOrgId } from "../rpc/org-scope";
import type { BaseContext } from "../rpc/orpc";

/** "Last cleaned HH:MM", the staleness alarm, learned rules and week-1 numbers. */
export async function loadDeckPipelineStatus(
	context: BaseContext,
	config: DecisionLearningConfig | undefined,
	now = new Date(),
) {
	try {
		return config ? await readStatus(context, config, now) : undefined;
	} catch (error) {
		// The Deck still renders; only its curation footer is missing.
		console.warn("deck pipeline status unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

async function readStatus(
	context: BaseContext,
	config: DecisionLearningConfig,
	now: Date,
) {
	const receipt = await getDeckSweepReceipt(context.db, requireOrgId(context));
	const ids = [context.userId, context.descopeUserId].filter(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	const recipientId =
		ids.find(
			(id) =>
				receipt?.metrics.some((entry) => entry.recipientId === id) ||
				config.deckPipeline.rules.some((rule) => rule.recipientId === id),
		) ??
		ids[0] ??
		null;
	return deckPipelineStatus(receipt, config.deckPipeline, recipientId, now);
}
