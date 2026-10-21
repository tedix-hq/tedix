import { createDbQueryClient } from "@tedix/db/query-client";
import { labelDecisionOutcomes } from "../services/decision-instrumentation";
import { reconcilePersonalAgentOutcomes } from "../services/personal-agent-outbound";
import { runScheduledDecisionGraphBackfill } from "../services/decision-graph-backfill";

/** Rides the existing maintenance tick; receipt/window uniqueness makes retries harmless. */
export async function runDecisionOutcomeLabeller(
	env: CloudflareEnv,
	scheduledTime: number,
) {
	const db = createDbQueryClient(env.DB);
	const now = new Date(scheduledTime);
	const labels = await labelDecisionOutcomes(db, now);
	const personalAgents = await reconcilePersonalAgentOutcomes(db, env, now);
	const backfill = await runScheduledDecisionGraphBackfill(db);
	return {
		...labels,
		personalAgentOutcomes: personalAgents.recorded,
		...backfill,
	};
}
