import { coreQueryDb } from "@tedix/db/core-store/scope";
import { listPendingAgentSessionEventOwners } from "@tedix/db/queries/agent-session-requests";
import { enqueueAgentSessionEvents } from "../services/agent-session-event-queue";

/** Recover pre-deploy backlogs, interrupted continuations and expired leases. */
export async function dispatchPendingAgentSessionEvents(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	if (!env.AUTOMATION_EVENTS) return { queued: 0 };
	const owners = await listPendingAgentSessionEventOwners(
		coreQueryDb(env),
		new Date().toISOString(),
	);
	for (const owner of owners) await enqueueAgentSessionEvents(env, owner);
	return { queued: owners.length };
}
