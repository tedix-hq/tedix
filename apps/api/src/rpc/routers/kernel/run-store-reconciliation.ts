import type {
	TediRunStatus,
	TediRuntimeEventKind,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { TediRuntimeEventKindSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import {
	getKernelRuntimeRun,
	hasUnacceptedChatDispatch,
	type KernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	kernelRunStatusToSubmissionOutcome,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { type BaseContext } from "../../orpc";
import { readSingleChildRunSummary } from "./child-run-reads";
import { stalledChildRunStatus } from "./child-run-stall";
import {
	disposeTerminalDirectDelegationWorkItem,
	isStaleDelegationDispatchRow,
	recordDelegationWorkItemHeartbeat,
	resolveDelegationWorkItemId,
} from "./delegation-work-item";
import { readOptionalHomePlanFromRun } from "./home-plan";
import {
	buildDelegationFailureEnvelope,
	childRunStatusFromSummary,
	childRunStatusKey,
	errorMessage,
	homeRunProgress,
	isTerminalHomeRunStatus,
	nonNullRecord,
	nowIso,
	shouldFailSoftHomeRunSetRead,
} from "./runtime-shared";
import { normalizeHomeRunRecord } from "./run-store-normalization";
import {
	reconcileHomePlanRunRowFromChildStatus,
	kernelUnblockEnqueue,
} from "./run-store-plan";
import {
	asyncCompletionAssistantMessageId,
	recordHomeDelegationDispatchFailure,
} from "./run-store";
import {
	homeDelegationCompletionEventId,
	recordHomeDelegationCompletionMessage,
	recordHomeDelegationProgressMessage,
} from "./run-store-completion";

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
			const childKey = childRunStatusKey(row.delegatedTediId, row.childRunId);
			const observedChildRunStatus = input.childRunStatuses.get(childKey);
			// A child past its delegation deadline that never settled has lost its
			// turn; settle it failed through the ordinary terminal path below.
			const stalled =
				observedChildRunStatus &&
				!isTerminalHomeRunStatus(row.status as TediRunStatus)
					? stalledChildRunStatus(row, observedChildRunStatus)
					: null;
			if (stalled) {
				console.warn("[kernelRuntime] delegated child stalled past deadline", {
					runId: row.id,
					childRunId: row.childRunId,
					childRunLatestEventAt: observedChildRunStatus?.childRunLatestEventAt,
				});
				input.childRunStatuses.set(childKey, stalled);
			}
			const childRunStatus = stalled ?? observedChildRunStatus;
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
				// Home timeout is not a child terminal receipt or Attempt settlement.
				const failure = nonNullRecord(
					nonNullRecord(row.metadata)?.delegationFailure,
				);
				if (
					failure?.childStillRunning === true ||
					failure?.reason === "dispatch_failed"
				)
					return canceledStopRow ?? row;
				if (isTerminalHomeRunStatus(row.status as TediRunStatus)) {
					const outputMessageId = asyncCompletionAssistantMessageId(row.id);
					if (row.outputMessageId !== outputMessageId) {
						await updateKernelRuntimeRunForOrg(context.db, {
							organizationId: row.organizationId,
							id: row.id,
							patch: { outputMessageId },
						});
						row.outputMessageId = outputMessageId;
					}
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
				// An unassigned mapping describes the observed handoff, not a cancellation.
				const dispatchNeverLanded = await didDispatchNeverLand(context, row);
				const error = dispatchNeverLanded
					? "Delegated child dispatch timed out with no assigned child run observed; execution has not been ruled out"
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
					childRunLatestEventAt: null,
					childRunLatestEventKind: null,
					childRunPreview: null,
					childRunStatus: "unknown",
					delegatedTediId: row.delegatedTediId,
					delegationFailure: buildDelegationFailureEnvelope({
						reason: "dispatch_failed",
						error,
						childStillRunning: true,
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
			// The execution reply remains readable while target acceptance is pending.
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
				const transitioned = await transitionKernelRuntimeRunStatus(
					context.db,
					{
						id: row.id,
						organizationId: row.organizationId,
						fromStatus: row.status,
						expectedUpdatedAt: row.updatedAt,
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
					},
				);
				if (!transitioned) {
					return (
						(await getKernelRuntimeRun(context.db, {
							id: row.id,
							organizationId: row.organizationId,
						})) ?? row
					);
				}
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

/** Whether the dispatch ledger still has an unassigned mapping. Not a stop receipt. */
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
