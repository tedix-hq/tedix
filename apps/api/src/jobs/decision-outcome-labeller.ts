import { backfillCardSummaries } from "../services/card-summary-backfill";
import { createDbClient } from "@tedix/db/client";
import { labelDecisionOutcomes } from "../services/decision-instrumentation";
import { reconcilePersonalAgentOutcomes } from "../services/personal-agent-outbound";
import { runScheduledDecisionGraphBackfill } from "../services/decision-graph-backfill";
import { runAgentDecisionMorningReview } from "../services/agent-decision-journal";

/** Rides the existing maintenance tick; receipt/window uniqueness makes retries harmless. */
export async function runDecisionOutcomeLabeller(
	env: CloudflareEnv,
	scheduledTime: number,
) {
	const db = createDbClient(env.DB);
	const now = new Date(scheduledTime);
	const labels = await labelDecisionOutcomes(db, now);
	const personalAgents = await reconcilePersonalAgentOutcomes(db, env, now);
	const backfill = await runScheduledDecisionGraphBackfill(db);
	const review = await runAgentDecisionMorningReview(db, now);
	const summaries = await backfillCardSummaries({ db, env }, now.toISOString());
	return {
		...labels,
		personalAgentOutcomes: personalAgents.recorded,
		...backfill,
		...review,
		...summaries,
	};
}
