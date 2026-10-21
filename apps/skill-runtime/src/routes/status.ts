import type { Hono } from "hono";
import { logRuntimeFailure } from "../control-log";
import {
	clearSkillRunRestartIntent,
	getSkillRun,
	reconcileSkillRun,
	skillRunEnvironment,
	updateSkillRunAfterControl,
} from "../db";
import { logRunEvent } from "../observability";
import { isAdmissionCreateFailureMarker } from "../workflow-admission";
import {
	type WorkflowEngineErrorValue,
	workflowEngineErrorMessage,
	workflowEngineErrorText,
} from "../workflow-engine-error";
import { mapWorkflowEngineStatus } from "../workflow-engine-status";
import {
	fingerprintWorkflowError,
	fingerprintWorkflowOutput,
	getWorkflowExecutionEpochOutcome,
	hasWorkflowExecutionEpochStarted,
	resolveAcceptedWorkflowRestart,
	workflowRestartBarrierState,
} from "../workflow-restart";
import {
	ensureWorkflowRestartSubmissionAttempt,
	settleWorkflowSubmissionBeforeTerminal,
} from "../workflow-submission";
import { StatusRequestSchema, type AppEnv } from "../control-requests";
import {
	type RunStatus,
	workflowControlRetiredConflict,
} from "../control-admission";

export function registerStatusRoutes(app: Hono<AppEnv>) {
	/**
	 * POST /status
	 * Reconcile the run row against the workflow engine and return the
	 * caller-facing status shape: { status, result?, error?, completedAt?,
	 * pausedAt? }. Reconcile-on-read keeps individual lookups fresh between
	 * cron ticks.
	 */
	app.post("/status", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const parsed = StatusRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "invalid_request" }, 400);
		}
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		if (workflowControlRetiredConflict(run)) {
			return c.json({
				status: run.status as RunStatus,
				result: null,
				error: run.error,
				completedAt: run.completedAt,
				pausedAt: run.pausedAt,
				executionEpoch: run.executionEpoch,
				restartId: null,
				engine: null,
			});
		}

		const TERMINAL: RunStatus[] = ["completed", "failed", "canceled"];
		let status = run.status as RunStatus;
		let result: unknown = null;
		let error: string | null = null;
		let completedAt: string | null = null;
		let pausedAt: string | null = null;
		const executionEpochStarted = run.restartRequestedAt
			? await hasWorkflowExecutionEpochStarted(
					c.env.DB,
					run.runId,
					run.executionEpoch,
				)
			: false;
		const acceptedRestart =
			run.executionEpoch > 0
				? await resolveAcceptedWorkflowRestart({
						db: c.env.DB,
						runId: run.runId,
						executionEpoch: run.executionEpoch,
						restartCommandId: run.restartCommandId,
						executionEpochStarted,
					})
				: null;
		if (run.restartRequestedAt && acceptedRestart) {
			const submissionReady = await ensureWorkflowRestartSubmissionAttempt({
				db: c.env.DB,
				runId: run.runId,
				organizationId: run.orgId,
				restartId: acceptedRestart.restartId,
				executionEpoch: run.executionEpoch,
			});
			if (!submissionReady) {
				return c.json({
					status: "queued" as RunStatus,
					result: null,
					error: null,
					completedAt: null,
					pausedAt: null,
					executionEpoch: run.executionEpoch,
					restartId: acceptedRestart.restartId,
					engine: null,
				});
			}
			const staged = await updateSkillRunAfterControl(
				c.env.DB,
				run.runId,
				"queued",
				{
					restart: true,
					clearRestartIntent: false,
					expectedExecutionEpoch: run.executionEpoch,
					requireRestartIntent: true,
				},
			);
			if (!staged) {
				const current = await getSkillRun(c.env.DB, run.runId);
				if (!current) return c.json({ error: "not_found" }, 404);
				return c.json({
					status: current.status as RunStatus,
					result: null,
					error: null,
					completedAt: current.completedAt,
					pausedAt: current.pausedAt,
					executionEpoch: current.executionEpoch,
					restartId: null,
					engine: null,
				});
			}
			status = "queued";
		}

		// `engine` is Cloudflare's lifecycle snapshot (status/error/output), not a
		// step timeline. Agent-readable step/attempt/call inspection comes from the
		// durable Tedix artifacts recorded by the dispatch shim.
		let engineSnapshot: Record<string, unknown> | null = null;

		if (run.instanceId) {
			try {
				const handle = await c.env.WORKFLOWS.get(run.instanceId);
				const engine = (await handle.status()) as {
					status?: string;
					output?: unknown;
					error?: WorkflowEngineErrorValue;
				};
				engineSnapshot = engine as unknown as Record<string, unknown>;
				const mapped = mapWorkflowEngineStatus(engine.status);
				if (mapped) {
					// The raw message is the epoch-fence fingerprint input the dispatcher
					// already used; `errText` is the persisted projection and carries the
					// thrown type name. The cron reconciler derives both the same way.
					const errMsg = workflowEngineErrorMessage(engine.error);
					const errText = workflowEngineErrorText(engine.error);
					if (isAdmissionCreateFailureMarker(run)) {
						// An accepted engine may finish before the admission-marker clear is
						// durably observed. Move that exact marker to a non-terminal state
						// before settlement/projection; the marker CAS prevents a late status
						// observer from resetting truth already committed by another observer.
						const admissionStatus = [
							"completed",
							"failed",
							"canceled",
						].includes(mapped)
							? "running"
							: mapped;
						const stagedAdmission = await updateSkillRunAfterControl(
							c.env.DB,
							run.runId,
							admissionStatus,
							{
								restart: true,
								expectedExecutionEpoch: run.executionEpoch,
								requireAdmissionMarker: true,
							},
						);
						if (!stagedAdmission) {
							const current = await getSkillRun(c.env.DB, run.runId);
							if (!current) return c.json({ error: "not_found" }, 404);
							return c.json({
								status: current.status as RunStatus,
								result: null,
								error: current.error,
								completedAt: current.completedAt,
								pausedAt: current.pausedAt,
								executionEpoch: current.executionEpoch,
								restartId: null,
								engine: engineSnapshot,
							});
						}
						status = admissionStatus;
					}
					const engineTerminalFingerprint =
						mapped === "completed"
							? await fingerprintWorkflowOutput(engine.output)
							: mapped === "failed"
								? await fingerprintWorkflowError(errMsg)
								: null;
					let restartBarrier = workflowRestartBarrierState({
						restartRequestedAt: run.restartRequestedAt,
						acceptedRestart,
						engineStatus: mapped,
						executionEpochOutcome: null,
						engineTerminalFingerprint,
					});
					if (run.restartRequestedAt && acceptedRestart) {
						const executionEpochOutcome =
							await getWorkflowExecutionEpochOutcome(
								c.env.DB,
								run.runId,
								run.executionEpoch,
							);
						restartBarrier = workflowRestartBarrierState({
							restartRequestedAt: run.restartRequestedAt,
							acceptedRestart,
							engineStatus: mapped,
							executionEpochOutcome,
							engineTerminalFingerprint,
						});
						if (restartBarrier === "released") {
							const cleared = await clearSkillRunRestartIntent(
								c.env.DB,
								run.runId,
								run.executionEpoch,
							);
							if (!cleared) {
								const current = await getSkillRun(c.env.DB, run.runId);
								if (
									!current ||
									current.executionEpoch !== run.executionEpoch ||
									current.restartRequestedAt
								) {
									restartBarrier = "blocked";
								}
							}
						}
					}
					if (restartBarrier === "blocked") {
						logRunEvent("run.restart_fenced", {
							runId: run.runId,
							workflowInstanceId: run.instanceId,
							status: mapped,
							executionEpoch: run.executionEpoch,
						});
					} else if (mapped !== status) {
						const terminalMapped =
							mapped === "completed" ||
							mapped === "failed" ||
							mapped === "canceled"
								? mapped
								: null;
						const terminalSubmissionReady = terminalMapped
							? await settleWorkflowSubmissionBeforeTerminal({
									db: c.env.DB,
									runId: run.runId,
									organizationId: run.orgId,
									executionEpoch: run.executionEpoch,
									status: terminalMapped,
									error: errText,
								})
							: true;
						if (!terminalSubmissionReady) {
							logRunEvent("run.terminal_submission_pending", {
								runId: run.runId,
								workflowInstanceId: run.instanceId,
								status: mapped,
								executionEpoch: run.executionEpoch,
							});
						} else {
							const applied = await reconcileSkillRun(c.env.DB, run.runId, {
								status: mapped,
								result: mapped === "completed" ? engine.output : undefined,
								error: mapped === "failed" ? errText : null,
								expectedExecutionEpoch: run.executionEpoch,
							});
							if (!applied) {
								const current = await getSkillRun(c.env.DB, run.runId);
								if (!current) return c.json({ error: "not_found" }, 404);
								return c.json({
									status: current.status as RunStatus,
									result: null,
									error: null,
									completedAt: current.completedAt,
									pausedAt: current.pausedAt,
									executionEpoch: current.executionEpoch,
									restartId: null,
									engine: engineSnapshot,
								});
							}
							logRunEvent("run.reconciled", {
								runId: run.runId,
								workflowInstanceId: run.instanceId,
								previousStatus: status,
								status: mapped,
								error: mapped === "failed" ? errText : null,
							});
							status = mapped;
							if (mapped === "completed") result = engine.output;
							if (mapped === "failed") error = errText;
						}
					}
				}
			} catch (err) {
				logRuntimeFailure(
					"workflow.status_confirmation.failed",
					err,
					run.runId,
				);
			}
		}

		if (TERMINAL.includes(status)) {
			const fresh = await getSkillRun(c.env.DB, run.runId);
			completedAt = fresh?.completedAt ?? null;
			pausedAt = fresh?.pausedAt ?? null;
		}

		return c.json({
			status,
			result,
			error,
			completedAt,
			pausedAt,
			executionEpoch: run.executionEpoch,
			restartId: acceptedRestart?.restartId ?? null,
			engine: engineSnapshot,
		});
	});
}
