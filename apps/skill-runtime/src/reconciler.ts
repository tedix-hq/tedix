/**
 * Reconciliation loop for skill workflow runs.
 *
 * Runs on the cron schedule defined in `cloudflare.config.ts`. Scans for
 * non-terminal `skill_runs` rows, queries the Workflow engine for each, and
 * writes the engine status back to D1 with `result`/`error`/`completed_at`/
 * `paused_at` fields populated.
 *
 * Idempotent: re-running mid-flight is harmless. Bounded: at most
 * RECONCILE_BATCH_LIMIT rows per tick to keep us inside the cron CPU budget.
 *
 * Status mapping (engine → our enum):
 *   queued        → queued
 *   running       → running
 *   paused        → paused
 *   waiting       → running     (native hibernation: sleep/retry/event)
 *   waitingForPause → paused
 *   complete      → completed
 *   errored       → failed
 *   terminated    → canceled
 */

import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { SubmissionSettleOutcome } from "@tedix/db/queries/runtime-submissions/settlement";
import { logRuntimeFailure, logSkillRuntimeWarning } from "./control-log";
import {
	clearSkillRunRestartIntent,
	listNonTerminalRuns,
	reconcileSkillRun,
	touchSkillRunReconciled,
	updateSkillRunAfterControl,
} from "./db";
import { logRunEvent } from "./observability";
import {
	type WorkflowEngineErrorValue,
	workflowEngineErrorMessage,
	workflowEngineErrorText,
} from "./workflow-engine-error";
import {
	mapWorkflowEngineStatus,
	type WorkflowRunStatus,
} from "./workflow-engine-status";
import {
	fingerprintWorkflowError,
	fingerprintWorkflowOutput,
	getWorkflowExecutionEpochOutcome,
	hasWorkflowExecutionEpochStarted,
	resolveAcceptedWorkflowRestart,
	workflowRestartBarrierState,
} from "./workflow-restart";
import {
	ensureWorkflowRestartSubmissionAttempt,
	ensureWorkflowSubmissionStarted,
	hasWorkflowSubmissionAbortIntent,
	settleWorkflowSubmissionBeforeTerminal,
} from "./workflow-submission";

const RECONCILE_BATCH_LIMIT = 50;

interface EngineStatus {
	status?: string;
	output?: unknown;
	error?: WorkflowEngineErrorValue;
}

interface AbortableWorkflowHandle {
	status(): Promise<EngineStatus>;
	terminate(options?: { rollback?: boolean }): Promise<void>;
}

function submissionOutcome(
	status: WorkflowRunStatus,
): SubmissionSettleOutcome | null {
	if (status === "completed") return "settled";
	if (status === "failed") return "failed";
	if (status === "canceled") return "canceled";
	return null;
}

/**
 * Deliver an API-recorded operator abort through the native Workflow control
 * plane. A terminal status always wins over the abort request; otherwise a
 * later cron/status reconciliation keeps retrying termination until the engine
 * exposes a terminal state. A terminate transport error is accepted only when
 * the follow-up read proves that the operation already took effect.
 */
export async function reconcileWorkflowAbortIntent(input: {
	abortRequested: boolean;
	handle: AbortableWorkflowHandle;
	engine: EngineStatus;
}): Promise<{ engine: EngineStatus; terminationRequested: boolean }> {
	const initialStatus = mapWorkflowEngineStatus(input.engine.status);
	if (
		!input.abortRequested ||
		(initialStatus != null && submissionOutcome(initialStatus) != null)
	) {
		return { engine: input.engine, terminationRequested: false };
	}

	try {
		await input.handle.terminate({ rollback: false });
	} catch (error) {
		const after = await input.handle.status().catch(() => {
			throw error;
		});
		const afterStatus = mapWorkflowEngineStatus(after.status);
		if (afterStatus == null || submissionOutcome(afterStatus) == null) {
			throw error;
		}
		return { engine: after, terminationRequested: true };
	}

	return {
		engine: await input.handle.status(),
		terminationRequested: true,
	};
}

export interface ReconcileEnv {
	DB: D1Database;
	WORKFLOWS: Workflow;
	ENVIRONMENT: "development" | "staging" | "production";
}

export async function reconcileSkillRuns(env: ReconcileEnv): Promise<{
	scanned: number;
	updated: number;
	failed: number;
}> {
	const rows = await listNonTerminalRuns(
		env.DB,
		env.ENVIRONMENT,
		RECONCILE_BATCH_LIMIT,
	);
	let updated = 0;
	let failed = 0;

	for (const row of rows) {
		try {
			let persistedStatus = row.status;
			const abortRequested = await hasWorkflowSubmissionAbortIntent({
				db: env.DB,
				runId: row.runId,
				organizationId: row.organizationId,
				executionEpoch: row.executionEpoch,
			});
			const executionEpochStarted = row.restartRequestedAt
				? await hasWorkflowExecutionEpochStarted(
						env.DB,
						row.runId,
						row.executionEpoch,
					)
				: false;
			let acceptedRestart: Awaited<
				ReturnType<typeof resolveAcceptedWorkflowRestart>
			> = null;
			if (row.restartRequestedAt) {
				acceptedRestart = await resolveAcceptedWorkflowRestart({
					db: env.DB,
					runId: row.runId,
					executionEpoch: row.executionEpoch,
					restartCommandId: row.restartCommandId,
					executionEpochStarted,
				});
				if (acceptedRestart) {
					const submissionReady = await ensureWorkflowRestartSubmissionAttempt({
						db: env.DB,
						runId: row.runId,
						organizationId: row.organizationId,
						restartId: acceptedRestart.restartId,
						executionEpoch: row.executionEpoch,
					});
					if (!submissionReady) continue;
					const staged = await updateSkillRunAfterControl(
						env.DB,
						row.runId,
						"queued",
						{
							restart: true,
							clearRestartIntent: false,
							expectedExecutionEpoch: row.executionEpoch,
							requireRestartIntent: true,
						},
					);
					if (!staged) continue;
					persistedStatus = "queued";
				}
			}
			let handle = await env.WORKFLOWS.get(row.workflowInstanceId);
			let engine = (await handle.status()) as EngineStatus;
			const abortReconciliation = await reconcileWorkflowAbortIntent({
				abortRequested,
				handle,
				engine,
			});
			engine = abortReconciliation.engine;
			if (abortReconciliation.terminationRequested) {
				logRunEvent("run.abort_termination_requested", {
					runId: row.runId,
					workflowInstanceId: row.workflowInstanceId,
					skillId: row.skillId,
					tediId: row.tediId,
					orgId: row.organizationId,
					executionEpoch: row.executionEpoch,
				});
			}
			if (
				row.admissionRecovery &&
				(!engine.status || engine.status === "unknown")
			) {
				const submissionReady = await ensureWorkflowSubmissionStarted({
					db: env.DB,
					runId: row.runId,
					organizationId: row.organizationId,
					tediId: row.tediId,
				});
				if (!submissionReady) continue;
				const admissionExecutionStarted =
					await hasWorkflowExecutionEpochStarted(env.DB, row.runId, 0);
				if (!admissionExecutionStarted) {
					const workflows = wrapWorkflowBinding({
						skillId: row.skillId,
						tediId: row.tediId,
						orgId: row.organizationId,
						runId: row.runId,
					});
					try {
						await workflows.create({ id: row.runId, params: row.params ?? {} });
					} catch {
						// A concurrent or ambiguity-recovery create may already own the id.
					}
					handle = await env.WORKFLOWS.get(row.workflowInstanceId);
					engine = (await handle.status()) as EngineStatus;
				}
			}
			if (!engine.status || engine.status === "unknown") continue;
			const nextStatus = mapWorkflowEngineStatus(engine.status);
			if (!nextStatus) {
				logSkillRuntimeWarning("workflow.reconciliation_status_unrecognized", {
					runId: row.runId,
				});
				continue;
			}
			// The terminate request was accepted but the native engine has not yet
			// exposed a terminal state. Preserve the active D1 projection and retry
			// on the next reconciliation rather than reporting a stale running state.
			if (
				abortReconciliation.terminationRequested &&
				submissionOutcome(nextStatus) == null
			) {
				continue;
			}
			// Two distinct values: the raw message is what the dispatcher already
			// fingerprinted for the epoch fence, while the persisted text carries
			// the thrown type name so the refusal signal reaches D1.
			const errorMessage = workflowEngineErrorMessage(engine.error);
			const error = workflowEngineErrorText(engine.error);
			const engineTerminalFingerprint =
				nextStatus === "completed"
					? await fingerprintWorkflowOutput(engine.output)
					: nextStatus === "failed"
						? await fingerprintWorkflowError(errorMessage)
						: null;
			if (row.restartRequestedAt) {
				const executionEpochOutcome = acceptedRestart
					? await getWorkflowExecutionEpochOutcome(
							env.DB,
							row.runId,
							row.executionEpoch,
						)
					: null;
				const restartBarrier = workflowRestartBarrierState({
					restartRequestedAt: row.restartRequestedAt,
					acceptedRestart,
					engineStatus: nextStatus,
					executionEpochOutcome,
					engineTerminalFingerprint,
				});
				if (restartBarrier === "blocked") continue;
				const cleared = await clearSkillRunRestartIntent(
					env.DB,
					row.runId,
					row.executionEpoch,
				);
				if (!cleared) continue;
			}
			if (row.admissionRecovery) {
				const recoveryStatus = submissionOutcome(nextStatus)
					? "running"
					: nextStatus;
				const clearedAdmissionFailure = await updateSkillRunAfterControl(
					env.DB,
					row.runId,
					recoveryStatus,
					{
						restart: true,
						expectedExecutionEpoch: row.executionEpoch,
						requireAdmissionMarker: true,
					},
				);
				if (!clearedAdmissionFailure) continue;
			}
			if (nextStatus === persistedStatus && !row.admissionRecovery) continue;

			const outcome = submissionOutcome(nextStatus);
			if (outcome) {
				// Settle the durable admission before committing the terminal run
				// projection. If the Worker dies between these writes, the still
				// non-terminal skill_runs row remains eligible for the next sweep;
				// the exactly-once settlement path then replays as a harmless no-op.
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: env.DB,
					runId: row.runId,
					organizationId: row.organizationId,
					executionEpoch: row.executionEpoch,
					status: nextStatus,
					error,
				});
				if (!submissionSettled) continue;
			}
			const reconciled = await reconcileSkillRun(env.DB, row.runId, {
				status: nextStatus,
				result: nextStatus === "completed" ? engine.output : undefined,
				error: nextStatus === "failed" ? error : null,
				expectedExecutionEpoch: row.executionEpoch,
			});
			if (!reconciled) continue;
			updated++;
			logRunEvent("run.reconciled", {
				runId: row.runId,
				workflowInstanceId: row.workflowInstanceId,
				previousStatus: persistedStatus,
				status: nextStatus,
				error: nextStatus === "failed" ? error : null,
			});
		} catch (err) {
			failed++;
			logRuntimeFailure("workflow.reconciliation_row.failed", err, row.runId);
			logRunEvent("run.reconciled", {
				runId: row.runId,
				workflowInstanceId: row.workflowInstanceId,
				previousStatus: row.status,
				status: row.status,
				error: "reconciliation_failed",
			});
		} finally {
			await touchSkillRunReconciled(env.DB, row.runId).catch((error) =>
				logRuntimeFailure(
					"workflow.reconciliation_cursor.failed",
					error,
					row.runId,
				),
			);
		}
	}

	return { scanned: rows.length, updated, failed };
}
