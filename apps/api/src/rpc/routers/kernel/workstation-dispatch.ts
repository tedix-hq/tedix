/**
 * Kernel — certified workstation adapter dispatch.
 *
 * Delivers an APPROVED workstation work order to a workstation-backed tedi and stamps the
 * home run row so reconciliation (`kernelRuntime.readRunSet`) can supervise the
 * child run to completion. This is the missing leg between
 * "approved_waiting_certified_dispatch" (work order parked) and the
 * workstation-backed tedi actually receiving the work.
 *
 * Delivery seam: the SAME in-process cognitive-runtime enqueue the isolate
 * delegation path uses (`defaultKernelDelegateRunner` →
 * `cognitiveRuntime.enqueueMessage`). The minted key makes delivery idempotent;
 * the returned childRunId identifies the Agent runtime ledger. Persist that
 * acknowledged id so Home reads the same run as the runtime's terminal events.
 * Legacy raw-key rows can still resolve through `chat_dispatch_idempotency`.
 *
 * No I/O beyond the injected deps — `enqueue` and `recordDispatchFailure` are
 * provided by kernel-runtime.ts so tests can stub the delivery without a live
 * runtime, and the DB writes go through the caller's drizzle handle.
 */

import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { createError, ErrorCodes } from "../../orpc";
import { predictAgentRunId } from "./runtime-shared";
import { updateKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { BaseContext } from "../../orpc";
import { renderDelegationWorkOrderMessage } from "./delegation-dispatch";

export type WorkstationDispatchTrigger =
	| "policy-auto-approval"
	| "agent-approval"
	| "human-approval";

export type WorkstationDispatchEnqueue = (input: {
	childRunId: string;
	content: string;
	delegateToTediId: string;
	metadata: Record<string, unknown>;
}) => Promise<{
	childRunId: string;
	childConversationId?: string;
	error?: string;
	status: "queued" | "failed";
}>;

export type WorkstationDispatchFailureRecorder = (input: {
	childConversationId?: string | null;
	childRunId: string;
	conversationId: string;
	delegatedTediId: string;
	error: string;
	existingMetadata?: Record<string, unknown> | null;
	organizationId: string;
	runId: string;
}) => Promise<void>;

export interface WorkstationDispatchDeps {
	db: BaseContext["db"];
	enqueue: WorkstationDispatchEnqueue;
	recordDispatchFailure: WorkstationDispatchFailureRecorder;
	now?: () => string;
}

export interface WorkstationDispatchInput {
	/** Verbatim operator request (source content for the work-order block). */
	content: string;
	/** Home conversation the work card lives in. */
	conversationId: string;
	existingMetadata?: Record<string, unknown> | null;
	existingRuntimeMetadata?: Record<string, unknown> | null;
	organizationId: string;
	/** Home run id (= work-card id = approval request id). */
	runId: string;
	targetTediId: string;
	trigger: WorkstationDispatchTrigger;
	/** Home `message.received` id that carries the original request. */
	userMessageId: string;
	/** Work Item supervising this workstation child run, when one is available. */
	workItemId?: string | null;
	/** The persisted workstation work order (metadata.delegationWorkOrder). */
	workOrder: Record<string, unknown> | null;
}

export interface WorkstationDispatchResult {
	childConversationId?: string;
	childRunId: string;
	error?: string;
	status: "dispatched" | "failed";
}

/**
 * Mirror of runtime-shared.ts `sanitizeAgentTurnKey` — the minted child run id
 * doubles as the cognitive-runtime idempotencyKey, so each segment must be
 * colon/whitespace-free the same way isolate client request ids are.
 */
function sanitizeWorkstationRunKeySegment(value: string): string {
	const cleaned = value
		.trim()
		.replace(/^<+|>+$/g, "")
		.replace(/:/g, "_")
		.replace(/\s+/g, "_")
		.trim();
	if (!cleaned) {
		throw new Error("Workstation child run id requires a stable home run id");
	}
	return cleaned;
}

function stringRecordValue(
	record: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function resolveWorkItemId(input: WorkstationDispatchInput): string | null {
	return (
		input.workItemId?.trim() ||
		stringRecordValue(input.existingMetadata, "workItemId") ||
		stringRecordValue(input.existingRuntimeMetadata, "workItemId") ||
		stringRecordValue(input.workOrder, "workItemId")
	);
}

/**
 * Deterministic workstation child run id: `{homeRunId}:workstation:{tediId}` with
 * each variable segment sanitized like `predictAgentRunId` sanitizes its
 * client request id. Deterministic so an idempotent re-dispatch reuses the
 * same cognitive-runtime idempotencyKey (the enqueue pre-writes
 * `tedi_runtime_events` rows keyed on it).
 */
export function mintWorkstationChildRunId(input: {
	homeRunId: string;
	tediId: string;
}): string {
	return `${sanitizeWorkstationRunKeySegment(input.homeRunId)}:workstation:${sanitizeWorkstationRunKeySegment(input.tediId)}`;
}

/** Delivery keys are enqueue idempotency keys; Attempt authority uses the runtime ID. */
export function workstationDispatchIdentity(input: {
	homeRunId: string;
	target: { id: string };
}): { deliveryKey: string; runtimeRunId: string } {
	const deliveryKey = mintWorkstationChildRunId({
		homeRunId: input.homeRunId,
		tediId: input.target.id,
	});
	return {
		deliveryKey,
		runtimeRunId: predictAgentRunId({
			clientRequestId: deliveryKey,
			// The runtime resolves its identity from the Tedi row's primary key.
			// isolateAgentId and slug route to the DO; rebinding never changes run identity.
			tediId: input.target.id,
		}),
	};
}

/** Never reinterpret existing execution authority when delivery and runtime IDs differ. */
export async function inspectWorkstationDispatchAdmission(
	context: BaseContext,
	input: {
		organizationId: string;
		workItemId: string;
		targetTediId: string;
		runtimeRunId: string;
		now: string;
	},
): Promise<boolean> {
	const page = await listWorkItemAttempts(context.db, {
		orgId: input.organizationId,
		workItemId: input.workItemId,
		limit: 100,
	});
	const active = page.data.filter((attempt) => {
		if (
			!["queued", "running", "waiting", "retrying"].includes(
				attempt.runtimeState,
			)
		)
			return false;
		// A missing/malformed expiry is ambiguous authority, not an absent Attempt.
		// startWorkItemAttempt can reuse legacy null-expiry rows; never skip their fence.
		const expiry =
			attempt.expiresAt === null ? NaN : Date.parse(attempt.expiresAt);
		return !Number.isFinite(expiry) || expiry > Date.parse(input.now);
	});
	if (active.length === 0) return false;
	const attempt = active[0]!;
	if (
		active.length !== 1 ||
		attempt.expiresAt === null ||
		!Number.isFinite(Date.parse(attempt.expiresAt)) ||
		attempt.admissionId === null ||
		attempt.orgId !== input.organizationId ||
		attempt.workItemId !== input.workItemId ||
		attempt.executorType !== "tedi" ||
		attempt.executorId !== input.targetTediId ||
		attempt.runId !== input.runtimeRunId ||
		attempt.runtimeState !== "running"
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workstation dispatch requires the exact admitted runtime run and tedi executor",
		);
	}
	return true;
}

export function composeWorkstationWorkOrderMessage(input: {
	content: string;
	homeRunId: string;
	workOrder: Record<string, unknown> | null;
}): string {
	return renderDelegationWorkOrderMessage({
		fallbackContent: input.content,
		fallbackWorkOrderId: `work-order:${input.homeRunId}`,
		label: "WORKSTATION",
		workOrder: input.workOrder,
	});
}

/**
 * Deliver an approved workstation work order and stamp the home run row.
 *
 * Success: `kernel_runtime_runs` gets `delegatedTediId` + `childRunId` (so
 * `readChildRunStatusesForRunRows` starts supervising), the work order flips
 * to `status: "dispatched"`, `runtimeMetadata.dispatch` becomes
 * `"workstation-dispatched"` (which also widens the stale-dispatch window for
 * cold workstation paths), and the run STAYS `"queued"` — reconciliation owns
 * all further transitions from runtime terminal events.
 *
 * Failure: the run is marked failed through the same
 * `recordHomeDelegationDispatchFailure` path the isolate dispatch uses
 * (run.failed event + async-completion transcript message + failed row).
 */
export async function dispatchWorkstationWorkOrder(
	deps: WorkstationDispatchDeps,
	input: WorkstationDispatchInput,
): Promise<WorkstationDispatchResult> {
	const now = deps.now ?? (() => new Date().toISOString());
	const childRunId = mintWorkstationChildRunId({
		homeRunId: input.runId,
		tediId: input.targetTediId,
	});
	const content = composeWorkstationWorkOrderMessage({
		content: input.content,
		homeRunId: input.runId,
		workOrder: input.workOrder,
	});
	const workItemId = resolveWorkItemId(input);

	let enqueueResult: Awaited<ReturnType<WorkstationDispatchEnqueue>>;
	try {
		enqueueResult = await deps.enqueue({
			childRunId,
			content,
			delegateToTediId: input.targetTediId,
			metadata: {
				source: "kernelRuntime.workstationDispatch",
				dispatchMode: "async",
				homeRunId: input.runId,
				homeConversationId: input.conversationId,
				homeMessageId: input.userMessageId,
				delegationWorkOrder: input.workOrder,
				dispatchTrigger: input.trigger,
				...(workItemId ? { workItemId } : {}),
			},
		});
	} catch (error) {
		enqueueResult = {
			childRunId,
			error: error instanceof Error ? error.message : String(error),
			status: "failed",
		};
	}

	if (enqueueResult.status === "failed") {
		const errorText =
			enqueueResult.error ?? "Workstation work order dispatch failed";
		try {
			await deps.recordDispatchFailure({
				childConversationId: enqueueResult.childConversationId ?? null,
				childRunId,
				conversationId: input.conversationId,
				delegatedTediId: input.targetTediId,
				error: errorText,
				existingMetadata: input.existingMetadata ?? null,
				organizationId: input.organizationId,
				runId: input.runId,
			});
		} catch (recordError) {
			console.warn(
				"[kernelRuntime.workstationDispatch] failed-run record failed",
				recordError instanceof Error
					? recordError.message
					: String(recordError),
			);
		}
		return { childRunId, error: errorText, status: "failed" };
	}

	const dispatchedAt = now();
	// The enqueue key identifies delivery; the runtime acknowledgement identifies
	// the ledger run Home must supervise. They differ for the Agent runtime.
	const acknowledgedChildRunId = enqueueResult.childRunId;
	const childConversationId = enqueueResult.childConversationId ?? null;
	const dispatchedWorkOrder = input.workOrder
		? { ...input.workOrder, status: "dispatched" }
		: null;
	const preview =
		"Work order dispatched to the workstation-backed tedi; progress will stream into this work card.";
	const nextMetadata = {
		...input.existingMetadata,
		childConversationId,
		childRunId: acknowledgedChildRunId,
		delegatedTediId: input.targetTediId,
		delegationStatus: "queued",
		delegationWorkOrder: dispatchedWorkOrder,
		...(workItemId ? { workItemId } : {}),
		workstationDispatch: {
			dispatchedAt,
			source: "kernelRuntime.workstationDispatch",
			trigger: input.trigger,
		},
	};
	const nextRuntimeMetadata = {
		...input.existingRuntimeMetadata,
		childRunId: acknowledgedChildRunId,
		dispatch: "workstation-dispatched",
		...(workItemId ? { workItemId } : {}),
	};

	try {
		await updateKernelRuntimeRun(deps.db, input.runId, {
			// Reconciliation takes over from here — the run stays queued until
			// the workstation-backed child publishes terminal events.
			status: "queued",
			delegatedTediId: input.targetTediId,
			childRunId: acknowledgedChildRunId,
			childConversationId,
			progressValue: 24,
			progressLabel: "Dispatched",
			progressDetail: "Work order delivered to the workstation-backed tedi",
			latestEventKind: "run.started",
			latestEventAt: dispatchedAt,
			preview,
			completedAt: null,
			// Stale-dispatch detection measures from startedAt — anchor it to the
			// DISPATCH moment, not the original enqueue (a human may approve the
			// work order minutes/hours after the run row was created).
			startedAt: dispatchedAt,
			updatedAt: dispatchedAt,
			metadata: nextMetadata,
			runtimeMetadata: nextRuntimeMetadata,
		});
	} catch (error) {
		// The runtime HAS the work order at this point — do not mark the run
		// failed for a bookkeeping write error; reconciliation falls back to the
		// pre-dispatch row (no childRunId) and stale detection will surface it.
		console.warn(
			"[kernelRuntime.workstationDispatch] dispatched-row update failed",
			error instanceof Error ? error.message : String(error),
		);
	}

	return {
		childConversationId: enqueueResult.childConversationId,
		childRunId: acknowledgedChildRunId,
		status: "dispatched",
	};
}
