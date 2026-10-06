/**
 * Kernel — durable run/event store. Insert and normalize helpers for the
 * `kernel_runtime_runs`/`kernel_runtime_events` D1 rows: home-run records,
 * plan/child-status reconciliation writes, dispatch-failure recording, and
 * conversation-access checks. This module must NOT import kernel-runtime.ts
 * (the router imports this module; a value import back would create a cycle).
 */

import { kernelSpanContext } from "./gateway-attribution";
import { createRouterClient } from "@orpc/server";
import type {
	TediRunStatus,
	TediRuntimeEventKind,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { TediRuntimeEventKindSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	HomeChildRunEvidence,
	HomePlan,
	HomeRun,
	KernelRuntimeEvent,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	buildKernelRuntimeEvent,
	homeRuntimeEventId,
	subagentOutcomeEventKind,
} from "@tedix/api-contract/utils/runtime-events";
import {
	insertKernelRuntimeEventIfAbsent,
	KernelRuntimeEventConflictError,
	type KernelRuntimeEvent as KernelRuntimeEventRow,
	listKernelRuntimeEvents,
	type NewKernelRuntimeEvent,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	findKernelRuntimeRunByChild,
	hasUnacceptedChatDispatch,
	insertKernelRuntimeRunIfAbsent,
	type KernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import {
	listWorkItemAttempts,
	settleWorkItemAttempt,
} from "@tedix/db/queries/work-items/attempts";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	type KernelConversationAccessLevel,
	resolveKernelConversationAccess,
} from "../../../kernel/conversation-access";
import { extractRunUsage } from "../../../kernel/kernel-state";
import {
	kernelRunStatusToSubmissionOutcome,
	recordKernelSubmissionStarted,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { cognitiveRuntimeContractRouter } from "../cognitive-runtime";
import {
	readChildRunFinalAssistantResult,
	readChildRunFullResult,
	readSingleChildRunSummary,
} from "./child-run-reads";
import { applyKernelConversationEvent } from "./conversation-index";
import {
	type DelegatedStopClassification,
	delegatedStopFromSummary,
	hasDelegatedOutput,
} from "./delegated-stop";
import {
	KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY,
	kernelConversationOriginFromPayload,
	resolveKernelConversationOrigin,
} from "./conversation-origin";
import {
	type DelegationAttemptResult,
	disposeDelegationWorkItem,
	disposeTerminalDirectDelegationWorkItem,
	isStaleDelegationDispatchRow,
	type KernelChildEnqueue,
	recordDelegationWorkItemHeartbeat,
	resolveDelegationWorkItemId,
	surfaceUnblockedDependents,
} from "./delegation-work-item";
import {
	approvedHomePlanStatus,
	homeRunStatusFromPlanStatus,
	planAssignmentStatusFromChildStatus,
	readOptionalHomePlanFromRun,
} from "./home-plan";
import { homeNarrationMetadata } from "./home-narration";
import { type KernelEnv, kernelModel } from "./llm";
import { validateDelegationOutput } from "./output-schema-validate";
import {
	buildDelegationFailureEnvelope,
	childRunStatusFromSummary,
	childRunStatusKey,
	DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
	delegatedChildSteerRunId,
	delegationSessionKey,
	errorMessage,
	homeRunProgress,
	isTerminalHomeRunStatus,
	latestIso,
	nonNullRecord,
	nowIso,
	shouldFailSoftHomeRunSetRead,
	stringFromPayload,
} from "./runtime-shared";

export const KERNEL_RUNTIME_BACKEND = "custom";

/**
 * The unblock watcher's injected child-enqueue: the same cognitive-runtime
 * `enqueueMessage` seam the kernel's delegate runner uses (async dispatch,
 * idempotency-keyed, per-delegation session scoping) — built here because
 * delegation-work-item.ts must stay import-cycle-free of cognitive-runtime.ts.
 */
function kernelUnblockEnqueue(context: BaseContext): KernelChildEnqueue {
	return async (input) => {
		const client = createRouterClient(cognitiveRuntimeContractRouter, {
			context,
		});
		const result = await client.enqueueMessage({
			tediId: input.delegateToTediId,
			content: input.content,
			conversationId: delegationSessionKey(input.childClientRequestId),
			idempotencyKey: input.childClientRequestId,
			metadata: { ...input.metadata, dispatchMode: "async" },
		});
		return {
			childRunId: result.runId ?? null,
			childConversationId: result.conversationId ?? null,
			error: result.error ?? null,
			status: result.status ?? null,
		};
	};
}

export function normalizeRuntime(row: KernelRuntimeEventRow) {
	return {
		backend: row.runtimeBackend,
		externalId: row.runtimeExternalId ?? undefined,
		externalUrl: row.runtimeExternalUrl ?? undefined,
		metadata: nonNullRecord(row.runtimeMetadata),
	};
}

function normalizeHomeEvent(row: KernelRuntimeEventRow): KernelRuntimeEvent {
	return {
		id: row.id,
		organizationId: row.organizationId,
		kind: row.kind,
		conversationId: row.conversationId,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		causeEventId: row.causeEventId ?? undefined,
		delegatedTediId: row.delegatedTediId ?? undefined,
		childRunId: row.childRunId ?? undefined,
		sequence: row.sequence ?? undefined,
		delta: row.delta ?? undefined,
		payload: nonNullRecord(row.payload),
		runtime: normalizeRuntime(row),
		createdAt: row.createdAt,
	};
}

/**
 * Single source of truth for the run-derived terminal state shared by
 * {@link normalizeHomeRunRecord} and {@link normalizeHomeMessage}.
 *
 * Both surfaces must agree on whether a run is terminal (`completed`/`failed`/
 * `canceled`), on the terminal answer text (`preview`/`content`), and on the
 * terminal timestamp (`completedAt`). Deriving these independently let the run
 * surface and the message surface drift (e.g. a run reads "completed" while its
 * message still reads "pending"). Routing both callers through this helper makes
 * that drift impossible.
 *
 * `childRunStatus` is the resolved per-row child-run summary record (already
 * looked up by the caller), NOT the summaries Map.
 */
function classifyHomeRunState(
	row: KernelRuntimeRun,
	childRunStatus: Record<string, unknown> | null,
): {
	status: TediRunStatus;
	content: string | null;
	preview: string | null;
	completedAt: string | null;
} {
	// Cancellation is a parent control decision. An older child snapshot or a
	// late child completion cannot revive it or replace the operator's outcome.
	if (row.status === "canceled") {
		return {
			status: "canceled",
			content: row.preview ?? null,
			preview: row.preview ?? null,
			completedAt: row.completedAt ?? null,
		};
	}
	const hasChildStatus = Boolean(childRunStatus);
	const childStatus = childRunStatusFromSummary(childRunStatus ?? null);
	const status =
		hasChildStatus && row.delegatedTediId
			? homeRunStatusFromChildStatus(childStatus, row.status as TediRunStatus)
			: (row.status as TediRunStatus);
	// Mirror the original `childRunStatus?.childRunPreview ?? row.preview ?? null`
	// exactly (child preview summaries are strings in practice) so the run
	// metadata `childRunPreview` value is byte-identical to pre-refactor output.
	const rowMetadata = nonNullRecord(row.metadata);
	// A durable Code Mode approval settles the parent after the child paused.
	// Its explicit parent preview is the authoritative exactly-once outcome;
	// selecting an older child message/tool-search preview here made successful
	// approvals look unrelated and noisy in CLI/Tedix OS.
	const preferParentPreview = Boolean(
		rowMetadata?.durableCodeResult && row.preview,
	);
	const preview =
		((preferParentPreview
			? row.preview
			: (childRunStatus?.childRunPreview ?? row.preview)) as
			| string
			| null
			| undefined) ?? null;
	const completedAt =
		(status === "completed" || status === "failed" || status === "canceled"
			? ((childRunStatus?.childRunTerminalAt as string | null | undefined) ??
				row.completedAt)
			: null) ?? null;
	return {
		status,
		// The run row carries no separate canonical "answer" body; the run-derived
		// content the message surface shows IS the preview/output text.
		content: preview,
		preview,
		completedAt,
	};
}

export function homeRunStatusFromChildStatus(
	status: HomeChildRunEvidence["status"] | undefined,
	fallback: TediRunStatus,
): TediRunStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "partial":
			return "failed";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
		case "running":
		case "streaming":
			return "running";
		case "requires_approval":
			return "requires_approval";
		case "queued":
			return "queued";
		default:
			return fallback;
	}
}

/**
 * Proof-verdict chip for a delegation attempt — carried as METADATA
 * (`metadata.delegationProof` on the completion message AND on the parent
 * Home run row), never concatenated into the assistant body: the body stays
 * what the tedi wrote and the OS renders the verdict as a chip. The OS maps
 * `verdict` words: verified/proven/passed → success, unverified/partial/
 * inconclusive → warning, failed/refuted/rejected → error. `reason` keeps the
 * exact ledger failure reason for diagnostics. `null` when the attempt has
 * not reached a verdict (non-terminal, or no disposition available).
 */
export type HomeDelegationProofMetadata = {
	verdict: "verified" | "unverified" | "failed";
	note?: string;
	reason?: NonNullable<DelegationAttemptResult["failureReason"]>;
};

export function homeDelegationProofMetadata(
	result: DelegationAttemptResult | null | undefined,
	status: TediRunStatus,
): HomeDelegationProofMetadata | null {
	// Only a COMPLETED child carries a proof verdict worth a chip; a failed or
	// canceled child already states its outcome in the message body.
	if (!result || status !== "completed") return null;
	if (result.outcome === "succeeded") {
		// Result references are telemetry, not independent verification of the task.
		return null;
	}
	if (result.outcome !== "failed") return null;
	switch (result.failureReason) {
		case "completed_without_proof":
			return {
				verdict: "unverified",
				reason: result.failureReason,
				note: "No durable execution evidence (commit, PR, or artifact) was recorded for this attempt — the Work Item remains accepted and can be re-dispatched.",
			};
		case "unverified_execution_evidence":
			return {
				verdict: "unverified",
				reason: result.failureReason,
				note: "Execution evidence for this attempt could not be verified (runtime telemetry is incomplete) — the Work Item remains accepted pending verification.",
			};
		case null:
			return null;
		default:
			return { verdict: "failed", reason: result.failureReason };
	}
}

/**
 * Read the caller-supplied output schema off a run row's opaque `metadata`
 * JSON column, defensively — `metadata.delegationWorkOrder.outputSchema` (see
 * `buildDelegationWorkOrder` in delegation-dispatch.ts, which is the only
 * writer of this key). Any shape mismatch (missing, wrong type, historical
 * row predating this feature) resolves to `null`, matching every other
 * defensive metadata read in this file.
 */
function delegationWorkOrderOutputSchema(
	metadata: unknown,
): Record<string, unknown> | null {
	const workOrder = nonNullRecord(nonNullRecord(metadata)?.delegationWorkOrder);
	const outputSchema = workOrder?.outputSchema;
	return outputSchema &&
		typeof outputSchema === "object" &&
		!Array.isArray(outputSchema)
		? (outputSchema as Record<string, unknown>)
		: null;
}

/**
 * Output-schema task mode (opt-in Tedix result-contract pattern): when a caller
 * supplied an output schema on the work order AND the delegation completed,
 * validate the relayed content against it. The verdict is MESSAGE METADATA
 * (`metadata.outputContract`) — the raw answer is never rewritten, relay-first
 * stays intact. `null` on success (no "contract met" affirmation) and whenever
 * there is nothing to validate, matching `homeDelegationProofMetadata`.
 */
export type HomeDelegationOutputContractMetadata = {
	met: false;
	errors: string[];
};

export function homeDelegationOutputContractMetadata(
	outputSchema: Record<string, unknown> | null | undefined,
	status: TediRunStatus,
	content: string,
): HomeDelegationOutputContractMetadata | null {
	if (!outputSchema || status !== "completed" || !content.trim()) return null;
	const result = validateDelegationOutput(content, outputSchema);
	if (result.valid) return null;
	return { met: false, errors: result.errors };
}

/**
 * The verdict metadata block for a delegation completion message — spread
 * into `payload.metadata` next to the relayed content. Empty when neither
 * verdict applies, so a clean completion carries no extra keys.
 */
export function homeDelegationVerdictMetadata(input: {
	disposition?: DelegationAttemptResult | null;
	outputSchema?: Record<string, unknown> | null;
	status: TediRunStatus;
	/** The operator-facing content the output contract validates (synthesis or the child's final message). */
	validatedContent: string | null;
}): {
	delegationProof?: HomeDelegationProofMetadata;
	outputContract?: HomeDelegationOutputContractMetadata;
} {
	const delegationProof = homeDelegationProofMetadata(
		input.disposition,
		input.status,
	);
	const outputContract = input.validatedContent
		? homeDelegationOutputContractMetadata(
				input.outputSchema,
				input.status,
				input.validatedContent,
			)
		: null;
	return {
		...(delegationProof ? { delegationProof } : {}),
		...(outputContract ? { outputContract } : {}),
	};
}

export function homeDelegationCompletionContent(input: {
	preview: string | null;
	synthesized?: string | null;
	finalMessage?: string | null;
	status: TediRunStatus;
	/** Runtime stop classification when the child was stopped early or reported partial. */
	stop?: Pick<DelegatedStopClassification, "detail" | "outcome"> | null;
}): string {
	// Proof and output-contract verdicts are NOT part of the body: they ride as
	// message metadata (`homeDelegationVerdictMetadata`) so the body stays
	// exactly what the tedi wrote and the OS renders the verdict as a chip.
	// When a full synthesis is available, use it directly — it's the operator-
	// facing interpreted answer, no wrapping needed.
	if (input.synthesized) return input.synthesized;
	// A runtime stop that left nothing but the `[Turn stopped early: …]` marker
	// is not a failed report and not a partial: the tedi produced no output.
	// Say so plainly, with the runtime's reason, instead of relaying the marker
	// as if it were the tedi's answer.
	if (
		input.stop?.outcome === "failed" &&
		input.status === "failed" &&
		!hasDelegatedOutput(input.finalMessage)
	) {
		return `The delegated tedi produced no output. ${input.stop.detail}; remaining work was not attempted.`;
	}
	// The child's own closing message is the next-best operator-facing answer:
	// show it as the result, not as wrapped "evidence".
	if (input.finalMessage) {
		switch (input.status) {
			case "completed":
				return input.finalMessage;
			case "failed":
				return input.stop?.outcome === "partial"
					? `The delegated tedi returned a partial result (${input.stop.detail}).\n\n${input.finalMessage}`
					: `The delegated tedi reported that the assignment failed.\n\n${input.finalMessage}`;
			case "canceled":
				return `The delegated tedi assignment was canceled.\n\n${input.finalMessage}`;
			default:
				return input.finalMessage;
		}
	}
	const evidence = input.preview ? ` Latest evidence: ${input.preview}` : "";
	switch (input.status) {
		case "completed":
			return `The delegated tedi finished the assignment.${evidence}`;
		case "failed":
			return `The delegated tedi reported that the assignment failed.${evidence}`;
		case "canceled":
			return `The delegated tedi assignment was canceled.${evidence}`;
		default:
			return `The delegated tedi published an update.${evidence}`;
	}
}

export async function ensureHomeConversationAccess(
	context: BaseContext,
	input: {
		conversationId: string;
		organizationId: string;
		required: KernelConversationAccessLevel;
	},
): Promise<void> {
	const decision = await resolveKernelConversationAccess(context.db, {
		conversationId: input.conversationId,
		descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
		organizationId: input.organizationId,
		required: input.required,
	});
	if (decision.allowed) return;
	throw createError(
		ErrorCodes.FORBIDDEN,
		`Access denied to Home conversation ${input.conversationId}`,
	);
}

function childRunStatusKeyForAssignment(
	assignment: HomePlan["assignments"][number],
): string | null {
	if (!assignment.ownerTediId || !assignment.childRunId) return null;
	return childRunStatusKey(assignment.ownerTediId, assignment.childRunId);
}

/**
 * Read the child run's full transcript and synthesize it via one bounded LLM
 * pass. Returns the synthesized string or null (any error → null; never throws).
 * Only called when the run is completed.
 */
async function readAndSynthesizeChildRunResult(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
	},
): Promise<string | null> {
	try {
		const fullResult = await readChildRunFullResult(context, input);
		if (!fullResult) return null;
		const model = kernelModel(
			context.env as unknown as KernelEnv,
			undefined,
			input.organizationId,
		);
		if (!model) return null;
		const { tracedAi } = await import("../../../lib/traced-ai");
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), 15_000);
		try {
			const synthResult = await tracedAi.generateText({
				model: model.model,
				system: DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
				runtimeContext: kernelSpanContext({
					organizationId: input.organizationId,
					runId: input.runId,
					source: "child_run_synthesis",
				}),
				telemetry: { functionId: "kernel.child_run_synthesis" },
				messages: [{ role: "user", content: fullResult }],
				maxOutputTokens: 1200,
				abortSignal: abortController.signal,
			});
			return synthResult.text?.trim() || null;
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		console.warn("[kernelRuntime] readAndSynthesizeChildRunResult failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		return null;
	}
}

export function normalizeHomeRunRecord(
	row: KernelRuntimeRun,
	childRunStatuses: Map<string, Record<string, unknown>> = new Map(),
): HomeRun {
	const observedChildRunStatus =
		row.delegatedTediId && row.childRunId
			? childRunStatuses.get(
					childRunStatusKey(row.delegatedTediId, row.childRunId),
				)
			: undefined;
	const rowMetadata = nonNullRecord(row.metadata);
	const persistedChildRunStatus =
		typeof rowMetadata?.childRunStatus === "string" ? rowMetadata : undefined;
	const childRunStatus = observedChildRunStatus ?? persistedChildRunStatus;
	const steerRunId = delegatedChildSteerRunId(row);
	const childSteerRunStatus =
		row.delegatedTediId && steerRunId
			? childRunStatuses.get(childRunStatusKey(row.delegatedTediId, steerRunId))
			: undefined;
	const childSteerRunResult = childSteerRunStatus
		? {
				childRunId: steerRunId,
				status: childRunStatusFromSummary(childSteerRunStatus),
				latestEventAt:
					(childSteerRunStatus.childRunLatestEventAt as
						| string
						| null
						| undefined) ?? null,
				latestEventKind:
					(childSteerRunStatus.childRunLatestEventKind as
						| string
						| null
						| undefined) ?? null,
				terminalAt:
					(childSteerRunStatus.childRunTerminalAt as
						| string
						| null
						| undefined) ?? null,
				preview:
					(childSteerRunStatus.childRunPreview as string | null | undefined) ??
					null,
			}
		: undefined;
	const childStatus = childRunStatusFromSummary(childRunStatus ?? null);
	const hasChildStatus = Boolean(childRunStatus);
	// Shared run-state derivation (status/preview/completedAt) so this run surface
	// and the message surface can never disagree on terminal state.
	const classified = classifyHomeRunState(row, childRunStatus ?? null);
	const status = classified.status;
	const childStop = delegatedStopFromSummary(childRunStatus ?? null);
	const latestActivityLabel =
		typeof childRunStatus?.childRunLatestActivityLabel === "string"
			? childRunStatus.childRunLatestActivityLabel
			: null;
	const useChildOutcome = hasChildStatus && row.status !== "canceled";
	const progress =
		!useChildOutcome && row.progressValue !== null && row.progressLabel
			? {
					current: row.progressValue,
					total: 100,
					label: row.progressLabel,
					detail: row.progressDetail ?? undefined,
				}
			: homeRunProgress({
					eventCount:
						typeof childRunStatus?.childRunEventCount === "number"
							? childRunStatus.childRunEventCount
							: (row.progressValue ?? 0) > 0
								? 1
								: 0,
					latestActivityLabel,
					status: useChildOutcome ? childStatus : status,
					stopDetail: childStop?.detail ?? null,
				});
	const runtimeMetadata = nonNullRecord(row.runtimeMetadata);
	const kernelWorkflowInspect = nonNullRecord(
		childRunStatus?.kernelWorkflowInspect,
	);
	const rowUsage = extractRunUsage(
		(row.metadata ?? null) as Record<string, unknown> | null,
	);
	return {
		id: row.id,
		organizationId: row.organizationId,
		conversationId: row.conversationId,
		status,
		inputMessageId: row.inputMessageId ?? undefined,
		outputMessageId: row.outputMessageId ?? null,
		delegatedTediId: row.delegatedTediId ?? null,
		childRunId: row.childRunId ?? null,
		runtime: {
			backend: row.runtimeBackend,
			externalId: row.runtimeExternalId ?? undefined,
			externalUrl: row.runtimeExternalUrl ?? undefined,
			metadata: {
				...runtimeMetadata,
				childConversationId: row.childConversationId ?? undefined,
			},
		},
		startedAt: row.startedAt ?? null,
		completedAt: classified.completedAt,
		// Observer ceiling for the run's owning submission. The run row itself
		// carries no `timeout_at` (it lives on `runtime_submissions`); surfaced as
		// null here until a per-run submission lookup is threaded. The contract
		// field is `.nullable().optional()`, so null is shape-correct and lets
		// submission-level reads populate it without a schema change.
		timeoutAt: null,
		createdAt: row.createdAt,
		updatedAt:
			row.status === "canceled"
				? (row.updatedAt ?? null)
				: ((childRunStatus?.childRunLatestEventAt as
						| string
						| null
						| undefined) ??
					row.updatedAt ??
					null),
		progress,
		...(rowUsage !== undefined ? { usage: rowUsage } : {}),
		metadata: {
			...nonNullRecord(row.metadata),
			// The delegation outcome follows parent cancellation while the child
			// status below remains the last independent child observation.
			delegationStatus: useChildOutcome ? childStatus : status,
			...(kernelWorkflowInspect ? { kernelWorkflowInspect } : {}),
			childConversationId: row.childConversationId ?? null,
			childRunId: row.childRunId ?? null,
			childRunLatestEventAt:
				childRunStatus?.childRunLatestEventAt ?? row.latestEventAt ?? null,
			childRunLatestEventKind:
				childRunStatus?.childRunLatestEventKind ?? row.latestEventKind ?? null,
			childRunPreview: classified.preview,
			childRunStatus: hasChildStatus ? childStatus : status,
			childTaskOutcome: childRunStatus?.childTaskOutcome ?? null,
			...(childRunStatus?.childRunTerminalEventKind
				? {
						childRunTerminalEventKind: childRunStatus.childRunTerminalEventKind,
					}
				: {}),
			...(childRunStatus?.childRunStopReason
				? { childRunStopReason: childRunStatus.childRunStopReason }
				: {}),
			...(childStop ? { childRunStopDetail: childStop.detail } : {}),
			...(childSteerRunResult
				? { delegatedChildSteerResult: childSteerRunResult }
				: {}),
			delegatedTediId: row.delegatedTediId ?? null,
			progress,
		},
	};
}

export type ReconciledHomePlanAssignment = {
	assignment: HomePlan["assignments"][number];
	latestEventAt: string | null;
	latestEventKind: TediRuntimeEventKind | undefined;
	preview: string | null;
	previousStatus: HomePlan["assignments"][number]["status"];
	status: HomePlan["assignments"][number]["status"];
	terminalAt: string | null;
};

export function reconcileHomePlanWithChildStatuses(
	plan: HomePlan,
	childRunStatuses: Map<string, Record<string, unknown>>,
): {
	changed: boolean;
	eventCount: number;
	latestEventAt: string | null;
	latestEventKind: TediRuntimeEventKind | undefined;
	plan: HomePlan;
	preview: string | null;
	terminalAssignments: ReconciledHomePlanAssignment[];
	terminalAt: string | null;
} {
	let changed = false;
	let eventCount = 0;
	const terminalAssignments: ReconciledHomePlanAssignment[] = [];
	const latestEventAts: string[] = [];
	const terminalAts: string[] = [];
	let latestEventKind: TediRuntimeEventKind | undefined;
	let preview: string | null = null;
	const assignments = plan.assignments.map((assignment) => {
		const key = childRunStatusKeyForAssignment(assignment);
		const childRunStatus = key ? childRunStatuses.get(key) : undefined;
		if (!childRunStatus) return assignment;
		const childStatus = childRunStatusFromSummary(childRunStatus);
		const nextStatus = planAssignmentStatusFromChildStatus(childStatus);
		const childEventCount =
			typeof childRunStatus.childRunEventCount === "number"
				? childRunStatus.childRunEventCount
				: 1;
		eventCount += childEventCount;
		const childLatestEventAt =
			typeof childRunStatus.childRunLatestEventAt === "string"
				? childRunStatus.childRunLatestEventAt
				: null;
		const childTerminalAt =
			typeof childRunStatus.childRunTerminalAt === "string"
				? childRunStatus.childRunTerminalAt
				: null;
		const childPreview =
			typeof childRunStatus.childRunPreview === "string"
				? childRunStatus.childRunPreview
				: null;
		const parsedEventKind =
			typeof childRunStatus.childRunLatestEventKind === "string"
				? TediRuntimeEventKindSchema.safeParse(
						childRunStatus.childRunLatestEventKind,
					)
				: null;
		if (childLatestEventAt) latestEventAts.push(childLatestEventAt);
		if (childTerminalAt) terminalAts.push(childTerminalAt);
		if (!preview && childPreview) preview = childPreview;
		if (!latestEventKind && parsedEventKind?.success) {
			latestEventKind = parsedEventKind.data;
		}
		const nextAssignment = {
			...assignment,
			error:
				nextStatus === "failed"
					? (childPreview ?? assignment.error ?? null)
					: (assignment.error ?? null),
			status: nextStatus,
		};
		const changedAssignment =
			assignment.status !== nextStatus ||
			(nextStatus === "failed" && nextAssignment.error !== assignment.error);
		if (changedAssignment) changed = true;
		if (
			["completed", "failed", "canceled"].includes(nextStatus) &&
			assignment.status !== nextStatus
		) {
			terminalAssignments.push({
				assignment: nextAssignment,
				latestEventAt: childLatestEventAt,
				latestEventKind: parsedEventKind?.success
					? parsedEventKind.data
					: undefined,
				preview: childPreview,
				previousStatus: assignment.status,
				status: nextStatus,
				terminalAt: childTerminalAt,
			});
		}
		return nextAssignment;
	});
	const nextPlan: HomePlan = {
		...plan,
		assignments,
		attentionRoutes: plan.attentionRoutes.map((route) => {
			const matching = assignments.find(
				(assignment) => assignment.ownerTediId === route.ownerTediId,
			);
			if (!matching) return route;
			const outcome =
				matching.status === "completed"
					? "completed"
					: matching.status === "canceled"
						? "rejected"
						: ["running", "queued"].includes(matching.status)
							? "dispatched"
							: route.outcome;
			return outcome === route.outcome ? route : { ...route, outcome };
		}),
	};
	nextPlan.status = approvedHomePlanStatus(nextPlan);
	if (nextPlan.status !== plan.status) changed = true;
	return {
		changed,
		eventCount,
		latestEventAt: latestIso(latestEventAts),
		latestEventKind,
		plan: nextPlan,
		preview,
		terminalAssignments,
		terminalAt: latestIso(terminalAts),
	};
}

function oneLinePreview(value: unknown, max = 240): string {
	if (typeof value !== "string") return "No result summary was published.";
	const uuidSource =
		"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
	const uuid = new RegExp(uuidSource, "gi");
	const compact = value
		// Child completions often include the internal Work Item UUID as proof.
		// Keep that correlation in traces/audit, not in the calm operator summary.
		.replace(
			new RegExp(`(?:Home )?Work Item \`${uuidSource}\``, "gi"),
			"the delegated work item",
		)
		.replace(new RegExp(`\`${uuidSource}\``, "gi"), "the delegated work item")
		.replace(uuid, "the delegated work item")
		.replace(/\s+/g, " ")
		.trim()
		.replaceAll("|", "\\|");
	if (!compact) return "No result summary was published.";
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

/** Deterministic, exactly-once operator synthesis for a settled Home plan. */
export function homePlanFinalSynthesisContent(
	plan: HomePlan,
	childRunStatuses: Map<string, Record<string, unknown>>,
): string {
	const failed = plan.assignments.filter((assignment) =>
		["failed", "canceled"].includes(assignment.status),
	).length;
	const heading =
		failed > 0
			? `Coordinated work finished with ${failed} issue${failed === 1 ? "" : "s"}.`
			: `Coordinated work completed across ${plan.assignments.length} tedis.`;
	const rows = plan.assignments.map((assignment) => {
		const key = childRunStatusKeyForAssignment(assignment);
		const child = key ? childRunStatuses.get(key) : undefined;
		const preview =
			child?.childRunPreview ??
			assignment.error ??
			"No result summary was published.";
		return `| ${assignment.ownerLabel.replaceAll("|", "\\|")} | ${assignment.status} | ${oneLinePreview(preview)} |`;
	});
	return [
		heading,
		"",
		"| Tedi | Outcome | Result |",
		"| --- | --- | --- |",
		...rows,
	].join("\n");
}

// ── Post-cancel child reconcile (P0 cancel race) ────────────────────────────
//
// A parent run can be `canceled` while its delegated child is STILL RUNNING:
// the operator cancel raced the turn's auto-dispatch, so cancelKernelRunCore
// saw `childRunId` null and skipped its child-stop cascade, and the child link
// landed on the canceled row afterwards. The run-set reconcile is the read
// path that notices this, so it invokes the SAME child-stop mechanism the
// cancel core uses. The stopper is injected as a seam because this module must
// NOT import kernel-runtime.ts (cycle); kernel-runtime registers it at module
// init. Absent seam ⇒ no stop (today's behavior, fail-soft).

export type CanceledParentChildStopResult = {
	attempted: boolean;
	outcome: "succeeded" | "failed" | "skipped";
	error?: string;
};

export type CanceledParentChildStopper = (
	context: BaseContext,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
		childConversationId: string | null;
		reason?: string;
	},
) => Promise<CanceledParentChildStopResult>;

let canceledParentChildStopper: CanceledParentChildStopper | null = null;

export function registerCanceledParentChildStopper(
	stopper: CanceledParentChildStopper | null,
): void {
	canceledParentChildStopper = stopper;
}

/**
 * Stop a canceled parent's still-live delegated child, once. Marker-gated:
 * a successful cancel-core stop (`metadata.delegatedChildStop.outcome ===
 * "succeeded"`) or a prior reconcile attempt (`metadata.canceledChildStopReconcile`)
 * skips the read entirely, so steady-state polls over canceled history rows do
 * ZERO extra work. Terminal parents are excluded from the batch child-status
 * read (perf), so this does its own single bounded summary read to decide
 * live-vs-terminal; a terminal child records a "skipped" marker without a stop
 * RPC. Fail-soft everywhere — a stop or persist failure never breaks the read.
 * Returns the row with the persisted marker metadata, or null when nothing was
 * done.
 */
async function stopCanceledParentChildIfLive(
	context: BaseContext,
	row: KernelRuntimeRun,
): Promise<KernelRuntimeRun | null> {
	if (!canceledParentChildStopper) return null;
	if (!row.delegatedTediId || !row.childRunId) return null;
	const metadata = nonNullRecord(row.metadata) ?? {};
	const coreStop = nonNullRecord(metadata.delegatedChildStop);
	if (coreStop?.outcome === "succeeded") return null;
	if (nonNullRecord(metadata.canceledChildStopReconcile)) return null;
	const summary = await readSingleChildRunSummary(context, {
		tediId: row.delegatedTediId,
		runId: row.childRunId,
	});
	const childStatus = summary ? childRunStatusFromSummary(summary) : null;
	const childTerminal =
		childStatus === "completed" ||
		childStatus === "failed" ||
		childStatus === "canceled";
	const at = nowIso();
	let marker: Record<string, unknown>;
	if (childTerminal) {
		// Child already settled on its own — record the decision so the summary
		// read never repeats, but do not fire a stop RPC.
		marker = {
			attempted: false,
			outcome: "skipped",
			childRunId: row.childRunId,
			childRunStatus: childStatus,
			at,
		};
	} else {
		let stop: CanceledParentChildStopResult;
		try {
			stop = await canceledParentChildStopper(context, {
				organizationId: row.organizationId,
				delegatedTediId: row.delegatedTediId,
				childRunId: row.childRunId,
				childConversationId: row.childConversationId ?? null,
				reason: "Parent Home run canceled by operator",
			});
		} catch (error) {
			stop = { attempted: true, outcome: "failed", error: errorMessage(error) };
		}
		marker = {
			attempted: stop.attempted,
			outcome: stop.outcome,
			...(stop.error ? { error: stop.error.slice(0, 200) } : {}),
			childRunId: row.childRunId,
			at,
		};
	}
	const nextMetadata = { ...metadata, canceledChildStopReconcile: marker };
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: row.id,
			organizationId: row.organizationId,
			patch: { metadata: toJsonRecord(nextMetadata) },
		});
	} catch (error) {
		console.warn(
			"[kernelRuntime] canceled-child stop marker persist failed",
			errorMessage(error),
		);
		// Marker not durable → the next read retries; the stop RPC itself is
		// idempotent-safe (stopping an already-stopped child records "failed").
	}
	return { ...row, metadata: toJsonRecord(nextMetadata) };
}

export async function reconcileHomeRunRowsFromChildStatus(
	context: BaseContext,
	input: {
		childRunStatuses: Map<string, Record<string, unknown>>;
		rows: KernelRuntimeRun[];
	},
): Promise<KernelRuntimeRun[]> {
	return Promise.all(
		input.rows.map(async (row) => {
			const plan = readOptionalHomePlanFromRun(row);
			if (plan) {
				return reconcileHomePlanRunRowFromChildStatus(context, {
					childRunStatuses: input.childRunStatuses,
					plan,
					row,
				});
			}
			if (!row.delegatedTediId || !row.childRunId) return row;
			const childRunStatus = input.childRunStatuses.get(
				childRunStatusKey(row.delegatedTediId, row.childRunId),
			);
			// Post-cancel child reconcile: a parent already `canceled` with a linked
			// child means the dispatch may have slipped through the cancel race —
			// stop the still-live child via the same mechanism cancelKernelRunCore
			// uses (marker-gated single shot; fail-soft; parent stays canceled).
			// Terminal parents are excluded from the batch child-status read, so
			// canceled rows always land in the `!childRunStatus` path below.
			const canceledStopRow =
				row.status === "canceled"
					? await stopCanceledParentChildIfLive(context, row)
					: null;
			if (!childRunStatus) {
				if (isTerminalHomeRunStatus(row.status as TediRunStatus)) {
					const run = normalizeHomeRunRecord(row);
					const runMetadata = nonNullRecord(run.metadata) ?? {};
					const latestEventKindParse = row.latestEventKind
						? TediRuntimeEventKindSchema.safeParse(row.latestEventKind)
						: null;
					// A terminal Home row is sufficient evidence to repair a completion
					// message even if child events are temporarily unavailable. The
					// repair pays the REAL content path (synthesis / child final
					// assistant message — both retry-backed and fail-soft, falling back
					// to the rolling preview) — but only when the completion message is
					// actually missing: the deterministic-event-id pre-check keeps
					// steady-state reads over terminal history at zero child-evidence
					// queries and keeps repeated read repairs idempotent.
					let completionMessageExists = false;
					try {
						const [existingCompletion] = await listKernelRuntimeEvents(
							context.db,
							{
								id: homeDelegationCompletionEventId(row),
								organizationId: row.organizationId,
								limit: 1,
							},
						);
						completionMessageExists = Boolean(existingCompletion);
					} catch (error) {
						// Fail-soft: an unreadable gate degrades to the idempotent insert
						// (onConflictDoNothing) rather than skipping the repair.
						console.warn(
							"[kernelRuntime] completion-message existence check failed",
							{ error: errorMessage(error), runId: row.id },
						);
					}
					// Dispose FIRST so the completion message can disclose the Work-Item
					// proof verdict (idempotent — an already-disposed item still returns
					// its derived disposition).
					try {
						const disposition = await disposeTerminalDirectDelegationWorkItem(
							context,
							{
								createdAt:
									run.completedAt ??
									run.updatedAt ??
									row.updatedAt ??
									row.createdAt,
								metadata: runMetadata,
								preview:
									typeof runMetadata.childRunPreview === "string"
										? runMetadata.childRunPreview
										: (row.preview ?? null),
								row,
								run,
							},
							{ enqueue: kernelUnblockEnqueue(context) },
						);
						if (!completionMessageExists) {
							await recordHomeDelegationCompletionMessage(context, {
								createdAt:
									run.completedAt ??
									run.updatedAt ??
									row.updatedAt ??
									row.createdAt,
								disposition,
								latestEventAt: row.latestEventAt ?? null,
								latestEventKind:
									latestEventKindParse?.success === true
										? latestEventKindParse.data
										: undefined,
								preview: row.preview ?? null,
								row,
								run,
							});
						}
					} catch (error) {
						// A historical repair is maintenance, never read authority. One
						// stale/missing delegation Work Item must not erase the whole run
						// set—including unrelated approvals the operator must resolve.
						console.warn("[kernelRuntime] terminal read repair failed", {
							error: errorMessage(error),
							runId: row.id,
						});
					}
				}
				if (!isStaleDelegationDispatchRow(row)) return canceledStopRow ?? row;
				const failedAt = nowIso();
				// Two very different failures reach this point, and reporting them
				// with one message sends operators after the wrong system. If the
				// dispatch ledger holds a row for this run whose `run_id` was never
				// mapped, the inject never landed and the child never heard about the
				// work at all — blaming it for "publishing no events" is false, and it
				// sends operators to debug the child runtime. A mapped `run_id` with no events is the real child-silent
				// case. When no ledger row is found we report the child-silent timeout.
				const dispatchNeverLanded = await didDispatchNeverLand(context, row);
				const error = dispatchNeverLanded
					? "Delegated child dispatch never reached the target runtime: the work order was accepted by Home but no child run was ever assigned"
					: "Delegated child dispatch timed out before the child runtime published events";
				const progress = homeRunProgress({
					eventCount: 0,
					status: "failed",
				});
				const preview = `Delegated child dispatch failed: ${error}`;
				const metadata = {
					...nonNullRecord(row.metadata),
					childConversationId: row.childConversationId ?? null,
					childRunId: row.childRunId,
					childRunLatestEventAt: failedAt,
					childRunLatestEventKind: "run.failed",
					childRunPreview: preview,
					childRunStatus: "failed",
					delegatedTediId: row.delegatedTediId,
					delegationFailure: buildDelegationFailureEnvelope({
						reason: "dispatch_failed",
						error,
					}),
					idempotencyKey: row.id,
					progress,
					source: "kernelRuntime.delegateDispatch",
				};
				await recordHomeDelegationDispatchFailure(context, {
					childConversationId: row.childConversationId,
					childRunId: row.childRunId,
					conversationId: row.conversationId,
					delegatedTediId: row.delegatedTediId,
					error,
					existingMetadata: nonNullRecord(row.metadata),
					failedAt,
					organizationId: row.organizationId,
					runId: row.id,
				});
				// Step 5 — stale/timeout: a no-events child must also TERMINATE the
				// Work Item (release the lease as blocked) rather than leave it claimed
				// forever. Fail-soft via disposeDelegationWorkItem (attempt settlement
				// returns null if already disposed). Mapped through the same terminal
				// disposer with a failed status + dispatch_timeout blocker note.
				const staleWorkItemId = await resolveDelegationWorkItemId(context, row);
				if (staleWorkItemId) {
					await disposeDelegationWorkItem(context, {
						childRunId: row.childRunId,
						childRunStatus: "failed",
						createdAt: failedAt,
						delegatedTediId: row.delegatedTediId,
						delegationError: `${
							dispatchNeverLanded ? "dispatch_never_landed" : "dispatch_timeout"
						}: ${error}`,
						organizationId: row.organizationId,
						proof: {
							hasProof: false,
							evidenceState: "missing",
							terminalExecutionSucceeded: false,
							repoCommitSha: null,
							prRef: null,
							artifactRefs: [],
							rationaleRef: null,
							transcript: null,
						},
						workItemId: staleWorkItemId,
					});
				}
				return {
					...row,
					status: "failed",
					progressValue: progress.current,
					progressLabel: progress.label,
					progressDetail: progress.detail,
					latestEventKind: "run.failed",
					latestEventAt: failedAt,
					preview,
					completedAt: failedAt,
					updatedAt: failedAt,
					metadata,
				};
			}
			const run = normalizeHomeRunRecord(row, input.childRunStatuses);
			const latestEventKindParse =
				typeof run.metadata?.childRunLatestEventKind === "string"
					? TediRuntimeEventKindSchema.safeParse(
							run.metadata.childRunLatestEventKind,
						)
					: null;
			const latestEventKind: TediRuntimeEventKind | undefined =
				latestEventKindParse?.success === true
					? latestEventKindParse.data
					: undefined;
			const latestEventAt =
				typeof run.metadata?.childRunLatestEventAt === "string"
					? run.metadata.childRunLatestEventAt
					: null;
			const preview =
				typeof run.metadata?.childRunPreview === "string"
					? run.metadata.childRunPreview
					: null;
			const terminal = isTerminalHomeRunStatus(run.status);
			const nextMetadata = {
				...nonNullRecord(row.metadata),
				...nonNullRecord(run.metadata),
				source: "kernelRuntime.reconcileChildStatus",
			};
			const nextProgressValue = run.progress?.current ?? null;
			const nextProgressLabel = run.progress?.label ?? null;
			const nextProgressDetail = run.progress?.detail ?? null;
			const nextCompletedAt = run.completedAt ?? null;
			const nextUpdatedAt = run.updatedAt ?? row.updatedAt ?? row.createdAt;
			// T1.3: on terminal reconcile, point outputMessageId at the async-completion
			// assistant message that recordHomeDelegationCompletionMessage will write.
			// Guard on delegatedTediId + childRunId — same precondition as that fn.
			const nextOutputMessageId =
				terminal && row.delegatedTediId && row.childRunId
					? asyncCompletionAssistantMessageId(row.id)
					: (row.outputMessageId ?? null);
			const nextRow = {
				...row,
				status: run.status,
				progressValue: nextProgressValue,
				progressLabel: nextProgressLabel,
				progressDetail: nextProgressDetail,
				latestEventKind: latestEventKind ?? null,
				latestEventAt,
				outputMessageId: nextOutputMessageId,
				preview,
				completedAt: nextCompletedAt,
				updatedAt: nextUpdatedAt,
				metadata: nextMetadata,
			};
			const unchanged =
				row.status === run.status &&
				(row.progressValue ?? null) === nextProgressValue &&
				(row.progressLabel ?? null) === nextProgressLabel &&
				(row.progressDetail ?? null) === nextProgressDetail &&
				(row.latestEventKind ?? null) === (latestEventKind ?? null) &&
				(row.latestEventAt ?? null) === latestEventAt &&
				(row.outputMessageId ?? null) === nextOutputMessageId &&
				(row.preview ?? null) === preview &&
				(row.completedAt ?? null) === nextCompletedAt &&
				(row.updatedAt ?? null) === nextUpdatedAt;
			if (unchanged) {
				if (terminal) {
					try {
						await settleTerminalHomeRunSubmission(context, row, run.status);
						// Dispose first so the repaired message can disclose the proof
						// verdict; then repair a prior fail-soft insert failure. The
						// completion event id is deterministic, so normal repeated reads
						// remain idempotent.
						const disposition = await disposeTerminalDirectDelegationWorkItem(
							context,
							{
								createdAt: nextCompletedAt ?? nextUpdatedAt,
								metadata: nextMetadata,
								preview,
								row,
								run,
							},
							{ enqueue: kernelUnblockEnqueue(context) },
						);
						await recordHomeDelegationCompletionMessage(context, {
							createdAt: nextCompletedAt ?? nextUpdatedAt,
							disposition,
							latestEventAt,
							latestEventKind,
							preview,
							row,
							run,
						});
					} catch (error) {
						console.warn("[kernelRuntime] terminal read repair failed", {
							error: errorMessage(error),
							runId: row.id,
						});
					}
				}
				return row;
			}
			try {
				await updateKernelRuntimeRunForOrg(context.db, {
					id: row.id,
					organizationId: row.organizationId,
					patch: {
						status: run.status,
						progressValue: nextProgressValue,
						progressLabel: nextProgressLabel,
						progressDetail: nextProgressDetail,
						latestEventKind,
						latestEventAt,
						outputMessageId: nextOutputMessageId,
						preview,
						completedAt: nextCompletedAt,
						updatedAt: nextUpdatedAt,
						metadata: nextMetadata,
					},
				});
				if (terminal) {
					try {
						await settleTerminalHomeRunSubmission(context, row, run.status);
						// Step 4 — disposition: map terminal child status to the Work Item.
						// Runs BEFORE the completion message so the message can disclose the
						// proof verdict. Idempotent and also called for unchanged terminal
						// rows above, so a transient missed disposer is repaired by any later
						// run-set read.
						const disposition = await disposeTerminalDirectDelegationWorkItem(
							context,
							{
								createdAt: nextCompletedAt ?? nextUpdatedAt,
								metadata: nextMetadata,
								preview,
								row,
								run,
							},
							{ enqueue: kernelUnblockEnqueue(context) },
						);
						await recordHomeDelegationCompletionMessage(context, {
							createdAt: nextCompletedAt ?? nextUpdatedAt,
							disposition,
							latestEventAt,
							latestEventKind,
							preview,
							row,
							run,
						});
					} catch (error) {
						console.warn("[kernelRuntime] terminal read repair failed", {
							error: errorMessage(error),
							runId: row.id,
						});
					}
				} else {
					// Surface INTERMEDIATE child progress live: a non-terminal child
					// advance (queued→running→streaming, fresh preview/delta) emits a
					// work-card progress event so the parent card updates during
					// delegation, not only on the queued→completed jump. Idempotent per
					// child latestEventAt — repeated reconcile polls over the same child
					// event collapse to one event id.
					await recordHomeDelegationProgressMessage(context, {
						createdAt: nextUpdatedAt,
						latestEventAt,
						latestEventKind,
						preview,
						row,
						run,
					});
					// Step 3 — heartbeat: mirror INTERMEDIATE liveness onto the Work Item.
					// The writer buckets pulses per minute and never copies raw previews;
					// exact tool/delta events remain in the child trace.
					const heartbeatWorkItemId = await resolveDelegationWorkItemId(
						context,
						row,
					);
					if (heartbeatWorkItemId) {
						await recordDelegationWorkItemHeartbeat(context, {
							childRunId: row.childRunId,
							createdAt: nextUpdatedAt,
							delegatedTediId: row.delegatedTediId,
							latestEventAt,
							latestEventKind: latestEventKind ?? null,
							organizationId: row.organizationId,
							progress: run.progress
								? {
										current: run.progress.current,
										label: run.progress.label,
									}
								: null,
							workItemId: heartbeatWorkItemId,
						});
					}
				}
				return nextRow;
			} catch (error) {
				if (shouldFailSoftHomeRunSetRead(error)) {
					console.warn("[kernelRuntime] run-set reconciliation failed", {
						runId: row.id,
						childRunId: row.childRunId,
						error: errorMessage(error),
					});
					return row;
				}
				throw error;
			}
		}),
	);
}

async function settleTerminalHomeRunSubmission(
	context: BaseContext,
	row: KernelRuntimeRun,
	status: TediRunStatus,
): Promise<void> {
	const outcome = kernelRunStatusToSubmissionOutcome(status);
	if (!outcome) return;
	await settleKernelSubmission(context.db, {
		runId: row.id,
		organizationId: row.organizationId,
		conversationId: row.conversationId,
		outcome,
	});
}

async function reconcileHomePlanRunRowFromChildStatus(
	context: BaseContext,
	input: {
		childRunStatuses: Map<string, Record<string, unknown>>;
		plan: HomePlan;
		row: KernelRuntimeRun;
	},
): Promise<KernelRuntimeRun> {
	const reconciliation = reconcileHomePlanWithChildStatuses(
		input.plan,
		input.childRunStatuses,
	);
	if (!reconciliation.changed) return input.row;
	const reconciledRunStatus = homeRunStatusFromPlanStatus(
		reconciliation.plan.status,
	);
	// A terminal child set is not yet the operator answer. Keep the parent live
	// until the inbox-wake convergence turn has assembled every full child
	// transcript and persisted the single canonical plan-convergence message.
	// This prevents the deterministic evidence table from winning a race against
	// the richer synthesis and then suppressing that better answer in the TUI.
	const awaitingConvergence = isTerminalHomeRunStatus(reconciledRunStatus);
	const runStatus: TediRunStatus = awaitingConvergence
		? "running"
		: reconciledRunStatus;
	const progress = homeRunProgress({
		eventCount: reconciliation.eventCount,
		status: reconciledRunStatus,
	});
	const completedAt = awaitingConvergence ? null : reconciliation.terminalAt;
	const fallbackPreview = awaitingConvergence
		? homePlanFinalSynthesisContent(reconciliation.plan, input.childRunStatuses)
		: null;
	const finalMessageId = input.row.outputMessageId;
	const updatedAt =
		reconciliation.latestEventAt ?? input.row.updatedAt ?? input.row.createdAt;
	const metadata = {
		...nonNullRecord(input.row.metadata),
		homePlan: reconciliation.plan,
		homePlanReconciledAt: updatedAt,
		...(awaitingConvergence ? { homePlanConvergencePending: true } : {}),
		progress,
		source: "kernelRuntime.reconcileHomePlanAssignments",
	};
	const nextRow = {
		...input.row,
		status: runStatus,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		latestEventKind:
			reconciliation.latestEventKind ?? input.row.latestEventKind,
		latestEventAt: reconciliation.latestEventAt ?? input.row.latestEventAt,
		outputMessageId: finalMessageId,
		preview: fallbackPreview ?? reconciliation.preview ?? input.row.preview,
		completedAt,
		updatedAt,
		metadata,
	};
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.row.id,
			organizationId: input.row.organizationId,
			patch: {
				status: runStatus,
				progressValue: progress.current,
				progressLabel: progress.label,
				progressDetail: progress.detail,
				latestEventKind:
					reconciliation.latestEventKind ?? input.row.latestEventKind,
				latestEventAt: reconciliation.latestEventAt ?? input.row.latestEventAt,
				outputMessageId: finalMessageId,
				preview: fallbackPreview ?? reconciliation.preview ?? input.row.preview,
				completedAt,
				updatedAt,
				metadata,
			},
		});
		await Promise.all(
			reconciliation.terminalAssignments.map((assignment) =>
				recordHomePlanAssignmentCompletion(context, {
					assignment,
					conversationId: input.row.conversationId,
					homeRunId: input.row.id,
					organizationId: input.row.organizationId,
				}),
			),
		);
		return nextRow;
	} catch (error) {
		if (shouldFailSoftHomeRunSetRead(error)) {
			console.warn("[kernelRuntime] plan assignment reconciliation failed", {
				error: errorMessage(error),
				runId: input.row.id,
			});
			return input.row;
		}
		throw error;
	}
}

function homePlanAssignmentCompletionContent(input: {
	assignment: HomePlan["assignments"][number];
	preview: string | null;
	status: HomePlan["assignments"][number]["status"];
}): string {
	const evidence = input.preview ? ` Latest evidence: ${input.preview}` : "";
	switch (input.status) {
		case "completed":
			return `${input.assignment.ownerLabel} finished the approved Home assignment.${evidence}`;
		case "failed":
			return `${input.assignment.ownerLabel} reported that the approved Home assignment failed.${evidence}`;
		case "canceled":
			return `${input.assignment.ownerLabel}'s approved Home assignment was canceled.${evidence}`;
		default:
			return `${input.assignment.ownerLabel} published an update for the approved Home assignment.${evidence}`;
	}
}

async function insertWorkItemCommentIfAbsent(
	context: BaseContext,
	input: {
		authorId: string;
		body: string;
		createdAt: string;
		id: string;
		metadata: Record<string, unknown>;
		orgId: string;
		workItemId: string;
	},
): Promise<void> {
	await addWorkItemCommentIfAbsent(context.db, {
		id: input.id,
		workItemId: input.workItemId,
		orgId: input.orgId,
		authorType: "system",
		authorId: input.authorId,
		body: input.body,
		metadata: toJsonRecord(input.metadata),
		createdAt: input.createdAt,
	});
}

async function recordHomePlanAssignmentCompletion(
	context: BaseContext,
	input: {
		assignment: ReconciledHomePlanAssignment;
		conversationId: string;
		homeRunId: string;
		organizationId: string;
	},
): Promise<void> {
	const assignment = input.assignment.assignment;
	if (!assignment.childRunId) return;
	const createdAt =
		input.assignment.terminalAt ?? input.assignment.latestEventAt ?? nowIso();
	const content = homePlanAssignmentCompletionContent({
		assignment,
		preview: input.assignment.preview,
		status: input.assignment.status,
	});
	if (assignment.workItemId) {
		const completionMetadata = {
			childRunId: assignment.childRunId,
			childRunLatestEventAt: input.assignment.latestEventAt,
			childRunLatestEventKind: input.assignment.latestEventKind ?? null,
			childRunPreview: input.assignment.preview,
			childRunStatus: input.assignment.status,
			homePlanAssignmentId: assignment.id,
			homeRunId: input.homeRunId,
			source: "kernelRuntime.planAssignmentCompletion",
		};
		const attempt = (
			await listWorkItemAttempts(context.db, {
				orgId: input.organizationId,
				workItemId: assignment.workItemId,
			})
		).data.find(
			(candidate) =>
				candidate.runId === assignment.childRunId &&
				["running", "waiting", "retrying"].includes(candidate.runtimeState),
		);
		if (attempt) {
			await settleWorkItemAttempt(context.db, {
				orgId: input.organizationId,
				workItemId: assignment.workItemId,
				attemptId: attempt.id,
				executor: { type: "tedi", id: assignment.ownerTediId },
				outcome:
					input.assignment.status === "completed"
						? "succeeded"
						: input.assignment.status === "canceled"
							? "cancelled"
							: "failed",
				summary: content,
				metadata: toJsonRecord(completionMetadata),
				settledAt: createdAt,
			});
		}
		await insertWorkItemCommentIfAbsent(context, {
			id: `${assignment.workItemId}:home-plan-terminal:${input.assignment.status}`,
			workItemId: assignment.workItemId,
			orgId: input.organizationId,
			authorId: "home",
			body: content,
			metadata: {
				assignmentId: assignment.id,
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				homeRunId: input.homeRunId,
			},
			createdAt,
		});
		// A terminal plan branch clears a blocker edge: run the unblock watcher so
		// a sibling assignment whose dispatch was deferred on this branch actually
		// dispatches (the cross-assignment deadlock fix — previously nothing fired
		// here and a deferred sibling waited forever; live repro run 234803c5).
		if (
			input.assignment.status === "completed" ||
			input.assignment.status === "canceled"
		) {
			await surfaceUnblockedDependents(
				context,
				{
					blockerWorkItemId: assignment.workItemId,
					organizationId: input.organizationId,
					createdAt,
				},
				{ enqueue: kernelUnblockEnqueue(context) },
			);
		}
	}
	const outcomeKind =
		input.assignment.status === "completed"
			? "subagent.completed"
			: input.assignment.status === "failed" ||
				  input.assignment.status === "canceled"
				? "subagent.failed"
				: null;
	if (outcomeKind) {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: outcomeKind,
				conversationId: input.conversationId,
				runId: input.homeRunId,
				suffix: assignment.id,
			}),
			organizationId: input.organizationId,
			kind: outcomeKind,
			conversationId: input.conversationId,
			runId: input.homeRunId,
			delegatedTediId: assignment.ownerTediId,
			childRunId: assignment.childRunId,
			payload: {
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				delegatedTediId: assignment.ownerTediId,
				homePlanAssignmentId: assignment.id,
				homeRunId: input.homeRunId,
				source: "kernelRuntime.planAssignmentCompletion",
				workItemId: assignment.workItemId ?? null,
			},
			runtimeMetadata: {
				childRunStatus: input.assignment.status,
				source: "kernelRuntime.planAssignmentCompletion",
			},
			createdAt,
		});
	}
	await insertKernelRuntimeEvent(context, {
		id: homeRuntimeEventId({
			organizationId: input.organizationId,
			kind: "message.completed",
			conversationId: input.conversationId,
			runId: input.homeRunId,
			suffix: `${assignment.id}:plan-assignment-completion`,
		}),
		organizationId: input.organizationId,
		kind: "message.completed",
		conversationId: input.conversationId,
		runId: input.homeRunId,
		// Per-assignment id family — intentionally NOT
		// asyncCompletionAssistantMessageId(), which is the run-level message id
		// that the terminal reconcile outputMessageId points at.
		messageId: `${input.homeRunId}:${assignment.id}:async-completion:assistant`,
		delegatedTediId: assignment.ownerTediId,
		childRunId: assignment.childRunId,
		payload: {
			role: "assistant",
			content,
			channel: "home",
			metadata: {
				asyncCompletion: true,
				childRunId: assignment.childRunId,
				childRunLatestEventAt: input.assignment.latestEventAt,
				childRunLatestEventKind: input.assignment.latestEventKind ?? null,
				childRunPreview: input.assignment.preview,
				childRunStatus: input.assignment.status,
				delegatedTediId: assignment.ownerTediId,
				homePlanAssignmentId: assignment.id,
				homeRunId: input.homeRunId,
				homeSubject: true,
				source: "kernelRuntime.planAssignmentCompletion",
				workItemId: assignment.workItemId ?? null,
			},
		},
		runtimeMetadata: {
			asyncCompletion: true,
			childRunId: assignment.childRunId,
			childRunLatestEventAt: input.assignment.latestEventAt,
			childRunLatestEventKind: input.assignment.latestEventKind ?? null,
			childRunStatus: input.assignment.status,
			delegatedTediId: assignment.ownerTediId,
			homePlanAssignmentId: assignment.id,
			source: "kernelRuntime.planAssignmentCompletion",
			workItemId: assignment.workItemId ?? null,
		},
		createdAt,
	});
}

/**
 * Emit an INTERMEDIATE delegation-progress event when a non-terminal child
 * advance is reconciled onto the parent run row, so the Home work card reflects
 * live progress (running/streaming + the child's latest evidence preview)
 * instead of jumping straight from queued to the terminal completion message.
 *
 * Emitted as a `message.delta` runtime event (not a `message.completed`
 * assistant message), so it feeds the work-card/event timeline without
 * polluting the Home chat transcript — `isHomeMessageEvent` only surfaces
 * received/completed messages. Idempotent: the event id is keyed by the child's
 * `latestEventAt`, so repeated reconcile polls over the same child event
 * collapse to one row. Fail-soft: a progress insert never breaks reconciliation.
 */
async function recordHomeDelegationProgressMessage(
	context: BaseContext,
	input: {
		createdAt: string;
		latestEventAt: string | null;
		latestEventKind: TediRuntimeEventKind | undefined;
		preview: string | null;
		row: KernelRuntimeRun;
		run: HomeRun;
	},
): Promise<void> {
	if (!input.row.delegatedTediId || !input.row.childRunId) return;
	// Only surface genuinely-active progress; a queued/needs-approval child with
	// no work advance yet carries no evidence worth a timeline event. The HomeRun
	// status collapses streaming→running, so "running" is the active gate.
	if (input.run.status !== "running") return;
	// The richer child sub-state (running vs streaming) lives in run metadata.
	const childRunStatus =
		stringFromPayload(nonNullRecord(input.run.metadata)?.childRunStatus) ??
		input.run.status;
	try {
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.row.organizationId,
				kind: "message.delta",
				conversationId: input.row.conversationId,
				runId: input.row.id,
				childRunId: input.row.childRunId,
				suffix: `progress:${input.latestEventAt ?? input.createdAt}`,
			}),
			organizationId: input.row.organizationId,
			kind: "message.delta",
			conversationId: input.row.conversationId,
			runId: input.row.id,
			delegatedTediId: input.row.delegatedTediId,
			childRunId: input.row.childRunId,
			delta: input.preview ?? undefined,
			payload: {
				role: "assistant",
				channel: "home",
				content: input.preview ?? "",
				metadata: {
					asyncProgress: true,
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					homeSubject: true,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationProgress",
				},
			},
			runtimeMetadata: {
				asyncProgress: true,
				childRunId: input.row.childRunId,
				childRunLatestEventAt: input.latestEventAt,
				childRunLatestEventKind: input.latestEventKind ?? null,
				childRunStatus,
				delegatedTediId: input.row.delegatedTediId,
				source: "kernelRuntime.delegationProgress",
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] async progress event insert failed", {
			error: errorMessage(error),
			runId: input.row.id,
			childRunId: input.row.childRunId,
		});
	}
}

/**
 * Shared deterministic message-id for the async-completion assistant message
 * written by recordHomeDelegationCompletionMessage and pointed to by the
 * terminal reconcile outputMessageId. Single source of truth — do not inline.
 */
export function asyncCompletionAssistantMessageId(homeRunId: string): string {
	return `${homeRunId}:async-completion:assistant`;
}

/**
 * Deterministic event id for the async-completion `message.completed` event —
 * single source of truth shared by the writer
 * ({@link recordHomeDelegationCompletionMessage}) and the read-repair gate in
 * `reconcileHomeRunRowsFromChildStatus` (which pre-checks existence so
 * steady-state reads over terminal history never re-pay the child-evidence
 * read).
 */
function homeDelegationCompletionEventId(row: KernelRuntimeRun): string {
	return homeRuntimeEventId({
		organizationId: row.organizationId,
		kind: "message.completed",
		conversationId: row.conversationId,
		runId: row.id,
		suffix: "delegation-completion",
	});
}

async function recordHomeDelegationCompletionMessage(
	context: BaseContext,
	input: {
		createdAt: string;
		disposition?: DelegationAttemptResult | null;
		latestEventAt: string | null;
		latestEventKind: TediRuntimeEventKind | undefined;
		preview: string | null;
		row: KernelRuntimeRun;
		run: HomeRun;
	},
): Promise<void> {
	if (!input.row.delegatedTediId || !input.row.childRunId) return;
	const messageId = asyncCompletionAssistantMessageId(input.row.id);
	// Relay-first (harness contract): the child's final assistant message IS
	// the return value — deliver it verbatim, exactly like a subagent tool
	// result. The child's own closing message is already operator-shaped; a
	// detached LLM pass over its transcript never sees the operator's question
	// and can role-play instead of reporting. Fail-soft (retry-backed inside
	// the child reads): a still-failing read yields null → synthesis/preview.
	const finalResult = await readChildRunFinalAssistantResult(context, {
		tediId: input.row.delegatedTediId,
		runId: input.row.childRunId,
		organizationId: input.row.organizationId,
	});
	const finalMessage = finalResult.content;
	// Synthesis is the FALLBACK, not a rewrite: only when the child completed
	// WITHOUT a final assistant message (tool-only evidence), interpret the full
	// transcript via one bounded LLM pass. Fail-soft — null → the preview-based
	// content.
	const synthesized =
		!finalMessage && input.run.status === "completed"
			? await readAndSynthesizeChildRunResult(context, {
					tediId: input.row.delegatedTediId,
					runId: input.row.childRunId,
					organizationId: input.row.organizationId,
				})
			: null;
	const content = homeDelegationCompletionContent({
		preview: input.preview,
		synthesized,
		finalMessage,
		status: input.run.status,
		stop: delegatedStopFromSummary(nonNullRecord(input.run.metadata)),
	});
	// One delegation = one row. With NEITHER a relayed child answer NOR a
	// synthesis, `homeDelegationCompletionContent` returns a template over
	// (`status`, `preview`) — "The delegated tedi assignment was canceled.
	// Latest evidence: …" and its siblings. Both inputs are already rendered by
	// the delegation receipt (humanized status label + clamped preview), so the
	// turn restates the adjacent row and nothing else. Structural, not textual:
	// the moment the child returns a real closing message (or synthesis produces
	// one) this is unstamped, because that message IS the delegation's return
	// value and must render in full.
	//
	// The proof verdict is the third exception: it discloses that the Work-Item
	// proof gate rejected a completion the transcript would otherwise call
	// finished. The receipt carries no proof verdict, so a turn carrying that
	// verdict (as `metadata.delegationProof`) is not a restatement and keeps
	// rendering so the chip has a row to sit on.
	const verdictMetadata = homeDelegationVerdictMetadata({
		disposition: input.disposition,
		outputSchema: delegationWorkOrderOutputSchema(input.row.metadata),
		status: input.run.status,
		validatedContent: synthesized ?? finalMessage ?? null,
	});
	const statusOnlyNarration =
		!synthesized && !finalMessage && !verdictMetadata.delegationProof;
	try {
		const outcomeKind = subagentOutcomeEventKind(input.run.status);
		if (outcomeKind) {
			await insertKernelRuntimeEvent(context, {
				id: homeRuntimeEventId({
					organizationId: input.row.organizationId,
					kind: outcomeKind,
					conversationId: input.row.conversationId,
					runId: input.row.id,
					childRunId: input.row.childRunId,
				}),
				organizationId: input.row.organizationId,
				kind: outcomeKind,
				conversationId: input.row.conversationId,
				runId: input.row.id,
				delegatedTediId: input.row.delegatedTediId,
				childRunId: input.row.childRunId,
				payload: {
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus: input.run.status,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationCompletion",
				},
				runtimeMetadata: {
					childRunStatus: input.run.status,
					source: "kernelRuntime.delegationCompletion",
				},
				createdAt: input.createdAt,
			});
		}
		await insertKernelRuntimeEvent(context, {
			id: homeDelegationCompletionEventId(input.row),
			organizationId: input.row.organizationId,
			kind: "message.completed",
			conversationId: input.row.conversationId,
			runId: input.row.id,
			messageId,
			delegatedTediId: input.row.delegatedTediId,
			childRunId: input.row.childRunId,
			payload: {
				role: "assistant",
				content,
				channel: "home",
				metadata: {
					asyncCompletion: true,
					childRunId: input.row.childRunId,
					childRunLatestEventAt: input.latestEventAt,
					childRunLatestEventKind: input.latestEventKind ?? null,
					childRunPreview: input.preview,
					childRunStatus: input.run.status,
					delegatedTediId: input.row.delegatedTediId,
					homeRunId: input.row.id,
					homeSubject: true,
					progress: input.run.progress ?? null,
					source: "kernelRuntime.delegationCompletion",
					...(finalResult.widgets.length > 0
						? {
								delegatedResult: {
									version: 1,
									widgets: finalResult.widgets,
								},
							}
						: {}),
					...verdictMetadata,
					...(statusOnlyNarration
						? homeNarrationMetadata("delegation_status_only")
						: {}),
				},
			},
			runtimeMetadata: {
				asyncCompletion: true,
				childRunId: input.row.childRunId,
				childRunLatestEventAt: input.latestEventAt,
				childRunLatestEventKind: input.latestEventKind ?? null,
				childRunStatus: input.run.status,
				delegatedTediId: input.row.delegatedTediId,
				source: "kernelRuntime.delegationCompletion",
			},
			createdAt: input.createdAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] async completion message insert failed", {
			error: errorMessage(error),
			runId: input.row.id,
			childRunId: input.row.childRunId,
		});
	}
	if (verdictMetadata.delegationProof) {
		await stampHomeRunDelegationProof(context, {
			row: input.row,
			run: input.run,
			delegationProof: verdictMetadata.delegationProof,
			updatedAt: input.createdAt,
		});
	}
}

/**
 * Mirror the proof chip onto the parent Home run row's metadata
 * (`metadata.delegationProof`) so the delegation receipt / run card can render
 * it without scanning the transcript. Idempotent: skipped when the row already
 * carries an identical chip. Fail-soft.
 */
async function stampHomeRunDelegationProof(
	context: BaseContext,
	input: {
		row: KernelRuntimeRun;
		run: HomeRun;
		delegationProof: HomeDelegationProofMetadata;
		updatedAt: string;
	},
): Promise<void> {
	const current =
		nonNullRecord(input.run.metadata) ??
		nonNullRecord(input.row.metadata) ??
		{};
	const existing = nonNullRecord(current.delegationProof);
	if (
		existing &&
		existing.verdict === input.delegationProof.verdict &&
		existing.reason === input.delegationProof.reason
	) {
		return;
	}
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.row.id,
			organizationId: input.row.organizationId,
			patch: {
				updatedAt: input.updatedAt,
				metadata: toJsonRecord({
					...current,
					delegationProof: input.delegationProof,
				}),
			},
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegation proof stamp failed", {
			error: errorMessage(error),
			runId: input.row.id,
		});
	}
}

/**
 * Stamp `payload.origin` on the turn-ingress event so the conversation index
 * can record who started the conversation.
 *
 * Done HERE, at the single event choke point, rather than in each emitter:
 * every `message.received` write in the kernel goes through
 * `insertKernelRuntimeEvent` under a real request context
 * (`kernelRuntime.enqueueMessage`, `startKernelTurn`, `retryRun`, `steerRun`),
 * so one stamp covers all four and any fifth that appears later.
 *
 * Two deliberate restrictions:
 * - Only `message.received` with `role: "user"` — the turn INGRESS, the one
 *   event whose request context is the originating caller. Assistant/tool
 *   events are written from settle paths and Durable Object contexts whose
 *   `authType` says nothing about who asked, and stamping them would let a
 *   completion overwrite the ingress classification.
 * - An origin already present on the payload wins, so a caller that knows
 *   better than the transport can say so.
 */
function stampConversationOrigin(
	context: BaseContext,
	kind: NewKernelRuntimeEvent["kind"],
	payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (kind !== "message.received") return payload;
	if (!payload || payload.role !== "user") return payload;
	if (kernelConversationOriginFromPayload(payload)) return payload;
	return {
		...payload,
		[KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY]:
			resolveKernelConversationOrigin(context),
	};
}

export type KernelRuntimeEventInsertInput = {
	id?: string;
	organizationId: string;
	kind: NewKernelRuntimeEvent["kind"];
	conversationId: string;
	runId?: string;
	messageId?: string;
	causeEventId?: string | null;
	delegatedTediId?: string;
	childRunId?: string;
	sequence?: number;
	delta?: string;
	payload?: Record<string, unknown>;
	runtimeMetadata?: Record<string, unknown>;
	createdAt?: string;
};

export async function existingRunStartedCause(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		messageId: string;
	},
): Promise<string | null | undefined> {
	const id = homeRuntimeEventId({
		organizationId: input.organizationId,
		kind: "run.started",
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
	});
	const [row] = await listKernelRuntimeEvents(context.db, { id, limit: 1 });
	if (!row) return undefined;
	if (
		row.organizationId !== input.organizationId ||
		row.conversationId !== input.conversationId ||
		row.runId !== input.runId ||
		row.kind !== "run.started" ||
		row.messageId !== input.messageId
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Existing kernel run start identity conflicts with replay",
		);
	return row.causeEventId;
}

export async function insertKernelRuntimeEventWithStatus(
	context: BaseContext,
	input: KernelRuntimeEventInsertInput,
): Promise<{ event: KernelRuntimeEvent; inserted: boolean }> {
	const createdAt = input.createdAt ?? nowIso();
	const payload = stampConversationOrigin(context, input.kind, input.payload);
	const event = buildKernelRuntimeEvent({
		id: input.id,
		organizationId: input.organizationId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		causeEventId: input.causeEventId,
		delegatedTediId: input.delegatedTediId,
		childRunId: input.childRunId,
		sequence: input.sequence,
		delta: input.delta,
		payload,
		runtimeBackend: KERNEL_RUNTIME_BACKEND,
		runtimeExternalId: input.runId,
		runtimeMetadata: input.runtimeMetadata,
		createdAt,
	});
	let inserted;
	try {
		inserted = await insertKernelRuntimeEventIfAbsent(context.db, {
			id: event.id,
			organizationId: event.organizationId,
			kind: event.kind,
			conversationId: event.conversationId,
			runId: event.runId,
			messageId: event.messageId,
			causeEventId: event.causeEventId,
			delegatedTediId: event.delegatedTediId,
			childRunId: event.childRunId,
			sequence: event.sequence,
			delta: event.delta,
			payload:
				event.payload === undefined ? undefined : toJsonRecord(event.payload),
			runtimeBackend: event.runtime?.backend ?? KERNEL_RUNTIME_BACKEND,
			runtimeExternalId: event.runtime?.externalId,
			runtimeMetadata:
				event.runtime?.metadata === undefined
					? undefined
					: toJsonRecord(event.runtime.metadata),
			createdAt: event.createdAt,
		});
	} catch (error) {
		if (error instanceof KernelRuntimeEventConflictError)
			throw createError(
				ErrorCodes.CONFLICT,
				"Kernel runtime event conflicts with immutable causal identity",
			);
		throw error;
	}
	if (inserted.inserted && inserted.row) {
		// Write-through to the durable Home conversation index. Only on a REAL
		// insert (an idempotent replay returns the existing row below and must
		// not double-count). Fail-soft inside; no-op for kinds the projection
		// does not track.
		await applyKernelConversationEvent(context.db, inserted.row);
		return { event: normalizeHomeEvent(inserted.row), inserted: true };
	}
	if (inserted.row)
		return { event: normalizeHomeEvent(inserted.row), inserted: false };
	throw createError(
		ErrorCodes.INTERNAL_SERVER_ERROR,
		"kernel runtime event insert was ignored and no existing event was found",
	);
}

export async function insertKernelRuntimeEvent(
	context: BaseContext,
	input: KernelRuntimeEventInsertInput,
): Promise<KernelRuntimeEvent> {
	return (await insertKernelRuntimeEventWithStatus(context, input)).event;
}

export async function insertKernelRuntimeRun(
	context: BaseContext,
	input: {
		id: string;
		organizationId: string;
		conversationId: string;
		status: TediRunStatus;
		inputMessageId?: string;
		outputMessageId?: string;
		delegatedTediId?: string;
		childRunId?: string;
		childConversationId?: string | null;
		progress?: ReturnType<typeof homeRunProgress>;
		metadata?: Record<string, unknown>;
		runtimeMetadata?: Record<string, unknown>;
		startedAt?: string;
		completedAt?: string | null;
		createdAt?: string;
		updatedAt?: string;
	},
): Promise<void> {
	const createdAt = input.createdAt ?? nowIso();
	const progress =
		input.progress ??
		homeRunProgress({
			eventCount: 0,
			status: input.status,
		});
	await insertKernelRuntimeRunIfAbsent(context.db, {
		id: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		status: input.status,
		inputMessageId: input.inputMessageId,
		outputMessageId: input.outputMessageId,
		delegatedTediId: input.delegatedTediId,
		childRunId: input.childRunId,
		childConversationId: input.childConversationId ?? undefined,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		runtimeBackend: KERNEL_RUNTIME_BACKEND,
		runtimeExternalId: input.id,
		runtimeMetadata:
			input.runtimeMetadata === undefined
				? undefined
				: toJsonRecord(input.runtimeMetadata),
		metadata:
			input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
		startedAt: input.startedAt ?? createdAt,
		completedAt: input.completedAt ?? undefined,
		createdAt,
		updatedAt: input.updatedAt ?? input.completedAt ?? createdAt,
	});
	// Durable submission ledger: admit + open the first attempt for this kernel
	// run. Idempotent (deterministic submission id), additive, never throws.
	// Awaited, never offloaded: this row is what the crash sweep reconciles
	// from, so admitting it on a background task made the recovery plane
	// conditional on the same isolate that the failure kills: an eviction would
	// take the dispatch and its admission together, leaving the sweep nothing
	// to recover. The cost is one D1 write on the
	// run-insert receipt; `.catch` keeps a ledger fault from failing the run.
	await recordKernelSubmissionStarted(context.db, {
		runId: input.id,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		idempotencyKey:
			typeof input.metadata?.idempotencyKey === "string"
				? input.metadata.idempotencyKey
				: input.id,
		delegatedTediId: input.delegatedTediId ?? null,
		createdAt,
	}).catch(() => {});
}

/**
 * Did the delegated dispatch ever reach the target runtime?
 *
 * `chat_dispatch_idempotency` is written before the inject is attempted and
 * patched with the runtime-assigned `run_id` once the child accepts. A row that
 * still has a NULL `run_id` therefore proves the accept never happened — the
 * signature of an isolate eviction that killed the dispatch mid-flight. Distinguishing this from a child that accepted and then
 * went quiet is the difference between "re-dispatch the work order" and
 * "investigate the tedi runtime".
 *
 * Fail-safe: any lookup miss or error returns false, keeping the historical
 * child-silent wording rather than asserting something we cannot prove.
 */
async function didDispatchNeverLand(
	context: BaseContext,
	row: KernelRuntimeRun,
): Promise<boolean> {
	if (!row.delegatedTediId) return false;
	try {
		return await hasUnacceptedChatDispatch(context.db, {
			tediId: row.delegatedTediId,
			homeRunId: row.id,
		});
	} catch (error) {
		console.warn("[kernelRuntime] didDispatchNeverLand lookup failed", {
			runId: row.id,
			error: errorMessage(error),
		});
		return false;
	}
}

/**
 * Orphan-sweep propagation: when `sweepOrphanRuns` seals a delegated CHILD run
 * as `run.failed` (runtime dropped, no terminal event), the parent Home run
 * and its delegation receipt otherwise keep saying "Running" forever — the
 * read-path reconcile only re-derives from child status when the row is read,
 * and a sealed child with no operator reading the thread never gets there.
 *
 * Resolves the Home run row by (org, delegated tedi, child run id) and, when
 * it is still non-terminal, drives it through the EXISTING failure path
 * ({@link recordHomeDelegationDispatchFailure}: run row → failed, `run.failed`
 * + `message.completed` events, delegation failure envelope). A row already
 * terminal, or no linked Home run, is a no-op. Fail-soft: returns whether a
 * propagation happened; never throws (the sweep records its own errors).
 */
export async function propagateSweptChildFailureToHomeRun(
	context: BaseContext,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
		/** Why the sweep sealed the child — surfaces in the failure envelope. */
		message: string;
		failedAt?: string;
	},
): Promise<boolean> {
	try {
		const row = await findKernelRuntimeRunByChild(context.db, {
			organizationId: input.organizationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
		});
		if (!row) return false;
		if (
			row.status === "completed" ||
			row.status === "failed" ||
			row.status === "canceled"
		) {
			return false;
		}
		await recordHomeDelegationDispatchFailure(context, {
			childConversationId: stringFromPayload(
				nonNullRecord(row.metadata)?.childConversationId,
			),
			childRunId: input.childRunId,
			conversationId: row.conversationId,
			delegatedTediId: input.delegatedTediId,
			error: input.message,
			existingMetadata: nonNullRecord(row.metadata),
			failedAt: input.failedAt,
			organizationId: input.organizationId,
			reason: "runtime_unavailable",
			runId: row.id,
		});
		return true;
	} catch (error) {
		console.warn("[kernelRuntime] swept-child failure propagation failed", {
			childRunId: input.childRunId,
			error: errorMessage(error),
		});
		return false;
	}
}

export async function recordHomeDelegationDispatchFailure(
	context: BaseContext,
	input: {
		childConversationId?: string | null;
		childRunId: string;
		conversationId: string;
		delegatedTediId: string;
		error: string;
		existingMetadata?: Record<string, unknown> | null;
		failedAt?: string;
		organizationId: string;
		/**
		 * Terminal reason for the child run failure. Use `runtime_unavailable` when
		 * the runtime preflight determined the target is unreachable/stopped and
		 * dispatch was never attempted. Defaults to `dispatch_failed`.
		 */
		reason?: "dispatch_failed" | "runtime_unavailable";
		runId: string;
	},
): Promise<void> {
	const failedAt = input.failedAt ?? nowIso();
	const reason = input.reason ?? "dispatch_failed";
	const progress = homeRunProgress({
		eventCount: 0,
		status: "failed",
	});
	const preview = `Delegated child dispatch failed: ${input.error}`;
	const nextMetadata = {
		...input.existingMetadata,
		childConversationId: input.childConversationId ?? null,
		childRunId: input.childRunId,
		childRunLatestEventAt: failedAt,
		childRunLatestEventKind: "run.failed",
		childRunPreview: preview,
		childRunStatus: "failed",
		delegatedTediId: input.delegatedTediId,
		delegationFailure: buildDelegationFailureEnvelope({
			reason,
			error: input.error,
		}),
		idempotencyKey: input.runId,
		progress,
		source: "kernelRuntime.delegateDispatch",
	};
	try {
		await updateKernelRuntimeRunForOrg(context.db, {
			id: input.runId,
			organizationId: input.organizationId,
			patch: {
				status: "failed",
				progressValue: progress.current,
				progressLabel: progress.label,
				progressDetail: progress.detail,
				latestEventKind: "run.failed",
				latestEventAt: failedAt,
				preview,
				completedAt: failedAt,
				updatedAt: failedAt,
				metadata: toJsonRecord(nextMetadata),
			},
		});
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "run.failed",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: "delegation-dispatch",
			}),
			organizationId: input.organizationId,
			kind: "run.failed",
			conversationId: input.conversationId,
			runId: input.runId,
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
			payload: {
				status: "failed",
				error: input.error,
				reason,
				progress,
			},
			runtimeMetadata: nextMetadata,
			createdAt: failedAt,
		});
		await insertKernelRuntimeEvent(context, {
			id: homeRuntimeEventId({
				organizationId: input.organizationId,
				kind: "message.completed",
				conversationId: input.conversationId,
				runId: input.runId,
				suffix: "delegation-dispatch-failed",
			}),
			organizationId: input.organizationId,
			kind: "message.completed",
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: asyncCompletionAssistantMessageId(input.runId),
			delegatedTediId: input.delegatedTediId,
			childRunId: input.childRunId,
			payload: {
				role: "assistant",
				content: homeDelegationCompletionContent({
					preview,
					status: "failed",
				}),
				channel: "home",
				metadata: {
					asyncCompletion: true,
					homeSubject: true,
					...nextMetadata,
					// Always status-only: this recorder has no child transcript to
					// relay, so the body is the (status, preview) template and the
					// receipt on this same row renders "Delegated to {tedi} · Failed"
					// plus the exact delegation failure envelope error.
					...homeNarrationMetadata("delegation_status_only"),
				},
			},
			runtimeMetadata: {
				asyncCompletion: true,
				...nextMetadata,
			},
			createdAt: failedAt,
		});
	} catch (error) {
		console.warn("[kernelRuntime] delegated dispatch failure write failed", {
			childRunId: input.childRunId,
			error: errorMessage(error),
			runId: input.runId,
		});
	}
}
