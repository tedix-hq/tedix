import type { SkillRuntimeEnv } from "./env";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import * as z from "zod";
import { logSkillRuntimeWarning } from "./control-log";
import {
	getSkillRun,
	loadSkillRunSnapshot,
	reconcileSkillRun,
	skillRunEnvironment,
	type SkillRunEnvironment,
	skillRunEnvironmentMatches,
	updateSkillRunAfterControl,
} from "./db";
import {
	isAdmissionCreateFailureMarker,
	isRecoverableAdmissionFailure,
	workflowAdmissionJsonEqual,
} from "./workflow-admission";
import {
	type WorkflowEngineErrorValue,
	workflowEngineErrorText,
} from "./workflow-engine-error";
import { mapWorkflowEngineStatus } from "./workflow-engine-status";
import { hasWorkflowExecutionEpochStarted } from "./workflow-restart";
import { isWorkflowRetirementError } from "./workflow-retirement";
import {
	ensureWorkflowSubmissionStarted,
	settleWorkflowSubmissionBeforeTerminal,
} from "./workflow-submission";
import { RunRequestSchema } from "./control-requests";

export interface EngineStatusSnapshot {
	status: string;
	output?: unknown;
	error?: WorkflowEngineErrorValue;
}

export type RunStatus =
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "canceled";

export function workflowEpochConflict(
	run: { executionEpoch: number },
	expectedExecutionEpoch: number | undefined,
): {
	error: "workflow_epoch_conflict";
	expectedExecutionEpoch: number;
	actualExecutionEpoch: number;
} | null {
	if (expectedExecutionEpoch == null) return null;
	if (run.executionEpoch === expectedExecutionEpoch) return null;
	return {
		error: "workflow_epoch_conflict",
		expectedExecutionEpoch,
		actualExecutionEpoch: run.executionEpoch,
	};
}

export function workflowControlRestartConflict(run: {
	executionEpoch: number;
	restartRequestedAt: string | null;
	restartCommandId: string | null;
}): {
	error: "workflow_restart_in_progress";
	executionEpoch: number;
	restartId: string | null;
	message: string;
} | null {
	if (!run.restartRequestedAt) return null;
	return {
		error: "workflow_restart_in_progress",
		executionEpoch: run.executionEpoch,
		restartId: run.restartCommandId,
		message:
			"a native restart is still being durably reconciled; inspect status and retry this control after the restart intent clears",
	};
}

export function workflowControlAdmissionConflict(run: {
	status: string;
	error: string | null;
}): {
	error: "workflow_admission_pending";
	message: string;
} | null {
	if (!isAdmissionCreateFailureMarker(run)) return null;
	return {
		error: "workflow_admission_pending",
		message:
			"the engine admission result is still being reconciled; inspect status and retry this control after the admission marker clears",
	};
}

export function workflowControlRetiredConflict(run: {
	workflowRetiredAt: string | null;
	error: string | null;
}): {
	error: "workflow_instance_retired";
	message: string;
} | null {
	if (run.workflowRetiredAt == null && !isWorkflowRetirementError(run.error)) {
		return null;
	}
	return {
		error: "workflow_instance_retired",
		message:
			"this Workflow instance is permanently retired; inspect the run or start a new runId instead of mutating it",
	};
}

const CONTROL_RETRY_DELAYS_MS = [0, 100, 250] as const;
const STATUS_CONFIRM_ATTEMPTS = 8;

async function waitMs(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readEngineStatus(
	handle: WorkflowInstance,
): Promise<EngineStatusSnapshot> {
	return (await handle.status()) as EngineStatusSnapshot;
}

export async function readAcceptedEngineStatus(
	env: SkillRuntimeEnv,
	instanceId: string,
): Promise<EngineStatusSnapshot | null> {
	try {
		const handle = await env.WORKFLOWS.get(instanceId);
		const engine = await readEngineStatus(handle);
		if (!mapWorkflowEngineStatus(engine.status)) {
			if (engine.status !== "unknown") {
				logSkillRuntimeWarning("workflow.engine_status_unrecognized");
			}
			return null;
		}
		return engine;
	} catch {
		return null;
	}
}

export async function invokeControlWithConfirmation(input: {
	handle: WorkflowInstance;
	action: () => Promise<void>;
	accept: (status: string) => boolean;
	onAccepted?: () => Promise<void>;
}): Promise<{
	engine: EngineStatusSnapshot;
	operationAttempts: number;
	statusChecks: number;
}> {
	let operationAttempts = 0;
	let lastError: unknown = null;
	for (const delayMs of CONTROL_RETRY_DELAYS_MS) {
		operationAttempts++;
		await waitMs(delayMs);
		try {
			await input.action();
			await input.onAccepted?.();
			lastError = null;
			break;
		} catch (error) {
			lastError = error;
			// A timed-out/duplicated operation may already have taken effect. Check
			// the engine before retrying a non-idempotent control call.
			try {
				const engine = await readEngineStatus(input.handle);
				if (input.accept(engine.status)) {
					return { engine, operationAttempts, statusChecks: 1 };
				}
			} catch {
				// The bounded retry below remains the source of the eventual error.
			}
		}
	}
	if (lastError) throw lastError;

	let statusChecks = 0;
	let lastEngine: EngineStatusSnapshot | null = null;
	let statusError: unknown = null;
	for (let index = 0; index < STATUS_CONFIRM_ATTEMPTS; index++) {
		statusChecks++;
		if (index > 0) await waitMs(Math.min(50 * 2 ** index, 500));
		try {
			lastEngine = await readEngineStatus(input.handle);
			statusError = null;
			if (input.accept(lastEngine.status)) {
				return { engine: lastEngine, operationAttempts, statusChecks };
			}
		} catch (error) {
			statusError = error;
		}
	}
	const detail = statusError
		? statusError instanceof Error
			? statusError.message
			: String(statusError)
		: `last engine status ${lastEngine?.status ?? "unavailable"}`;
	throw new Error(`workflow control was not confirmed: ${detail}`);
}

export async function snapshotMatchesAdmission(
	db: D1Database,
	input: z.infer<typeof RunRequestSchema>,
	runId: string,
	runtimeEnvironment: SkillRunEnvironment,
): Promise<boolean> {
	const snapshot = await loadSkillRunSnapshot(db, runId);
	if (!snapshot) return false;
	return (
		snapshot.skillId === input.skillId &&
		snapshot.tediId === input.tediId &&
		snapshot.orgId === input.orgId &&
		skillRunEnvironmentMatches(
			snapshot.runtimeEnvironment,
			runtimeEnvironment,
		) &&
		workflowAdmissionJsonEqual(snapshot.params, input.params ?? {}) &&
		workflowAdmissionJsonEqual(
			snapshot.resourceAccessEnvelope,
			input.resourceAccessEnvelope ?? null,
		) &&
		snapshot.skillSlug === input.skillSlug &&
		snapshot.skillRevision === (input.skillRevision ?? null) &&
		snapshot.workflowSource === input.workflowSource &&
		snapshot.skillDoc === input.skillDoc &&
		workflowAdmissionJsonEqual(
			snapshot.capabilityManifest,
			input.capabilityManifest,
		) &&
		Boolean(snapshot.certification) === (input.certification ?? false) &&
		snapshot.createdBy === (input.createdBy ?? null) &&
		snapshot.workItemId === (input.workItemId ?? null) &&
		snapshot.originTediRunId === (input.originTediRunId ?? null)
	);
}

export async function recoverFailedAdmission(
	env: SkillRuntimeEnv,
	input: z.infer<typeof RunRequestSchema>,
	runId: string,
): Promise<RunStatus | null> {
	const failedRun = await getSkillRun(env.DB, runId);
	if (!failedRun) return null;
	if (
		!skillRunEnvironmentMatches(
			failedRun.runtimeEnvironment,
			skillRunEnvironment(env.ENVIRONMENT),
		)
	) {
		return null;
	}
	if (!isAdmissionCreateFailureMarker(failedRun)) return null;
	const submissionReady = await ensureWorkflowSubmissionStarted({
		db: env.DB,
		runId,
		organizationId: failedRun.orgId,
		tediId: failedRun.tediId,
	});
	if (!submissionReady) return null;
	const executionStarted = await hasWorkflowExecutionEpochStarted(
		env.DB,
		runId,
		0,
	);
	let accepted = await readAcceptedEngineStatus(env, runId);
	if (
		!accepted &&
		isRecoverableAdmissionFailure({
			status: failedRun.status,
			error: failedRun.error,
			executionStarted,
		})
	) {
		try {
			const workflows = wrapWorkflowBinding({
				skillId: input.skillId,
				tediId: input.tediId,
				orgId: input.orgId,
				runId,
			});
			await workflows.create({ id: runId, params: input.params ?? {} });
		} catch {
			// A concurrent/ambiguous create may have won. The status read below is
			// the authority; an unknown instance keeps the failed admission visible.
		}
		accepted = await readAcceptedEngineStatus(env, runId);
	}
	if (!accepted) return null;
	const status = mapWorkflowEngineStatus(accepted.status);
	if (!status) return null;
	const terminal = ["completed", "failed", "canceled"].includes(status);
	await updateSkillRunAfterControl(
		env.DB,
		runId,
		terminal ? "running" : status,
		{
			// Clear the pre-acceptance failure marker before projecting the engine's
			// authoritative state. A terminal recovery stages through running so a
			// crash before the terminal projection remains cron-eligible.
			restart: true,
			requireAdmissionMarker: true,
		},
	);
	if (terminal) {
		const engineError = workflowEngineErrorText(accepted.error);
		const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
			db: env.DB,
			runId,
			organizationId: failedRun.orgId,
			executionEpoch: failedRun.executionEpoch,
			status,
			error: engineError,
		});
		if (!submissionSettled) return "running";
		await reconcileSkillRun(env.DB, runId, {
			status,
			result: status === "completed" ? accepted.output : undefined,
			error: status === "failed" ? engineError : null,
		});
	}
	return status;
}

export function workflowEnvironmentMismatch(
	run: NonNullable<Awaited<ReturnType<typeof getSkillRun>>>,
	current: SkillRunEnvironment,
): Record<string, unknown> | null {
	if (skillRunEnvironmentMatches(run.runtimeEnvironment, current)) return null;
	return {
		error: "workflow_environment_mismatch",
		message:
			"this run belongs to a different Workflow binding environment and cannot be operated through the current runtime",
		runEnvironment: run.runtimeEnvironment,
		currentEnvironment: current,
	};
}
