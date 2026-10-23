import {
	humanReservedActionClasses,
	parseRuntimeApprovalTimestamp,
	resolveRuntimeApprovalTimeout,
} from "@tedix/api-contract/utils/approval-policy";
import { isCapacityDeferredDelegation } from "./delegation-deferral";

/**
 * Deterministic progress-ledger reconciliation for kernel runs — the
 * "run-reconciliation / progress-ledger" pass of a bounded-agency orchestrator
 * (Magentic-One's five questions per step).
 * v1 answers all five questions WITHOUT an LLM (the closed-pass-list doctrine
 * allows a planned LLM pass later; this module must stay deterministic):
 *
 *   1. complete?         Terminal statuses (completed/failed/canceled) → no
 *                        action.
 *   2. forward progress? `running` runs whose `updatedAt` is older than
 *                        {@link STALL_RUNNING_MS} (and `queued` older than
 *                        {@link STALL_QUEUED_MS}) with no delegation →
 *                        `mark_stalled` (patch to `failed`).
 *   3. looping?          v1 proxy: a run already carrying the
 *                        {@link KERNEL_RECONCILIATION_METADATA_KEY} marker is
 *                        never re-processed (idempotency guard).
 *   4. waiting on whom?  `requires_approval` runs whose approval row is
 *                        expired (`tedi_approval_requests.expires_at` in the
 *                        past while still `pending`, or already patched to
 *                        `expired` by `expireStaleApprovals`) → `mark_expired`
 *                        (patch to `canceled`). A held Home delegation (no
 *                        approval row) expires the same way once its review
 *                        window passes, a newer identical request is waiting,
 *                        or its human-reserved hold reason no longer matches.
 *                        Nothing is ever approved here.
 *   5. which executor / what instruction? OUT OF SCOPE for v1. Runs with a
 *                        `childRunId` are delegated work — the existing
 *                        child-run reconciliation in `kernelRuntime.readRunSet`
 *                        owns their lifecycle, so this planner explicitly
 *                        skips every run with a `childRunId` (and, extra
 *                        conservatively, any run with `delegatedTediId` or
 *                        delegation metadata) rather than duplicating it.
 *
 * Conservative defaults throughout: when in doubt, NO action — a wrongly
 * killed run is worse than a lingering one. Unparseable timestamps, missing
 * approval rows, resolved-but-unsettled approvals, and unknown statuses all
 * produce no action.
 *
 * Pure module on purpose (like kernel-state.ts): no agents-SDK /
 * `cloudflare:workers` imports, so the decision table is unit-testable under
 * plain vitest. `KernelDO.reconcileRuns` loads the rows, runs
 * {@link planRunReconciliation}, and applies each action with a
 * status-guarded conditional UPDATE (a concurrent legitimate patch wins).
 */

/** `running` runs with no `updatedAt` advance for this long are stalled. */
export const STALL_RUNNING_MS = 15 * 60 * 1000;
/** `queued` runs (non-delegated) older than this are stalled. */
export const STALL_QUEUED_MS = 30 * 60 * 1000;
/** Hard cap on actions per sweep — a bad clock or mass stall reconciles incrementally. */
export const MAX_LEDGER_ACTIONS_PER_SWEEP = 10;
/** Max non-terminal rows one sweep loads from D1. */
export const MAX_RECONCILIATION_SCAN_RUNS = 100;
/** Run-metadata key marking a reconciled run (idempotency / looping guard). */
export const KERNEL_RECONCILIATION_METADATA_KEY = "kernelReconciliation";
/** Statuses a sweep considers (mirrors `isActiveHomeRunStatus` in kernel-runtime.ts). */
export const NON_TERMINAL_KERNEL_RUN_STATUSES = [
	"queued",
	"running",
	"requires_approval",
] as const;

/** Compact projection of one `kernel_runtime_runs` row (keep this minimal). */
export interface LedgerRunRow {
	id: string;
	conversationId: string;
	status: string;
	createdAt: string | null;
	updatedAt: string | null;
	childRunId: string | null;
	delegatedTediId: string | null;
	metadata: Record<string, unknown> | null;
}

/** Compact projection of one `tedi_approval_requests` row (read-only). */
export interface LedgerApprovalRow {
	id: string;
	status: string;
	expiresAt: string | null;
}

export interface LedgerAction {
	kind: "mark_stalled" | "mark_expired" | "propagate_child_failure";
	runId: string;
	conversationId: string;
	/** Conditional-update guard: only apply while the run still has this status. */
	expectedStatus: "queued" | "running" | "requires_approval";
	patchStatus: "failed" | "canceled";
	eventKind: "run.failed" | "run.canceled";
	progressLabel: string;
	/** Compact machine-ish reason (metadata + progressDetail + warn log). */
	reason: string;
	/** Operator-facing transcript/preview message. */
	operatorMessage: string;
	/** The expired approval that gated the run (mark_expired only). */
	approvalRequestId: string | null;
}

/**
 * The terminal outcome to propagate to a delegation PARENT from its CHILD run's
 * summarized status. Only a child that FAILED or was CANCELED propagates (the
 * parent's delegation died, unambiguously); a child that COMPLETED is the happy
 * path the event-driven reconcileChildStatus owns (auto-completing a multi-step
 * parent could be wrong), and a non-terminal child is still live → null.
 */
export function terminalChildOutcomeFromStatus(
	childStatus: unknown,
): "failed" | "canceled" | null {
	return childStatus === "failed" || childStatus === "canceled"
		? childStatus
		: null;
}

/**
 * Parse a run/approval timestamp to epoch ms. Accepts both the ISO strings
 * app code writes and D1's `CURRENT_TIMESTAMP` format
 * (`YYYY-MM-DD HH:MM:SS`, which is UTC but zone-less — normalized here so
 * the result does not depend on the host timezone). Returns null when
 * unparseable (callers must treat null as "no action").
 */
export function parseLedgerTimestamp(
	value: string | null | undefined,
): number | null {
	return parseRuntimeApprovalTimestamp(value);
}

function minutesLabel(thresholdMs: number): string {
	return `${Math.round(thresholdMs / 60000)} minutes`;
}

function hasReconciliationMarker(metadata: Record<string, unknown>): boolean {
	const marker = metadata[KERNEL_RECONCILIATION_METADATA_KEY];
	return marker !== undefined && marker !== null;
}

function hasDelegationMetadata(metadata: Record<string, unknown>): boolean {
	return (
		(metadata.delegationWorkOrder !== undefined &&
			metadata.delegationWorkOrder !== null) ||
		(metadata.homePlan !== undefined && metadata.homePlan !== null) ||
		(typeof metadata.delegatedTediId === "string" &&
			metadata.delegatedTediId.length > 0)
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

interface HeldHomeDelegation {
	workOrder: Record<string, unknown>;
	decision: Record<string, unknown>;
	stampedExpiresAt: string | null;
}

/**
 * A Home run parked on an operator delegation card: `requires_approval`, a
 * `needs_approval` verdict, no child run yet and no runtime approval row (a
 * row-backed approval expires through `tedi_approval_requests`).
 */
function heldHomeDelegation(
	run: Pick<LedgerRunRow, "status" | "childRunId" | "metadata">,
): HeldHomeDelegation | null {
	if (run.status !== "requires_approval" || run.childRunId) return null;
	const metadata = run.metadata ?? {};
	if (nonEmptyString(metadata.approvalRequestId)) return null;
	const delegation = asRecord(metadata.homeDelegation);
	const workOrder = asRecord(delegation?.workOrder);
	const decision = asRecord(delegation?.decision);
	if (!delegation || !workOrder || decision?.mode !== "needs_approval")
		return null;
	return {
		workOrder,
		decision,
		stampedExpiresAt: nonEmptyString(delegation.expiresAt),
	};
}

/**
 * When a held Home delegation's approval lapses: the expiry stamped when Home
 * parked it, else creation plus the organization's approval TTL. Null when
 * neither is known (no action).
 */
export function homeDelegationApprovalExpiresAt(
	run: Pick<LedgerRunRow, "createdAt" | "metadata">,
	approvalTtlHours: number | undefined,
): string | null {
	const delegation = asRecord(run.metadata?.homeDelegation);
	const stamped = nonEmptyString(delegation?.expiresAt);
	if (stamped && parseLedgerTimestamp(stamped) !== null) return stamped;
	const createdAt = parseLedgerTimestamp(run.createdAt);
	if (createdAt === null || approvalTtlHours === undefined) return null;
	return new Date(createdAt + approvalTtlHours * 3_600_000).toISOString();
}

/** Identity of the requested action: the target plus the operator's request text. */
function delegationRequestKey(workOrder: Record<string, unknown>): string {
	const target =
		nonEmptyString(workOrder.targetTediId) ??
		nonEmptyString(workOrder.targetTediLabel) ??
		"?";
	const request = (
		nonEmptyString(workOrder.sourceContent) ??
		nonEmptyString(workOrder.objective) ??
		""
	)
		.replace(/\[\[tedix-context:[^\]]*\]\]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return `${target}\u0000${request}`;
}

function isNewerRun(
	a: Pick<LedgerRunRow, "id" | "createdAt">,
	b: Pick<LedgerRunRow, "id" | "createdAt">,
): boolean {
	const aAt = parseLedgerTimestamp(a.createdAt) ?? 0;
	const bAt = parseLedgerTimestamp(b.createdAt) ?? 0;
	return aAt > bAt || (aAt === bAt && a.id > b.id);
}

/**
 * Why a held Home delegation's approval should expire now, or null. Three
 * objective reasons, never an approval: a newer identical request is waiting,
 * the human-reserved class that held it no longer matches the request under
 * the current classifier, or its review window has passed.
 */
function heldHomeDelegationExpiry(
	run: LedgerRunRow,
	input: {
		runs: readonly LedgerRunRow[];
		now: number;
		approvalTtlHours?: number;
	},
): { reason: string } | null {
	const held = heldHomeDelegation(run);
	if (!held) return null;
	const key = delegationRequestKey(held.workOrder);
	const newer = input.runs.find((other) => {
		if (other.id === run.id || !isNewerRun(other, run)) return false;
		const otherHeld = heldHomeDelegation(other);
		return (
			otherHeld !== null && delegationRequestKey(otherHeld.workOrder) === key
		);
	});
	if (newer) {
		return {
			reason: `a newer identical request is waiting for approval (run ${newer.id})`,
		};
	}
	const holdReason = nonEmptyString(held.decision.reason);
	const reservedHold = holdReason?.match(/^human-reserved:\s*(.+)$/);
	const request =
		nonEmptyString(held.workOrder.sourceContent) ??
		nonEmptyString(held.workOrder.objective);
	if (
		reservedHold &&
		request &&
		humanReservedActionClasses(request).length === 0
	) {
		return {
			reason: `the hold reason (${reservedHold[1]}) no longer applies under the current approval policy`,
		};
	}
	const expiresAt = parseLedgerTimestamp(
		homeDelegationApprovalExpiresAt(run, input.approvalTtlHours),
	);
	if (expiresAt !== null && expiresAt <= input.now) {
		return {
			reason: `no decision before it expired at ${new Date(expiresAt).toISOString()}`,
		};
	}
	return null;
}

function approvalIsExpired(approval: LedgerApprovalRow, now: number): boolean {
	return resolveRuntimeApprovalTimeout({
		status: approval.status,
		expiresAt: approval.expiresAt,
		now,
	}).expired;
}

/**
 * Answer the five questions for a batch of non-terminal run rows and return
 * the reconciliation actions, oldest-first, capped at
 * {@link MAX_LEDGER_ACTIONS_PER_SWEEP}. Deterministic and side-effect free.
 */
export function planRunReconciliation(input: {
	runs: LedgerRunRow[];
	/** `tedi_approval_requests` rows keyed by id (read-only projection). */
	approvals: ReadonlyMap<string, LedgerApprovalRow>;
	/** Epoch ms "now" — injected for determinism. */
	now: number;
	/**
	 * The organization's approval TTL in hours (`approvalTtlHours`). Held Home
	 * delegations without a stamped expiry expire this long after creation.
	 * Absent: such rows expire only for a duplicate or a lapsed hold reason.
	 */
	approvalTtlHours?: number;
}): LedgerAction[] {
	const candidates: Array<{ ageRef: number; action: LedgerAction }> = [];

	for (const run of input.runs) {
		// 1. complete? Terminal (or unknown) statuses get no action.
		if (
			!(NON_TERMINAL_KERNEL_RUN_STATUSES as readonly string[]).includes(
				run.status,
			)
		) {
			continue;
		}
		const metadata = run.metadata ?? {};
		// 3. looping? Already reconciled once → never re-process.
		if (hasReconciliationMarker(metadata)) continue;
		// 5. which executor? Delegated runs belong to child-run reconciliation.
		if (run.childRunId) continue;
		if (run.delegatedTediId) continue;

		if (run.status === "running" || run.status === "queued") {
			// 2. forward progress? Only when the staleness is provable.
			if (
				run.status === "queued" &&
				(hasDelegationMetadata(metadata) || isCapacityDeferredDelegation(run))
			) {
				continue;
			}
			const updatedAt = parseLedgerTimestamp(run.updatedAt);
			if (updatedAt === null) continue; // when in doubt, no action
			const threshold =
				run.status === "running" ? STALL_RUNNING_MS : STALL_QUEUED_MS;
			if (input.now - updatedAt < threshold) continue;
			const reason = `no forward progress for over ${minutesLabel(threshold)} (status: ${run.status})`;
			candidates.push({
				ageRef: updatedAt,
				action: {
					kind: "mark_stalled",
					runId: run.id,
					conversationId: run.conversationId,
					expectedStatus: run.status,
					patchStatus: "failed",
					eventKind: "run.failed",
					progressLabel: "Stalled",
					reason,
					operatorMessage: `This run stalled — ${reason} — and was closed by the kernel's reconciliation pass. Nothing further will execute; re-send the request to retry.`,
					approvalRequestId: null,
				},
			});
			continue;
		}

		// run.status === "requires_approval"
		// 4. waiting on whom? Only act when the gating approval provably expired.
		const heldDelegationExpiry = heldHomeDelegationExpiry(run, input);
		if (heldDelegationExpiry) {
			candidates.push({
				ageRef: parseLedgerTimestamp(run.updatedAt) ?? 0,
				action: {
					kind: "mark_expired",
					runId: run.id,
					conversationId: run.conversationId,
					expectedStatus: "requires_approval",
					patchStatus: "canceled",
					eventKind: "run.canceled",
					progressLabel: "Approval expired",
					reason: heldDelegationExpiry.reason,
					operatorMessage: `This delegation approval expired without a decision: ${heldDelegationExpiry.reason}. Nothing was dispatched. Send the request again if it is still needed.`,
					approvalRequestId: null,
				},
			});
			continue;
		}
		const approvalRequestId =
			typeof metadata.approvalRequestId === "string" &&
			metadata.approvalRequestId.length > 0
				? metadata.approvalRequestId
				: null;
		if (!approvalRequestId) continue;
		const approval = input.approvals.get(approvalRequestId);
		if (!approval) continue; // missing row → cannot prove expiry → no action
		if (!approvalIsExpired(approval, input.now)) continue;
		candidates.push({
			ageRef: parseLedgerTimestamp(run.updatedAt) ?? 0,
			action: {
				kind: "mark_expired",
				runId: run.id,
				conversationId: run.conversationId,
				expectedStatus: "requires_approval",
				patchStatus: "canceled",
				eventKind: "run.canceled",
				progressLabel: "Approval expired",
				reason: "approval expired",
				operatorMessage: `The approval request gating this run expired before anyone resolved it, so the run was canceled — nothing was executed. Re-send the request to propose it again.`,
				approvalRequestId,
			},
		});
	}

	// Oldest first (longest-stuck reconciles before the cap bites), with a
	// stable id tiebreaker so the plan is fully deterministic.
	candidates.sort(
		(a, b) =>
			a.ageRef - b.ageRef || a.action.runId.localeCompare(b.action.runId),
	);
	return candidates
		.slice(0, MAX_LEDGER_ACTIONS_PER_SWEEP)
		.map((candidate) => candidate.action);
}
