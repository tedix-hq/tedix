import {
	workstationDispatchIdentity,
	inspectWorkstationDispatchAdmission,
} from "../kernel/workstation-dispatch";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";
import {
	CODEMODE_EXECUTE_WRITE_KIND,
	type CodemodeExecuteWritePayload,
	parseCodemodeExecuteWritePayload,
} from "@tedix/api-contract/schemas/codemode-execute-write";
import { ExecutionRequirementSchema } from "@tedix/api-contract/schemas/execution-evidence";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
	disposeDelegationWorkItem,
	isStaleDelegationDispatchRow,
	releaseCanceledDelegationWorkItem,
} from "../kernel/delegation-work-item";
import {
	type KernelRuntimeRun,
	getDurableKernelRuntimeRun,
	getKernelRuntimeRun,
	updateKernelRuntimeRun,
} from "@tedix/db/queries/kernel-runtime-runs";
import {
	REPO_COMMIT_FINGERPRINT_RE,
	REPO_COMMIT_WRITE_KIND,
	type RepoCommitWritePayload,
	classifyRepoCommitRisk,
} from "@tedix/api-contract/schemas/repo-commit-write";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import { auditActor } from "../../audit-helpers";
import {
	childRunStatusFromSummary,
	childRunStatusKey,
	delegatedChildSteerRunId,
	errorMessage,
	homeRunProgress,
	isTerminalHomeRunStatus,
	nonNullRecord,
	nowIso,
	numberFromPayload,
	offsetIso,
	predictAgentRunId,
	stringFromPayload,
	withTimeout,
} from "../kernel/runtime-shared";
import {
	startWorkItemAttempt,
	listWorkItemAttempts,
	settleWorkItemAttempt,
} from "@tedix/db/queries/work-items/attempts";
import {
	createApprovalRequest,
	getApprovalRequestById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import {
	decideKernelWriteApproval,
	resolveApprovalTtlHours,
} from "@tedix/api-contract/utils/approval-policy";
import {
	getWorkItemById,
	cancelWorkItem,
} from "@tedix/db/queries/work-items/crud";
import {
	homeRunStatusFromChildStatus,
	insertKernelRuntimeEvent,
	normalizeHomeRunRecord,
	reconcileHomeRunRowsFromChildStatus,
	recordHomeDelegationDispatchFailure,
} from "../kernel/run-store";
import { homeWorkstationAttachPayload } from "../kernel/workstation-attach";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { insertWorkItemCommentIfAbsent } from "@tedix/db/queries/kernel-runtime-support";
import { readChildRunStatusesForRunRows } from "../kernel/home-plan";
import { renderDelegationWorkOrderMessage } from "../kernel/delegation-dispatch";
import { requestRunAbort } from "../../../kernel/runtime-submission-bridge";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	KernelChildControlResult,
	MAX_DELEGATION_RETRIES,
	childControlSkipped,
	kernelChildSteerForwarder,
	kernelChildStopper,
	kernelDelegateRunner,
	kernelDoTurnCanceler,
	readOrgGovernancePolicy,
	readSessionWriteAllowlist,
} from "./policy-normalization";
import {
	admitWorkAttempt,
	WORK_ATTEMPT_ADMISSION_TTL_MS,
} from "../work-items/attempt-admission";
import {
	readKernelUserMessageContent,
	resolveKernelDelegateTarget,
	resolvedWorkstationAttachProgress,
} from "./run-reads-streams";
import { internalDelegationContext } from "./delegation-context";
import { runWorkstationWorkOrderDispatch } from "./workstation-dispatch";

export function delegationRetryState(
	workItemMetadata: unknown,
	attempts: Array<{ metadata: unknown }>,
): { latestAttemptMetadata: Record<string, unknown>; retryCount: number } {
	const itemMetadata = nonNullRecord(workItemMetadata) ?? {};
	const latestAttemptMetadata = nonNullRecord(attempts[0]?.metadata) ?? {};
	return {
		latestAttemptMetadata,
		retryCount: Math.max(
			numberFromPayload(itemMetadata.retryCount) ?? 0,
			...attempts.map(
				(attempt) =>
					numberFromPayload(nonNullRecord(attempt.metadata)?.retryCount) ?? 0,
			),
		),
	};
}

export function recoverableDelegationWorkOrder(
	homeRunMetadata: unknown,
): Record<string, unknown> | null {
	const metadata = nonNullRecord(homeRunMetadata) ?? {};
	const direct = nonNullRecord(metadata.delegationWorkOrder);
	if (direct) return direct;
	return (
		nonNullRecord(nonNullRecord(metadata.homeDelegation)?.workOrder) ?? null
	);
}

export /**
 * BOUNDED RECOVERY PRIMITIVE: re-dispatch a failed delegation attempt for the
 * same target tedi with the SAME work order, deterministically and at most
 * MAX_DELEGATION_RETRIES times. This is the operator-gated counterpart to
 * Step 1's `disposeDelegationWorkItem`, which only WRITES machine-recoverable
 * hints onto the settled attempt; it never auto-fires. The reconcile loop never calls
 * this either — the single caller is the operator `retry_delegation` handler.
 *
 * Deliberate divergences from `retryKernelRunCore`:
 * - REUSES the `kernelDelegateRunner` seam DIRECTLY to mint a runnable child run
 *   (NOT `enqueueMessage`, which re-enters the kernel router and may re-plan /
 *   re-route — non-deterministic for a deterministic recovery).
 * - DETERMINISTIC child-run id keyed off (workItemId, retryCount) — NOT a fresh
 *   UUID — so a double call dedupes instead of double-dispatching.
 * - Re-points the SAME Home run row (not a new one) to the new child and stamps
 *   `metadata.workItemId` so the existing reconcile loop disposes the retry's
 *   outcome through `disposeDelegationWorkItem` again.
 *
 * Idempotency has two layers: (1) the ATTEMPT LATCH — admitting a new attempt
 * only succeeds for the first caller; a racing/repeat caller resumes the active
 * attempt and returns the current run as a
 * no-op WITHOUT dispatching. (2) the deterministic child-run id passed as the
 * dispatch idempotency key dedupes the turn at the tedi runtime. Fail-closed:
 * not-blocked / not-retryable / ceiling / missing linked run all reject, and a
 * dispatch failure releases the latch back to 'blocked'.
 */
async function retryDelegationWorkItem(
	context: BaseContext,
	input: {
		organizationId: string;
		workItemId: string;
	},
): Promise<{
	run: HomeRun;
	childRunId: string;
	retryCount: number;
}> {
	const { organizationId, workItemId } = input;

	// (1) Load + fail-closed guards.
	const workItem = await getWorkItemById(context.db, workItemId);
	if (!workItem || workItem.orgId !== organizationId) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Work item ${workItemId} not found`,
		);
	}
	// SELF-HEAL a dispatch-orphaned attempt before the readiness guard.
	//
	// createDelegationWorkItem creates an attempt in-band before dispatching, so
	// an evicted dispatch leaves active execution authority
	// until a LAZY on-read reconcile happens to notice the run went silent. That
	// is an unbounded window in which the operator cannot retry the very thing
	// that just failed, and the previous behaviour was to refuse and tell them to
	// go force the reconcile by hand. Seal it here instead: the evidence needed
	// is the same evidence the reconcile would use.
	//
	// Safe to do inline because it is bounded on every axis that matters — only a
	// run that is provably stale by isStaleDelegationDispatchRow, only the
	// operator-initiated path (the automatic sweep selects `blocked` rows only,
	// so it never reaches here), and the retry it unblocks is still capped by
	// MAX_DELEGATION_RETRIES.
	let retryTarget = workItem;
	if (retryTarget.disposition === "accepted") {
		const homeRunIdForSeal =
			typeof nonNullRecord(retryTarget.metadata)?.homeRunId === "string"
				? (nonNullRecord(retryTarget.metadata)?.homeRunId as string)
				: null;
		const childRunIdForSeal =
			typeof nonNullRecord(retryTarget.metadata)?.childRunId === "string"
				? (nonNullRecord(retryTarget.metadata)?.childRunId as string)
				: null;
		if (homeRunIdForSeal && childRunIdForSeal) {
			const childRow = await getKernelRuntimeRun(context.db, {
				id: childRunIdForSeal,
				organizationId,
			});
			if (childRow && isStaleDelegationDispatchRow(childRow)) {
				// The run row carries no delegationError (nothing ever failed it —
				// it simply went silent), so derive the discrimination from how far
				// the dispatch got, matching classifyDelegationFailureRecovery's own
				// definitions: still `queued` past the timeout means the child never
				// heard about the work at all, whereas `running` means it accepted
				// and then published nothing.
				const sealReason =
					childRow.status === "queued"
						? "dispatch_never_landed"
						: "dispatch_timeout";
				await disposeDelegationWorkItem(context, {
					childRunId: childRunIdForSeal,
					childRunStatus: "failed",
					createdAt: nowIso(),
					delegatedTediId:
						childRow.delegatedTediId ?? retryTarget.accountableOwnerId ?? "",
					delegationError: `${sealReason}: dispatch went silent past its timeout; sealed by operator retry`,
					organizationId,
					// A dispatch that never produced a first event has no proof by
					// definition. `missing`, not `unknown`: we DID look, and the run
					// row shows nothing was ever published.
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
					workItemId,
				});
				// Re-read the stable specification after sealing the attempt.
				retryTarget =
					(await getWorkItemById(context.db, workItemId)) ?? retryTarget;
			}
		}
	}

	if (retryTarget.disposition !== "accepted") {
		// Only an accepted WorkSpec may admit a recovery attempt.
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Work item ${workItemId} is "${retryTarget.disposition}" — only accepted delegations can be retried`,
		);
	}
	const metadata = nonNullRecord(retryTarget.metadata) ?? {};
	const attempts = await listWorkItemAttempts(context.db, {
		orgId: organizationId,
		workItemId,
	});
	const { latestAttemptMetadata, retryCount } = delegationRetryState(
		metadata,
		attempts.data,
	);
	if (
		latestAttemptMetadata.retryable === false ||
		metadata.retryable === false
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Work item ${workItemId} is marked not-retryable and cannot be re-dispatched`,
		);
	}

	// (2) Ceiling: at most MAX_DELEGATION_RETRIES recovery dispatches. The
	// terminal rung does NOT re-dispatch; it writes a durable human-escalation
	// event-linked comment onto the Work Item so the exhausted item surfaces for
	// a human, then rejects.
	if (retryCount >= MAX_DELEGATION_RETRIES) {
		try {
			await insertWorkItemCommentIfAbsent(context.db, {
				id: `${workItemId}:escalation:ceiling`,
				workItemId,
				orgId: organizationId,
				authorType: "system",
				authorId: retryTarget.accountableOwnerId ?? null,
				body: `Delegation recovery ceiling reached (${retryCount}/${MAX_DELEGATION_RETRIES} retries). No further automatic re-dispatch — escalate to a human operator.`,
				metadata: toJsonRecord({
					escalation: "operator",
					failureReason:
						latestAttemptMetadata.failureReason ??
						metadata.failureReason ??
						null,
					recoveryHints:
						latestAttemptMetadata.recoveryHints ?? metadata.recoveryHints ?? [],
					retryCount,
					retryCeiling: MAX_DELEGATION_RETRIES,
					source: "kernelRuntime.retryDelegation",
				}),
				createdAt: nowIso(),
			});
		} catch (escalationError) {
			console.warn(
				"[kernelRuntime] retryDelegation ceiling escalation comment failed",
				{
					workItemId,
					error: errorMessage(escalationError),
				},
			);
		}
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"delegation retry ceiling reached — escalated to a human operator",
		);
	}
	const nextRetryCount = retryCount + 1;

	// (3) Resolve target tedi + the linked Home run (source of the work order).
	const delegatedTediId =
		(retryTarget.accountableOwnerType === "tedi"
			? retryTarget.accountableOwnerId
			: null) ??
		(typeof metadata.delegatedTediId === "string"
			? metadata.delegatedTediId
			: null);
	if (!delegatedTediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Work item ${workItemId} cannot be retried: no delegated tedi to re-dispatch to`,
		);
	}
	const homeRunId =
		typeof metadata.homeRunId === "string" ? metadata.homeRunId : null;
	if (!homeRunId) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Work item ${workItemId} has no linked Home run to recover`,
		);
	}
	const homeRun = await getKernelRuntimeRun(context.db, {
		id: homeRunId,
		organizationId,
	});
	if (!homeRun) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Linked Home run ${homeRunId} not found`,
		);
	}
	const homeRunMetadata = nonNullRecord(homeRun.metadata) ?? {};
	const delegationWorkOrder = recoverableDelegationWorkOrder(homeRunMetadata);
	const recoveryExecutionRequirement = ExecutionRequirementSchema.safeParse(
		delegationWorkOrder?.executionRequirement,
	);
	if (!recoveryExecutionRequirement.success) {
		throw createError(
			ErrorCodes.CONFLICT,
			`Home run ${homeRunId} cannot be retried: its delegation work order has no valid execution requirement`,
		);
	}

	// (4) Deterministic ids keyed off (workItemId, nextRetryCount) — NOT a UUID.
	const childClientRequestId = `${workItemId}:retry:${nextRetryCount}`;
	const predictedChildRunId = predictAgentRunId({
		clientRequestId: childClientRequestId,
		tediId: delegatedTediId,
	});
	const dispatchedAt = nowIso();

	// (5) IDEMPOTENCY LATCH: admit one fenced retry attempt. A racing/repeat
	// caller resumes the active attempt without double-dispatching.
	const admission = await admitWorkAttempt(context.db, {
		workItem: retryTarget,
		executor: { type: "tedi", id: delegatedTediId },
		leaseTtlMs: WORK_ATTEMPT_ADMISSION_TTL_MS,
		now: dispatchedAt,
	});
	const attemptAdmission = await startWorkItemAttempt(context.db, {
		workItemId,
		orgId: organizationId,
		admissionId: admission.id,
		executor: { type: "tedi", id: delegatedTediId },
		runId: predictedChildRunId,
		startedAt: dispatchedAt,
		expiresAt: admission.expiresAt,
		metadata: { retryCount: nextRetryCount, recovery: true },
		// Operator recovery retries the same admitted WorkSpec. Dependency state is
		// already represented by the original admission decision.
	});

	// (6) REDISPATCH via the kernelDelegateRunner seam (mints a runnable child run
	// on the target tedi; same shape as retryKernelRunCore / respondApproval).
	const internalContext = internalDelegationContext(context, organizationId);
	const childResult = await withTimeout(
		kernelDelegateRunner({
			context: internalContext,
			childRunId: childClientRequestId,
			content: renderDelegationWorkOrderMessage({
				fallbackContent: retryTarget.description ?? "",
				fallbackWorkOrderId: `work-order:${workItemId}`,
				label: "RECOVERY",
				workOrder: delegationWorkOrder,
			}),
			delegateToTediId: delegatedTediId,
			metadata: {
				source: "kernelRuntime.retryDelegation",
				homeRunId,
				workItemId,
				retryCount: nextRetryCount,
				dispatchTrigger: "operator-recovery",
				executionSurface: recoveryExecutionRequirement.data.surface,
				delegationWorkOrder,
				...(nonNullRecord(homeRun.runtimeMetadata)?.requiredProofKind === "code"
					? { requiredProofKind: "code" }
					: {}),
			},
		}),
		KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
		"Home delegation recovery dispatch",
	).catch((error) => ({
		childRunId: predictedChildRunId,
		childConversationId: undefined,
		error: errorMessage(error),
		status: "failed" as const,
		reason: undefined,
	}));

	// (7) Settle: on failure record the dispatch failure + release the latch back
	// to 'blocked' (the item stays recoverable); on success re-point the SAME Home
	// run row to the new child and advance the Work Item retry state.
	if (childResult.status === "failed") {
		await recordHomeDelegationDispatchFailure(context, {
			childConversationId: childResult.childConversationId,
			childRunId: childResult.childRunId,
			conversationId: homeRun.conversationId,
			delegatedTediId,
			error: childResult.error ?? "Delegation recovery dispatch failed",
			existingMetadata: homeRunMetadata,
			organizationId,
			reason: childResult.reason ?? "dispatch_failed",
			runId: homeRunId,
		});
		// Settle the admitted retry attempt as failed. The attempt id is the exact
		// fence, so a concurrent or stale retry cannot mutate another execution.
		await settleWorkItemAttempt(context.db, {
			workItemId,
			orgId: organizationId,
			attemptId: attemptAdmission.attempt.id,
			executor: { type: "tedi", id: delegatedTediId },
			outcome: "failed",
			summary: "Delegation recovery dispatch failed",
			settledAt: dispatchedAt,
			metadata: {
				...metadata,
				retryCount: nextRetryCount,
			},
		});
	} else {
		// Child summaries belong to one execution. Carrying the previous terminal
		// projection into this dispatch makes the immediate receipt look complete.
		const recoveryMetadata = { ...homeRunMetadata };
		for (const key of [
			"childRunStatus",
			"childRunEventCount",
			"childRunLatestEventAt",
			"childRunLatestEventKind",
			"childRunLatestActivityLabel",
			"childRunPreview",
			"childRunTerminalAt",
			"childRunTerminalEventKind",
			"childRunStopReason",
			"childRunStopDetail",
			"childTaskOutcome",
			"kernelWorkflowInspect",
			"delegationProof",
			"progress",
		])
			delete recoveryMetadata[key];
		await updateKernelRuntimeRun(context.db, homeRunId, {
			status: "queued",
			delegatedTediId,
			childRunId: childResult.childRunId,
			childConversationId: childResult.childConversationId ?? null,
			progressValue: 24,
			progressLabel: "Dispatched",
			progressDetail: "Recovery work order delivered to the target tedi",
			latestEventKind: "run.started",
			latestEventAt: dispatchedAt,
			preview:
				"Recovery dispatched to the target tedi; progress will stream into this work card.",
			completedAt: null,
			startedAt: dispatchedAt,
			updatedAt: dispatchedAt,
			runtimeMetadata: {
				...nonNullRecord(homeRun.runtimeMetadata),
				childRunId: childResult.childRunId,
				childConversationId: childResult.childConversationId ?? null,
			},
			metadata: {
				...recoveryMetadata,
				childRunId: childResult.childRunId,
				childConversationId: childResult.childConversationId ?? null,
				delegatedTediId,
				workItemId,
				retryCount: nextRetryCount,
				delegationStatus: "queued",
				homeRecoveryDispatch: {
					previousChildRunId: homeRun.childRunId,
					previousChildConversationId: homeRun.childConversationId,
					childRunId: childResult.childRunId,
					dispatchedAt,
					retryCount: nextRetryCount,
					source: "kernelRuntime.retryDelegation",
				},
			},
		});
	}

	// (8) Audit trail.
	const actor = auditActor(context);
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: "kernel.delegation.retried",
		resourceType: "work_item",
		resourceId: workItemId,
		metadata: toJsonRecord({
			...actor.actorMetadata,
			source: "kernelRuntime.retryDelegation",
			workItemId,
			homeRunId,
			delegatedTediId,
			childRunId: childResult.childRunId,
			retryCount: nextRetryCount,
			dispatchStatus: childResult.status,
		}),
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
	const updatedHomeRun = await getKernelRuntimeRun(context.db, {
		id: homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedHomeRun ?? homeRun),
		childRunId: childResult.childRunId,
		retryCount: nextRetryCount,
	};
}

// Cancel an active Home run: mark canceled + emit run.canceled, and CASCADE the
// stop to a live delegated child via the canonical child-stop RPC so the running
// worker actually halts (fail-safe — a child-side failure never blocks the
// parent cancel). Persists through the package-level kernel runtime query boundary.

export // Cancel an active Home run: mark canceled + emit run.canceled, and CASCADE the
// stop to a live delegated child via the canonical child-stop RPC so the running
// worker actually halts (fail-safe — a child-side failure never blocks the
// parent cancel). Persists through the package-level kernel runtime query boundary.
async function cancelKernelRunCore(
	context: BaseContext,
	input: {
		organizationId: string;
		homeRunId: string;
		reason?: string;
	},
): Promise<{
	run: HomeRun;
}> {
	const { organizationId } = input;
	const existingRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId,
	});
	if (!existingRun) {
		throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
	}
	if (isTerminalHomeRunStatus(existingRun.status as TediRunStatus)) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run is already "${existingRun.status}" and cannot be canceled`,
		);
	}
	// Durable abort intent BEFORE any downstream action: even if
	// the child stop, run patch, or event insert below fails, the recorded intent
	// survives and recovery honors it. Fail-soft: never blocks the cancel.
	await requestRunAbort(context.db, {
		runId: input.homeRunId,
		organizationId,
		reason: input.reason ?? null,
	});
	if (existingRun.childRunId && existingRun.delegatedTediId) {
		const childRunStatuses = await readChildRunStatusesForRunRows(context, [
			existingRun,
		]);
		const childRunStatus = childRunStatuses.get(
			childRunStatusKey(existingRun.delegatedTediId, existingRun.childRunId),
		);
		if (
			childRunStatus &&
			isTerminalHomeRunStatus(
				homeRunStatusFromChildStatus(
					childRunStatusFromSummary(childRunStatus),
					existingRun.status as TediRunStatus,
				),
			)
		) {
			const [reconciledRow = existingRun] =
				await reconcileHomeRunRowsFromChildStatus(context, {
					childRunStatuses,
					rows: [existingRun],
				});
			return {
				run: normalizeHomeRunRecord(reconciledRow, childRunStatuses),
			};
		}
	}
	const canceledAt = nowIso();
	const progress = homeRunProgress({
		eventCount: 0,
		status: "canceled",
	});
	const preview = input.reason
		? `Home run canceled by operator: ${input.reason}`
		: "Home run canceled by operator.";
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};

	// Cascade the cancel to a live delegated child: the parent going canceled
	// must actually stop the running worker, not just mark the parent terminal.
	// Fail-safe — a missing child (no childRunId) is skipped; a child-side
	// failure is recorded but never blocks the parent cancel. The child's own
	// submission gets the durable abort stamp FIRST, so a failed child-stop RPC
	// still leaves recoverable intent on the child's ledger row.
	const delegatedChildRunIds = existingRun.delegatedTediId
		? [existingRun.childRunId, delegatedChildSteerRunId(existingRun)].filter(
				(runId, index, runIds): runId is string =>
					Boolean(runId) && runIds.indexOf(runId) === index,
			)
		: [];
	for (const childRunId of delegatedChildRunIds) {
		await requestRunAbort(context.db, {
			runId: childRunId,
			organizationId,
			reason: input.reason ?? "parent home run canceled",
		});
	}
	const delegatedChildStops = await Promise.all(
		delegatedChildRunIds.map(async (childRunId) => ({
			childRunId,
			result: await kernelChildStopper({
				context,
				organizationId,
				delegatedTediId: existingRun.delegatedTediId as string,
				childRunId,
				childConversationId: existingRun.childConversationId,
				reason: input.reason ?? undefined,
			}),
		})),
	);
	const childStopErrors = delegatedChildStops
		.map(({ childRunId, result }) =>
			result.error ? `${childRunId}: ${result.error}` : null,
		)
		.filter((error): error is string => Boolean(error));
	const childStop: KernelChildControlResult =
		delegatedChildStops.length === 0
			? childControlSkipped
			: {
					attempted: delegatedChildStops.some(({ result }) => result.attempted),
					outcome: delegatedChildStops.some(
						({ result }) => result.outcome === "failed",
					)
						? "failed"
						: "succeeded",
					...(childStopErrors.length > 0
						? {
								error: childStopErrors.join("; "),
							}
						: {}),
				};
	const nextMetadata = {
		...existingMetadata,
		cancelReason: input.reason ?? null,
		canceledAt,
		progress,
		delegatedChildStop: existingRun.childRunId
			? {
					attempted: childStop.attempted,
					outcome: childStop.outcome,
					childRunId: existingRun.childRunId,
					delegatedTediId: existingRun.delegatedTediId ?? null,
					error: childStop.error ?? null,
					canceledAt,
				}
			: null,
		delegatedChildStops: delegatedChildStops.map(({ childRunId, result }) => ({
			attempted: result.attempted,
			outcome: result.outcome,
			childRunId,
			delegatedTediId: existingRun.delegatedTediId ?? null,
			error: result.error ?? null,
			canceledAt,
		})),
	};
	await updateKernelRuntimeRun(context.db, input.homeRunId, {
		status: "canceled",
		latestEventKind: "run.canceled",
		latestEventAt: canceledAt,
		preview,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		completedAt: canceledAt,
		updatedAt: canceledAt,
		metadata: toJsonRecord(nextMetadata),
	});

	// The parent is durably canceled. Settle its exact Work Item attempt now;
	// child terminal telemetry may arrive later (or never arrive). Canonical
	// operator-selected tasks return to accepted instead of being canceled.
	await releaseCanceledDelegationWorkItem(context, {
		createdAt: canceledAt,
		row: existingRun,
	});

	// Best-effort DO-side abort of an in-flight kernel turn's LLM pass
	// (docs/cognition/kernel-execution-model.md "Operator cancel") — AFTER the
	// run row above is durably `canceled`, so the turn body's pre-materialize
	// cancel gate settles correctly regardless of whether this call reaches
	// the DO or finds a live controller. Fail-soft at this call site too (on
	// top of the canceler's own internal fail-soft): a throwing test stub or
	// future refactor must never fail the cancel RPC.
	try {
		await kernelDoTurnCanceler({
			context,
			organizationId,
			runId: input.homeRunId,
		});
	} catch (error) {
		console.warn(
			"[kernelRuntime] DO cancelTurn best-effort call threw (cancel is already durable)",
			errorMessage(error),
		);
	}
	await insertKernelRuntimeEvent(context, {
		id: [
			"home",
			organizationId,
			"event",
			"run.canceled",
			existingRun.conversationId,
			input.homeRunId,
			canceledAt,
		].join(":"),
		organizationId,
		kind: "run.canceled",
		conversationId: existingRun.conversationId,
		runId: input.homeRunId,
		delegatedTediId: existingRun.delegatedTediId ?? undefined,
		childRunId: existingRun.childRunId ?? undefined,
		payload: {
			action: "home.run.canceled",
			reason: input.reason ?? null,
			childRunId: existingRun.childRunId ?? null,
			childRunIds: delegatedChildRunIds,
			delegatedTediId: existingRun.delegatedTediId ?? null,
		},
		runtimeMetadata: {
			source: "kernelRuntime.cancelRun",
			delegatedChildStopAttempted: childStop.attempted,
			delegatedChildStopOutcome: childStop.outcome,
			...(childStop.error
				? {
						delegatedChildStopError: childStop.error,
					}
				: {}),
		},
		createdAt: canceledAt,
	});
	// Carry the run's kernelRoute into the audit event so
	// home-reflection-producer can mine the kernel's routing rationale into
	// delegation-decision facts. Fail-soft: absent → null (producer skips the
	// "because:" clause and emits the bare fact text, zero regression).
	const cancelKernelRoute = existingMetadata.kernelRoute ?? null;
	const actor = auditActor(context);
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: "kernel.run.canceled",
		resourceType: "kernel_run",
		resourceId: input.homeRunId,
		metadata: toJsonRecord({
			...actor.actorMetadata,
			source: "kernelRuntime.cancelRun",
			conversationId: existingRun.conversationId,
			reason: input.reason ?? null,
			childRunId: existingRun.childRunId ?? null,
			childRunIds: delegatedChildRunIds,
			delegatedTediId: existingRun.delegatedTediId ?? null,
			delegatedChildStopAttempted: childStop.attempted,
			delegatedChildStopOutcome: childStop.outcome,
			kernelRoute: cancelKernelRoute,
		}),
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? existingRun),
	};
}

// Steer an active Home run without closing it. Records the operator's
// instruction on the parent run, emits a transcript-visible user event, AND
// FORWARDS the instruction to a live delegated child via the same async
// isolate-inject path the dispatcher uses — so the running worker consumes the
// steer inline instead of treating it as an inert parent-only note. Fail-safe:
// a child-side failure never blocks the parent steer.

export // Steer an active Home run without closing it. Records the operator's
// instruction on the parent run, emits a transcript-visible user event, AND
// FORWARDS the instruction to a live delegated child via the same async
// isolate-inject path the dispatcher uses — so the running worker consumes the
// steer inline instead of treating it as an inert parent-only note. Fail-safe:
// a child-side failure never blocks the parent steer.
async function steerKernelRunCore(
	context: BaseContext,
	input: {
		organizationId: string;
		homeRunId: string;
		instruction: string;
	},
): Promise<{
	run: HomeRun;
}> {
	const { organizationId } = input;
	const instruction = input.instruction.trim();
	if (!instruction) {
		throw createError(ErrorCodes.BAD_REQUEST, "Steering instruction required");
	}
	const existingRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId,
	});
	if (!existingRun) {
		throw createError(ErrorCodes.NOT_FOUND, "Home run not found");
	}
	if (isTerminalHomeRunStatus(existingRun.status as TediRunStatus)) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home run is already "${existingRun.status}" and cannot be steered`,
		);
	}
	const steeredAt = nowIso();
	const steeringMessageId = `${input.homeRunId}:steer:${Date.parse(steeredAt)}`;
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};
	const priorInstructions = Array.isArray(existingMetadata.steeringInstructions)
		? existingMetadata.steeringInstructions.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
	// Forward the steer to a live delegated child before persisting, so the
	// recorded instruction + event carry the real forwarding outcome. Fail-safe —
	// a missing child (no childRunId) is skipped; a child-side failure is recorded
	// but never blocks the parent steer.
	const childSteer: KernelChildControlResult =
		existingRun.childRunId && existingRun.delegatedTediId
			? await kernelChildSteerForwarder({
					context,
					organizationId,
					delegatedTediId: existingRun.delegatedTediId,
					childRunId: existingRun.childRunId,
					childConversationId: existingRun.childConversationId,
					...(typeof existingMetadata.workItemId === "string" &&
					existingMetadata.workItemId.trim().length > 0
						? { workItemId: existingMetadata.workItemId.trim() }
						: {}),
					instruction,
					homeRunId: input.homeRunId,
					steeredAt,
				})
			: childControlSkipped;
	const steeringRecord = {
		instruction,
		steeredAt,
		source: "kernelRuntime.steerRun",
		delegatedChildSteerOutcome: childSteer.outcome,
	};
	const nextMetadata = {
		...existingMetadata,
		steeredAt,
		latestSteeringInstruction: instruction,
		steeringInstructions: [...priorInstructions.slice(-9), steeringRecord],
		delegatedChildSteer: existingRun.childRunId
			? {
					attempted: childSteer.attempted,
					outcome: childSteer.outcome,
					childRunId: existingRun.childRunId,
					delegatedTediId: existingRun.delegatedTediId ?? null,
					childInjectRunId: childSteer.childInjectRunId ?? null,
					error: childSteer.error ?? null,
					steeredAt,
				}
			: null,
	};
	const preview = `Operator steered this Home run: ${instruction.slice(0, 180)}`;
	await updateKernelRuntimeRun(context.db, input.homeRunId, {
		latestEventKind: "message.received",
		latestEventAt: steeredAt,
		preview,
		updatedAt: steeredAt,
		metadata: toJsonRecord(nextMetadata),
	});
	await insertKernelRuntimeEvent(context, {
		id: [
			"home",
			organizationId,
			"event",
			"run.steered",
			existingRun.conversationId,
			input.homeRunId,
			steeredAt,
		].join(":"),
		organizationId,
		kind: "message.received",
		conversationId: existingRun.conversationId,
		runId: input.homeRunId,
		messageId: steeringMessageId,
		delegatedTediId: existingRun.delegatedTediId ?? undefined,
		childRunId: existingRun.childRunId ?? undefined,
		payload: {
			role: "user",
			content: instruction,
			channel: "home",
			metadata: {
				action: "home.run.steered",
				childRunId: existingRun.childRunId ?? null,
				delegatedTediId: existingRun.delegatedTediId ?? null,
				homeRunId: input.homeRunId,
				steeredAt,
			},
		},
		runtimeMetadata: {
			source: "kernelRuntime.steerRun",
			delegatedChildSteerAttempted: childSteer.attempted,
			delegatedChildSteerOutcome: childSteer.outcome,
			...(childSteer.childInjectRunId
				? {
						delegatedChildSteerRunId: childSteer.childInjectRunId,
					}
				: {}),
			...(childSteer.error
				? {
						delegatedChildSteerError: childSteer.error,
					}
				: {}),
		},
		createdAt: steeredAt,
	});
	const actor = auditActor(context);
	await insertAuditEvent(context.db, {
		organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: "kernel.run.steered",
		resourceType: "kernel_run",
		resourceId: input.homeRunId,
		metadata: {
			...actor.actorMetadata,
			source: "kernelRuntime.steerRun",
			conversationId: existingRun.conversationId,
			steeredAt,
			instructionLength: instruction.length,
			instructionPreview:
				instruction.length > 500
					? `${instruction.slice(0, 497)}...`
					: instruction,
			childRunId: existingRun.childRunId ?? null,
			delegatedTediId: existingRun.delegatedTediId ?? null,
			delegatedChildSteerAttempted: childSteer.attempted,
			delegatedChildSteerOutcome: childSteer.outcome,
		},
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? existingRun),
	};
}

export async function resolveKernelWorkstationAttachWorkOrder(
	context: BaseContext,
	input: {
		approvalRequestId: string;
		organizationId: string;
		resolution?: string | null;
		status: "approved" | "rejected";
	},
): Promise<{
	run: HomeRun;
}> {
	const approval = await getApprovalRequestById(
		context.db,
		input.approvalRequestId,
	);
	if (!approval) {
		throw createError(ErrorCodes.NOT_FOUND, "Approval request not found");
	}
	if (approval.orgId !== input.organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Access denied to this Home work order",
		);
	}
	if (approval.status !== input.status) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Home work order approval is "${approval.status}", not "${input.status}"`,
		);
	}
	const payload = homeWorkstationAttachPayload(approval.payload);
	if (!payload) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Approval is not a Home workstation attachment work order",
		);
	}
	const existingRun = await getKernelRuntimeRun(context.db, {
		id: payload.homeRunId,
		organizationId: input.organizationId,
	});
	if (!existingRun) {
		throw createError(ErrorCodes.NOT_FOUND, "Home work order run not found");
	}
	const resolvedAt = nowIso();
	const progress = resolvedWorkstationAttachProgress(input.status);
	const nextRunStatus: TediRunStatus =
		input.status === "approved" ? "queued" : "canceled";
	const existingMetadata = nonNullRecord(existingRun.metadata) ?? {};
	const existingWorkItemId = stringFromPayload(existingMetadata.workItemId);
	if (input.status === "approved") {
		if (isTerminalHomeRunStatus(existingRun.status))
			throw createError(
				ErrorCodes.CONFLICT,
				"Terminal Home run cannot dispatch a workstation",
			);
		if (!existingWorkItemId)
			throw createError(
				ErrorCodes.CONFLICT,
				"Approved workstation dispatch has no admitted Work Item",
			);
		const target = await resolveKernelDelegateTarget(context, {
			organizationId: input.organizationId,
			delegateToTediId: payload.delegateToTediId,
		});
		if (!target)
			throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
		const identity = workstationDispatchIdentity({
			homeRunId: payload.homeRunId,
			target,
		});
		const hasLiveAdmission = await inspectWorkstationDispatchAdmission(
			context,
			{
				organizationId: input.organizationId,
				workItemId: existingWorkItemId,
				targetTediId: target.id,
				runtimeRunId: identity.runtimeRunId,
				now: resolvedAt,
			},
		);
		if (!hasLiveAdmission)
			throw createError(
				ErrorCodes.CONFLICT,
				"Approved workstation dispatch requires a live admitted Work attempt",
			);
	}
	const existingWorkOrder =
		nonNullRecord(existingMetadata.delegationWorkOrder) ??
		payload.workOrder ??
		null;
	const nextWorkOrder = existingWorkOrder
		? {
				...existingWorkOrder,
				status:
					input.status === "approved"
						? "approved_waiting_certified_dispatch"
						: "rejected",
			}
		: null;
	const preview =
		input.status === "approved"
			? "Workstation attachment approved — dispatching the certified work order to the workstation-backed tedi."
			: "Workstation attachment rejected by operator.";
	const nextMetadata = {
		...existingMetadata,
		approvalRequestId: input.approvalRequestId,
		approvalResolvedAt: resolvedAt,
		approvalResolution: input.resolution ?? approval.resolution ?? null,
		approvalStatus: input.status,
		delegationWorkOrder: nextWorkOrder,
		...(existingWorkItemId
			? {
					workItemId: existingWorkItemId,
				}
			: {}),
		progress,
	};
	await updateKernelRuntimeRun(context.db, payload.homeRunId, {
		status: nextRunStatus,
		progressValue: progress.current,
		progressLabel: progress.label,
		progressDetail: progress.detail,
		latestEventKind: "approval.resolved",
		latestEventAt: resolvedAt,
		preview,
		completedAt: input.status === "rejected" ? resolvedAt : null,
		updatedAt: resolvedAt,
		metadata: nextMetadata,
	});
	await insertKernelRuntimeEvent(context, {
		id: [
			"home",
			input.organizationId,
			"event",
			"approval.resolved",
			payload.homeConversationId,
			payload.homeRunId,
			input.approvalRequestId,
		].join(":"),
		organizationId: input.organizationId,
		kind: "approval.resolved",
		conversationId: payload.homeConversationId,
		runId: payload.homeRunId,
		delegatedTediId: payload.delegateToTediId,
		payload: {
			approvalRequestId: input.approvalRequestId,
			delegationWorkOrder: nextWorkOrder,
			nextRunStatus,
			resolution: input.resolution ?? approval.resolution ?? null,
			status: input.status,
		},
		runtimeMetadata: {
			source: "kernelRuntime.resolveDelegationWorkOrder",
			dispatch:
				input.status === "approved"
					? "certified-workstation-attach-initiated"
					: "workstation-attach-rejected",
		},
		createdAt: resolvedAt,
	});
	if (input.status === "rejected" && existingWorkItemId) {
		await cancelWorkItem(context.db, {
			workItemId: existingWorkItemId,
			orgId: input.organizationId,
			actor: { type: "system", id: "home" },
			cancelledAt: resolvedAt,
			reason: "workstation_attach_rejected",
		}).catch((error: unknown) => {
			console.warn(
				"[kernelRuntime.resolveDelegationWorkOrder] workstation work item release failed",
				errorMessage(error),
			);
			return null;
		});
	}
	if (input.status === "approved") {
		const sourceContent =
			(await readKernelUserMessageContent(context, {
				conversationId: payload.homeConversationId,
				organizationId: input.organizationId,
				runId: payload.homeRunId,
			})) ??
			stringFromPayload(nonNullRecord(nextWorkOrder)?.requestPreview) ??
			"Complete the approved Home workstation work order.";
		await runWorkstationWorkOrderDispatch(context, {
			content: sourceContent,
			conversationId: payload.homeConversationId,
			delegateToTediId: payload.delegateToTediId,
			existingMetadata: nextMetadata,
			existingRuntimeMetadata: nonNullRecord(existingRun.runtimeMetadata),
			organizationId: input.organizationId,
			runId: payload.homeRunId,
			trigger: "human-approval",
			userMessageId: existingRun.inputMessageId ?? `${payload.homeRunId}:input`,
			workItemId: existingWorkItemId,
			workOrder: nextWorkOrder,
		}).catch((error) => {
			console.warn(
				"[kernelRuntime.resolveDelegationWorkOrder] workstation work order dispatch failed",
				errorMessage(error),
			);
			return null;
		});
	}
	const updatedRun = await getKernelRuntimeRun(context.db, {
		id: payload.homeRunId,
	});
	return {
		run: normalizeHomeRunRecord(updatedRun ?? existingRun),
	};
}

/**
 * Core logic for the proposeCodemodeExecute proc — exported for unit-testing.
 *
 * Arbitrary model JS over the live durable workspace is always HIGH risk, so
 * this ALWAYS parks a human approval card (never auto-resolves via policy). On
 * approval the DO authorizes the whole coding session; the model re-issues
 * `execute`, which then runs inline. The code never leaves the DO — only its
 * SHA-256 hash is recorded here for audit.
 */

/**
 * Core logic for the proposeCodemodeExecute proc — exported for unit-testing.
 *
 * Arbitrary model JS over the live durable workspace is always HIGH risk, so
 * this ALWAYS parks a human approval card (never auto-resolves via policy). On
 * approval the DO authorizes the whole coding session; the model re-issues
 * `execute`, which then runs inline. The code never leaves the DO — only its
 * SHA-256 hash is recorded here for audit.
 */
export async function proposeCodemodeExecuteImpl(
	context: BaseContext,
	input: {
		tediId: string;
		orgId: string;
		conversationId: string;
		sessionKey: string;
		executionId: string;
		codeHash: string;
		approvalRequestId?: string;
		executionMode?: "session_replay" | "durable_call";
		homeRunId?: string;
		childRunId?: string;
		pendingSeq?: number;
		connector?: string;
		method?: string;
	},
): Promise<{
	approvalRequestId: string;
	status: "approved" | "pending";
}> {
	const policy = await readOrgGovernancePolicy(context, input.orgId);
	let durableHomeRun: KernelRuntimeRun | undefined;
	if (input.executionMode === "durable_call") {
		durableHomeRun = await getDurableKernelRuntimeRun(context.db, {
			id: input.homeRunId ?? "",
			organizationId: input.orgId,
			delegatedTediId: input.tediId,
			childRunId: input.childRunId ?? "",
		});
		if (!durableHomeRun) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Durable Code Mode approval does not match the delegated Home run",
			);
		}
	}
	const payload: CodemodeExecuteWritePayload = {
		kind: CODEMODE_EXECUTE_WRITE_KIND,
		organizationId: input.orgId,
		tediId: input.tediId,
		conversationId: input.conversationId,
		sessionKey: input.sessionKey,
		executionId: input.executionId,
		codeHash: input.codeHash,
		riskTier: "high",
		...(input.executionMode
			? {
					executionMode: input.executionMode,
				}
			: {}),
		...(input.homeRunId
			? {
					homeRunId: input.homeRunId,
				}
			: {}),
		...(input.childRunId
			? {
					childRunId: input.childRunId,
				}
			: {}),
		...(input.pendingSeq !== undefined
			? {
					pendingSeq: input.pendingSeq,
				}
			: {}),
		...(input.connector
			? {
					connector: input.connector,
				}
			: {}),
		...(input.method
			? {
					method: input.method,
				}
			: {}),
	};
	const approvalRequestId = input.approvalRequestId ?? crypto.randomUUID();
	const existingApproval = await getApprovalRequestById(
		context.db,
		approvalRequestId,
	);
	if (existingApproval) {
		const existingPayload = parseCodemodeExecuteWritePayload(
			existingApproval.payload,
		);
		if (
			existingApproval.tediId !== input.tediId ||
			existingApproval.orgId !== input.orgId ||
			existingPayload?.executionId !== input.executionId ||
			existingPayload?.codeHash !== input.codeHash
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Approval request id is already bound to another durable execution",
			);
		}
		if (
			existingApproval.status !== "pending" &&
			existingApproval.status !== "approved"
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Durable execution approval is already "${existingApproval.status}"`,
			);
		}
	}
	const createdAt = existingApproval?.createdAt ?? nowIso();
	const ttlHours = resolveApprovalTtlHours(policy);
	if (!existingApproval) {
		await createApprovalRequest(context.db, {
			id: approvalRequestId,
			tediId: input.tediId,
			orgId: input.orgId,
			actionType:
				input.executionMode === "durable_call"
					? "durable_code.call"
					: "home.tool_write",
			description:
				input.executionMode === "durable_call"
					? `Approve ${input.connector}.${input.method} in durable execution ${input.executionId}`
					: `Authorize network-isolated code execution for coding session ${input.sessionKey}`,
			payload: toJsonRecord(payload),
			createdAt,
			expiresAt: offsetIso(createdAt, ttlHours * 60 * 60 * 1000),
		});
	}
	if (
		input.executionMode === "durable_call" &&
		existingApproval?.status !== "approved"
	) {
		const homeRun = durableHomeRun!;
		const metadata = nonNullRecord(homeRun.metadata) ?? {};
		await updateKernelRuntimeRun(context.db, homeRun.id, {
			status: "requires_approval",
			progressLabel: "Approval required",
			progressDetail: `${input.connector}.${input.method} is paused in durable execution ${input.executionId}`,
			latestEventKind: "approval.requested",
			latestEventAt: createdAt,
			completedAt: null,
			updatedAt: createdAt,
			metadata: toJsonRecord({
				...metadata,
				approvalRequestId,
				durableCodeApproval: {
					approvalRequestId,
					executionId: input.executionId,
					childRunId: input.childRunId,
					connector: input.connector,
					method: input.method,
					seq: input.pendingSeq,
					status: "pending",
				},
			}),
		});
	}
	if (!existingApproval)
		await insertAuditEvent(context.db, {
			organizationId: input.orgId,
			actorId: input.tediId,
			actorType: "tedi",
			action: "approval.requested",
			resourceType: "approval_request",
			resourceId: approvalRequestId,
			metadata: {
				source: "kernelRuntime.proposeCodemodeExecute",
				actionType:
					input.executionMode === "durable_call"
						? "durable_code.call"
						: "home.tool_write",
				sessionKey: input.sessionKey,
				executionId: input.executionId,
				riskTier: "high",
				conversationId: input.conversationId,
			},
		});
	return {
		approvalRequestId,
		status: existingApproval?.status === "approved" ? "approved" : "pending",
	};
}

/**
 * Core logic for the proposeRepoCommit proc — exported for unit-testing without
 * the oRPC middleware stack (mirrors the settleHomeToolWriteApproval pattern).
 *
 * Security: NEVER accepts file contents or PATs. riskTier from the caller is
 * IGNORED; it is recomputed server-side from baseRef+branch as defense-in-depth.
 * MCP executor is NEVER called here.
 */

/**
 * Core logic for the proposeRepoCommit proc — exported for unit-testing without
 * the oRPC middleware stack (mirrors the settleHomeToolWriteApproval pattern).
 *
 * Security: NEVER accepts file contents or PATs. riskTier from the caller is
 * IGNORED; it is recomputed server-side from baseRef+branch as defense-in-depth.
 * MCP executor is NEVER called here.
 */
export async function proposeRepoCommitImpl(
	context: BaseContext,
	input: {
		tediId: string;
		orgId: string;
		conversationId: string;
		owner: string;
		repo: string;
		baseRef: string;
		branch: string;
		message: string;
		openPr: boolean;
		prBase?: string | null;
		changeSummary: {
			fileCount: number;
			addedOrModified: string[];
			deleted: string[];
			totalBytes: number;
		};
		/**
		 * Exact content fingerprint of the ordered changeset + push target,
		 * computed by the caller's publish fence. Persisted verbatim onto the
		 * approval: apps/api never sees file contents, so it cannot recompute
		 * this and must not try — the value's whole job is to land the tedi's
		 * propose-time declaration in D1, a store the tedi cannot rewrite.
		 */
		changeFingerprint?: string | null;
		executionLedgerId: string;
		riskTier: "low" | "high";
	},
): Promise<{
	approvalRequestId: string;
	status: "approved" | "pending";
	autoResolved: boolean;
	decisionReason: string;
}> {
	const recomputedRisk = classifyRepoCommitRisk({
		baseRef: input.baseRef,
		branch: input.branch,
	});
	if (recomputedRisk !== input.riskTier) {
		console.warn("[kernelRuntime] proposeRepoCommit: riskTier mismatch", {
			callerRisk: input.riskTier,
			serverRisk: recomputedRisk,
			owner: input.owner,
			repo: input.repo,
			branch: input.branch,
			baseRef: input.baseRef,
		});
	}
	const riskTier = recomputedRisk;
	// Shape-check at the trust boundary, then store verbatim. A malformed value
	// is dropped rather than persisted, because a payload carrying a non-hex
	// fingerprint fails parseRepoCommitWritePayload outright and would make the
	// approval unreadable — i.e. would strand the commit instead of binding it.
	const changeFingerprint =
		typeof input.changeFingerprint === "string" &&
		REPO_COMMIT_FINGERPRINT_RE.test(input.changeFingerprint)
			? input.changeFingerprint
			: null;
	if (input.changeFingerprint != null && changeFingerprint === null) {
		console.warn("[kernelRuntime] proposeRepoCommit: malformed fingerprint", {
			owner: input.owner,
			repo: input.repo,
			executionLedgerId: input.executionLedgerId,
		});
	}
	const policy = await readOrgGovernancePolicy(context, input.orgId);
	const sessionAllowlist = await readSessionWriteAllowlist(context, {
		organizationId: input.orgId,
		conversationId: input.conversationId,
	});
	const decision = decideKernelWriteApproval({
		policy,
		sessionAllowlist,
		proposal: {
			appSlug: "repo",
			toolName: "repo_commit",
			riskTier,
		},
	});
	// Protected-branch commits always park, even when session/policy would auto-resolve
	// a low-risk commit. The shared decideKernelWriteApproval intentionally lets session
	// grants carry high-risk writes for home_tool_write; we narrow that here for repo commits.
	const effectiveAutoResolve = decision.autoResolve && riskTier !== "high";
	const approvalTitle = `Commit ${input.changeSummary.fileCount} file(s) to ${input.owner}/${input.repo}@${input.branch}`;
	const approvalPreview = `${approvalTitle} (base ${input.baseRef})${input.openPr ? " + open PR" : ""}`;
	const payload = {
		kind: REPO_COMMIT_WRITE_KIND,
		organizationId: input.orgId,
		tediId: input.tediId,
		conversationId: input.conversationId,
		homeRunId: null,
		owner: input.owner,
		repo: input.repo,
		baseRef: input.baseRef,
		branch: input.branch,
		message: input.message,
		openPr: input.openPr,
		prBase: input.prBase ?? null,
		changeSummary: input.changeSummary,
		changeFingerprint,
		riskTier,
		executionLedgerId: input.executionLedgerId,
		// Operator-facing approval card metadata. Summary-only; no file contents or
		// credentials. cognitiveRuntime.listApprovals uses title/requestPreview for
		// concise card labels and review semantics.
		appSlug: "repo",
		toolName: "repo_commit",
		title: approvalTitle,
		requestPreview: approvalPreview,
	} satisfies RepoCommitWritePayload & Record<string, unknown>;
	const approvalRequestId = crypto.randomUUID();
	const createdAt = nowIso();
	const ttlHours = resolveApprovalTtlHours(policy);
	await createApprovalRequest(context.db, {
		id: approvalRequestId,
		tediId: input.tediId,
		orgId: input.orgId,
		actionType: "home.tool_write",
		description: approvalPreview,
		payload: toJsonRecord(payload),
		createdAt,
		expiresAt: offsetIso(createdAt, ttlHours * 60 * 60 * 1000),
	});
	await insertAuditEvent(context.db, {
		organizationId: input.orgId,
		actorId: input.tediId,
		actorType: "tedi",
		action: "approval.requested",
		resourceType: "approval_request",
		resourceId: approvalRequestId,
		metadata: {
			source: "kernelRuntime.proposeRepoCommit",
			actionType: "home.tool_write",
			owner: input.owner,
			repo: input.repo,
			branch: input.branch,
			riskTier,
			conversationId: input.conversationId,
		},
	});
	if (effectiveAutoResolve) {
		const resolved = await resolveApprovalRequest(
			context.db,
			approvalRequestId,
			{
				status: "approved",
				resolvedBy: decision.source ?? "policy",
				resolution: decision.reason.slice(0, 200),
			},
		);
		if (!resolved) {
			console.warn(
				"[kernelRuntime] proposeRepoCommit auto-resolve: approval not pending",
				{
					approvalRequestId,
				},
			);
			return {
				approvalRequestId,
				status: "pending",
				autoResolved: false,
				decisionReason: decision.reason,
			};
		}
		await insertAuditEvent(context.db, {
			organizationId: input.orgId,
			actorId: "policy",
			actorType: "service",
			action: "approval.approved",
			resourceType: "approval_request",
			resourceId: approvalRequestId,
			metadata: {
				source: "kernelRuntime.proposeRepoCommit.autoResolve",
				autoResolveSource: decision.source,
				autoResolveReason: decision.reason.slice(0, 200),
				owner: input.owner,
				repo: input.repo,
				branch: input.branch,
			},
		});
	}
	return {
		approvalRequestId,
		status: effectiveAutoResolve ? "approved" : "pending",
		autoResolved: effectiveAutoResolve,
		decisionReason: decision.reason,
	};
}
