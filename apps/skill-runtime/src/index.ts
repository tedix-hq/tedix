/**
 * @tedix/skill-runtime
 *
 * Cloudflare Worker that runs executable skill workflows in per-tenant
 * Dynamic Worker isolates with durable execution semantics
 * (`step.do/sleep/waitForEvent`).
 *
 * Entry points:
 *
 *  - POST /run     — optional idempotent runId + pinned snapshot → run handle
 *  - POST /status  — { runId } → mapped + raw engine lifecycle state
 *  - POST /pause, /resume, /restart, /cancel — native Workflow controls
 *
 * Internal-only. Auth via service binding or PLATFORM_SERVICE_TOKEN. See
 * `auth.ts`.
 *
 * Architecture:
 *
 *  - The static `SkillWorkflow` class (created via
 *    `@cloudflare/dynamic-workflows`) is bound to the Workflows runtime
 *    by the `WORKFLOWS` binding in `cloudflare.config.ts`.
 *  - On `/run` we wrap the binding with `wrapWorkflowBinding()` so the
 *    dispatcher metadata (skillId/tediId/orgId/runId) is stashed on the
 *    workflow params. The Workflow engine later invokes our static class,
 *    which uses that metadata to load the right tenant Worker via
 *    env.LOADER and forwards `run()` to it.
 *  - `DynamicWorkflowBinding` is re-exported so Cloudflare auto-registers
 *    it on the Worker's `exports` (required by `wrapWorkflowBinding`).
 *
 * @see https://blog.cloudflare.com/dynamic-workflows/
 * @see https://blog.cloudflare.com/dynamic-workers/
 */

import {
	DynamicWorkflowBinding,
	wrapWorkflowBinding,
} from "@cloudflare/dynamic-workflows";
import { WorkflowEventTypeSchema } from "@tedix/api-contract/schemas/common";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import * as z from "zod";
import { createDbClient } from "@tedix/db/client";
import { requirePendingConnectionRecovery } from "./workflow-connection-recovery";
import { ArtifactBridge } from "./artifacts";
import { isAuthenticated } from "./auth";
import {
	logControlFailure,
	logRuntimeFailure,
	logSkillRuntimeWarning,
} from "./control-log";
import { skillRuntimeHealth } from "./health";
import {
	clearSkillRunRestartIntent,
	createSkillRun,
	finalizeAbortedSkillRunRestart,
	getSkillRun,
	loadSkillRunSnapshot,
	reconcileSkillRun,
	reserveSkillRunExecutionEpoch,
	skillRunEnvironment,
	type SkillRunEnvironment,
	skillRunEnvironmentMatches,
	updateSkillRunAfterControl,
} from "./db";
import { EvidenceBridge } from "./evidence";
import { ReasonBridge } from "./reason";
import { McpBridge } from "./mcp-bridge";
import { logRunEvent } from "./observability";
import { OutboundProxy } from "./outbound-proxy";
import { RationaleBridge } from "./rationale";
import { reconcileSkillRuns } from "./reconciler";
import { SkillWorkflow } from "./skill-workflow";
import {
	claimImplicitWorkflowAdmission,
	deriveIdempotentRunId,
	isAdmissionCreateFailureMarker,
	isRecoverableAdmissionFailure,
	pruneExpiredWorkflowAdmissionDedup,
	releaseImplicitWorkflowAdmission,
	WORKFLOW_ADMISSION_CREATE_FAILED,
	workflowAdmissionFingerprint,
	workflowAdmissionJsonEqual,
} from "./workflow-admission";
import {
	buildWorkflowApprovalEvent,
	claimWorkflowApprovalDecision,
	finalizeWorkflowApprovalDecision,
	WORKFLOW_APPROVAL_EVENT_TYPE,
	WorkflowApprovalDecisionConflictError,
} from "./workflow-approval";
import {
	type WorkflowEngineErrorValue,
	workflowEngineErrorMessage,
	workflowEngineErrorText,
} from "./workflow-engine-error";
import { mapWorkflowEngineStatus } from "./workflow-engine-status";
import {
	abortAmbiguousWorkflowRestart,
	bindWorkflowRestartExecutionEpoch,
	claimWorkflowRestart,
	finalizeWorkflowRestart,
	fingerprintWorkflowError,
	fingerprintWorkflowOutput,
	getWorkflowExecutionEpochOutcome,
	hasWorkflowExecutionEpochStarted,
	resolveAcceptedWorkflowRestart,
	WorkflowRestartConflictError,
	workflowRestartBarrierState,
} from "./workflow-restart";
import { isWorkflowRetirementError } from "./workflow-retirement";
import {
	ensureWorkflowRestartSubmissionAttempt,
	ensureWorkflowSubmissionStarted,
	settleAbortedWorkflowRestartSubmission,
	settleWorkflowSubmissionBeforeTerminal,
} from "./workflow-submission";
import type { SkillRuntimeEnv } from "./env";

// Required exports for Cloudflare to register dynamic-workflows, workflow engine,
// and tenant capability bridges on ctx.exports.
export {
	ArtifactBridge,
	DynamicWorkflowBinding,
	EvidenceBridge,
	McpBridge,
	OutboundProxy,
	RationaleBridge,
	ReasonBridge,
	SkillWorkflow,
};

const RunRequestSchema = z.object({
	runId: z.string().uuid().optional(),
	idempotencyKey: z.string().min(1).max(256).optional(),
	skillId: z.string().min(1),
	tediId: z.string().min(1),
	orgId: z.string().min(1),
	params: z.unknown().optional(),
	// Run-pinned source. The workflow factory only reads the snapshot captured
	// at dispatch time, never live skill_entries rows.
	skillSlug: z.string(),
	skillRevision: z.number().int().nullish(),
	workflowSource: z.string().min(1),
	skillDoc: z.string(),
	capabilityManifest: z.record(z.string(), z.unknown()),
	createdBy: z.string().min(1).max(128).optional(),
	workItemId: z.string().uuid().optional(),
	originTediRunId: z.string().uuid().optional(),
});

const StatusRequestSchema = z.object({
	runId: z.string().min(1),
});

const ControlRequestSchema = z.object({
	runId: z.string().min(1),
	// Optional for one rolling-compatible release because production deploys
	// skill-runtime before apps/api. The new API always supplies this fence;
	// remove optionality after every caller has crossed this release.
	expectedExecutionEpoch: z.number().int().min(0).optional(),
});

const CancelRequestSchema = ControlRequestSchema.extend({
	rollback: z.boolean().optional().default(false),
});

const RestartRequestSchema = ControlRequestSchema.extend({
	restartId: z.string().min(1).max(128),
	abortUnknown: z.boolean().optional().default(false),
	reason: z.string().min(1).max(4000).optional(),
	from: z
		.object({
			name: z.string().min(1),
			count: z.number().int().min(1).optional(),
			type: z.enum(["do", "sleep", "waitForEvent"]).optional(),
		})
		.optional(),
});

const ApprovalRequestSchema = ControlRequestSchema.extend({
	approvalId: z.string().min(1).max(128),
	reason: z.string().min(1).max(4000).optional(),
	payload: z.record(z.string(), z.unknown()).optional().default({}),
});

const RejectionRequestSchema = ApprovalRequestSchema;

const SendEventRequestSchema = ControlRequestSchema.extend({
	type: WorkflowEventTypeSchema.describe(
		"Event name the tenant workflow is awaiting (e.g. 'content-approved')",
	),
	payload: z.unknown().optional(),
});

type AppEnv = {
	Bindings: SkillRuntimeEnv;
};

interface EngineStatusSnapshot {
	status: string;
	output?: unknown;
	error?: WorkflowEngineErrorValue;
}

type RunStatus =
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "canceled";

function workflowEpochConflict(
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

async function readEngineStatus(
	handle: WorkflowInstance,
): Promise<EngineStatusSnapshot> {
	return (await handle.status()) as EngineStatusSnapshot;
}

async function readAcceptedEngineStatus(
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

async function invokeControlWithConfirmation(input: {
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

async function snapshotMatchesAdmission(
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
		snapshot.skillSlug === input.skillSlug &&
		snapshot.skillRevision === (input.skillRevision ?? null) &&
		snapshot.workflowSource === input.workflowSource &&
		snapshot.skillDoc === input.skillDoc &&
		workflowAdmissionJsonEqual(
			snapshot.capabilityManifest,
			input.capabilityManifest,
		) &&
		snapshot.createdBy === (input.createdBy ?? null) &&
		snapshot.workItemId === (input.workItemId ?? null) &&
		snapshot.originTediRunId === (input.originTediRunId ?? null)
	);
}

async function recoverFailedAdmission(
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

const app = new Hono<AppEnv>();

installHonoErrorHandlers(app, { service: "skill-runtime" });

function workflowEnvironmentMismatch(
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

// Auth gate — every route requires an internal caller.
app.use("*", async (c, next) => {
	if (c.req.method === "GET" && c.req.path === "/health") return next();
	if (!(await isAuthenticated(c.req.raw, c.env.PLATFORM_SERVICE_TOKEN))) {
		return c.json({ error: "unauthorized" }, 401);
	}
	return next();
});

// authz: public — the app-wide gate above deliberately waves GET /health through; liveness probe only.
app.get("/health", (c) => c.json(skillRuntimeHealth(c.env)));

/**
 * POST /benchmark/drive-turn
 * Drive one native Agent-runtime turn through `/hooks/chat-stream` over the
 * TEDI_RUNTIME_SERVICE binding. First-party (not tenant-sandboxed), so it
 * runs the real `do.ts` turn and ESCAPES the 30s Code Mode executor budget the
 * external `code`-tool path hits. Buffers the SSE stream and returns the final
 * assistant reply. Foundation for the tau2-bench retail benchmark workflow.
 */
app.post("/benchmark/drive-turn", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		slug?: string;
		text?: string;
		session_key?: string;
		client_request_id?: string;
	};
	const { slug, text, session_key, client_request_id } = body;
	if (!slug || !text || !session_key || !client_request_id) {
		return c.json(
			{ error: "missing slug/text/session_key/client_request_id" },
			400,
		);
	}
	const isolate = c.env.TEDI_RUNTIME_SERVICE;
	if (!isolate) {
		return c.json({ error: "TEDI_RUNTIME_SERVICE binding unavailable" }, 500);
	}
	const url = `https://tedi-runtime.internal/hooks/chat-stream?slug=${encodeURIComponent(slug)}`;
	const started = Date.now();
	const res = await isolate.fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"X-Service-Binding": "true",
		},
		body: JSON.stringify({ session_key, text, client_request_id }),
		// SSE turns can be long; cap so a stalled stream can't wedge the request.
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => "");
		return c.json(
			{ error: `chat-stream ${res.status}`, detail: detail.slice(0, 500) },
			502,
		);
	}
	// Read the SSE stream INCREMENTALLY and stop at the `done`/`error` frame —
	// the stream may not close promptly, so buffering with res.text() can hang.
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let assistant = "";
	let runId: string | null = null;
	let errMsg: string | null = null;
	let finished = false;
	try {
		while (!finished) {
			const { value, done: streamDone } = await reader.read();
			if (streamDone) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				try {
					const frame = JSON.parse(line.slice(5).trim());
					if (frame.kind === "done") {
						assistant = typeof frame.text === "string" ? frame.text : assistant;
						runId = frame.runId ?? frame.sessionKey ?? runId;
						finished = true;
					} else if (frame.kind === "error") {
						errMsg = frame.message ?? "error";
						finished = true;
					}
				} catch {
					/* skip non-JSON data lines */
				}
				nl = buf.indexOf("\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (errMsg) return c.json({ error: errMsg, ms: Date.now() - started }, 502);
	return c.json({
		ok: true,
		assistant,
		run_id: runId,
		ms: Date.now() - started,
	});
});

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
			throw new Error("workflow submission admission did not open an attempt");
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
				status === "completed" || status === "failed" || status === "canceled";
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
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
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
					const admissionStatus = ["completed", "failed", "canceled"].includes(
						mapped,
					)
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
					const executionEpochOutcome = await getWorkflowExecutionEpochOutcome(
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
			logRuntimeFailure("workflow.status_confirmation.failed", err, run.runId);
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
				return c.json({ error: "workflow_submission_settlement_pending" }, 503);
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
				return c.json({ error: "workflow_submission_settlement_pending" }, 503);
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

async function deliverApprovalDecision(input: {
	env: SkillRuntimeEnv;
	run: NonNullable<Awaited<ReturnType<typeof getSkillRun>>>;
	decision: "approved" | "rejected";
	approvalId: string;
	reason?: string;
	payload: Record<string, unknown>;
}): Promise<{
	runId: string;
	workflowInstanceId: string;
	executionEpoch: number;
	status: RunStatus;
	engine: EngineStatusSnapshot | null;
	eventType: string;
	decision: "approved" | "rejected";
	deduplicated: boolean;
}> {
	if (!input.run.instanceId) throw new Error("no_instance");
	const handle = await input.env.WORKFLOWS.get(input.run.instanceId);
	const approvalId = input.approvalId!;
	const claim = await claimWorkflowApprovalDecision({
		db: input.env.DB,
		runId: input.run.runId,
		executionEpoch: input.run.executionEpoch,
		approvalId,
		decision: input.decision,
		reason: input.reason,
		payload: input.payload,
	});
	if (!claim.deduplicated) {
		if (!claim.pendingContent) {
			throw new Error("workflow approval reservation is missing pending state");
		}
		try {
			await handle.sendEvent(
				buildWorkflowApprovalEvent({
					approved: input.decision === "approved",
					reason: input.reason,
					approvalId,
					metadata: input.payload,
				}),
			);
			await finalizeWorkflowApprovalDecision({
				db: input.env.DB,
				runId: input.run.runId,
				path: claim.path,
				executionEpoch: input.run.executionEpoch,
				approvalId,
				decision: input.decision,
				requestDigest: claim.requestDigest,
				pendingContent: claim.pendingContent,
				delivered: true,
			});
		} catch (error) {
			await finalizeWorkflowApprovalDecision({
				db: input.env.DB,
				runId: input.run.runId,
				path: claim.path,
				executionEpoch: input.run.executionEpoch,
				approvalId,
				decision: input.decision,
				requestDigest: claim.requestDigest,
				pendingContent: claim.pendingContent,
				delivered: false,
			}).catch(() => {});
			throw error;
		}
	}
	let engine: EngineStatusSnapshot | null = null;
	let status = input.run.status as RunStatus;
	try {
		engine = await readEngineStatus(handle);
		const mappedStatus = mapWorkflowEngineStatus(engine.status);
		if (mappedStatus) {
			status = mappedStatus;
			const terminal =
				status === "completed" || status === "failed" || status === "canceled";
			const engineError = workflowEngineErrorText(engine.error);
			if (terminal) {
				const submissionSettled = await settleWorkflowSubmissionBeforeTerminal({
					db: input.env.DB,
					runId: input.run.runId,
					organizationId: input.run.orgId,
					executionEpoch: input.run.executionEpoch,
					status,
					error: engineError,
				});
				if (!submissionSettled) {
					throw new Error("workflow_submission_settlement_pending");
				}
				await reconcileSkillRun(input.env.DB, input.run.runId, {
					status,
					result: status === "completed" ? engine.output : undefined,
					error: status === "failed" ? engineError : null,
					expectedExecutionEpoch: input.run.executionEpoch,
				});
			} else {
				await updateSkillRunAfterControl(
					input.env.DB,
					input.run.runId,
					status,
					{
						expectedExecutionEpoch: input.run.executionEpoch,
					},
				);
			}
		}
	} catch (error) {
		// The event delivery already succeeded. Do not encourage a duplicate event
		// merely because the follow-up lifecycle read was temporarily unavailable.
		logRuntimeFailure(
			"workflow.approval_status_confirmation.failed",
			error,
			input.run.runId,
		);
	}
	return {
		runId: input.run.runId,
		workflowInstanceId: input.run.instanceId,
		executionEpoch: input.run.executionEpoch,
		status,
		engine,
		eventType: WORKFLOW_APPROVAL_EVENT_TYPE,
		decision: input.decision,
		deduplicated: claim.deduplicated,
	};
}

/** Deliver the standard, branchable human-approval event. */
app.post("/approve", async (c) => {
	const parsed = ApprovalRequestSchema.safeParse(
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
	const retiredConflict = workflowControlRetiredConflict(run);
	if (retiredConflict) return c.json(retiredConflict, 409);
	const restartConflict = workflowControlRestartConflict(run);
	if (restartConflict) return c.json(restartConflict, 409);
	const admissionConflict = workflowControlAdmissionConflict(run);
	if (admissionConflict) return c.json(admissionConflict, 409);
	if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
	try {
		return c.json({
			ok: true,
			action: "approve",
			...(await deliverApprovalDecision({
				env: c.env,
				run,
				decision: "approved",
				approvalId: parsed.data.approvalId,
				reason: parsed.data.reason,
				payload: parsed.data.payload,
			})),
		});
	} catch (error) {
		if (error instanceof WorkflowApprovalDecisionConflictError) {
			return c.json({ error: error.code, message: error.message }, 409);
		}
		const message = error instanceof Error ? error.message : String(error);
		logControlFailure("approve", error, run.runId);
		return c.json({ error: "workflow_approve_failed", message }, 502);
	}
});

/** Deliver rejection through the same standard approval event type. */
app.post("/reject", async (c) => {
	const parsed = RejectionRequestSchema.safeParse(
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
	const retiredConflict = workflowControlRetiredConflict(run);
	if (retiredConflict) return c.json(retiredConflict, 409);
	const restartConflict = workflowControlRestartConflict(run);
	if (restartConflict) return c.json(restartConflict, 409);
	const admissionConflict = workflowControlAdmissionConflict(run);
	if (admissionConflict) return c.json(admissionConflict, 409);
	if (!run.instanceId) return c.json({ error: "no_instance" }, 409);
	try {
		return c.json({
			ok: true,
			action: "reject",
			...(await deliverApprovalDecision({
				env: c.env,
				run,
				decision: "rejected",
				approvalId: parsed.data.approvalId,
				reason: parsed.data.reason,
				payload: parsed.data.payload,
			})),
		});
	} catch (error) {
		if (error instanceof WorkflowApprovalDecisionConflictError) {
			return c.json({ error: error.code, message: error.message }, 409);
		}
		const message = error instanceof Error ? error.message : String(error);
		logControlFailure("reject", error, run.runId);
		return c.json({ error: "workflow_reject_failed", message }, 502);
	}
});

/**
 * POST /event
 * Deliver a typed event to a workflow awaiting step.waitForEvent. Event
 * delivery is not claimed to be idempotent; callers must avoid blind retries
 * after an ambiguous transport failure and use a business identifier in the
 * payload when dedupe matters.
 */
app.post("/event", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = SendEventRequestSchema.safeParse(body);
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
	const retiredConflict = workflowControlRetiredConflict(run);
	if (retiredConflict) return c.json(retiredConflict, 409);
	const restartConflict = workflowControlRestartConflict(run);
	if (restartConflict) return c.json(restartConflict, 409);
	const admissionConflict = workflowControlAdmissionConflict(run);
	if (admissionConflict) return c.json(admissionConflict, 409);
	if (!run.instanceId) return c.json({ error: "no_instance" }, 409);

	try {
		if (parsed.data.type.startsWith("connection_recovery_")) {
			await requirePendingConnectionRecovery(createDbClient(c.env.DB), {
				runId: run.runId,
				executionEpoch: run.executionEpoch,
				type: parsed.data.type,
				payload: parsed.data.payload,
			});
		}
		const handle = await c.env.WORKFLOWS.get(run.instanceId);
		await handle.sendEvent({
			type: parsed.data.type,
			payload: parsed.data.payload ?? {},
		});
		console.log(
			JSON.stringify({
				service: "skill-runtime",
				event: "run.event_sent",
				ts: new Date().toISOString(),
				runId: run.runId,
				workflowInstanceId: run.instanceId,
				eventType: parsed.data.type,
			}),
		);
		return c.json({ ok: true, executionEpoch: run.executionEpoch });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logControlFailure("event", err, run.runId);
		return c.json({ error: "send_event_failed", message }, 500);
	}
});

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<SkillRuntimeEnv> {
	override async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}
}

export default {
	fetch: (request, env, ctx) =>
		app.fetch(stripServiceBindingMarker(request), env, ctx),
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(
			(async () => {
				try {
					const summary = await reconcileSkillRuns({
						DB: env.DB,
						WORKFLOWS: env.WORKFLOWS,
						ENVIRONMENT: skillRunEnvironment(env.ENVIRONMENT),
					});
					console.log(
						JSON.stringify({
							service: "skill-runtime",
							event: "reconciler.tick",
							ts: new Date().toISOString(),
							...summary,
						}),
					);
				} catch (err) {
					logRuntimeFailure("workflow.reconciler_tick.failed", err);
				}
			})(),
		);
	},
} satisfies ExportedHandler<SkillRuntimeEnv>;
