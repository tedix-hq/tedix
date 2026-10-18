import { createDbQueryClient } from "@tedix/db/query-client";
import { labelDecisionOutcomes } from "../services/decision-instrumentation";

/** Rides the existing maintenance tick; receipt/window uniqueness makes retries harmless. */
export function runDecisionOutcomeLabeller(
	env: CloudflareEnv,
	scheduledTime: number,
) {
	return labelDecisionOutcomes(
		createDbQueryClient(env.DB),
		new Date(scheduledTime),
	);
}
