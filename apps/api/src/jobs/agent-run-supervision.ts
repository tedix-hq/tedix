/**
 * Gives a tedi a supervision round while agent runs it started are live.
 *
 * Runs on the two-minute platform tick. For each active tedi with an
 * accepted run it started, it plans a round (`services/agent-run-supervision`),
 * wakes the tedi in its supervision session and then records what the round
 * saw on each run. Delivery is keyed by a five-minute window, so a tick that
 * is retried, or a record that failed, never gives the tedi a second round in
 * the same window.
 */

import { AGENT_RUN_SUPERVISION_SESSION_PREFIX } from "@tedix/api-contract/schemas/work-agent-runs";
import {
	buildRuntimeRunId,
	buildTediConversationId,
} from "@tedix/api-contract/utils/runtime-identity";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { listTediRuntimeEventsForRouter } from "@tedix/db/queries/cognitive-runtime";
import { listTediRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import {
	type AgentRunSupervisor,
	agentRunSupervisionState,
	listAgentRunSupervisors,
	recordAgentRunSupervisionRound,
} from "@tedix/db/queries/work-items/agent-runs";
import type { TediHostEnv } from "../lib/platform-hosts";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { describeAgentRunRows } from "../services/agent-run-status";
import {
	planSupervisionRound,
	SUPERVISION_WINDOW_MS,
	supervisionConfig,
	supervisionDigest,
} from "../services/agent-run-supervision";
import {
	buildTediContextWakeRequest,
	deliverTediContextWake,
} from "./tedi-context-wake";

/**
 * Only runs started in the last two days are supervised. A run uses its 12
 * rounds well before that, and the window keeps the tick from re-reading
 * tedis whose only accepted runs ended long ago.
 */
const SUPERVISED_RUN_AGE_MS = 2 * 86_400_000;
/** Tedis examined per tick; the rest wait for the next one. */
const SUPERVISORS_PER_TICK = 40;
const RUNS_PER_TEDI = 50;
const RUN_BUDGET_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 15_000;

type Send = (request: Request) => Promise<Response>;

async function roundInProgress(
	db: DbClient,
	supervisor: AgentRunSupervisor,
	sessionKey: string,
	thisRunId: string,
): Promise<boolean> {
	const [started] = await listTediRuntimeEventsForRouter(db, {
		organizationId: supervisor.orgId,
		tediId: supervisor.tediId,
		conversationId: buildTediConversationId({
			tediRef: supervisor.slug,
			sessionKey,
		}),
		kind: "run.started",
		order: "desc",
		limit: 1,
	});
	if (!started?.runId || started.runId === thisRunId) return false;
	const terminal = await listTediRuntimeEvents(db, {
		organizationId: supervisor.orgId,
		tediId: supervisor.tediId,
		runId: started.runId,
		kinds: ["run.completed", "run.failed", "run.canceled"],
		limit: 1,
	});
	return terminal.length === 0;
}

export async function superviseAgentRuns(input: {
	db: DbClient;
	env: TediHostEnv;
	send: Send;
	now: number;
}): Promise<Record<string, number>> {
	const { db, now } = input;
	const deadline = Date.now() + RUN_BUDGET_MS;
	const counts = {
		supervisors: 0,
		off: 0,
		notDue: 0,
		deferred: 0,
		rounds: 0,
		deduplicated: 0,
		failed: 0,
		budgetExhausted: 0,
	};
	const supervisors = await listAgentRunSupervisors(db, {
		since: new Date(now - SUPERVISED_RUN_AGE_MS).toISOString(),
		limit: SUPERVISORS_PER_TICK,
	});
	counts.supervisors = supervisors.length;
	const window = Math.floor(now / SUPERVISION_WINDOW_MS);
	for (const supervisor of supervisors) {
		if (Date.now() >= deadline) {
			counts.budgetExhausted = 1;
			break;
		}
		const config = supervisionConfig(supervisor.runtimeOverrides);
		if (!config.enabled) {
			counts.off++;
			continue;
		}
		try {
			const { described } = await describeAgentRunRows(db, {
				orgId: supervisor.orgId,
				stewardTediId: supervisor.tediId,
				state: "all",
				limit: RUNS_PER_TEDI,
				at: new Date(now).toISOString(),
			});
			const oldest = new Date(now - SUPERVISED_RUN_AGE_MS).toISOString();
			const runs = described
				.filter(({ run }) => run.createdAt > oldest)
				.map(({ row, run }) => ({
					run,
					state: agentRunSupervisionState(row.workItem.metadata),
				}));
			const plan = planSupervisionRound(runs, config, now);
			if (plan.due.length === 0) {
				counts.notDue++;
				continue;
			}
			const sessionKey = `${AGENT_RUN_SUPERVISION_SESSION_PREFIX}${supervisor.tediId}`;
			const deliveryKey = `agent-run-supervision:${supervisor.orgId}:${supervisor.tediId}:${window}`;
			if (
				await roundInProgress(
					db,
					supervisor,
					sessionKey,
					buildRuntimeRunId({
						tediId: supervisor.tediId,
						surface: "mcp",
						turnKey: deliveryKey,
					}),
				)
			) {
				counts.deferred++;
				continue;
			}
			const receipt = await deliverTediContextWake(db, {
				orgId: supervisor.orgId,
				tediId: supervisor.tediId,
				request: buildTediContextWakeRequest(supervisor.slug, input.env, {
					session_key: sessionKey,
					client_request_id: deliveryKey,
					metadata: {
						source: "agent_run_supervision",
						workItemIds: plan.due.map((entry) => entry.workItemId),
					},
					text: supervisionDigest(runs, plan, config),
				}),
				send: (request) =>
					input.send(
						new Request(request, {
							signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
						}),
					),
			});
			// Recorded after delivery: a lost record repeats this window's key,
			// which the runtime answers without a second turn.
			for (const record of plan.records)
				await recordAgentRunSupervisionRound(db, {
					orgId: supervisor.orgId,
					...record,
				});
			if (receipt.deduplicated) counts.deduplicated++;
			else counts.rounds++;
		} catch (error) {
			counts.failed++;
			console.warn("[agent-run-supervision] round failed", {
				tediId: supervisor.tediId,
				exception: safeExceptionTopology(error),
			});
		}
	}
	return counts;
}

export function dispatchAgentRunSupervision(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	return superviseAgentRuns({
		db: createDbClient(env.DB),
		env,
		send: (request) => env.TEDI_SERVICE.fetch(request),
		now: Math.max(scheduledTime, Date.now()),
	});
}
