import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";
import type { WorkflowDispatchContext } from "./workflow-start-watchdog";

export type CronPacingSchedule = { everyMs: number } | { expr: string };

export interface CronPacingState {
	open?: {
		workflowId: string;
		admittedAt: number;
		schedule: CronPacingSchedule;
	};
	eligibleAt?: number;
	finishedAt?: number;
	finishedWorkflowId?: string;
	lastFireKey?: string;
	deferred?: { reason: string; at: number; eligibleAt?: number };
}

type Storage = Pick<DurableObjectStorage, "transaction">;
const CRON_RECONCILE_AFTER_MS = 3_600_000;
export const cronPacingKey = (name: string) => `cron-pacing:${name}`;

/** Reserve before any external await. DO transactions serialize competing fires. */
export async function reserveCronTask(
	storage: Storage,
	input: {
		name: string;
		workflowId: string;
		fireKey: string;
		schedule: CronPacingSchedule;
		now: number;
		scheduledFor?: number;
	},
): Promise<CronPacingState["deferred"]> {
	return storage.transaction(async (tx) => {
		const key = cronPacingKey(input.name);
		const state = (await tx.get<CronPacingState>(key)) ?? {};
		// Adopt pre-upgrade dispatches by name, including superseded schedule IDs.
		// A missing start timestamp or old record is uncertainty, never capacity.
		if (!state.open) {
			const contexts = await tx.list<WorkflowDispatchContext>({
				prefix: "wfctx:",
			});
			for (const [contextKey, context] of contexts) {
				if (
					context.cron?.name !== input.name ||
					contextKey === `wfctx:${state.finishedWorkflowId}`
				)
					continue;
				state.open = {
					workflowId: contextKey.slice("wfctx:".length),
					admittedAt: context.admittedAt ?? 0,
					schedule: input.schedule,
				};
				break;
			}
		}
		let deferred: CronPacingState["deferred"];
		if (state.open) {
			deferred = {
				reason:
					input.now - state.open.admittedAt >= CRON_RECONCILE_AFTER_MS
						? "reconciliation_required"
						: "previous_run_open",
				at: input.now,
			};
		} else if (state.lastFireKey === input.fireKey) {
			deferred = { reason: "fire_already_finished", at: input.now };
		} else if (state.finishedAt !== undefined) {
			const eligibleAt = Math.max(
				state.eligibleAt ?? 0,
				nextEligibleAt(input.schedule, state.finishedAt),
			);
			if (
				input.now < eligibleAt ||
				(input.scheduledFor !== undefined && input.scheduledFor < eligibleAt)
			) {
				deferred = { reason: "completion_cooldown", at: input.now, eligibleAt };
			}
		}
		if (deferred) state.deferred = deferred;
		else {
			state.open = {
				workflowId: input.workflowId,
				admittedAt: input.now,
				schedule: input.schedule,
			};
			state.lastFireKey = input.fireKey;
			delete state.deferred;
		}
		await tx.put(key, state);
		return deferred;
	});
}

/** Terminal callbacks seal once; redrives never call this or release the slot. */
export async function finishCronTask(
	storage: Storage,
	name: string,
	workflowId: string,
	now: number,
): Promise<void> {
	await storage.transaction(async (tx) => {
		const key = cronPacingKey(name);
		const state = await tx.get<CronPacingState>(key);
		if (state?.open?.workflowId !== workflowId) return;
		await tx.put(key, {
			...state,
			open: undefined,
			finishedAt: now,
			finishedWorkflowId: workflowId,
			eligibleAt: nextEligibleAt(state.open.schedule, now),
		});
	});
}

function nextEligibleAt(
	schedule: CronPacingSchedule,
	finishedAt: number,
): number {
	if ("everyMs" in schedule) return finishedAt + schedule.everyMs;
	// Calendar expressions have no fixed millisecond interval. Use the gap
	// between their next two occurrences, paced from completion, not wall time.
	const first = Date.parse(nextSkillScheduleFireAt(schedule.expr, finishedAt));
	const second = Date.parse(nextSkillScheduleFireAt(schedule.expr, first));
	return finishedAt + second - first;
}
