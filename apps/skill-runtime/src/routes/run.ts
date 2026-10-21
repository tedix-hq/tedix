import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { Hono } from "hono";
import { logRuntimeFailure } from "../control-log";
import {
	createSkillRun,
	getSkillRun,
	reconcileSkillRun,
	skillRunEnvironment,
	updateSkillRunAfterControl,
} from "../db";
import { logRunEvent } from "../observability";
import {
	claimImplicitWorkflowAdmission,
	deriveIdempotentRunId,
	isAdmissionCreateFailureMarker,
	pruneExpiredWorkflowAdmissionDedup,
	releaseImplicitWorkflowAdmission,
	WORKFLOW_ADMISSION_CREATE_FAILED,
	workflowAdmissionFingerprint,
} from "../workflow-admission";
import { workflowEngineErrorText } from "../workflow-engine-error";
import { mapWorkflowEngineStatus } from "../workflow-engine-status";
import {
	ensureWorkflowSubmissionStarted,
	settleWorkflowSubmissionBeforeTerminal,
} from "../workflow-submission";
import { RunRequestSchema, type AppEnv } from "../control-requests";
import {
	type RunStatus,
	readAcceptedEngineStatus,
	snapshotMatchesAdmission,
	recoverFailedAdmission,
	workflowEnvironmentMismatch,
} from "../control-admission";

export function registerRunRoutes(app: Hono<AppEnv>) {
	/**
	 * POST /run
	 * Create a new skill run. Inserts a `skill_runs` row, then dispatches a
	 * workflow instance via the wrapped Workflow binding so dispatcher
	 * metadata is preserved across the dynamic-workflow indirection.
	 */
	app.post("/run", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const parsed = RunRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: "invalid_request", issues: parsed.error.issues },
				400,
			);
		}
		const {
			runId: explicitRunId,
			idempotencyKey,
			skillId,
			tediId,
			orgId,
			params,
			skillSlug,
			skillRevision,
			workflowSource,
			skillDoc,
			capabilityManifest,
			resourceAccessEnvelope,
			createdBy,
			workItemId,
			originTediRunId,
		} = parsed.data;
		const requestedRunId =
			explicitRunId ??
			(idempotencyKey
				? await deriveIdempotentRunId({
						orgId,
						skillId,
						tediId,
						runtimeEnvironment: skillRunEnvironment(c.env.ENVIRONMENT),
						idempotencyKey,
					})
				: undefined);
		let admissionRunId = requestedRunId;
		let implicitDeduplication = false;
		let implicitFingerprint: string | null = null;
		let ownsImplicitReservation = false;
		if (!admissionRunId) {
			const fingerprint = await workflowAdmissionFingerprint({
				orgId,
				skillId,
				tediId,
				runtimeEnvironment: skillRunEnvironment(c.env.ENVIRONMENT),
				skillRevision: skillRevision ?? null,
				params: params ?? {},
				workflowSource,
				skillDoc,
				capabilityManifest,
				workItemId: workItemId ?? null,
				originTediRunId: originTediRunId ?? null,
			});
			implicitFingerprint = fingerprint;
			const claimed = await claimImplicitWorkflowAdmission({
				db: c.env.DB,
				fingerprint,
				candidateRunId: crypto.randomUUID(),
			});
			admissionRunId = claimed.runId;
			implicitDeduplication = claimed.deduplicated;
			ownsImplicitReservation = !claimed.deduplicated;
			c.executionCtx.waitUntil(
				pruneExpiredWorkflowAdmissionDedup(c.env.DB).catch((error) => {
					logRuntimeFailure("workflow.admission_dedup_prune.failed", error);
				}),
			);
		}
		if (admissionRunId) {
			let existing = await getSkillRun(c.env.DB, admissionRunId);
			if (!existing && implicitDeduplication) {
				for (let attempt = 0; attempt < 4 && !existing; attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 25));
					existing = await getSkillRun(c.env.DB, admissionRunId);
				}
				if (!existing) {
					return c.json(
						{
							error: "workflow_admission_pending",
							message:
								"an identical workflow admission is still creating its canonical run; retry this request",
							runId: admissionRunId,
							retryable: true,
						},
						503,
					);
				}
			}
			if (existing) {
				const environmentMismatch = workflowEnvironmentMismatch(
					existing,
					skillRunEnvironment(c.env.ENVIRONMENT),
				);
				if (
					environmentMismatch ||
					!(await snapshotMatchesAdmission(
						c.env.DB,
						parsed.data,
						admissionRunId,
						skillRunEnvironment(c.env.ENVIRONMENT),
					))
				) {
					return c.json(
						{
							error: "run_id_conflict",
							message: environmentMismatch
								? "the requested runId belongs to a different Workflow binding environment"
								: "the requested runId is already pinned to a different workflow identity or source snapshot",
							runId: admissionRunId,
							idempotencyKey: idempotencyKey ?? null,
						},
						409,
					);
				}
				let status = existing.status as RunStatus;
				if (isAdmissionCreateFailureMarker(existing)) {
					const recovered = await recoverFailedAdmission(
						c.env,
						parsed.data,
						admissionRunId,
					);
					if (!recovered) {
						return c.json(
							{
								error: "workflow_admission_recovery_pending",
								message:
									"the matching run is still repairing its pre-engine admission; retry the same runId or idempotencyKey",
								runId: admissionRunId,
								retryable: true,
							},
							503,
						);
					}
					status = recovered;
				}
				if (existing.restartRequestedAt) status = "queued";
				return c.json({
					runId: existing.runId,
					workflowInstanceId: existing.instanceId,
					status,
					executionEpoch: existing.executionEpoch,
					deduplicated: true,
					idempotencyKey: idempotencyKey ?? null,
				});
			}
		}

		let rateLimitAllowed = true;
		try {
			if (c.env.RUN_RATE_LIMITER) {
				const rateLimit = await c.env.RUN_RATE_LIMITER.limit({
					key: `skill-run:${orgId}:${tediId}`,
				});
				rateLimitAllowed = rateLimit.success;
			}
		} catch (error) {
			logRuntimeFailure("workflow.admission_rate_limiter.failed", error);
		}
		if (!rateLimitAllowed) {
			if (ownsImplicitReservation && implicitFingerprint && admissionRunId) {
				await releaseImplicitWorkflowAdmission({
					db: c.env.DB,
					fingerprint: implicitFingerprint,
					runId: admissionRunId,
				});
			}
			return c.json(
				{
					error: "rate_limited",
					message: "skill workflow admission rate exceeded",
					retryable: true,
				},
				429,
			);
		}

		const runId = admissionRunId ?? crypto.randomUUID();

		// Create the run row before dispatching the Workflow. The Workflow engine
		// can invoke the factory as soon as `create()` resolves; the factory reads
		// this snapshot and has no live skill fallback.
		const workflows = wrapWorkflowBinding({
			skillId,
			tediId,
			orgId,
			runId,
		});

		try {
			await createSkillRun(c.env.DB, {
				runId,
				skillId,
				tediId,
				orgId,
				workflowInstanceId: runId,
				params,
				workflowSource: workflowSource ?? null,
				skillDoc: skillDoc ?? null,
				skillRevision: skillRevision ?? null,
				skillSlug: skillSlug ?? null,
				capabilityManifest: capabilityManifest ?? null,
				resourceAccessEnvelope,
				createdBy: createdBy ?? null,
				workItemId: workItemId ?? null,
				originTediRunId: originTediRunId ?? null,
				runtimeEnvironment: skillRunEnvironment(c.env.ENVIRONMENT),
			});
		} catch (err) {
			// Close the create race for every reserved admission identity. A matching
			// row is a deduplicated success; any mismatch remains a hard conflict.
			if (admissionRunId) {
				const existing = await getSkillRun(c.env.DB, admissionRunId);
				if (existing) {
					const environmentMismatch = workflowEnvironmentMismatch(
						existing,
						skillRunEnvironment(c.env.ENVIRONMENT),
					);
					if (
						environmentMismatch ||
						!(await snapshotMatchesAdmission(
							c.env.DB,
							parsed.data,
							admissionRunId,
							skillRunEnvironment(c.env.ENVIRONMENT),
						))
					) {
						return c.json(
							{
								error: "run_id_conflict",
								message: environmentMismatch
									? "the requested runId raced with a run from a different Workflow binding environment"
									: "the requested runId raced with a different workflow identity or source snapshot",
								runId: admissionRunId,
								idempotencyKey: idempotencyKey ?? null,
							},
							409,
						);
					}
					let status = existing.status as RunStatus;
					if (isAdmissionCreateFailureMarker(existing)) {
						const recovered = await recoverFailedAdmission(
							c.env,
							parsed.data,
							admissionRunId,
						);
						if (!recovered) {
							return c.json(
								{
									error: "workflow_admission_recovery_pending",
									message:
										"the matching run is still repairing its pre-engine admission; retry the same runId or idempotencyKey",
									runId: admissionRunId,
									retryable: true,
								},
								503,
							);
						}
						status = recovered;
					}
					if (existing.restartRequestedAt) status = "queued";
					return c.json({
						runId: existing.runId,
						workflowInstanceId: existing.instanceId,
						status,
						executionEpoch: existing.executionEpoch,
						deduplicated: true,
						idempotencyKey: idempotencyKey ?? null,
					});
				}
			}
			if (ownsImplicitReservation && implicitFingerprint) {
				await releaseImplicitWorkflowAdmission({
					db: c.env.DB,
					fingerprint: implicitFingerprint,
					runId,
				});
			}
			logRunEvent("run.create_failed", {
				runId,
				skillId,
				tediId,
				orgId,
				error: err instanceof Error ? err.message : String(err),
			});
			return c.json(
				{
					error: "create_run_failed",
					message: err instanceof Error ? err.message : String(err),
				},
				500,
			);
		}

		try {
			const submissionReady = await ensureWorkflowSubmissionStarted({
				db: c.env.DB,
				runId,
				organizationId: orgId,
				tediId,
			});
			if (!submissionReady) {
				throw new Error(
					"workflow submission admission did not open an attempt",
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await reconcileSkillRun(c.env.DB, runId, {
				status: "failed",
				error: `${WORKFLOW_ADMISSION_CREATE_FAILED} submission admission failed: ${message}`,
				expectedExecutionEpoch: 0,
			});
			return c.json(
				{
					error: "workflow_submission_admission_failed",
					message,
					runId,
				},
				500,
			);
		}

		let instanceId = runId;
		try {
			const instance = await workflows.create({
				id: runId,
				params: params ?? {},
			});
			// `instance.id` may be an RPC property on the wrapped binding — await
			// in case it's a lazy getter, then coerce to a plain string. We pass
			// `id: runId`, so any other id is a platform invariant violation.
			instanceId = String(await instance.id);
			if (instanceId !== runId) {
				try {
					const handle = await c.env.WORKFLOWS.get(instanceId);
					await handle.terminate();
				} catch {}
				const message = `workflow id mismatch: expected ${runId}, got ${instanceId}`;
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: c.env.DB,
					runId,
					organizationId: orgId,
					executionEpoch: 0,
					status: "failed",
					error: message,
				});
				if (submissionSettled) {
					await reconcileSkillRun(c.env.DB, runId, {
						status: "failed",
						error: message,
						expectedExecutionEpoch: 0,
					});
				}
				logRunEvent("run.create_failed", {
					runId,
					workflowInstanceId: instanceId,
					skillId,
					tediId,
					orgId,
					error: message,
				});
				return c.json({ error: "workflow_id_mismatch", message }, 500);
			}
			const admitted = await updateSkillRunAfterControl(
				c.env.DB,
				runId,
				"queued",
				{
					restart: true,
					expectedExecutionEpoch: 0,
					requireAdmissionMarker: true,
				},
			);
			if (!admitted) {
				throw new Error("workflow admission marker could not be cleared");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const accepted = await readAcceptedEngineStatus(c.env, runId);
			if (accepted) {
				const status = mapWorkflowEngineStatus(accepted.status);
				if (!status) {
					throw new Error("workflow engine returned an unrecognized status");
				}
				const terminal =
					status === "completed" ||
					status === "failed" ||
					status === "canceled";
				// Keep the run non-terminal until the matching durable submission
				// settles. This closes the engine-accepted/response-lost crash window.
				await updateSkillRunAfterControl(
					c.env.DB,
					runId,
					terminal ? "running" : status,
					{
						restart: true,
						expectedExecutionEpoch: 0,
						requireAdmissionMarker: true,
					},
				);
				if (terminal) {
					const engineError = workflowEngineErrorText(accepted.error);
					const submissionSettled =
						await settleWorkflowSubmissionBeforeTerminal({
							db: c.env.DB,
							runId,
							organizationId: orgId,
							executionEpoch: 0,
							status,
							error: engineError,
						});
					if (!submissionSettled) {
						return c.json({
							runId,
							workflowInstanceId: runId,
							status: "running",
							executionEpoch: 0,
							deduplicated: false,
							idempotencyKey: idempotencyKey ?? null,
						});
					}
					await reconcileSkillRun(c.env.DB, runId, {
						status,
						result: status === "completed" ? accepted.output : undefined,
						error: status === "failed" ? engineError : null,
						expectedExecutionEpoch: 0,
					});
				}
				logRunEvent("run.dispatched", {
					runId,
					workflowInstanceId: runId,
					skillId,
					tediId,
					orgId,
					status,
					admissionResponseRecovered: true,
				});
				return c.json({
					runId,
					workflowInstanceId: runId,
					status,
					executionEpoch: 0,
					deduplicated: false,
					idempotencyKey: idempotencyKey ?? null,
				});
			}
			await reconcileSkillRun(c.env.DB, runId, {
				status: "failed",
				error: `${WORKFLOW_ADMISSION_CREATE_FAILED} ${message}`,
			});
			logRunEvent("run.create_failed", {
				runId,
				workflowInstanceId: instanceId,
				skillId,
				tediId,
				orgId,
				error: message,
			});
			return c.json(
				{
					error: "workflow_create_failed",
					message,
				},
				500,
			);
		}

		logRunEvent("run.dispatched", {
			runId,
			workflowInstanceId: instanceId,
			skillId,
			tediId,
			orgId,
			status: "queued",
		});
		return c.json({
			runId,
			workflowInstanceId: instanceId,
			status: "queued",
			executionEpoch: 0,
			deduplicated: false,
			idempotencyKey: idempotencyKey ?? null,
		});
	});
}
