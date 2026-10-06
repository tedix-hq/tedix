/**
 * Kernel ↔ runtime-submission bridge.
 *
 * Threads the durable submission ledger (`@tedix/db` runtime-submissions) into
 * the kernel Home turn lifecycle: a submission is admitted + a first attempt
 * opened when a kernel run row is created, and settled exactly-once when the run
 * reaches a terminal status — via turn-work completion or kernel-do
 * reconciliation. Both settle sites are idempotent (the submission's own
 * conditional-update guard), mirroring the run-row `WHERE status="running"`
 * guard. Settlement telemetry remains additive and fail-soft. The execution
 * policy claim is different: it is an authority boundary and deliberately
 * fails closed before any turn effect.
 */

import type { DbClient } from "@tedix/db/client";
import { insertKernelRuntimeEventIfAbsent } from "@tedix/db/queries/kernel-runtime-events";
import { getTediSubmissionInputEvent } from "@tedix/db/queries/runtime-submission-bridge";
import { admitSubmission } from "@tedix/db/queries/runtime-submissions/admission";
import {
	reopenSubmissionForOperatorRestart,
	startAttempt,
} from "@tedix/db/queries/runtime-submissions/attempts";
import { requestSubmissionAbort } from "@tedix/db/queries/runtime-submissions/phase-transitions";
import {
	getSubmissionById,
	type RuntimeSubmission,
} from "@tedix/db/queries/runtime-submissions/read-models";
import {
	type SubmissionSettleOutcome,
	settleSubmission,
} from "@tedix/db/queries/runtime-submissions/settlement";
import type { TediRuntimeBackend } from "@tedix/db/schema";
import type { KernelExecutionPolicy } from "@tedix/api-contract/schemas/kernel-runtime";

/** One submission per kernel run; a deterministic id keeps admit/settle idempotent. */
export function kernelSubmissionId(runId: string): string {
	return `sub:${runId}`;
}

function storedExecutionPolicy(
	submission: RuntimeSubmission,
): KernelExecutionPolicy {
	const metadata = submission.metadata;
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		const policy = (metadata as Record<string, unknown>).executionPolicy;
		if (policy === "normal" || policy === "observe_only") return policy;
		if (policy !== undefined)
			throw new Error("Malformed kernel execution policy claim");
	}
	return "normal";
}

/** Atomic, fail-closed authority claim made before Home performs effects. */
export async function claimKernelExecutionPolicy(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		conversationId: string;
		idempotencyKey?: string | null;
		delegatedTediId?: string | null;
		executionPolicy: KernelExecutionPolicy;
	},
): Promise<RuntimeSubmission> {
	const submission = await admitSubmission(db, {
		id: kernelSubmissionId(args.runId),
		organizationId: args.organizationId,
		subjectKind: "kernel",
		subjectId: `kernel:${args.organizationId}`,
		sourceKind: "home",
		conversationId: args.conversationId,
		runId: args.runId,
		idempotencyKey: args.idempotencyKey ?? args.runId,
		tediId: args.delegatedTediId ?? null,
		metadata: { executionPolicy: args.executionPolicy },
	});
	const matches =
		submission.organizationId === args.organizationId &&
		submission.subjectKind === "kernel" &&
		submission.subjectId === `kernel:${args.organizationId}` &&
		submission.sourceKind === "home" &&
		submission.conversationId === args.conversationId &&
		submission.runId === args.runId &&
		submission.idempotencyKey === (args.idempotencyKey ?? args.runId) &&
		(submission.tediId ?? null) === (args.delegatedTediId ?? null) &&
		storedExecutionPolicy(submission) === args.executionPolicy;
	if (!matches) {
		throw new Error(
			"Kernel submission identity or execution policy conflicts with its immutable claim",
		);
	}
	return submission;
}

export async function assertKernelExecutionPolicyClaim(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		conversationId: string;
		executionPolicy: KernelExecutionPolicy;
	},
): Promise<void> {
	const submission = await getSubmissionById(
		db,
		kernelSubmissionId(args.runId),
		args.organizationId,
	);
	if (
		!submission ||
		submission.organizationId !== args.organizationId ||
		submission.subjectKind !== "kernel" ||
		submission.subjectId !== `kernel:${args.organizationId}` ||
		submission.sourceKind !== "home" ||
		submission.conversationId !== args.conversationId ||
		submission.runId !== args.runId ||
		submission.idempotencyKey !== args.runId ||
		(submission.tediId ?? null) !== null ||
		storedExecutionPolicy(submission) !== args.executionPolicy
	) {
		throw new Error("Kernel execution policy claim is missing or conflicting");
	}
}

/**
 * Map a terminal kernel run status to a submission outcome. Non-terminal
 * statuses (running / queued / requires_approval) return null — the submission
 * stays in-flight until the run actually completes.
 */
export function kernelRunStatusToSubmissionOutcome(
	status: string,
): SubmissionSettleOutcome | null {
	if (status === "completed") return "settled";
	if (status === "failed") return "failed";
	if (status === "canceled") return "canceled";
	return null;
}

function submissionEventId(
	organizationId: string,
	kind: string,
	conversationId: string,
	runId: string,
): string {
	return [
		"home",
		organizationId,
		"event",
		kind,
		conversationId,
		runId,
		"submission",
	].join(":");
}

/**
 * Admit a submission + open its first attempt for a freshly created kernel run.
 * Idempotent: a re-sent run (same runId) returns the existing submission and
 * does not bump the attempt counter.
 */
export async function recordKernelSubmissionStarted(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		conversationId: string;
		idempotencyKey?: string | null;
		delegatedTediId?: string | null;
		createdAt?: string;
	},
): Promise<void> {
	try {
		const submissionId = kernelSubmissionId(args.runId);
		const submission = await admitSubmission(db, {
			id: submissionId,
			organizationId: args.organizationId,
			subjectKind: "kernel",
			subjectId: `kernel:${args.organizationId}`,
			sourceKind: "home",
			conversationId: args.conversationId,
			runId: args.runId,
			idempotencyKey: args.idempotencyKey ?? args.runId,
			tediId: args.delegatedTediId ?? null,
		});
		// Open the first attempt only on the initial admit. A re-sent run returns
		// the existing submission (already running, attemptCount ≥ 1) → skip.
		if (submission.attemptCount === 0 && submission.status === "admitted") {
			await startAttempt(db, {
				submissionId,
				organizationId: args.organizationId,
			});
		}
		await insertKernelRuntimeEventIfAbsent(db, {
			id: submissionEventId(
				args.organizationId,
				"submission.admitted",
				args.conversationId,
				args.runId,
			),
			organizationId: args.organizationId,
			kind: "submission.admitted",
			conversationId: args.conversationId,
			runId: args.runId,
			payload: { submissionId },
			runtimeExternalId: args.runId,
			createdAt: args.createdAt ?? new Date().toISOString(),
		});
	} catch (error) {
		console.warn(
			"[kernel] submission admit failed",
			args.runId,
			error instanceof Error ? error.message : String(error),
		);
	}
}

/**
 * Settle a kernel submission exactly-once and emit the terminal ledger event
 * only on the transition that actually settled it.
 */
export async function settleKernelSubmission(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		conversationId: string;
		outcome: SubmissionSettleOutcome;
		/** Optional attempt-ownership fence (see settleSubmission). */
		attemptId?: string | null;
		error?: string | null;
	},
): Promise<void> {
	try {
		const submissionId = kernelSubmissionId(args.runId);
		const result = await settleSubmission(db, {
			submissionId,
			organizationId: args.organizationId,
			outcome: args.outcome,
			...(args.attemptId != null ? { attemptId: args.attemptId } : {}),
			error: args.error ?? null,
		});
		// The deterministic receipt is also a read-repair target: the submission
		// transition can commit while the following event insert fails. A later
		// same-outcome settle must be allowed to retry that idempotent insert, while
		// a conflicting terminal outcome remains inert.
		if (!result.settled && result.submission?.status !== args.outcome) return;
		await insertKernelRuntimeEventIfAbsent(db, {
			id: submissionEventId(
				args.organizationId,
				"submission.settled",
				args.conversationId,
				args.runId,
			),
			organizationId: args.organizationId,
			kind: "submission.settled",
			conversationId: args.conversationId,
			runId: args.runId,
			payload: { submissionId, outcome: args.outcome },
			runtimeExternalId: args.runId,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		console.warn(
			"[kernel] submission settle failed",
			args.runId,
			error instanceof Error ? error.message : String(error),
		);
	}
}

// =============================================================================
// Tedi subject — same ledger, persisted from the cognitive-runtime event choke
// point (`insertRuntimeEvent`). The tedi runtime reports lifecycle as events
// (no runs table), so admit fires on run.started and settle on a terminal run
// event kind.
// =============================================================================

/** Map a terminal tedi run event kind (not a status) to a submission outcome. */
export function runEventKindToSubmissionOutcome(
	kind: string,
): SubmissionSettleOutcome | null {
	if (kind === "run.completed") return "settled";
	if (kind === "run.failed") return "failed";
	if (kind === "run.canceled") return "canceled";
	return null;
}

/**
 * Normalize a D1 timestamp (`"YYYY-MM-DD HH:MM:SS"`, UTC, no zone) — or an
 * already-ISO value — to epoch ms. Explicit UTC, so the result does not depend on
 * the host timezone. Returns NaN for null/unparseable input.
 */
export function parseDbTimestampMs(value: string | null | undefined): number {
	if (!value) return Number.NaN;
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	return Date.parse(iso);
}

/**
 * Decide recovery for a stale kernel submission left `running` by probing the
 * kernel run's own status and its liveness signal:
 *
 *  - run is already terminal (completed/failed/canceled) → return the settle
 *    outcome (missed fail-soft settle at turn completion);
 *  - run is in an active-execution state (`running` or `queued`) and the last
 *    liveness signal (latest kernel event `createdAt`, falling back to
 *    `submission.updatedAt`) is older than the crash lease → the DO was evicted
 *    mid-turn without a terminal status → return `"failed"`;
 *  - run is in an active-execution state but still within the crash lease →
 *    null (skip; the turn may still be executing — never kill a live/slow turn);
 *  - run is parked (`requires_approval`) → null always (legitimately awaiting
 *    user/operator action; must never be terminalized by the liveness sweep).
 *
 * Delegated waits may outlive the crash lease. A fresh observation from the
 * exact child extends liveness without treating historical running status as
 * proof of execution. The caller's settleKernelSubmission is exactly-once,
 * so a concurrent real terminal settle (turn completion / operator cancel) wins
 * any race.
 */
export function decideKernelSubmissionRecovery(args: {
	runStatus: string;
	/** Durable operator abort intent (submission.abortRequestedAt); null = none. */
	abortRequestedAt?: string | null;
	lastSignalMs: number;
	nowMs: number;
	crashLeaseMs: number;
	/** Freshly read evidence for this parent's exact tenant, tedi and child run. */
	childRun?: { status: unknown; latestEventAt: unknown } | null;
}): SubmissionSettleOutcome | null {
	// Already terminal — settle the stranded submission row, no run-row update needed.
	// Completed work wins over a recorded abort intent.
	const terminalOutcome = kernelRunStatusToSubmissionOutcome(args.runStatus);
	if (terminalOutcome !== null) return terminalOutcome;

	// Durable operator abort intent: honored on any non-terminal
	// status — deliberately before the parked guard (a requires_approval run with
	// an explicit stamp is recorded operator intent, not sweep guesswork) and
	// before the lease (a durable abort must not wait out the crash lease; the
	// sweep's staleness pre-filter is the built-in grace). Precedence:
	// completed-work-wins → abort → budget → timeout.
	if (args.abortRequestedAt != null) return "canceled";

	// Parked: legitimately awaiting user action — never terminalize.
	if (args.runStatus === "requires_approval") return null;

	// A delegated parent can be silent while its child durably waits on a
	// command. Only a recent observation extends liveness; a historical running
	// status (or a timestamp in the future) is not proof the child is still alive.
	const child = args.childRun;
	const childSignalMs = parseDbTimestampMs(
		typeof child?.latestEventAt === "string" ? child.latestEventAt : null,
	);
	if (
		child &&
		["queued", "running", "streaming", "requires_approval"].includes(
			String(child.status),
		) &&
		Number.isFinite(childSignalMs) &&
		childSignalMs <= args.nowMs &&
		childSignalMs >= args.nowMs - args.crashLeaseMs
	)
		return null;

	// Active-execution states (running / queued): apply crash-lease liveness check.
	if (
		(args.runStatus === "running" || args.runStatus === "queued") &&
		Number.isFinite(args.lastSignalMs) &&
		args.lastSignalMs < args.nowMs - args.crashLeaseMs
	) {
		return "failed";
	}

	// Within the lease, or unknown status → leave.
	return null;
}

/**
 * Turn-journal phase for a tedi submission.
 *
 * Advances monotonically server-side from the events the runtime already emits
 * (no new RPC) at the cognitive-runtime event choke point:
 *   admitted ≡ before_provider  → provider_started → tool_request_recorded → committed
 *
 * Recovery keys off this to distinguish a crash before any side effect
 * (`admitted` / null, safe to requeue) from a crash mid-execution
 * (`provider_started`+, tools may have fired, must not requeue).
 *
 * Cross-file DEP: the canonical const + `RuntimeSubmissionPhase` type must be
 * added to packages/db/src/schema/runtime-submissions.ts as
 * `RUNTIME_SUBMISSION_PHASE_VALUES` and the `phase` column added (see the ALTER
 * in the blueprint). This local union mirrors those values so the recovery
 * decision typechecks within this file's slice; collapse to the schema export
 * once that column lands.
 */
export const TEDI_SUBMISSION_PHASE_VALUES = [
	"admitted",
	"provider_started",
	"tool_request_recorded",
	"committed",
] as const;
export type TediSubmissionPhase = (typeof TEDI_SUBMISSION_PHASE_VALUES)[number];

/**
 * Recovery-only decision verb. Settle's `SubmissionSettleOutcome` stays clean
 * (3-valued terminal); recovery additionally may decide `"requeue"` (re-dispatch
 * a turn that crashed before any side effect) or `null` (leave it running).
 */
export type TediRecoveryDecision = SubmissionSettleOutcome | "requeue" | null;

/**
 * Decide phase-aware recovery for a stale `tedi_message` submission left
 * `running`. Replaces the coarse
 * terminal-or-fail binary with a journal-phase × crash-point decision bounded by
 * the durable retry budget.
 *
 * Decision table (in evaluation order):
 *  1. terminal run event exists (any phase) → settle with its outcome — the run
 *     truly finished (a missed fail-soft choke-point settle). Exactly-once via
 *     the reserve→finalize CAS. Completed work wins over a recorded abort.
 *  1b. durable operator abort intent recorded (`abortRequestedAt`) → `"canceled"`
 *     — before the lease (an abort must not wait out the crash lease) and it
 *     blocks requeue. Null on legacy rows keeps today's decisions exactly.
 *  2. still within the crash lease (recent activity) → null = leave; never kill a
 *     live/slow turn.
 *  3. `attemptCount >= maxRetry` (budget spent) → `"failed"` — hard recovery
 *     bound, even for an otherwise-requeue-safe phase. Prevents infinite recovery.
 *  4. crashed before input delivery — positive evidence required: phase is
 *     exactly `"admitted"` (the journal affirmatively says the row was admitted
 *     and never advanced) and `inputAppliedAt == null` — and the lease has
 *     expired → `"requeue"`: no provider/tool side effect can have fired, so
 *     re-dispatch is safe by construction.
 *  5. otherwise (lease expired, but not provably pre-provider) → `"failed"`: the
 *     turn may have run a provider/tool call; re-running could double-execute, so
 *     terminalize, never requeue.
 *
 * Legacy / null-phase safety (load-bearing): a fully-unjournaled row — `phase`
 * null (the column is absent, or the runtime never emitted a phase-advancing
 * event) — carries no proof of the pre-provider state, so it falls through to
 * step 5 = `"failed"`, behaving exactly as today's coarse terminal-or-fail path.
 * Requeue demands affirmative `phase === "admitted"` evidence; absence of data is
 * never read as "safe to requeue". This is why the requeue gate is `=== admitted`
 * (positive) and not `<= admitted` (which would mis-include null/legacy).
 *
 * No double-execution (load-bearing): requeue requires both the affirmative
 * `admitted` phase and `inputAppliedAt == null` — the EARLIEST "input accepted"
 * marker, stamped on the runtime's first `run.started`, which precedes any tool
 * call in emission order. A dropped later event can only make the outcome more
 * conservative (fail where requeue was safe) — never the reverse. The caller's
 * settle remains exactly-once, so a concurrent real terminal settle wins any race.
 */
export function decideTediSubmissionRecovery(args: {
	terminalEventKind: string | null;
	/** Journal phase from the submission row; null on legacy/unknown rows. */
	phase?: TediSubmissionPhase | null;
	/** ISO when the runtime first accepted the input (first run.started); null = never. */
	inputAppliedAt?: string | null;
	/** Durable operator abort intent (submission.abortRequestedAt); null = none. */
	abortRequestedAt?: string | null;
	/** Durable per-logical-turn requeue count (submission.attemptCount). */
	attemptCount?: number;
	/** Durable requeue bound (submission.maxRetry, schema default 10). */
	maxRetry?: number;
	lastSignalMs: number;
	nowMs: number;
	crashLeaseMs: number;
}): TediRecoveryDecision {
	// 1. The run truly finished — settle with the recorded terminal outcome.
	// Completed work wins over a recorded abort intent.
	if (args.terminalEventKind) {
		return runEventKindToSubmissionOutcome(args.terminalEventKind);
	}

	// 1b. Durable operator abort intent — honored before the lease
	// (a durable abort must not wait out the 30-min crash lease; the sweep's
	// staleness pre-filter plus exactly-once settle is the built-in grace) and it
	// blocks requeue below. Null on legacy rows → exactly today's decisions.
	// Precedence: completed-work-wins → abort → budget → timeout.
	if (args.abortRequestedAt != null) return "canceled";

	// 2. Within the lease (or no usable liveness signal) → never kill a live turn.
	const leaseExpired =
		Number.isFinite(args.lastSignalMs) &&
		args.lastSignalMs < args.nowMs - args.crashLeaseMs;
	if (!leaseExpired) return null;

	// 3. Durable retry budget spent → hard fail, even for a requeue-safe phase.
	// `maxRetry` defaults to the schema default (10) when the column is absent on
	// a legacy row; attemptCount defaults to 0. Bounded recovery: a DO restart
	// cannot reset this because attemptCount lives in D1.
	const attemptCount = args.attemptCount ?? 0;
	const maxRetry = args.maxRetry ?? 10;
	if (attemptCount >= maxRetry) return "failed";

	// 4. Crashed before any side effect — positive evidence only. The phase must
	// affirmatively read `admitted` (journal proves admitted-but-never-advanced)
	// and the input was never applied. A null phase (legacy / unjournaled row)
	// proves nothing → it must not requeue; it falls through to step 5.
	const neverAppliedInput = !args.inputAppliedAt;
	const provablyPreProvider = args.phase === "admitted";
	if (neverAppliedInput && provablyPreProvider) return "requeue";

	// 5. Crashed mid-execution, or an unjournaled/legacy row that cannot prove the
	// pre-provider state → fail, never requeue, to avoid double-execution. This is
	// exactly today's coarse path for the null-phase case.
	return "failed";
}

/**
 * Recovery decision for a stale kernel routing run left `running`/`queued` past
 * the crash lease (a deploy evicted the org KernelDO mid-turn; the inline turn is
 * wrap-or-lose — see kernel-do.ts runPlannerStep). The kernel router is a pure
 * route→{delegate | write-propose | direct-read} decision; its committed external
 * side effects are (a) dispatching a child tedi run (delegatedTediId/childRunId
 * become non-null on the run row) and (b) running a write/direct-read tools/call
 * (the route decision itself — metadata.kernelRoute flips from null to the chosen
 * route). So a turn that crashed with no route decided and no delegation dispatched
 * did nothing externally and is safe to re-drive verbatim.
 *
 * Decision table (evaluation order):
 *  1. terminal status → null (caller settles the stranded submission).
 *  2. requires_approval → null (parked; never terminalize or re-drive).
 *  3. not running/queued → null.
 *  4. within the crash lease → null (never kill a live/slow turn).
 *  5. attemptCount >= maxRetry → "failed" (durable budget spent; a turn that
 *     crashes on every deploy still terminalizes after N attempts).
 *  6. Positive pre-side-effect proof — `kernelRoute === null` (the affirmative
 *     persist-first stamp, only flipped when the route decision completes) and
 *     both delegation columns null → "redrive": re-running the route decision has
 *     no external effect (LLM re-plan = cost only).
 *  7. otherwise (route decided / delegation dispatched / no affirmative proof) →
 *     "failed": re-running could double-dispatch a child or re-fire a write call.
 *
 * Affirmative-only (load-bearing, mirrors the tedi requeue gate): `kernelRoute`
 * must read exactly `null` — a metadata that lacks the key (`undefined`, a legacy
 * row) proves nothing and falls through to "failed". Absence of data is never read
 * as "safe to re-drive". The delegation columns are explicit run-row columns whose
 * natural unset value is null, so `== null` there is itself affirmative. The
 * caller's settle is exactly-once, so a concurrent real terminal settle wins any
 * race with a re-drive, and the child-dispatch path is independently idempotent on
 * a deterministic clientRequestId.
 */
export type KernelRecoveryDecision = "redrive" | "failed" | null;

export function decideKernelRedrive(args: {
	runStatus: string;
	/**
	 * `metadata.kernelRoute` from the run row. Exactly `null` is the affirmative
	 * persist-first "route not yet decided" stamp; `undefined`/absent proves
	 * nothing (legacy row) and is treated conservatively.
	 */
	kernelRoute?: string | null;
	/** Run-row column; non-null once a child tedi run was dispatched. */
	delegatedTediId?: string | null;
	/** Run-row column; non-null once a child run id was minted. */
	childRunId?: string | null;
	/** Durable operator abort intent (submission.abortRequestedAt); null = none. */
	abortRequestedAt?: string | null;
	/** Durable per-logical-turn re-drive count (submission.attemptCount). */
	attemptCount?: number;
	/** Durable re-drive bound (submission.maxRetry, schema default 10). */
	maxRetry?: number;
	lastSignalMs: number;
	nowMs: number;
	crashLeaseMs: number;
}): KernelRecoveryDecision {
	// 1. Already terminal → caller settles the stranded submission, no run patch.
	if (kernelRunStatusToSubmissionOutcome(args.runStatus) !== null) return null;
	// 2. Parked, awaiting user action → never terminalize or re-drive.
	if (args.runStatus === "requires_approval") return null;
	// 3. Only active-execution states are recoverable.
	if (args.runStatus !== "running" && args.runStatus !== "queued") return null;
	// 4. Within the lease (or no usable signal) → never kill a live/slow turn.
	const leaseExpired =
		Number.isFinite(args.lastSignalMs) &&
		args.lastSignalMs < args.nowMs - args.crashLeaseMs;
	if (!leaseExpired) return null;
	// 5. Durable re-drive budget spent → hard fail (attemptCount lives in D1, so a
	// DO restart cannot reset it).
	const attemptCount = args.attemptCount ?? 0;
	const maxRetry = args.maxRetry ?? 10;
	if (attemptCount >= maxRetry) return "failed";
	// 5b. Durable operator abort: never re-drive an aborted turn. "failed" here
	// only means do-not-redrive — the outer decider's "canceled" governs the
	// settle outcome and the run-row patch.
	if (args.abortRequestedAt != null) return "failed";
	// 6. Positive pre-side-effect proof: affirmatively un-routed and un-delegated.
	const provablyUnrouted = args.kernelRoute === null;
	const provablyUndelegated =
		args.delegatedTediId == null && args.childRunId == null;
	if (provablyUnrouted && provablyUndelegated) return "redrive";
	// 7. Lease expired but provably-past (or not-provably-pre) a side effect → fail.
	return "failed";
}

/**
 * Admit a submission + open its first attempt for a tedi run (subject = the
 * named tedi). Idempotent on the deterministic `sub:<runId>` id; fail-soft.
 * The `runtime_submissions` row is the record — no `submission.*` events are
 * emitted into the tedi conversation ledger (that surface is transcript, and
 * the kernel-only readRunEvents endpoint does not read tedi events).
 *
 * Recovery-hardening #2: this admit sets neither `maxRetry` (rides the schema
 * default of 10 — `runtime_submissions.max_retry`, cross-file DEP: add the
 * column + ALTER) nor `inputAppliedAt` (by definition post-admit: stamped once,
 * server-side, on the first `run.started` at the cognitive-runtime event choke
 * point — cross-file DEP: `stampInputApplied` + the `input_applied_at` column).
 */
export async function recordTediSubmissionStarted(
	db: DbClient,
	args: {
		tediId: string;
		runId: string;
		organizationId: string;
		conversationId?: string | null;
		runtimeBackend?: TediRuntimeBackend | null;
		restartId?: string;
		executionEpoch?: number;
		/** Defaults to a tedi chat turn; skill dispatch passes "skill_workflow". */
		sourceKind?: "tedi_message" | "skill_workflow";
	},
): Promise<void> {
	try {
		const submissionId = kernelSubmissionId(args.runId);
		// Stamp a 15-minute observer ceiling for tedi subjects. This matches
		// KERNEL_CRASH_LEASE_MS (15 min) and is set once at first admission —
		// idempotent re-admits return the existing row without overwriting timeoutAt.
		// Cross-file dependency: AdmitSubmissionArgs must include `timeoutAt?:
		// string | null` (runtime-submissions/admission.ts) and the
		// D1 ALTER must be applied before this deploy.
		const timeoutAt = new Date(Date.now() + 15 * 60_000).toISOString();
		const submission = await admitSubmission(db, {
			id: submissionId,
			organizationId: args.organizationId,
			subjectKind: "tedi",
			subjectId: args.tediId,
			sourceKind: args.sourceKind ?? "tedi_message",
			tediId: args.tediId,
			conversationId: args.conversationId ?? null,
			runId: args.runId,
			idempotencyKey: args.runId,
			runtimeBackend: args.runtimeBackend ?? null,
			timeoutAt,
			metadata:
				args.restartId && args.executionEpoch != null
					? {
							workflowRestartId: args.restartId,
							workflowExecutionEpoch: args.executionEpoch,
						}
					: null,
		});
		if (submission.attemptCount === 0 && submission.status === "admitted") {
			await startAttempt(db, {
				submissionId,
				organizationId: args.organizationId,
				runtimeBackend: args.runtimeBackend ?? null,
				metadata:
					args.restartId && args.executionEpoch != null
						? {
								kind: "operator_restart_ledger_repair",
								workflowRestartId: args.restartId,
								workflowExecutionEpoch: args.executionEpoch,
							}
						: null,
			});
		}
	} catch (error) {
		console.warn(
			"[tedi] submission admit failed",
			args.runId,
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** Settle a tedi submission exactly-once on a terminal run event. Fail-soft. */
export async function settleTediSubmission(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		outcome: SubmissionSettleOutcome;
		/** Optional attempt-ownership fence (see settleSubmission). */
		attemptId?: string | null;
		error?: string | null;
		/** Optional workflow restart epoch fence (see settleSubmission). */
		expectedWorkflowExecutionEpoch?: number;
	},
): Promise<void> {
	try {
		await settleSubmission(db, {
			submissionId: kernelSubmissionId(args.runId),
			organizationId: args.organizationId,
			outcome: args.outcome,
			...(args.attemptId != null ? { attemptId: args.attemptId } : {}),
			error: args.error ?? null,
			expectedWorkflowExecutionEpoch: args.expectedWorkflowExecutionEpoch,
		});
	} catch (error) {
		console.warn(
			"[tedi] submission settle failed",
			args.runId,
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** A pre-engine workflow admission marker is recoverable, not terminal truth. */
export function isPendingSkillWorkflowAdmission(input: {
	status: string;
	error?: string | null;
}): boolean {
	return (
		input.status === "failed" &&
		(input.error?.startsWith("WORKFLOW_ADMISSION_PENDING:") === true ||
			input.error?.startsWith("WORKFLOW_ADMISSION_CREATE_FAILED:") === true)
	);
}

/**
 * Reopen a terminal skill-workflow submission after Cloudflare confirms a
 * native restart. The previous terminal attempt is preserved and a new attempt
 * is appended under CAS, so run and submission lifecycle truth stay aligned.
 */
export async function restartTediSubmissionAttempt(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		tediId: string;
		restartId: string;
		executionEpoch: number;
		runtimeBackend?: TediRuntimeBackend | null;
	},
): Promise<{ restarted: boolean; alreadyRunning: boolean }> {
	let result = await reopenSubmissionForOperatorRestart(db, {
		submissionId: kernelSubmissionId(args.runId),
		organizationId: args.organizationId,
		restartId: args.restartId,
		executionEpoch: args.executionEpoch,
		runtimeBackend: args.runtimeBackend ?? null,
		runtimeExternalId: args.runId,
		timeoutAt: new Date(Date.now() + 15 * 60_000).toISOString(),
	});
	if (!result.submission) {
		// Legacy/fail-soft admissions may have no ledger row. Repair that gap after
		// the engine accepted the restart so a later status poll can settle it.
		await recordTediSubmissionStarted(db, {
			tediId: args.tediId,
			runId: args.runId,
			organizationId: args.organizationId,
			runtimeBackend: args.runtimeBackend ?? null,
			sourceKind: "skill_workflow",
			restartId: args.restartId,
			executionEpoch: args.executionEpoch,
		});
		const repaired = await getSubmissionById(
			db,
			kernelSubmissionId(args.runId),
			args.organizationId,
		);
		result = {
			reopened: false,
			alreadyRunning:
				repaired?.status === "admitted" || repaired?.status === "running",
			submission: repaired,
			attempt: undefined,
		};
	}
	return {
		restarted: result.reopened,
		alreadyRunning: result.alreadyRunning,
	};
}

/**
 * Liveness floor for the tedi stale-submission sweep: the run is alive while
 * either its event stream emits or its submission row advances. Without the
 * max(), a just-requeued row (bumped `updatedAt`, latest event still the
 * pre-crash `run.started`) would look stale again on the very next pass and
 * burn the durable requeue budget at sweep cadence. NaN inputs are ignored;
 * both missing → NaN (the deciders treat an unusable signal as "leave it").
 */
export function submissionLivenessFloorMs(
	latestEventAt: string | null | undefined,
	submissionUpdatedAt: string | null | undefined,
): number {
	const eventMs = parseDbTimestampMs(latestEventAt);
	const updatedMs = parseDbTimestampMs(submissionUpdatedAt);
	if (Number.isNaN(eventMs)) return updatedMs;
	if (Number.isNaN(updatedMs)) return eventMs;
	return Math.max(eventMs, updatedMs);
}

/**
 * Durably stamp operator abort intent on a run's submission.
 * Fail-soft: a ledger failure never throws into a cancel path — the stamp is
 * additive intent, not the cancel itself.
 */
export async function requestRunAbort(
	db: DbClient,
	args: { runId: string; organizationId: string; reason?: string | null },
): Promise<{ requested: boolean }> {
	try {
		const result = await requestSubmissionAbort(db, {
			submissionId: kernelSubmissionId(args.runId),
			organizationId: args.organizationId,
			reason: args.reason ?? null,
		});
		return { requested: result.requested };
	} catch (error) {
		console.warn(
			"[kernel] submission abort stamp failed",
			args.runId,
			error instanceof Error ? error.message : String(error),
		);
		return { requested: false };
	}
}

/** Attachment shape re-injectable through the tedi runtime inject route. */
export interface TediRequeueMessageAttachment {
	content: string;
	fileName: string;
	mimeType: string;
	type: "audio" | "file" | "image";
}

export interface TediRequeueDeps {
	/** Not org-scoped (getTediById); the executor verifies ownership itself. */
	loadTedi: (
		tediId: string,
	) => Promise<
		{ id: string; organizationId: string; slug: string | null } | undefined
	>;
	inject: (args: {
		tedi: { slug: string | null };
		message: string;
		session: string;
		attachments?: TediRequeueMessageAttachment[];
		clientRequestId: string;
		metadata?: Record<string, unknown>;
	}) => Promise<{ success: boolean; error?: string }>;
}

export type TediRequeueOutcome =
	| "requeued"
	| "lost_latch"
	| "aborted"
	| "budget_spent"
	| "input_missing"
	| "inject_failed"
	| "tedi_missing";

/** Re-injectable attachments from the durable `message.received` payload. */
function requeueAttachmentsFromPayload(
	value: unknown,
): TediRequeueMessageAttachment[] {
	if (!Array.isArray(value)) return [];
	const attachments: TediRequeueMessageAttachment[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (
			typeof record.content !== "string" ||
			typeof record.mimeType !== "string"
		) {
			continue;
		}
		attachments.push({
			content: record.content,
			fileName:
				typeof record.fileName === "string" ? record.fileName : "attachment",
			mimeType: record.mimeType,
			type:
				record.type === "audio" || record.type === "image"
					? record.type
					: "file",
		});
	}
	return attachments;
}

/**
 * In-place crash requeue for a tedi submission that provably crashed before any
 * side effect (the `"requeue"` decision from `decideTediSubmissionRecovery`):
 * append a `recovered` attempt (the CAS latch) and re-inject the original input
 * under the same clientRequestId. The row stays `"running"` — the re-run's own
 * terminal event settles it at the cognitive-runtime choke point.
 *
 * Safety stack (in order):
 *  - abort pre-flight: a durable operator abort beats requeue → settle canceled;
 *  - attempt-insert latch: racing executors compute the same attemptNo, exactly
 *    one insert wins the (submissionId, attemptNo) unique index; the loser
 *    injects nothing;
 *  - same-clientRequestId re-inject: the runtime derives the same deterministic
 *    runId, so its settled/in-flight dedupe makes redelivery at-most-once even
 *    if the crash diagnosis was wrong, and the re-run lands on this
 *    submission's own event chain (no forked transcript);
 *  - terminal branches settle through the exactly-once fence, pinning the
 *    attempt they observed/created so a stale racer cannot mis-attribute.
 *
 * Fail-soft: never throws into the sweep.
 */
export async function requeueTediSubmissionInPlace(
	db: DbClient,
	deps: TediRequeueDeps,
	args: { submission: RuntimeSubmission; organizationId: string },
): Promise<{ requeued: boolean; reason: TediRequeueOutcome }> {
	const { submission } = args;
	const runId = submission.runId ?? "";
	try {
		// Durable operator abort beats requeue (completed → abort → budget → timeout).
		if (submission.abortRequestedAt != null) {
			await settleTediSubmission(db, {
				runId,
				organizationId: args.organizationId,
				outcome: "canceled",
				attemptId: submission.currentAttemptId,
				error: "operator abort honored at recovery",
			});
			return { requeued: false, reason: "aborted" };
		}
		// Durable budget re-check — defense-in-depth: the decision function already
		// gates this; a spent row is left for the next sweep's "failed" decision.
		if ((submission.attemptCount ?? 0) >= (submission.maxRetry ?? 10)) {
			return { requeued: false, reason: "budget_spent" };
		}
		// The re-inject key is the runId's turn key: `{tediId}:mcp:{turnKey}`.
		// Re-injecting it reproduces the same deterministic runId (sanitize is
		// idempotent), so all re-run events land on this same submission.
		const clientRequestId = runId.split(":")[2];
		// The original input is durably persisted in the run's own event chain
		// (`message.received`, written before dispatch acked).
		const inputEvent =
			submission.tediId && clientRequestId
				? await getTediSubmissionInputEvent(db, {
						organizationId: args.organizationId,
						tediId: submission.tediId,
						runId,
					})
				: undefined;
		const payload = (inputEvent?.payload ?? null) as Record<
			string,
			unknown
		> | null;
		const message =
			typeof payload?.content === "string" ? payload.content : null;
		if (!inputEvent || !payload || message === null || !clientRequestId) {
			await settleTediSubmission(db, {
				runId,
				organizationId: args.organizationId,
				outcome: "failed",
				attemptId: submission.currentAttemptId,
				error:
					"requeue input unavailable — no durable message.received for this run",
			});
			return { requeued: false, reason: "input_missing" };
		}
		const tedi = await deps.loadTedi(submission.tediId ?? "");
		// getTediById is not org-scoped — verify ownership explicitly.
		if (!tedi || tedi.organizationId !== args.organizationId) {
			await settleTediSubmission(db, {
				runId,
				organizationId: args.organizationId,
				outcome: "failed",
				attemptId: submission.currentAttemptId,
				error: "requeue target tedi missing or not owned by this organization",
			});
			return { requeued: false, reason: "tedi_missing" };
		}
		// CAS latch: exactly one executor per observed attemptCount appends the
		// recovered attempt; the loser must inject nothing and touch nothing else.
		const { attempt } = await startAttempt(db, {
			submissionId: submission.id,
			organizationId: args.organizationId,
			recovered: true,
			metadata: {
				kind: "crash_requeue",
				requeuedFromAttemptId: submission.currentAttemptId,
				requeuedAt: new Date().toISOString(),
			},
		});
		if (!attempt) return { requeued: false, reason: "lost_latch" };
		// Ledger conversationId is `{slug||tediId}:{sessionKey}` — strip the prefix
		// to recover the runtime session key.
		const ledgerPrefix = `${tedi.slug || tedi.id}:`;
		const conversationId = inputEvent.conversationId ?? "";
		const session = conversationId.startsWith(ledgerPrefix)
			? conversationId.slice(ledgerPrefix.length)
			: conversationId;
		const attachments = requeueAttachmentsFromPayload(payload.attachments);
		const metadata =
			payload.metadata && typeof payload.metadata === "object"
				? (payload.metadata as Record<string, unknown>)
				: undefined;
		let injected: { success: boolean; error?: string };
		try {
			injected = await deps.inject({
				tedi: { slug: tedi.slug },
				message,
				session,
				...(attachments.length ? { attachments } : {}),
				clientRequestId,
				...(metadata ? { metadata } : {}),
			});
		} catch (error) {
			injected = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!injected.success) {
			await settleTediSubmission(db, {
				runId,
				organizationId: args.organizationId,
				outcome: "failed",
				attemptId: attempt.id,
				error: injected.error ?? "requeue inject rejected by tedi gateway",
			});
			return { requeued: false, reason: "inject_failed" };
		}
		// Success: the row stays running under the fresh recovered attempt.
		return { requeued: true, reason: "requeued" };
	} catch (error) {
		console.warn(
			"[tedi] submission requeue failed",
			runId,
			error instanceof Error ? error.message : String(error),
		);
		return { requeued: false, reason: "inject_failed" };
	}
}
