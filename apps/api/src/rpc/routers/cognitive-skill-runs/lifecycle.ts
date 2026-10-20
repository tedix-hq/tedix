import {
	retireSkillRunForRevocation,
	type SkillRun,
	type SkillRunStatus,
} from "@tedix/db/queries/skill-runs";
import {
	isPendingSkillWorkflowAdmission,
	kernelRunStatusToSubmissionOutcome,
	restartTediSubmissionAttempt,
	settleTediSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { callSkillRuntime } from "../../../services/skill-runtime-client";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import {
	type SkillRuntimeLifecycleResponse,
	skillRuntimeLifecycleEngine,
	getSkillRunForEnvironment,
	requireWorkflowRunTedi,
	type SkillRuntimeStatusResponse,
} from "./shared";

async function applySkillWorkflowLifecycleResponse(
	_context: BaseContext,
	run: SkillRun,
	remote: SkillRuntimeLifecycleResponse,
	_options?: { resetTerminalState?: boolean },
) {
	return {
		runId: run.id,
		status: remote.status,
		engine: skillRuntimeLifecycleEngine(remote),
		executionEpoch: remote.executionEpoch,
		restartId: remote.restartId,
		restartAborted: remote.restartAborted,
		deduplicated: remote.deduplicated,
	};
}

export const skillsPauseWorkflow = authedSkills.pauseWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/pause",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsResumeWorkflow = authedSkills.resumeWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/resume",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsRestartWorkflow = authedSkills.restartWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/restart",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				restartId: input.restartId,
				abortUnknown: input.abortUnknown,
				reason: input.reason,
				from: input.from,
			},
		);
		if (!remote.restartAborted) {
			if (remote.executionEpoch == null) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Workflow runtime accepted restart without an execution epoch",
				);
			}
			// Reconcile the additive submission ledger on every confirmed restart,
			// not only when the pre-call skill_runs snapshot looked terminal. This
			// makes a retry repair an engine-first/ledger-second partial failure.
			const submission = await restartTediSubmissionAttempt(context.db, {
				runId: run.id,
				organizationId: orgId,
				tediId: run.tediId,
				restartId: input.restartId,
				executionEpoch: remote.executionEpoch,
			});
			if (!submission.restarted && !submission.alreadyRunning) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Workflow engine restarted but its durable submission attempt could not be reopened",
				);
			}
		}
		const result = await applySkillWorkflowLifecycleResponse(
			context,
			run,
			remote,
			{
				resetTerminalState: !["completed", "failed", "canceled"].includes(
					remote.status,
				),
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return result;
	});

export const skillsApproveWorkflow = authedSkills.approveWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/approve",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				approvalId: input.approvalId,
				reason: input.reason,
				payload: input.payload ?? {},
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsRejectWorkflow = authedSkills.rejectWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/reject",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				approvalId: input.approvalId,
				reason: input.reason,
				payload: input.payload ?? {},
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

// =============================================================================
// SKILL RUN ARTIFACTS
// =============================================================================

const REVOCABLE_SKILL_RUN_STATUSES = new Set<SkillRunStatus>([
	"completed",
	"failed",
	"canceled",
]);

const TERMINAL_WORKFLOW_ENGINE_STATUSES = new Set([
	"complete",
	"errored",
	"terminated",
]);

function revokedSkillRunReason(error: string | null): string | undefined {
	if (error === "REVOKED") return undefined;
	if (!error?.startsWith("REVOKED:")) return undefined;
	return error.slice("REVOKED:".length).trim() || undefined;
}

function requireRevocableSkillRunProjection(run: SkillRun): void {
	if (isPendingSkillWorkflowAdmission(run)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_ADMISSION_PENDING: revoke is blocked until engine admission is reconciled",
		);
	}
	if (run.restartRequestedAt) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_RESTART_IN_PROGRESS: revoke is blocked while a restart intent is unresolved",
		);
	}
	if (!REVOCABLE_SKILL_RUN_STATUSES.has(run.status)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_NOT_TERMINAL: cancel the workflow and confirm a terminal engine state before revoking its artifacts",
		);
	}
}

export const skillsRevokeSkillRun = authedSkills.revokeSkillRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}

		const alreadyRevoked =
			run.error === "REVOKED" || run.error?.startsWith("REVOKED:") === true;
		// Legacy REVOKED rows predate the durable workflow tombstone. Their
		// destructive cleanup already ran under the old contract, so retain the
		// historical no-op behavior without trying to recreate deleted evidence.
		if (alreadyRevoked && !run.workflowRetiredAt) {
			return {
				runId: run.id,
				revoked: true,
				artifactsDeleted: 0,
				r2ObjectsDeleted: 0,
				factsDeleted: 0,
				musclesDeleted: 0,
				reason: revokedSkillRunReason(run.error),
			};
		}

		const reasonText = input.reason?.trim() ?? "";
		const durableClaimed = Boolean(alreadyRevoked && run.workflowRetiredAt);
		let effectiveReasonText = durableClaimed
			? (revokedSkillRunReason(run.error) ?? "")
			: reasonText;
		if (durableClaimed) {
			if (reasonText && reasonText !== effectiveReasonText) {
				throw createError(
					ErrorCodes.CONFLICT,
					"WORKFLOW_REVOKE_CONFLICT: this run was already claimed with a different audit reason",
				);
			}
		} else {
			requireRevocableSkillRunProjection(run);

			// An operator-abort tombstone is itself durable proof that factory
			// entry lost the start/abort race; the runtime intentionally hides its
			// stale prior engine snapshot. All other first claims require a live
			// terminal engine read because D1 terminal state alone may be stale.
			if (!run.workflowRetiredAt) {
				const remote = await callSkillRuntime<SkillRuntimeStatusResponse>(
					context,
					"/status",
					{ workflowInstanceId: run.workflowInstanceId, runId: run.id },
				);
				const engineStatus =
					typeof remote.engine?.status === "string"
						? remote.engine.status
						: null;
				if (
					remote.executionEpoch != null &&
					remote.executionEpoch !== (run.executionEpoch ?? 0)
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_EXECUTION_EPOCH_CONFLICT: the run advanced while revoke was checking engine state",
					);
				}
				if (
					!REVOCABLE_SKILL_RUN_STATUSES.has(remote.status) ||
					!engineStatus ||
					!TERMINAL_WORKFLOW_ENGINE_STATUSES.has(engineStatus)
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						`WORKFLOW_ENGINE_NOT_TERMINAL: observed ${engineStatus ?? "unavailable"}; cancel and confirm terminal status before revoking`,
					);
				}
			}

			const retired = await retireSkillRunForRevocation(context.db, {
				runId: run.id,
				organizationId: orgId,
				runtimeEnvironment: context.env.ENVIRONMENT,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				reason: reasonText,
			});
			if (!retired) {
				const current = await getSkillRunForEnvironment(context, run.id, orgId);
				const concurrentRevoke = Boolean(
					current?.workflowRetiredAt &&
					(current.error === "REVOKED" ||
						current.error?.startsWith("REVOKED:") === true),
				);
				if (!concurrentRevoke) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_REVOKE_CONFLICT: run lifecycle changed before the retirement claim; inspect status and retry",
					);
				}
				const storedReason =
					revokedSkillRunReason(current?.error ?? null) ?? "";
				if (reasonText && reasonText !== storedReason) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_REVOKE_CONFLICT: this run was already claimed with a different audit reason",
					);
				}
				effectiveReasonText = storedReason;
			}
		}

		// The workflow tombstone and REVOKED audit marker are now durable. Only
		// after that CAS may source-keyed cleanup begin. Repeating this section is
		// safe and repairs a prior partial D1/R2/fact deletion.
		// 1) D1 artifact rows. The (run_id, path) UNIQUE index handles
		//    dupes; cascade FK takes care of any future child tables.
		const { listRunArtifacts, deleteRunArtifacts } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const beforeArtifacts = await listRunArtifacts(context.db, run.id);
		const artifactsDeleted = await deleteRunArtifacts(context.db, run.id);

		// 2) R2 objects under `{runId}/` prefix. List then delete in batch.
		//    Skipped if the binding isn't configured (test envs).
		const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
		let r2ObjectsDeleted = 0;
		if (env.SKILL_ARTIFACTS) {
			let cursor: string | undefined;
			const keysToDelete: string[] = [];
			do {
				const list = await env.SKILL_ARTIFACTS.list({
					prefix: `${run.id}/`,
					cursor,
				});
				for (const obj of list.objects) keysToDelete.push(obj.key);
				cursor = list.truncated ? list.cursor : undefined;
			} while (cursor);

			// R2 batch delete supports up to 1000 keys per call.
			for (let i = 0; i < keysToDelete.length; i += 1000) {
				const batch = keysToDelete.slice(i, i + 1000);
				await env.SKILL_ARTIFACTS.delete(batch);
			}
			r2ObjectsDeleted = keysToDelete.length;

			// Sanity check: if D1 said we had R2-spilled artifacts but R2
			// returned zero objects, the bucket got cleared out-of-band.
			// Surface as a warning in the log; revoke still succeeds.
			const expectedR2 = beforeArtifacts.filter((a) => a.contentR2Key).length;
			if (expectedR2 > 0 && r2ObjectsDeleted < expectedR2) {
				console.warn(
					`[revokeSkillRun] R2 objects deleted (${r2ObjectsDeleted}) < expected (${expectedR2}) for run ${run.id} — bucket may be out of sync with D1`,
				);
			}
		}

		// 3) Source-keyed brain memory facts. Workflow learns default their
		//    `source` to `skill://runs/{runId}` (see memoryGraph.learn — the
		//    X-Tedix-Skill-Run-Id header is the trigger). Hard delete here is
		//    symmetric with the artifact cascade: revoke means gone. Edges
		//    cascade via schema FK; vector embeddings become orphans and get
		//    cleaned by the periodic reindex.
		const { deleteFactsByRunId } =
			await import("@tedix/db/queries/memory-graph/fact-search");
		const factsDeleted = await deleteFactsByRunId(context.db, orgId, run.id);

		// Muscle memory cascade still deferred — muscle entries don't yet
		// carry a run-source link.
		const musclesDeleted = 0;

		return {
			runId: run.id,
			revoked: true,
			artifactsDeleted,
			r2ObjectsDeleted,
			factsDeleted,
			musclesDeleted,
			reason: effectiveReasonText || undefined,
		};
	});
