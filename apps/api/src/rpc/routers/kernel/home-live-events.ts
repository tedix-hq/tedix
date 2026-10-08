/**
 * Kernel — durable Home live-event recording.
 *
 * Owns the fail-soft D1 projection for batched answer deltas, provisional
 * rationale deltas and phase transitions emitted by KernelDO. The router and Durable Object both depend on this
 * leaf; it must not import `kernel-runtime.ts` or `kernel-do.ts`.
 */

import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { BaseContext } from "../../orpc";
import { insertKernelRuntimeEvent } from "./run-store";
import type { KernelTurnPhase } from "./turn-work";

/**
 * Persist one batched answer-delta chunk as a durable `message.delta` event on
 * the parent run (no childRunId). Called from KernelDO's turn-progress batcher
 * on its flush cadence. Idempotent by sequence number within one stream
 * attempt and fail-soft. Re-driven turns use a distinct attempt namespace so
 * different replayed text remains append-only instead of colliding with the
 * pre-crash partial rows.
 */
export async function recordHomeAnswerDelta(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		delta: string;
		sequence: number;
		/** Zero for the original stream; positive for a durable re-drive. */
		streamAttempt?: number;
		createdAt: string;
	},
): Promise<void> {
	const requestedStreamAttempt = input.streamAttempt ?? 0;
	const streamAttempt =
		Number.isInteger(requestedStreamAttempt) && requestedStreamAttempt > 0
			? requestedStreamAttempt
			: 0;
	try {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "message.delta",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix:
					streamAttempt > 0
						? `answer-delta:redrive:${streamAttempt}:${input.sequence}`
						: `answer-delta:${input.sequence}`,
			}),
			organizationId: input.organizationId,
			kind: "message.delta",
			conversationId: input.conversationId,
			runId: input.runId,
			sequence: input.sequence,
			delta: input.delta,
			payload: {
				role: "assistant",
				channel: "home",
				content: input.delta,
				metadata: {
					homeSubject: true,
					homeRunId: input.runId,
					source: "kernelRuntime.answerStream",
					...(streamAttempt > 0 ? { streamAttempt } : {}),
				},
			},
			runtimeMetadata: {
				source: "kernelRuntime.answerStream",
				sequence: input.sequence,
				...(streamAttempt > 0 ? { streamAttempt } : {}),
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn({
			component: "kernel.home_live_events",
			event: "answer_delta_insert_failed",
			error: safeExceptionTopology(error),
			sequence: input.sequence,
		});
	}
}

/**
 * Persist one kernel-turn PHASE transition as a durable `message.phase` live
 * event on the parent run. Wire shape (the OS frame parser strips unknown
 * TOP-LEVEL keys, so phase data lives in `payload`):
 *
 *   { kind: "message.phase", runId, sequence, createdAt,
 *     payload: { phase: <CHAT_RUNTIME_PHASES value>, detail?: string, at: ISO } }
 *
 * Idempotent by sequence within one turn and fail-soft — persistence cannot
 * affect the turn. Documented in docs/engineering/cognition/runtime.md (Events).
 */
export async function recordHomePhaseEvent(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		sequence: number;
		phase: KernelTurnPhase;
		detail?: string;
		createdAt: string;
	},
): Promise<void> {
	try {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "message.phase",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: `phase:${input.sequence}`,
			}),
			organizationId: input.organizationId,
			kind: "message.phase",
			conversationId: input.conversationId,
			runId: input.runId,
			sequence: input.sequence,
			payload: {
				phase: input.phase,
				...(input.detail ? { detail: input.detail } : {}),
				at: input.createdAt,
				channel: "home",
				metadata: {
					homeSubject: true,
					homeRunId: input.runId,
					source: "kernelRuntime.turnPhase",
				},
			},
			runtimeMetadata: {
				source: "kernelRuntime.turnPhase",
				sequence: input.sequence,
				phase: input.phase,
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn({
			component: "kernel.home_live_events",
			event: "phase_insert_failed",
			error: safeExceptionTopology(error),
			phase: input.phase,
		});
	}
}

/**
 * Persist one batched PROVISIONAL rationale chunk as a durable
 * `message.reasoning` event on the parent run (no childRunId).
 *
 * The planner's `rationale` field streams on every route, so this is the only
 * thing the operator sees while a delegation / write-proposal / workflow /
 * clarification plan is being decided. DISPLAY ONLY — it is never the durable
 * answer, never read back into a transcript, and nothing in accounting,
 * approvals or cost attribution reads these rows. The OS renders it as a
 * provisional thinking line and drops it when the run finalizes.
 *
 * Written on the SAME batched ~1s cadence as `recordHomeAnswerDelta` (the
 * rationale is one or two sentences generated early in the pass, so this is a
 * couple of rows per run, not a write storm). Idempotent by sequence and
 * fail-soft.
 */
export async function recordHomeRationaleDelta(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		delta: string;
		sequence: number;
		createdAt: string;
	},
): Promise<void> {
	try {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "message.reasoning",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: `rationale:${input.sequence}`,
			}),
			organizationId: input.organizationId,
			kind: "message.reasoning",
			conversationId: input.conversationId,
			runId: input.runId,
			sequence: input.sequence,
			delta: input.delta,
			payload: {
				channel: "home",
				content: input.delta,
				provisional: true,
				metadata: {
					homeSubject: true,
					homeRunId: input.runId,
					source: "kernelRuntime.rationaleStream",
				},
			},
			runtimeMetadata: {
				source: "kernelRuntime.rationaleStream",
				sequence: input.sequence,
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn({
			component: "kernel.home_live_events",
			event: "rationale_delta_insert_failed",
			error: safeExceptionTopology(error),
			sequence: input.sequence,
		});
	}
}
