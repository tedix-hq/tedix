import type { Hono } from "hono";
import { logControlFailure } from "../control-log";
import {
	finalizeAbortedSkillRunRestart,
	getSkillRun,
	reconcileSkillRun,
	reserveSkillRunExecutionEpoch,
	skillRunEnvironment,
	updateSkillRunAfterControl,
} from "../db";
import { logRunEvent } from "../observability";
import { workflowEngineErrorText } from "../workflow-engine-error";
import { mapWorkflowEngineStatus } from "../workflow-engine-status";
import {
	abortAmbiguousWorkflowRestart,
	bindWorkflowRestartExecutionEpoch,
	claimWorkflowRestart,
	finalizeWorkflowRestart,
	hasWorkflowExecutionEpochStarted,
	WorkflowRestartConflictError,
} from "../workflow-restart";
import {
	ensureWorkflowRestartSubmissionAttempt,
	settleAbortedWorkflowRestartSubmission,
	settleWorkflowSubmissionBeforeTerminal,
} from "../workflow-submission";
import {
	ControlRequestSchema,
	CancelRequestSchema,
	RestartRequestSchema,
	type AppEnv,
} from "../control-requests";
import {
	type EngineStatusSnapshot,
	type RunStatus,
	workflowEpochConflict,
	workflowControlRestartConflict,
	workflowControlAdmissionConflict,
	workflowControlRetiredConflict,
	readEngineStatus,
	invokeControlWithConfirmation,
} from "../control-admission";

export function registerLifecycleRoutes(app: Hono<AppEnv>) {
	/** Pause a live instance using Cloudflare's native Workflow control API. */
	app.post("/pause", async (c) => {
		const parsed = ControlRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			const handle = await c.env.WORKFLOWS.get(run.instanceId);
			const before = await readEngineStatus(handle);
			if (["paused", "waitingForPause"].includes(before.status)) {
				await updateSkillRunAfterControl(c.env.DB, run.runId, "paused", {
					expectedExecutionEpoch: run.executionEpoch,
				});
				return c.json({
					ok: true,
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					executionEpoch: run.executionEpoch,
					action: "pause",
					status: "paused",
					engineStatus: before.status,
					engine: before,
					deduplicated: true,
				});
			}
			if (["complete", "errored", "terminated"].includes(before.status)) {
				return c.json(
					{
						error: "workflow_not_controllable",
						action: "pause",
						engineStatus: before.status,
					},
					409,
				);
			}
			const confirmed = await invokeControlWithConfirmation({
				handle,
				action: () => handle.pause(),
				accept: (status) => status === "paused" || status === "waitingForPause",
			});
			const status = mapWorkflowEngineStatus(confirmed.engine.status);
			if (!status) {
				throw new Error("workflow engine returned an unrecognized status");
			}
			await updateSkillRunAfterControl(c.env.DB, run.runId, status, {
				expectedExecutionEpoch: run.executionEpoch,
			});
			logRunEvent("run.paused", {
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				previousStatus: run.status,
				status,
			});
			return c.json({
				ok: true,
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				executionEpoch: run.executionEpoch,
				action: "pause",
				status,
				engineStatus: confirmed.engine.status,
				engine: confirmed.engine,
				deduplicated: false,
				operationAttempts: confirmed.operationAttempts,
				statusChecks: confirmed.statusChecks,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("pause", error, run.runId);
			return c.json({ error: "workflow_pause_failed", message }, 502);
		}
	});

	/** Resume an instance that was explicitly paused. */
	app.post("/resume", async (c) => {
		const parsed = ControlRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			const handle = await c.env.WORKFLOWS.get(run.instanceId);
			const before = await readEngineStatus(handle);
			if (before.status === "running" || before.status === "queued") {
				const status = mapWorkflowEngineStatus(before.status);
				if (!status) {
					throw new Error("workflow engine returned an unrecognized status");
				}
				await updateSkillRunAfterControl(c.env.DB, run.runId, status, {
					expectedExecutionEpoch: run.executionEpoch,
				});
				return c.json({
					ok: true,
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					executionEpoch: run.executionEpoch,
					action: "resume",
					status,
					engineStatus: before.status,
					engine: before,
					deduplicated: true,
				});
			}
			if (before.status === "waiting") {
				return c.json(
					{
						error: "workflow_hibernating",
						action: "resume",
						engineStatus: before.status,
						message:
							"the instance is sleeping, between retries, or waiting for an event; wait for its timer or send the matching event when applicable",
					},
					409,
				);
			}
			if (["complete", "errored", "terminated"].includes(before.status)) {
				return c.json(
					{
						error: "workflow_not_controllable",
						action: "resume",
						engineStatus: before.status,
					},
					409,
				);
			}
			const confirmed = await invokeControlWithConfirmation({
				handle,
				action: () => handle.resume(),
				accept: (status) =>
					["queued", "running", "waiting", "complete", "errored"].includes(
						status,
					),
			});
			const status = mapWorkflowEngineStatus(confirmed.engine.status);
			if (!status) {
				throw new Error("workflow engine returned an unrecognized status");
			}
			if (["completed", "failed", "canceled"].includes(status)) {
				const engineError = workflowEngineErrorText(confirmed.engine.error);
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: c.env.DB,
					runId: run.runId,
					organizationId: run.orgId,
					executionEpoch: run.executionEpoch,
					status,
					error: engineError,
				});
				if (!submissionSettled) {
					return c.json(
						{ error: "workflow_submission_settlement_pending" },
						503,
					);
				}
				await reconcileSkillRun(c.env.DB, run.runId, {
					status,
					result: status === "completed" ? confirmed.engine.output : undefined,
					error: status === "failed" ? engineError : null,
					expectedExecutionEpoch: run.executionEpoch,
				});
			} else {
				await updateSkillRunAfterControl(c.env.DB, run.runId, status, {
					expectedExecutionEpoch: run.executionEpoch,
				});
			}
			logRunEvent("run.resumed", {
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				previousStatus: run.status,
				status,
			});
			return c.json({
				ok: true,
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				executionEpoch: run.executionEpoch,
				action: "resume",
				status,
				engineStatus: confirmed.engine.status,
				engine: confirmed.engine,
				deduplicated: false,
				operationAttempts: confirmed.operationAttempts,
				statusChecks: confirmed.statusChecks,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("resume", error, run.runId);
			return c.json({ error: "workflow_resume_failed", message }, 502);
		}
	});

	/** Restart from the beginning or from a native Cloudflare step coordinate. */
	app.post("/restart", async (c) => {
		const parsed = RestartRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_request", issues: parsed.error.issues },
				400,
			);
		}
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			if (parsed.data.abortUnknown) {
				if (!parsed.data.reason) {
					return c.json(
						{
							error: "workflow_restart_abort_reason_required",
							message: "operator abort requires an audit reason",
						},
						400,
					);
				}
				if (
					!run.restartRequestedAt ||
					run.restartCommandId !== parsed.data.restartId
				) {
					const replay = await abortAmbiguousWorkflowRestart({
						db: c.env.DB,
						runId: run.runId,
						restartId: parsed.data.restartId,
						executionEpoch: run.executionEpoch,
						from: parsed.data.from,
						reason: parsed.data.reason,
						dedupeOnly: true,
					});
					return c.json({
						ok: true,
						runId: run.runId,
						workflowInstanceId: run.instanceId,
						action: "restart_abort",
						restartId: parsed.data.restartId,
						from: parsed.data.from ?? null,
						executionEpoch: run.executionEpoch,
						status: run.status as RunStatus,
						engine: null,
						restartAborted: true,
						deduplicated: replay.deduplicated,
						operationAttempts: 0,
						statusChecks: 0,
					});
				}
				if (
					await hasWorkflowExecutionEpochStarted(
						c.env.DB,
						run.runId,
						run.executionEpoch,
					)
				) {
					return c.json(
						{
							error: "workflow_restart_abort_epoch_started",
							message:
								"the reserved epoch has start evidence and cannot be aborted",
						},
						409,
					);
				}
				const handle = await c.env.WORKFLOWS.get(run.instanceId);
				const engine = await readEngineStatus(handle);
				if (engine.status !== "complete" && engine.status !== "errored") {
					return c.json(
						{
							error: "workflow_restart_abort_engine_not_terminal",
							message:
								"operator abort requires the engine to remain on its prior terminal state",
							engineStatus: engine.status,
						},
						409,
					);
				}
				const aborted = await abortAmbiguousWorkflowRestart({
					db: c.env.DB,
					runId: run.runId,
					restartId: parsed.data.restartId,
					executionEpoch: run.executionEpoch,
					from: parsed.data.from,
					reason: parsed.data.reason,
				});
				const submissionAborted = await settleAbortedWorkflowRestartSubmission({
					db: c.env.DB,
					runId: run.runId,
					organizationId: run.orgId,
					restartId: parsed.data.restartId,
					executionEpoch: run.executionEpoch,
				});
				if (!submissionAborted) {
					return c.json(
						{
							error: "workflow_restart_abort_submission_pending",
							message:
								"operator abort was recorded but the reserved submission epoch could not yet be canceled; retry the exact command",
							restartId: parsed.data.restartId,
							executionEpoch: run.executionEpoch,
						},
						503,
					);
				}
				await finalizeAbortedSkillRunRestart(
					c.env.DB,
					run.runId,
					run.executionEpoch,
					parsed.data.restartId,
				);
				const current = await getSkillRun(c.env.DB, run.runId);
				const projectionReady = Boolean(
					current &&
					current.executionEpoch === run.executionEpoch &&
					current.status === "canceled" &&
					current.restartRequestedAt == null &&
					current.restartCommandId == null,
				);
				if (!projectionReady) {
					return c.json(
						{
							error: "workflow_restart_abort_projection_pending",
							message:
								"the reserved submission epoch was canceled but the run projection is not finalized; retry the exact command",
							restartId: parsed.data.restartId,
							executionEpoch: run.executionEpoch,
						},
						503,
					);
				}
				return c.json({
					ok: true,
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					action: "restart_abort",
					restartId: parsed.data.restartId,
					from: parsed.data.from ?? null,
					executionEpoch: run.executionEpoch,
					status: "canceled" as RunStatus,
					engine,
					restartAborted: true,
					deduplicated: aborted.deduplicated,
					operationAttempts: 0,
					statusChecks: 1,
				});
			}
			const handle = await c.env.WORKFLOWS.get(run.instanceId);
			const claim = await claimWorkflowRestart({
				db: c.env.DB,
				runId: run.runId,
				restartId: parsed.data.restartId,
				from: parsed.data.from,
			});
			if (claim.deduplicated) {
				if (claim.receipt.status === "rejected") {
					return c.json(
						{
							error: "workflow_restart_rejected",
							restartId: parsed.data.restartId,
							message:
								"this restart command was definitively rejected before the engine was invoked; use a new restartId after correcting the request",
						},
						409,
					);
				}
				const executionEpoch = claim.receipt.executionEpoch;
				const submissionReady = await ensureWorkflowRestartSubmissionAttempt({
					db: c.env.DB,
					runId: run.runId,
					organizationId: run.orgId,
					restartId: parsed.data.restartId,
					executionEpoch,
				});
				if (!submissionReady) {
					return c.json(
						{
							error: "workflow_restart_submission_pending",
							restartId: parsed.data.restartId,
							executionEpoch,
							message:
								"the engine accepted this restart but its durable submission attempt is not open yet; retry this restartId",
						},
						503,
					);
				}
				const current = await getSkillRun(c.env.DB, run.runId);
				if (!current || current.executionEpoch !== executionEpoch) {
					return c.json(
						{
							error: "workflow_restart_superseded",
							restartId: parsed.data.restartId,
							executionEpoch,
						},
						409,
					);
				}
				// An accepted receipt plus a still-open intent is the narrow crash window
				// after engine acceptance and before the run row reset. Repair only that
				// state; never erase a result that a later reconciler already settled.
				if (current.restartRequestedAt) {
					await updateSkillRunAfterControl(c.env.DB, run.runId, "queued", {
						restart: true,
						clearRestartIntent: false,
						expectedExecutionEpoch: executionEpoch,
						requireRestartIntent: true,
					});
				}
				const repaired = await getSkillRun(c.env.DB, run.runId);
				return c.json({
					ok: true,
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					action: "restart",
					restartId: parsed.data.restartId,
					from: parsed.data.from ?? null,
					executionEpoch,
					status: (repaired?.status ?? "queued") as RunStatus,
					engine: null,
					deduplicated: true,
					operationAttempts: 0,
					statusChecks: 0,
				});
			}

			let before: EngineStatusSnapshot;
			try {
				before = await readEngineStatus(handle);
			} catch (error) {
				await finalizeWorkflowRestart({
					db: c.env.DB,
					runId: run.runId,
					path: claim.path,
					restartId: parsed.data.restartId,
					from: parsed.data.from,
					pendingContent: claim.pendingContent,
					result: { status: "rejected" },
				});
				return c.json(
					{
						error: "workflow_restart_status_failed",
						message: error instanceof Error ? error.message : String(error),
						restartId: parsed.data.restartId,
					},
					502,
				);
			}
			if (before.status !== "complete" && before.status !== "errored") {
				await finalizeWorkflowRestart({
					db: c.env.DB,
					runId: run.runId,
					path: claim.path,
					restartId: parsed.data.restartId,
					from: parsed.data.from,
					pendingContent: claim.pendingContent,
					result: { status: "rejected" },
				});
				return c.json(
					{
						error: "workflow_not_restartable",
						message:
							"Cloudflare restarts are accepted only for completed or errored workflow instances",
						restartId: parsed.data.restartId,
						engineStatus: before.status,
					},
					409,
				);
			}

			const proposedExecutionEpoch = run.executionEpoch + 1;
			const boundPendingContent = await bindWorkflowRestartExecutionEpoch({
				db: c.env.DB,
				runId: run.runId,
				path: claim.path,
				pendingContent: claim.pendingContent,
				executionEpoch: proposedExecutionEpoch,
			});
			const executionEpoch = await reserveSkillRunExecutionEpoch(
				c.env.DB,
				run.runId,
				run.executionEpoch,
				parsed.data.restartId,
			);
			if (executionEpoch == null) {
				await finalizeWorkflowRestart({
					db: c.env.DB,
					runId: run.runId,
					path: claim.path,
					restartId: parsed.data.restartId,
					from: parsed.data.from,
					pendingContent: boundPendingContent,
					result: {
						status: "rejected",
						executionEpoch: proposedExecutionEpoch,
					},
				});
				return c.json(
					{
						error: "workflow_restart_in_progress",
						restartId: parsed.data.restartId,
						message:
							"another restart has an unresolved intent; inspect its control receipt before taking another action",
					},
					409,
				);
			}

			try {
				// Restart is intentionally invoked once. A transport exception is
				// ambiguous and must never trigger a blind second engine operation.
				await handle.restart({ from: parsed.data.from });
			} catch (error) {
				await finalizeWorkflowRestart({
					db: c.env.DB,
					runId: run.runId,
					path: claim.path,
					restartId: parsed.data.restartId,
					from: parsed.data.from,
					pendingContent: boundPendingContent,
					result: { status: "unknown", executionEpoch },
				}).catch((receiptError) =>
					logControlFailure("restart_receipt", receiptError, run.runId),
				);
				const message = error instanceof Error ? error.message : String(error);
				return c.json(
					{
						error: "workflow_restart_ambiguous",
						message,
						restartId: parsed.data.restartId,
						executionEpoch,
					},
					502,
				);
			}

			await finalizeWorkflowRestart({
				db: c.env.DB,
				runId: run.runId,
				path: claim.path,
				restartId: parsed.data.restartId,
				from: parsed.data.from,
				pendingContent: boundPendingContent,
				result: { status: "accepted", executionEpoch },
			});
			const submissionReady = await ensureWorkflowRestartSubmissionAttempt({
				db: c.env.DB,
				runId: run.runId,
				organizationId: run.orgId,
				restartId: parsed.data.restartId,
				executionEpoch,
			});
			if (!submissionReady) {
				return c.json(
					{
						error: "workflow_restart_submission_pending",
						restartId: parsed.data.restartId,
						executionEpoch,
						message:
							"the engine accepted the restart but its durable submission attempt could not be opened; retry this restartId",
					},
					503,
				);
			}
			// A resolved native restart call is acceptance. Reset the prior terminal
			// projection and return queued; an immediate status read can still be the
			// pre-restart terminal snapshot, so reconciliation is deliberately async.
			await updateSkillRunAfterControl(c.env.DB, run.runId, "queued", {
				restart: true,
				clearRestartIntent: false,
				expectedExecutionEpoch: executionEpoch,
				requireRestartIntent: true,
			});
			const restartedRun = await getSkillRun(c.env.DB, run.runId);
			logRunEvent("run.restarted", {
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				previousStatus: run.status,
				status: (restartedRun?.status ?? "queued") as RunStatus,
			});
			return c.json({
				ok: true,
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				action: "restart",
				restartId: parsed.data.restartId,
				from: parsed.data.from ?? null,
				executionEpoch,
				status: (restartedRun?.status ?? "queued") as RunStatus,
				engine: null,
				deduplicated: false,
				operationAttempts: 1,
				statusChecks: 0,
			});
		} catch (error) {
			if (error instanceof WorkflowRestartConflictError) {
				return c.json(
					{
						error: error.code,
						message: error.message,
						receiptStatus: error.receiptStatus ?? null,
					},
					409,
				);
			}
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("restart", error, run.runId);
			return c.json({ error: "workflow_restart_failed", message }, 502);
		}
	});

	/** Terminate a workflow, optionally running registered rollback handlers. */
	app.post("/cancel", async (c) => {
		const parsed = CancelRequestSchema.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
		const run = await getSkillRun(
			c.env.DB,
			parsed.data.runId,
			skillRunEnvironment(c.env.ENVIRONMENT),
		);
		if (!run) return c.json({ error: "not_found" }, 404);
		const epochConflict = workflowEpochConflict(
			run,
			parsed.data.expectedExecutionEpoch,
		);
		if (epochConflict) return c.json(epochConflict, 409);
		const retiredConflict = workflowControlRetiredConflict(run);
		if (retiredConflict) return c.json(retiredConflict, 409);
		const restartConflict = workflowControlRestartConflict(run);
		if (restartConflict) return c.json(restartConflict, 409);
		const admissionConflict = workflowControlAdmissionConflict(run);
		if (admissionConflict) return c.json(admissionConflict, 409);
		if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
		try {
			const handle = await c.env.WORKFLOWS.get(run.instanceId);
			const before = await readEngineStatus(handle);
			if (before.status === "terminated") {
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: c.env.DB,
					runId: run.runId,
					organizationId: run.orgId,
					executionEpoch: run.executionEpoch,
					status: "canceled",
				});
				if (!submissionSettled) {
					return c.json(
						{ error: "workflow_submission_settlement_pending" },
						503,
					);
				}
				await updateSkillRunAfterControl(c.env.DB, run.runId, "canceled", {
					clearRestartIntent: true,
					expectedExecutionEpoch: run.executionEpoch,
				});
				return c.json({
					ok: true,
					runId: run.runId,
					workflowInstanceId: run.instanceId,
					executionEpoch: run.executionEpoch,
					action: "cancel",
					rollback: parsed.data.rollback,
					status: "canceled",
					engineStatus: before.status,
					engine: before,
					deduplicated: true,
				});
			}
			if (before.status === "complete" || before.status === "errored") {
				return c.json(
					{
						error: "workflow_not_controllable",
						action: "cancel",
						engineStatus: before.status,
					},
					409,
				);
			}
			const confirmed = await invokeControlWithConfirmation({
				handle,
				action: () => handle.terminate({ rollback: parsed.data.rollback }),
				accept: (status) => status === "terminated",
			});
			const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
				db: c.env.DB,
				runId: run.runId,
				organizationId: run.orgId,
				executionEpoch: run.executionEpoch,
				status: "canceled",
			});
			if (!submissionSettled) {
				return c.json({ error: "workflow_submission_settlement_pending" }, 503);
			}
			await updateSkillRunAfterControl(c.env.DB, run.runId, "canceled", {
				clearRestartIntent: true,
				expectedExecutionEpoch: run.executionEpoch,
			});
			logRunEvent("run.canceled", {
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				previousStatus: run.status,
				status: "canceled",
			});
			return c.json({
				ok: true,
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				executionEpoch: run.executionEpoch,
				action: "cancel",
				rollback: parsed.data.rollback,
				status: "canceled",
				engineStatus: confirmed.engine.status,
				engine: confirmed.engine,
				deduplicated: false,
				operationAttempts: confirmed.operationAttempts,
				statusChecks: confirmed.statusChecks,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logControlFailure("cancel", error, run.runId);
			return c.json({ error: "workflow_cancel_failed", message }, 502);
		}
	});
}
