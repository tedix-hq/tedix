import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	HomeChildRunEvidence,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { type KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { extractRunUsage } from "../../../kernel/kernel-state";
import { delegatedStopFromSummary } from "./delegated-stop";
import {
	childRunStatusFromSummary,
	childRunStatusKey,
	delegatedChildSteerRunId,
	homeRunProgress,
	isTerminalHomeRunStatus,
	nonNullRecord,
} from "./runtime-shared";

function parentOwnsTerminalOutcome(
	row: KernelRuntimeRun,
	childRunStatus: Record<string, unknown> | null,
): boolean {
	return (
		row.status === "canceled" ||
		(isTerminalHomeRunStatus(row.status as TediRunStatus) &&
			!isTerminalHomeRunStatus(
				homeRunStatusFromChildStatus(
					childRunStatusFromSummary(childRunStatus),
					row.status as TediRunStatus,
				),
			))
	);
}

/** Run and message projections share terminal status, content and timestamp. */
function classifyHomeRunState(
	row: KernelRuntimeRun,
	childRunStatus: Record<string, unknown> | null,
): {
	status: TediRunStatus;
	content: string | null;
	preview: string | null;
	completedAt: string | null;
} {
	// A cached child progress snapshot cannot revive a settled parent. Explicit
	// cancellation also wins over a later terminal child outcome.
	if (parentOwnsTerminalOutcome(row, childRunStatus)) {
		return {
			status: row.status as TediRunStatus,
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
	const useChildOutcome =
		hasChildStatus && !parentOwnsTerminalOutcome(row, childRunStatus ?? null);
	const interrupted =
		!useChildOutcome &&
		status === "failed" &&
		/^runtime crash\b.*\bkernel DO eviction\b/i.test(row.progressDetail ?? "");
	const progress = interrupted
		? {
				current: 100,
				total: 100,
				label: "Interrupted",
				detail: "This reply was interrupted. Try again to continue.",
			}
		: !useChildOutcome && row.progressValue !== null && row.progressLabel
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
		updatedAt: parentOwnsTerminalOutcome(row, childRunStatus ?? null)
			? (row.updatedAt ?? null)
			: ((childRunStatus?.childRunLatestEventAt as string | null | undefined) ??
				row.updatedAt ??
				null),
		progress,
		...(rowUsage !== undefined ? { usage: rowUsage } : {}),
		metadata: {
			...nonNullRecord(row.metadata),
			...(interrupted
				? {
						progressDiagnostic: {
							label: row.progressLabel,
							detail: row.progressDetail,
						},
					}
				: {}),
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
