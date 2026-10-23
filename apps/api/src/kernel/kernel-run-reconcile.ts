/** Scheduled run reconciliation and durable submission recovery. */
import type { BaseContext } from "../rpc/context";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelTurnWorkInput } from "../rpc/routers/kernel/turn-work-context";
import { injectAgentMessage } from "@tedix/provisioning";
import { resolveApprovalTtlHours } from "@tedix/api-contract/utils/approval-policy";
import type { TediRequeueDeps } from "./runtime-submission-bridge";
import {
	loadRuntimeSubmissionBridge,
	loadKernelChildRunReads,
	loadKernelHomePlan,
	loadKernelRunReads,
	loadTediHelpers,
} from "./kernel-lazy";
import {
	KERNEL_RECONCILIATION_METADATA_KEY,
	type LedgerAction,
	type LedgerApprovalRow,
	type LedgerRunRow,
	MAX_RECONCILIATION_SCAN_RUNS,
	NON_TERMINAL_KERNEL_RUN_STATUSES,
	planRunReconciliation,
} from "./progress-ledger";
import { isCapacityDeferredDelegation } from "./delegation-deferral";

interface RunReconcileHost {
	turnContext(): Promise<BaseContext>;
	schedule(
		delay: number,
		callback: "runPlannerStep",
		payload: KernelTurnWorkInput,
	): Promise<unknown>;
	ensureReconciliationSchedule(organizationId: string): Promise<void>;
}

interface RunReconcileScheduleHost {
	getSchedules(): { callback: string; time: number }[];
	schedule(
		delay: number,
		callback: "reconcileRuns",
		payload: { organizationId: string },
	): Promise<unknown>;
}

/** Delay before a post-turn reconciliation sweep fires. */
const RECONCILE_SWEEP_DELAY_SECONDS = 5 * 60;
/** Matches `KERNEL_RUNTIME_BACKEND` in kernel-runtime.ts. */
const KERNEL_RUNTIME_BACKEND = "custom";
/**
 * Don't sweep a submission until the normal settle path (turn-work completion + the run-reconcile at terminalization)
 * has had time to fire — the sweep is the missed-settle safety net, not the primary settler.
 */
const STALE_SUBMISSION_RECONCILE_THRESHOLD_MS = 2 * 60_000;
const STALE_SUBMISSION_RECONCILE_LIMIT = 50;
/**
 * A submission in `reserved` status older than this was latched by Step A (the reserve CAS won) but the finalize Step B
 * never committed — the DO was evicted between the two steps. 30 s is generous enough that a live two-step settle is
 * never raced (A→B is sub-millisecond when the DO is alive) while still giving fast recovery.
 */
const RESERVED_LATCH_SWEEP_MS = 30_000;
/** Terminal tedi run-event kinds (a settle from the choke point). */
const TERMINAL_TEDI_RUN_EVENT_KINDS = [
	"run.completed",
	"run.failed",
	"run.canceled",
] as const;
/**
 * A `tedi_message` run that emits no event for this long, with no terminal event,
 * is treated as crashed and terminalized. Deliberately generous — well beyond any
 * normal turn + tool call — so a live (merely slow) turn is never terminalized.
 */
const TEDI_CRASH_LEASE_MS = 30 * 60_000;
/**
 * A kernel run stuck `running`/`queued` with no liveness signal (latest `kernel_runtime_events.createdAt` for the run,
 * or the submission's own `updatedAt`) for this long is treated as crashed (DO eviction mid-turn) and terminalized.
 * Conservative: the Code Mode ceiling is 300 000 ms (5 min), and multi-hop/fan-out turns can be slow — 15 min gives
 * substantial headroom before the sweep fires a crash-terminalization.
 */
const KERNEL_CRASH_LEASE_MS = 15 * 60_000;

function kernelErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Schedule one `reconcileRuns` sweep {@link RECONCILE_SWEEP_DELAY_SECONDS}s out unless one is already pending. Dedup
 * via `getSchedules()` — the synchronous list is valid here because `KernelDO` is the top-level alarm-owning agent
 * (same reasoning as the isolate DO's diag surface; the deprecation only affects sub-agents). Fail-soft: scheduling is
 * an optimization — the next turn re-attempts it.
 */
export async function ensureReconciliationSchedule(
	host: RunReconcileScheduleHost,
	organizationId: string,
): Promise<void> {
	try {
		// `schedule.time` is epoch seconds. A delayed schedule's row is only deleted after its callback completes (agents SDK
		// alarm loop), so the sweep currently executing is still listed — filter to future fire times or the self re-arm
		// inside `reconcileRuns` would always no-op.
		const nowSeconds = Math.floor(Date.now() / 1000);
		const pending = host
			.getSchedules()
			.some(
				(schedule) =>
					schedule.callback === "reconcileRuns" && schedule.time > nowSeconds,
			);
		if (pending) return;
		await host.schedule(RECONCILE_SWEEP_DELAY_SECONDS, "reconcileRuns", {
			organizationId,
		});
	} catch (error) {
		console.warn(
			"[kernel] reconciliation scheduling failed",
			kernelErrorMessage(error),
		);
	}
}

/**
 * Scheduled progress-ledger sweep (see progress-ledger.ts for the decision table). Public because the agents-SDK
 * schedule callback is looked up by method name. Steps: load the org's non-terminal runs (all conversations,
 * oldest-updated first so the longest-stuck rows are inside the scan cap), load the gating approval rows read-only,
 * plan deterministically, apply each action with a status-guarded conditional update. Re-schedules itself only while
 * non-terminal runs remain. Fail-soft throughout: a sweep failure logs and waits for the next turn's
 * `afterTurnMaintenance` to re-arm.
 */
export async function reconcileRuns(
	host: RunReconcileHost,
	payload: { organizationId: string },
): Promise<void> {
	const organizationId = payload?.organizationId;
	if (!organizationId) return;
	const context = await host.turnContext();
	try {
		const rows = await (
			await import("@tedix/db/queries/kernel-do-storage")
		).listKernelRunsByStatus(context.db, {
			organizationId,
			statuses: [...NON_TERMINAL_KERNEL_RUN_STATUSES],
			limit: MAX_RECONCILIATION_SCAN_RUNS,
		});
		// Stale-submission safety net — runs before the quiet-org early return, because an already-terminal run is not in the
		// non-terminal scan above, so a submission left 'running' by a missed (fail-soft) settle would otherwise never be
		// caught.
		await reconcileStaleSubmissions(host, context, organizationId);
		if (rows.length === 0) return; // org is quiet — let the alarm lapse
		// Capacity-deferred delegations start here once their target has a
		// free slot; they stay non-terminal, so this sweep keeps re-arming.
		if (rows.some(isCapacityDeferredDelegation)) {
			try {
				await (
					await import("../rpc/routers/kernel-runtime/delegation-capacity-release")
				).releaseCapacityDeferredDelegations(context, organizationId, rows);
			} catch (error) {
				console.warn(
					"[kernel] capacity-deferred release failed",
					kernelErrorMessage(error),
				);
			}
		}

		const ledgerRuns: LedgerRunRow[] = rows.map((row) => ({
			id: row.id,
			conversationId: row.conversationId,
			status: row.status,
			createdAt: row.createdAt ?? null,
			updatedAt: row.updatedAt ?? null,
			childRunId: row.childRunId ?? null,
			delegatedTediId: row.delegatedTediId ?? null,
			metadata: row.metadata ?? null,
		}));

		// Read-only approval lookups for requires_approval rows (the same helper the approval workflow + tedi-approvals
		// router use). A failed lookup just omits the row — the planner treats that as "cannot prove expiry" and takes no
		// action.
		const approvalIds = new Set<string>();
		for (const run of ledgerRuns) {
			if (run.status !== "requires_approval") continue;
			const id = run.metadata?.approvalRequestId;
			if (typeof id === "string" && id.length > 0) approvalIds.add(id);
		}
		const approvals = new Map<string, LedgerApprovalRow>();
		for (const id of approvalIds) {
			try {
				const row = await (
					await import("@tedix/db/queries/approvals")
				).getApprovalRequestById(context.db, id);
				if (row) {
					approvals.set(id, {
						id: row.id,
						status: row.status,
						expiresAt: row.expiresAt ?? null,
					});
				}
			} catch (error) {
				console.warn(
					"[kernel] reconciliation approval lookup failed",
					id,
					kernelErrorMessage(error),
				);
			}
		}

		// Held Home delegations carry no approval row; their review window is the
		// organization's approval TTL (policy pack `approvalTtlHours`).
		const approvalTtlHours = ledgerRuns.some(
			(run) =>
				run.status === "requires_approval" &&
				run.metadata?.homeDelegation !== undefined &&
				run.metadata?.homeDelegation !== null,
		)
			? resolveApprovalTtlHours(
					await (
						await import("../rpc/routers/kernel-runtime/policy-normalization")
					).readOrgGovernancePolicy(context, organizationId),
				)
			: undefined;
		const actions = planRunReconciliation({
			runs: ledgerRuns,
			approvals,
			now: Date.now(),
			approvalTtlHours,
		});
		let appliedCount = 0;
		for (const action of actions) {
			const applied = await applyLedgerAction(
				host,
				context,
				organizationId,
				action,
			);
			if (applied) {
				appliedCount += 1;
			}
		}

		// Delegation-parent backstop: terminalize a parent whose child run has provably failed/canceled but whom the
		// fail-soft event-driven reconcileChildStatus left non-terminal (planRunReconciliation skips delegation parents).
		// Runs on the same loaded rows.
		await reconcileStaleDelegationParents(host, context, organizationId, rows);

		// Success backstop: re-drive the inbox-wake success relay for any delegation parent whose completed child was missed
		// by a dropped wake alarm. reconcileStaleDelegationParents above only propagates failure; this makes the parent←child
		// relay eventually-exactly-once: a dropped one-shot wake self-heals here instead of stranding a completed child with
		// no Home follow-up.
		await reconcileUnrelayedDelegations(host, context, organizationId, rows);

		// Conservative re-arm: anything still (or possibly still) non-terminal gets another sweep — a guard-skipped action
		// means the run changed under us, and a full scan window means there may be more rows.
		if (rows.length - appliedCount > 0) {
			await host.ensureReconciliationSchedule(organizationId);
		}
	} catch (error) {
		console.warn(
			"[kernel] reconciliation sweep failed",
			kernelErrorMessage(error),
		);
	}
}

/**
 * Stale-submission safety net (durable-submission recovery). A kernel run can
 * terminalize while its `runtime_submissions` row is left `running` — every
 * `settleKernelSubmission` call is fail-soft, so a settle can be missed, and an
 * already-terminal run is not in this sweep's non-terminal run scan, so nothing
 * else catches the orphaned submission (it sits `running` forever, corrupting
 * the exactly-once accounting + the resume receipt's `closed` signal). This
 * lists the org's stale `running` submissions, re-reads each kernel submission's
 * canonical D1 run status, and settles it exactly-once only when the run is
 * already terminal — `kernelRunStatusToSubmissionOutcome` returns null for a
 * non-terminal/in-flight run, so live work is never settled or raced, and
 * `settleKernelSubmission` is itself exactly-once (a concurrent settle is a
 * no-op). Fail-soft. Scope: all three subjects, each via its canonical D1 truth
 * (no external poll) —
 *  - kernel: the kernel run row status;
 *  - tedi (`tedi_message`): the tedi runtime-event ledger — settle on a terminal
 *    event, or terminalize a crashed run (no terminal event, silent past
 *    {@link TEDI_CRASH_LEASE_MS}); the run's own event stream is the liveness
 *    signal, so a live (merely slow) turn is never terminalized;
 *  - tedi (`skill_workflow`): `skill_runs.status`, which the skill-runtime's own
 *    reconciler cron pushes to terminal independent of any client poll.
 */
async function reconcileStaleSubmissions(
	host: RunReconcileHost,
	context: BaseContext,
	organizationId: string,
): Promise<void> {
	try {
		const submissionBridge = await loadRuntimeSubmissionBridge();
		const nowMs = Date.now();
		const olderThanIso = new Date(
			nowMs - STALE_SUBMISSION_RECONCILE_THRESHOLD_MS,
		).toISOString();
		const stale = await (
			await import("@tedix/db/queries/runtime-submissions/read-models")
		).listStaleRunningSubmissions(
			context.db,
			organizationId,
			olderThanIso,
			STALE_SUBMISSION_RECONCILE_LIMIT,
		);
		let reconciled = 0;
		let requeued = 0;
		for (const submission of stale) {
			if (!submission.runId) continue;
			if (submission.subjectKind === "kernel") {
				try {
					const runRow = await (
						await import("@tedix/db/queries/kernel-do-storage")
					).getKernelRunForRecovery(context.db, {
						id: submission.runId,
						organizationId,
					});
					if (!runRow) continue; // no run row → orphan; leave for a heartbeat-gated pass
					// Waiting for a free slot on its target is not a crash; the reconcileRuns sweep starts it.
					if (isCapacityDeferredDelegation(runRow)) continue;
					const crashLeaseMs = submissionBridge.kernelCrashLeaseMs({
						kernelRoute: (runRow.metadata as Record<string, unknown> | null)
							?.kernelRoute,
						delegatedTediId: runRow.delegatedTediId,
						childRunId: runRow.childRunId,
						defaultLeaseMs: KERNEL_CRASH_LEASE_MS,
					});
					// Liveness signal: prefer the run's own latest-event timestamp (kept current by insertKernelRuntimeEvent's
					// latestEventAt patch), falling back to the run row's updatedAt, then the submission's updatedAt.
					const lastSignalRaw =
						runRow.latestEventAt ?? runRow.updatedAt ?? submission.updatedAt;
					const lastSignalMs =
						submissionBridge.parseDbTimestampMs(lastSignalRaw);
					const outcome = submissionBridge.decideKernelSubmissionRecovery({
						runStatus: runRow.status,
						abortRequestedAt: submission.abortRequestedAt,
						lastSignalMs,
						nowMs,
						crashLeaseMs,
					});
					if (!outcome) continue;
					const conversationId =
						submission.conversationId ?? runRow.conversationId;
					// Crash terminalization: the run row is still non-terminal (running/queued) but the DO died — patch it to failed
					// so the run row is consistent with the submission settle that follows. For delegation parents, re-check current
					// child evidence before crashing. Fresh activity keeps a waiting parent alive; substantive completion settles the
					// parent completed instead of failing (the firecrawl pattern: child completes at t0, parent crash-fails at t0+18m
					// because the DO was evicted with the run still running). Fail-soft: any error in the re-check falls back to the
					// original crash-fail behavior.
					const isCrashTerminalization =
						submissionBridge.kernelRunStatusToSubmissionOutcome(
							runRow.status,
						) === null;
					if (isCrashTerminalization) {
						const delegatedTediId = runRow.delegatedTediId;
						const childRunId = runRow.childRunId;
						if (
							typeof delegatedTediId === "string" &&
							delegatedTediId.length > 0 &&
							typeof childRunId === "string" &&
							childRunId.length > 0
						) {
							try {
								const childSummary = await (
									await loadKernelChildRunReads()
								).readSingleChildRunSummary(context, {
									organizationId,
									tediId: delegatedTediId,
									runId: childRunId,
								});
								// Native command waits publish real observations without completing the child. Recheck freshness under the same
								// terminal/abort precedence before declaring its parent dead.
								if (
									submissionBridge.decideKernelSubmissionRecovery({
										runStatus: runRow.status,
										abortRequestedAt: submission.abortRequestedAt,
										lastSignalMs,
										nowMs,
										crashLeaseMs,
										childRun: childSummary
											? {
													status: childSummary.childRunStatus,
													latestEventAt: childSummary.childRunLatestEventAt,
												}
											: null,
									}) === null
								)
									continue;
								if (childSummary?.childRunStatus === "completed") {
									// Child completed substantively — settle parent completed.
									const now = new Date().toISOString();
									const existingMetadata = runRow.metadata;
									await (
										await import("@tedix/db/queries/kernel-do-storage")
									).transitionKernelRunForRecovery(context.db, {
										id: submission.runId,
										organizationId,
										expectedStatus: runRow.status,
										patch: {
											status: "completed",
											progressLabel: "Done",
											progressDetail: null,
											completedAt: now,
											updatedAt: now,
											metadata: {
												...existingMetadata,
												...childSummary,
												source: "reconcileStaleSubmissions.crashSelfHeal",
											},
										},
									});
									await submissionBridge.settleKernelSubmission(context.db, {
										runId: submission.runId,
										organizationId,
										conversationId,
										outcome: "settled",
										error: null,
									});
									reconciled += 1;
									continue;
								}
							} catch (selfHealError) {
								console.warn(
									"[kernel] crash self-heal child re-check failed — falling back to crash-fail",
									submission.runId,
									selfHealError instanceof Error
										? selfHealError.message
										: String(selfHealError),
								);
							}
						}
						// Pre-side-effect crash → re-drive instead of sealing failed. The inline kernel routing turn is wrap-or-lose on a
						// deploy/DO eviction; if it crashed before deciding a route and before dispatching a delegation it did nothing
						// externally, so re-running it (bounded by the durable attempt budget) is safe by construction.
						// decideKernelRedrive demands affirmative kernelRoute===null + null delegation columns — anything else, or a
						// spent budget, falls through to the crash-fail below.
						const runMetadata =
							(runRow.metadata as Record<string, unknown> | null) ?? {};
						if (
							submissionBridge.decideKernelRedrive({
								runStatus: runRow.status,
								kernelRoute: (runMetadata.kernelRoute ?? undefined) as
									| string
									| null
									| undefined,
								delegatedTediId,
								childRunId,
								abortRequestedAt: submission.abortRequestedAt,
								attemptCount: submission.attemptCount ?? 0,
								maxRetry: submission.maxRetry ?? 10,
								lastSignalMs,
								nowMs,
								crashLeaseMs,
							}) === "redrive"
						) {
							const stamp = runMetadata.redriveInput;
							if (stamp && typeof stamp === "object") {
								const redriveCount =
									(typeof runMetadata.redriveCount === "number"
										? runMetadata.redriveCount
										: 0) + 1;
								const redriveMetadata = {
									...runMetadata,
									redriveCount,
								};
								// CAS-reset: re-drive only while still non-terminal (a
								// concurrent real completion/route wins the race; 0 rows → skip).
								const reset = await (
									await import("@tedix/db/queries/kernel-do-storage")
								).transitionKernelRunForRecovery(context.db, {
									id: submission.runId,
									organizationId,
									expectedStatus: runRow.status,
									patch: {
										updatedAt: new Date().toISOString(),
										metadata: redriveMetadata,
									},
								});
								if (reset) {
									// Durable attempt bump bounds re-drive across repeated
									// deploys (attemptCount lives in D1, survives DO restarts).
									await (
										await import("@tedix/db/queries/runtime-submissions/attempts")
									).startAttempt(context.db, {
										submissionId: submission.id,
										organizationId,
										recovered: true,
									});
									// Reconstruct the turn input from the stamp + the row's metadata, and re-schedule the planner step (the same
									// alarm path the async planner uses). Leaves the submission running — the re-driven turn settles it on
									// completion.
									const redriveTurnInput = {
										...(stamp as Record<string, unknown>),
										runRowMetadata: redriveMetadata,
									} as unknown as KernelTurnWorkInput;
									await host.schedule(0, "runPlannerStep", redriveTurnInput);
									console.warn(
										`[kernel.sweep] re-drove pre-side-effect crashed kernel run=${submission.runId} attempt=${(submission.attemptCount ?? 0) + 1}`,
									);
									reconciled += 1;
									continue;
								}
							}
						}
						// Align the run-row patch with the decided outcome: an abort-driven terminalization (durable operator stamp,
						// outcome "canceled") records the honored intent; anything else is the crash-fail.
						const abortDriven = outcome === "canceled";
						const now = new Date().toISOString();
						const terminalizeReason = abortDriven
							? "operator abort honored at recovery"
							: "runtime crash — kernel DO eviction with no terminal run status before crash-lease expiry";
						await (
							await import("@tedix/db/queries/kernel-do-storage")
						).transitionKernelRunForRecovery(context.db, {
							id: submission.runId,
							organizationId,
							expectedStatus: runRow.status,
							patch: {
								status: abortDriven ? "canceled" : "failed",
								progressLabel: abortDriven ? "Canceled" : "Crashed",
								progressDetail: terminalizeReason,
								completedAt: now,
								updatedAt: now,
							},
						});
					}
					const abortDrivenSettle =
						isCrashTerminalization && outcome === "canceled";
					await submissionBridge.settleKernelSubmission(context.db, {
						runId: submission.runId,
						organizationId,
						conversationId,
						outcome,
						// Abort-driven settles pin the observed attempt (Port 2 fence) so
						// the honored intent is attributed to the attempt that owned it.
						...(abortDrivenSettle
							? { attemptId: submission.currentAttemptId }
							: {}),
						error: isCrashTerminalization
							? abortDrivenSettle
								? "operator abort honored at recovery"
								: "runtime crash — kernel DO eviction with no terminal run status before crash-lease expiry"
							: null,
					});
					reconciled += 1;
				} catch (kernelReconcileError) {
					console.warn(
						"[kernel] submission reconcile error for run",
						submission.runId,
						kernelReconcileError instanceof Error
							? kernelReconcileError.message
							: String(kernelReconcileError),
					);
				}
			} else if (
				submission.subjectKind === "tedi" &&
				submission.sourceKind === "tedi_message" &&
				submission.tediId
			) {
				// Tedi message run: canonical truth is the tedi runtime-event ledger (the choke point that normally settles on a
				// terminal event). Settle from a terminal event if one already exists (a missed fail-soft choke-point settle);
				// otherwise use the run's own event stream as the liveness signal — if it stopped emitting past the crash lease,
				// the turn died, so terminalize it. skill_workflow needs a skill-runtime poll — deferred.
				const terminalEvent = await (
					await import("@tedix/db/queries/kernel-runtime-events")
				)
					.listTediRuntimeEvents(context.db, {
						organizationId,
						tediId: submission.tediId,
						runId: submission.runId,
						kinds: [...TERMINAL_TEDI_RUN_EVENT_KINDS],
						limit: 1,
					})
					.then((rows) => rows[0]?.kind ?? null);
				// Liveness floor: max(latest event timestamp, submission.updatedAt) — the run is alive while either its event
				// stream emits or its submission row advances (a just-requeued row bumps updatedAt while the latest event is still
				// the pre-crash one; without the max it would look stale again on the very next pass and burn the budget).
				let latestEventAt: string | null = null;
				if (!terminalEvent) {
					latestEventAt = await (
						await import("@tedix/db/queries/kernel-runtime-events")
					)
						.listTediRuntimeEvents(context.db, {
							organizationId,
							tediId: submission.tediId,
							runId: submission.runId,
							order: "desc",
							limit: 1,
						})
						.then((rows) => rows[0]?.createdAt ?? null);
				}
				const decision = submissionBridge.decideTediSubmissionRecovery({
					terminalEventKind: terminalEvent,
					// Phase-aware recovery: engage the journal phase + durable retry budget so a provably-pre-provider crash is
					// distinguished from a crashed-mid-execution turn, plus the durable operator abort intent.
					phase: submission.phase,
					inputAppliedAt: submission.inputAppliedAt,
					abortRequestedAt: submission.abortRequestedAt,
					attemptCount: submission.attemptCount ?? 0,
					maxRetry: submission.maxRetry ?? 10,
					lastSignalMs: submissionBridge.submissionLivenessFloorMs(
						latestEventAt,
						submission.updatedAt,
					),
					nowMs,
					crashLeaseMs: TEDI_CRASH_LEASE_MS,
				});
				if (!decision) continue;
				// A "requeue" decision is a provably-pre-provider crash (no side effects) that is safe to re-dispatch in place:
				// append a recovered attempt and re-inject the original input under the same clientRequestId. The executor's
				// terminal branches settle the row themselves; a successful requeue leaves it running.
				if (decision === "requeue") {
					const requeueDeps: TediRequeueDeps = {
						loadTedi: async (tediId) =>
							(await import("@tedix/db/queries/tedis")).getTediById(
								context.db,
								tediId,
							),
						inject: async (injectArgs) => {
							const provConfig = (
								await loadTediHelpers()
							).getProvisioningConfig(injectArgs.tedi, context.env);
							if (!provConfig) {
								return {
									success: false,
									error: "tedi runtime route is not configured",
								};
							}
							const injected = await injectAgentMessage(provConfig, {
								message: injectArgs.message,
								session: injectArgs.session,
								...(injectArgs.attachments?.length
									? { attachments: injectArgs.attachments }
									: {}),
								clientRequestId: injectArgs.clientRequestId,
								...(injectArgs.metadata
									? { metadata: injectArgs.metadata }
									: {}),
								async: true,
							});
							return { success: injected.success, error: injected.error };
						},
					};
					const result = await submissionBridge.requeueTediSubmissionInPlace(
						context.db,
						requeueDeps,
						{
							submission,
							organizationId,
						},
					);
					if (result.requeued) {
						requeued += 1;
						console.warn(
							`[kernel.sweep] requeued pre-input crashed tedi run=${submission.runId} attempt=${(submission.attemptCount ?? 0) + 1}`,
						);
					} else if (
						result.reason !== "lost_latch" &&
						result.reason !== "budget_spent"
					) {
						// Terminal executor branch (aborted / input_missing / tedi_missing / inject_failed) settled the row exactly-once.
						reconciled += 1;
					}
					continue;
				}
				const abortDriven = !terminalEvent && decision === "canceled";
				await submissionBridge.settleTediSubmission(context.db, {
					runId: submission.runId,
					organizationId,
					outcome: decision,
					// Abort-driven settles pin the observed attempt (Port 2 fence).
					...(abortDriven ? { attemptId: submission.currentAttemptId } : {}),
					error: terminalEvent
						? null
						: abortDriven
							? "operator abort honored at recovery"
							: "runtime crash — no terminal run event before crash-lease expiry",
				});
				reconciled += 1;
			} else if (
				submission.subjectKind === "tedi" &&
				submission.sourceKind === "skill_workflow"
			) {
				// Skill workflow: canonical D1 truth is skill_runs.status, which the skill-runtime's own reconciler cron pushes to
				// terminal even with no client poll. The gap is only the submission settle — today it fires solely from the
				// client-driven runWorkflowStatus path, so a completed-but-never-polled workflow leaves its submission running.
				// Settle exactly-once once skill_runs is terminal; otherwise leave (not yet terminal, or the skill-runtime cron
				// hasn't reconciled it yet).
				const skillRun = await (
					await import("@tedix/db/queries/skill-runs")
				).getSkillRun(
					context.db,
					submission.runId,
					organizationId,
					context.env.ENVIRONMENT,
				);
				if (!skillRun) continue;
				// A failed admission marker is a repairable pre-engine state, and an open restart intent is still fencing the prior
				// terminal snapshot. Neither may settle the current submission attempt.
				if (
					skillRun.restartRequestedAt ||
					submissionBridge.isPendingSkillWorkflowAdmission(skillRun)
				) {
					continue;
				}
				const outcome = submissionBridge.kernelRunStatusToSubmissionOutcome(
					skillRun.status,
				);
				if (!outcome) continue;
				await submissionBridge.settleTediSubmission(context.db, {
					runId: submission.runId,
					organizationId,
					outcome,
					expectedWorkflowExecutionEpoch: skillRun.executionEpoch ?? 0,
				});
				reconciled += 1;
			}
		}

		// ── Reserved-latch sweep ────────────────────────────────────────────
		// Step A of the two-step settle (reserve CAS) can win while Step B
		// (finalize) never commits — the DO is evicted between the two steps.
		// The row sits `reserved` with `metadata.reservedOutcome` recording the
		// intended terminal status. Re-drive Step B for any reserved row older
		// than RESERVED_LATCH_SWEEP_MS; `settleSubmission` internally handles
		// the re-drive path (CAS on `status='reserved'`), so this is exactly-once.
		const reservedOlderThan = new Date(
			nowMs - RESERVED_LATCH_SWEEP_MS,
		).toISOString();
		let reservedSwept = 0;
		try {
			const reservedRows = await (
				await import("@tedix/db/queries/runtime-submissions/read-models")
			).listPendingReservedSubmissions(
				context.db,
				organizationId,
				reservedOlderThan,
				STALE_SUBMISSION_RECONCILE_LIMIT,
			);
			for (const row of reservedRows) {
				if (!row.runId) continue;
				// Read the intended outcome from the metadata stamp written by Step A. Fall back to "failed" for a reserved row
				// that has no recorded outcome (corrupt latch — fail-closed).
				const reservedOutcome = (row.metadata as Record<string, unknown> | null)
					?.reservedOutcome;
				const outcome: import("@tedix/db/queries/runtime-submissions/settlement").SubmissionSettleOutcome =
					reservedOutcome === "settled" ||
					reservedOutcome === "failed" ||
					reservedOutcome === "canceled"
						? (reservedOutcome as import("@tedix/db/queries/runtime-submissions/settlement").SubmissionSettleOutcome)
						: "failed";
				try {
					if (row.subjectKind === "kernel") {
						const conversationId =
							row.conversationId ??
							(
								await (
									await import("@tedix/db/queries/kernel-do-storage")
								).getKernelRunForRecovery(context.db, {
									id: row.runId,
									organizationId,
								})
							)?.conversationId;
						await submissionBridge.settleKernelSubmission(context.db, {
							runId: row.runId,
							organizationId,
							conversationId: conversationId ?? "",
							outcome,
							error:
								outcome === "failed"
									? "reserved latch sweep — finalize step never committed"
									: null,
						});
					} else {
						// tedi subject (tedi_message or skill_workflow)
						await submissionBridge.settleTediSubmission(context.db, {
							runId: row.runId,
							organizationId,
							outcome,
							error:
								outcome === "failed"
									? "reserved latch sweep — finalize step never committed"
									: null,
						});
					}
					reservedSwept += 1;
				} catch (rowError) {
					console.warn(
						"[kernel] reserved-latch sweep error for run",
						row.runId,
						rowError instanceof Error ? rowError.message : String(rowError),
					);
				}
			}
		} catch (reservedSweepError) {
			console.warn(
				"[kernel] reserved-latch sweep failed",
				kernelErrorMessage(reservedSweepError),
			);
		}

		// Visibility into the self-heal: how many orphaned submissions this pass
		// reconciled (and how many stale rows it scanned). Silent on a no-op pass.
		if (reconciled > 0 || requeued > 0 || reservedSwept > 0) {
			console.log(
				JSON.stringify({
					service: "kernel",
					event: "stale_submission_reconcile",
					organizationId,
					reconciled,
					requeued,
					scanned: stale.length,
					reservedSwept,
				}),
			);
		}
	} catch (error) {
		console.warn(
			"[kernel] stale-submission reconcile failed",
			kernelErrorMessage(error),
		);
	}
}

/**
 * Apply one ledger action with the same status-guarded conditional-update pattern as the turn-work completion patch
 * (`WHERE id = ? AND status = expected`): a concurrent legitimate transition (operator cancel, approval resolution,
 * turn completion) wins and the action becomes a no-op. On a successful patch, writes the matching
 * `run.failed`/`run.canceled` transcript event via the same drizzle insert pattern kernel-runtime's (non-exported)
 * `insertKernelRuntimeEvent` uses — deterministic id + `onConflictDoNothing`, so a retried sweep can never duplicate
 * it. The event is advisory: the run patch (with its `kernelReconciliation` idempotency marker) is the durable source
 * of truth.
 */
/**
 * Delegation-parent reconcile backstop (run-level analog of reconcileStaleSubmissions). planRunReconciliation
 * deliberately skips delegation parents — they belong to the event-driven reconcileChildStatus — but that propagation
 * is fail-soft and can miss, stranding a parent non-terminal forever after its child died (a Home turn stuck "running"
 * on a failed delegation). This re-reads each non-terminal delegation parent's child outcome
 * (readTerminalChildOutcomesForParents resolves the container child-run id mapping) and, only when the child provably
 * failed/canceled, terminalizes the parent to match via the same status-guarded applyLedgerAction (which also settles
 * the parent submission and emits run.*). A child that completed or is still live is left untouched, so a live (merely
 * slow) delegation is never killed. Fail-soft.
 */
async function reconcileStaleDelegationParents(
	host: RunReconcileHost,
	context: BaseContext,
	organizationId: string,
	rows: KernelRuntimeRun[],
): Promise<void> {
	try {
		const parents = rows.filter((row) => row.childRunId && row.delegatedTediId);
		if (parents.length === 0) return;
		const childOutcomes = await (
			await loadKernelHomePlan()
		).readTerminalChildOutcomesForParents(context, parents);
		if (childOutcomes.size === 0) return;
		for (const parent of parents) {
			const outcome = childOutcomes.get(parent.id);
			if (!outcome) continue; // child completed / still live → leave
			await applyLedgerAction(host, context, organizationId, {
				kind: "propagate_child_failure",
				runId: parent.id,
				conversationId: parent.conversationId,
				expectedStatus: parent.status as
					| "queued"
					| "running"
					| "requires_approval",
				patchStatus: outcome,
				eventKind: outcome === "failed" ? "run.failed" : "run.canceled",
				progressLabel:
					outcome === "failed" ? "Delegation failed" : "Delegation canceled",
				reason: `delegated child run ${outcome}`,
				operatorMessage: `The delegated run this turn was waiting on ${outcome}, so the kernel closed this run to match — nothing further will execute. Re-send the request to retry.`,
				approvalRequestId: null,
			});
		}
	} catch (error) {
		console.warn(
			"[kernel] delegation-parent reconcile failed",
			kernelErrorMessage(error),
		);
	}
}

/**
 * Success backstop for the parent←child relay. The inbox-wake alarm (`reconcileInboxWakeRuns`) is the fast path that
 * relays a completed child's result back to its Home conversation via `recordHomeDelegationCompletionMessage` (the
 * single authoritative disposition writer). That wake is a one-shot push; if it drops (alarm-context teardown — the
 * documented alarm-drop class) the completed child is stranded with no Home follow-up, while
 * `reconcileStaleDelegationParents` only handles failure. This re-drives the same authoritative relay for every
 * non-terminal delegation parent, so a dropped success-wake self-heals on the next sweep — converting a best-effort
 * push into eventually-exactly-once. Idempotent: already-terminal parents and already-relayed children are no-ops
 * (`reconcileInboxWakeRuns` excludes rows terminal before the call, and the completion message dedups on
 * `asyncCompletionAssistantMessageId`). No new writer, no new table.
 */
async function reconcileUnrelayedDelegations(
	host: RunReconcileHost,
	context: BaseContext,
	organizationId: string,
	rows: KernelRuntimeRun[],
): Promise<void> {
	try {
		const terminal = new Set(["completed", "failed", "canceled"]);
		const childRunIds = rows
			.filter(
				(row) =>
					Boolean(row.childRunId) &&
					Boolean(row.delegatedTediId) &&
					!terminal.has(row.status),
			)
			.map((row) => row.childRunId as string);
		if (childRunIds.length === 0) return;
		await (
			await loadKernelRunReads()
		).reconcileInboxWakeRuns(context, {
			organizationId,
			childRunIds,
		});
	} catch (error) {
		console.warn(
			"[kernel] unrelayed-delegation reconcile failed",
			kernelErrorMessage(error),
		);
	}
}

async function applyLedgerAction(
	host: RunReconcileHost,
	context: BaseContext,
	organizationId: string,
	action: LedgerAction,
): Promise<boolean> {
	try {
		const submissionBridge = await loadRuntimeSubmissionBridge();
		const existing = await (
			await import("@tedix/db/queries/kernel-do-storage")
		).getKernelRunForRecovery(context.db, {
			id: action.runId,
			organizationId,
		});
		if (!existing || existing.status !== action.expectedStatus) return false;
		const now = new Date().toISOString();
		const patched = await (
			await import("@tedix/db/queries/kernel-do-storage")
		).transitionKernelRunForRecovery(context.db, {
			id: action.runId,
			organizationId,
			expectedStatus: action.expectedStatus,
			patch: {
				status: action.patchStatus,
				progressLabel: action.progressLabel,
				progressDetail: action.reason,
				completedAt: now,
				updatedAt: now,
				metadata: {
					...existing.metadata,
					[KERNEL_RECONCILIATION_METADATA_KEY]: {
						action: action.kind,
						reason: action.reason,
						at: now,
					},
				},
			},
		});
		if (!patched) return false;

		// Durable submission ledger: settle the submission for a reconciled (terminalized) run, exactly-once.
		const reconcileOutcome =
			submissionBridge.kernelRunStatusToSubmissionOutcome(action.patchStatus);
		if (reconcileOutcome) {
			await submissionBridge.settleKernelSubmission(context.db, {
				runId: action.runId,
				organizationId,
				conversationId: action.conversationId,
				outcome: reconcileOutcome,
				error: action.reason,
			});
		}

		try {
			await (
				await import("@tedix/db/queries/kernel-runtime-events")
			).insertKernelRuntimeEventIfAbsent(context.db, {
				// Deterministic id (insertKernelRuntimeEvent's shape with a fixed
				// "reconciliation" discriminator): one event per reconciled run.
				id: [
					"home",
					organizationId,
					"event",
					action.eventKind,
					action.conversationId,
					action.runId,
					"reconciliation",
				].join(":"),
				organizationId,
				kind: action.eventKind,
				conversationId: action.conversationId,
				runId: action.runId,
				payload: {
					status: action.patchStatus,
					error: action.reason,
					message: action.operatorMessage,
					...(action.approvalRequestId
						? { approvalRequestId: action.approvalRequestId }
						: {}),
				},
				runtimeBackend: KERNEL_RUNTIME_BACKEND,
				runtimeExternalId: action.runId,
				runtimeMetadata: {
					source: "kernel.reconcileRuns",
					reconciliation: { action: action.kind, at: now },
				},
				createdAt: now,
			});
		} catch (error) {
			console.warn(
				"[kernel] reconciliation event insert failed",
				action.runId,
				kernelErrorMessage(error),
			);
		}
		console.warn(
			"[kernel] reconciled run",
			action.runId,
			action.kind,
			action.reason,
		);
		return true;
	} catch (error) {
		console.warn(
			"[kernel] reconciliation action failed",
			action.runId,
			kernelErrorMessage(error),
		);
		return false;
	}
}
