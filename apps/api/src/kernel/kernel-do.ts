/** Org-scoped durable kernel execution, reconciliation, progress and wake recovery. */
// Database queries, context, and their consumers load inside async operations.
// A static import here evaluates the full D1 schema on every Worker startup.
import { AIChatAgent } from "@cloudflare/ai-chat";

import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";

import { isDurableObjectMemoryLimitReset } from "agents";

import { injectAgentMessage } from "@tedix/provisioning";
import type { BaseContext } from "../rpc/context";
import type {
	KernelTurnPhase,
	KernelTurnProgress,
	KernelTurnWorkInput,
	KernelTurnWorkResult,
} from "../rpc/routers/kernel/turn-work";
import {
	type AgentMemoryCandidate,
	HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
	startRelevanceRecall,
} from "../integrations/cloudflare/agent-memory";
import { ensureKernelWakeSchedule } from "./kernel-wake-schedule";
import { createAnswerDeltaBatcher } from "./answer-delta-batcher";

import {
	createKernelTurnStageTimings,
	type KernelTurnStageTimings,
} from "./turn-stage-timings";
import {
	recoverPendingInboxWake,
	resolveInboxWakeDelayMs,
} from "./inbox-wake-recovery";
import {
	loadHomeLiveEvents,
	loadKernelTurnDelegation,
	loadKernelRunReads,
	loadKernelChildRunReads,
	loadKernelHomePlan,
	loadRuntimeSubmissionBridge,
	loadTediHelpers,
	loadTurnWork,
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
import { createProgressPersistenceTracker } from "./progress-persistence";
import { createProgressThrottle } from "./progress-throttle";
import {
	boundKernelActiveTurn,
	INITIAL_KERNEL_STATE,
	type KernelActiveTurn,
	type KernelState,
} from "./kernel-state";
import type { TediRequeueDeps } from "./runtime-submission-bridge";
import { abortKernelTurn } from "./turn-abort";

/** Delay before a post-turn reconciliation sweep fires. */
const RECONCILE_SWEEP_DELAY_SECONDS = 5 * 60;
/**
 * Don't sweep a submission until the normal settle path (turn-work completion +
 * the run-reconcile at terminalization) has had time to fire — the sweep is the
 * missed-settle safety net, not the primary settler.
 */
const STALE_SUBMISSION_RECONCILE_THRESHOLD_MS = 2 * 60_000;
const STALE_SUBMISSION_RECONCILE_LIMIT = 50;
/**
 * A submission in `reserved` status older than this was latched by Step A (the
 * reserve CAS won) but the finalize Step B never committed — the DO was evicted
 * between the two steps. 30 s is generous enough that a live two-step settle is
 * never raced (A→B is sub-millisecond when the DO is alive) while still giving
 * fast recovery.
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
 * A kernel run stuck `running`/`queued` with no liveness signal (latest
 * `kernel_runtime_events.createdAt` for the run, or the submission's own
 * `updatedAt`) for this long is treated as crashed (DO eviction mid-turn) and
 * terminalized. Conservative: the Code Mode ceiling is 300 000 ms (5 min),
 * and multi-hop/fan-out turns can be slow — 15 min gives substantial headroom
 * before the sweep fires a crash-terminalization.
 */
const KERNEL_CRASH_LEASE_MS = 15 * 60_000;
/**
 * Durable per-turn watchdog bound. The kernel's per-LLM-pass abort guards
 * (llm-guard.ts withIdleAbort / AbortSignal.timeout, ~70s) are in-isolate timers:
 * when a reasoning-model provider stall opens a connection and then
 * emitting no bytes) parks the inline `await runKernelTurnWork` and the DO is then
 * hibernated/evicted/redeployed before the 70s timer fires, the timer dies with
 * the isolate — nothing aborts, nothing settles, and the run sits silently
 * `running` until the 15-min crash sweep mislabels it "DO eviction". This DO alarm
 * survives isolate death (durable schedule) and force-fails the still-running turn
 * with a clear "Model unavailable" signal. Set well above the worst-case healthy
 * turn (route ≤70s + read-loop ≤80s ≈ 150s) so a legitimately slow turn is
 * never clipped, and well under the 15-min lease so the operator learns fast.
 */
const KERNEL_TURN_WATCHDOG_SECONDS = 240;
const KERNEL_TURN_STUCK_DETAIL =
	"No response from the language model within the timeout — the model (AI Gateway / Azure) appears to be unavailable. Your message is saved; please try again shortly.";
/** Matches `KERNEL_RUNTIME_BACKEND` in kernel-runtime.ts. */
const KERNEL_RUNTIME_BACKEND = "custom";

// ─────────────────────────────────────────────────────────────────────────────
// Inbox-wake constants — phase-1 (dark, additive, flag-gated)
// ─────────────────────────────────────────────────────────────────────────────

/** ms from turn-end to stranded-wake alarm fire. */
const INBOX_WAKE_STRANDED_DELAY_MS = 500;
/** Storage key for the stranded-wake flag (persists across hibernation). */
const INBOX_WAKE_STRANDED_KEY = "inboxWakeStranded";
/** Storage key for the conversationId associated with a pending stranded wake. */
const INBOX_WAKE_STRANDED_CONV_KEY = "inboxWakeStrandedConv";
const BLOCKED_DESCENDANT_GRACE_MS = 90_000;
const BLOCKED_DESCENDANT_KEY = "blockedDescendantApprovals";

/**
 * Non-blocking planner flag. When "true", `processTurn` schedules the planner off the DO
 * turn body via `schedule(0, "runPlannerStep")` and returns an async-dispatch
 * sentinel, so `enqueueMessage` acks immediately and the org's single DO thread
 * is freed for concurrent Home turns instead of being held for the full planner
 * pass. Default off. Relies on the `super.alarm()` schedule dispatch added to
 * this file's `alarm()` — a scheduled `runPlannerStep` only fires because of it.
 */
function kernelAsyncPlannerEnabled(env: CloudflareEnv): boolean {
	return (
		(env as unknown as Record<string, string>).KERNEL_ASYNC_PLANNER === "true"
	);
}

/**
 * Marker property set on `processTurn`'s return value when the planner was
 * scheduled async (not run inline). `enqueueMessage` reads it to return the ack
 * path. Kept as a bare string literal (mirrored verbatim in kernel-runtime.ts)
 * so neither module has to import it from the other — kernel-do already imports
 * from kernel-runtime, and a value import back would be a cycle.
 */
const KERNEL_ASYNC_DISPATCH_MARKER = "kernelAsyncDispatched";

/**
 * Steady-state batch interval for durable answer-delta persistence. The first
 * delta flushes immediately; later deltas use one D1 write per 1s window
 * instead of per-token, bounding the cost (e.g. a 5s answer ≈ 6 rows).
 * Gated by {@link kernelAnswerDeltaPersistEnabled} (KERNEL_ANSWER_DELTA_PERSIST).
 */
const ANSWER_DELTA_FLUSH_INTERVAL_MS = 1_000;

/**
 * Gate for the durable per-turn event persistence that feeds the D1-draining
 * SSE channel. When "true" the `startTurnProgress` seam also writes two
 * additive families of `kernel_runtime_events` rows for the in-flight turn:
 *   - `message.delta` answer-delta rows (batched ~1s — see
 *     {@link ANSWER_DELTA_FLUSH_INTERVAL_MS}), and
 *   - `tool.started`/`tool.completed`/`tool.failed` per-tool rows.
 * These events feed OS Cap'n Web delivery and CLI streaming, including replay
 * and recovery. Disabling persistence removes live answer deltas. The terminal
 * message.completed event is stamped at settle time, and the
 * turn body flushes the trailing delta batch (`flushStreamedProgress`) before
 * that settle clock is read, so the (createdAt, id) offset stream orders every
 * delta before it — `packages/cli/src/answer-stream.ts` renders them live and
 * drops them the moment the canonical answer lands. (Before that flush existed
 * the batcher's 1s window landed the bulk delta ~0.8s after the terminal row.)
 */
function kernelAnswerDeltaPersistEnabled(env: CloudflareEnv): boolean {
	return (
		(env as unknown as Record<string, string>).KERNEL_ANSWER_DELTA_PERSIST ===
		"true"
	);
}

interface BlockedDescendantApproval {
	id: string;
	parentConversationId: string;
	childRunId: string;
	approvalRequestId: string;
	delegatedTediId: string | null;
	status: "pending" | "escalated";
	blockedAt: string;
	escalateAt: number;
	escalatedAt: string | null;
	clearedAt: string | null;
}

function kernelErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Type alias preserving the conceptual `KernelDO` name for type-only imports
 * (`DurableObjectNamespace<KernelDO>`). The RUNTIME class was renamed to
 * `KernelDOv2` in DO migration v9 (apps/api/wrangler.jsonc) — a state-preserving
 * `renamed_classes` rename whose only purpose is to force the continuously-active
 * org-scoped kernel DO to restart onto current code. An active org DO never
 * hibernates (continuous org turns + reconcile alarms), so it otherwise keeps
 * executing stale code across deploys; the rename evicts the old instance and the
 * next `idFromName(org)` boots a fresh DO (new code) over the migrated storage.
 */
export type KernelDO = KernelDOv4;

export class KernelDOv4 extends AIChatAgent<CloudflareEnv, KernelState> {
	override initialState: KernelState = INITIAL_KERNEL_STATE;

	/**
	 * Re-arm persisted child-completion delivery on every cold activation.
	 *
	 * `kernel_wake_queue` is canonical and is written before the child notifier
	 * calls this DO. Consequently the RPC that activates a cold instance can
	 * recover a previously dropped alarm before `scheduleWakeAlarm()` itself is
	 * entered. This keeps the five-minute reconciliation sweep as a backstop,
	 * not the normal recovery path.
	 */
	override async onStart(): Promise<void> {
		const organizationId =
			this.state.organizationId ?? this.ctx.id.name ?? null;
		if (!organizationId) return;
		try {
			const context = await this.turnContext();
			await recoverPendingInboxWake({
				delayMs: this.inboxWakeDelayMs(),
				hasPendingWake: async () =>
					(
						await import("@tedix/db/queries/kernel-do-storage")
					).hasPendingKernelWake(context.db, organizationId),
				ensureAlarm: (targetMs) => this.ensureStorageAlarm(targetMs),
			});
		} catch (error) {
			console.warn(
				"[inboxWake] cold-start recovery failed",
				kernelErrorMessage(error),
			);
		}
	}

	private inboxWakeDelayMs(): number {
		return resolveInboxWakeDelayMs(
			(this.env as unknown as Record<string, string>)
				.KERNEL_INBOX_WAKE_DELAY_MS,
		);
	}

	/**
	 * Per-turn abort controllers, keyed by runId. Created in `runPlannerStep`
	 * around the `runKernelTurnWork` call and removed in its `finally` — a DO
	 * is single-threaded per isolate, so a plain in-memory `Map` is safe (no
	 * cross-request race). `cancelTurn` aborts the entry for a runId if one is
	 * still live; a turn that already settled (or never ran on this isolate —
	 * e.g. after an `abortIfStaleCode` restart) simply has no entry, and the
	 * cancel is a fail-soft no-op there (the existing pre-materialize cancel
	 * gate + durable submission-ledger abort stamp still own correctness in
	 * that case — see docs/engineering/cognition/kernel-execution-model.md "Operator
	 * cancel").
	 */
	private readonly turnAbortControllers = new Map<string, AbortController>();

	/**
	 * Synthetic per-turn context: the DO has no inbound oRPC request — auth
	 * already happened in the RPC handler for `processTurn`.
	 * `createContext` only needs the env to build
	 * the D1 client; the placeholder request supplies headers/url shape.
	 *
	 * Deliberately no `waitUntil`: `DurableObjectState.waitUntil` is a lifetime
	 * no-op, and this instance can be aborted (`ctx.abort` version reset) or
	 * idled between turns — a promise detached under a fake waitUntil is
	 * silently dropped (live-observed: auto-titles vanishing without a
	 * breadcrumb). Deps that branch on `context.waitUntil` (e.g. the
	 * conversation auto-title sink in `buildKernelTurnWorkDeps`) therefore fall
	 * into their awaited path here, which is the correct durability lever. Do
	 * not thread `this.ctx.waitUntil` in.
	 */
	private async turnContext(): Promise<BaseContext> {
		const { createContext } = await import("../rpc/context");
		return createContext(new Request("https://kernel.internal/turn"), this.env);
	}

	/**
	 * Version-triggered self-restart — retires the DO-rename tax (v9/v10/…).
	 *
	 * Why: a Durable Object only loads new code when it shuts down + restarts
	 * (docs: durable-objects/concepts/durable-object-lifecycle — "New Worker
	 * deployments with code updates" cause a shutdown, but only once the DO leaves
	 * memory, which needs 10s idle + no setTimeout/WebSocket/in-flight-fetch/
	 * outbound-connection). This org DO is continuously active, so it never
	 * hibernates → keeps stale code across deploys. Renaming the class forced a
	 * fresh instance; this replaces that.
	 *
	 * How: `this.env.CF_VERSION_METADATA.id` is this instance's own code version
	 * (fixed at construction). The edge caller (`enqueueMessage`) is always on the
	 * latest deployed version and passes its id as `callerVersionId`. If they
	 * differ, a newer deployment is live but this instance is stale → `ctx.abort`
	 * forcibly resets it (docs: durable-objects/api/state — "forcibly reset a
	 * Durable Object"; uncatchable). The current turn errors out and re-drives on
	 * the fresh instance (persist-first run row + durable submission ledger make it
	 * idempotent). No loop: a freshly-booted instance has own===latest. Benign if
	 * the binding ever reports latest instead of own — it simply no-ops.
	 */
	private abortIfStaleCode(callerVersionId?: string | null): void {
		if (!callerVersionId) return;
		const ownVersionId = (this.env as { CF_VERSION_METADATA?: { id?: string } })
			.CF_VERSION_METADATA?.id;
		if (!ownVersionId || ownVersionId === callerVersionId) return;
		console.warn(
			`[kernel-do] code-update detected (own ${ownVersionId} → deployed ${callerVersionId}); aborting to reload`,
		);
		// Uncatchable forced reset — the next request boots this DO on current code.
		this.ctx.abort(`kernel code-update: ${ownVersionId} -> ${callerVersionId}`);
	}

	private async ensureStorageAlarm(targetMs: number): Promise<void> {
		await ensureKernelWakeSchedule(this, targetMs);
	}

	/** The SDK owns the wake; alarm() drains custom timers after SDK jobs retire. */
	async wakeKernelTimers(): Promise<void> {}

	private async readBlockedDescendants(): Promise<BlockedDescendantApproval[]> {
		return (
			(await this.ctx.storage.get<BlockedDescendantApproval[]>(
				BLOCKED_DESCENDANT_KEY,
			)) ?? []
		).filter((row) => !row.clearedAt);
	}

	private async writeBlockedDescendants(
		rows: BlockedDescendantApproval[],
	): Promise<void> {
		if (rows.length === 0) {
			await this.ctx.storage.delete(BLOCKED_DESCENDANT_KEY);
		} else {
			await this.ctx.storage.put(BLOCKED_DESCENDANT_KEY, rows);
			const pendingEscalations = rows
				.filter((row) => row.status === "pending")
				.map((row) => row.escalateAt);
			if (pendingEscalations.length > 0) {
				await this.ensureStorageAlarm(Math.min(...pendingEscalations));
			}
		}
		this.setState({
			...this.state,
			approvalMirrors: Object.fromEntries(rows.map((row) => [row.id, row])),
		});
	}

	private async processBlockedDescendantAlarm(): Promise<void> {
		const rows = await this.readBlockedDescendants();
		const now = Date.now();
		let changed = false;
		const escalatedIds: string[] = [];
		for (const row of rows) {
			if (row.status !== "pending" || row.escalateAt > now) continue;
			row.status = "escalated";
			row.escalatedAt = new Date(now).toISOString();
			escalatedIds.push(row.id);
			changed = true;
		}
		if (changed || rows.some((row) => row.status === "pending")) {
			await this.writeBlockedDescendants(rows);
		}
		if (escalatedIds.length > 0) {
			const escalatedAt = new Date(now).toISOString();
			try {
				const db = (await this.turnContext()).db;
				// CAS + `returning()` — only rows this call moved come back, so a
				// re-armed alarm or a second DO activation cannot page twice.
				const escalated = await (
					await import("@tedix/db/queries/kernel-approval-mirrors")
				).escalateKernelApprovalMirrors(db, {
					ids: escalatedIds,
					escalatedAt,
				});
				const organizationId =
					this.state.organizationId ?? this.ctx.id.name ?? null;
				if (escalated.length > 0 && organizationId) {
					// The escalation's only human-facing exit. Fail-soft inside, so the
					// inbox-wake work after this alarm step is unaffected.
					await (
						await import("../lib/approval-escalation-notify")
					).notifyApprovalEscalation(this.env, db, {
						organizationId,
						escalated,
						escalatedAt,
					});
				} else if (escalated.length > 0) {
					console.warn(
						JSON.stringify({
							signal: "approval.escalation.undelivered",
							approvalRequestIds: escalated.map((r) => r.approvalRequestId),
							reason: "no_organization_id",
						}),
					);
				}
			} catch (error) {
				console.error(
					"[KernelDO] approval mirror escalation projection failed",
					{
						error: error instanceof Error ? error.message : String(error),
						escalatedIds,
					},
				);
			}
		}
	}

	async mirrorChildApprovalBlocked(input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId: string;
		delegatedTediId?: string | null;
	}): Promise<void> {
		const organizationId = this.ctx.id.name ?? this.state.organizationId;
		if (!organizationId) return;
		const id = [
			input.parentConversationId,
			input.childRunId,
			input.approvalRequestId,
		].join(":");
		const rows = await this.readBlockedDescendants();
		const now = Date.now();
		try {
			await (
				await import("@tedix/db/queries/kernel-approval-mirrors")
			).createKernelApprovalMirror((await this.turnContext()).db, {
				id,
				organizationId,
				parentConversationId: input.parentConversationId,
				childRunId: input.childRunId,
				approvalRequestId: input.approvalRequestId,
				delegatedTediId: input.delegatedTediId ?? null,
				blockedAt: new Date(now).toISOString(),
				escalateAt: now + BLOCKED_DESCENDANT_GRACE_MS,
			});
		} catch (error) {
			console.error("[KernelDO] approval mirror insert projection failed", {
				error: error instanceof Error ? error.message : String(error),
				id,
			});
		}
		if (rows.some((row) => row.id === id)) return;
		rows.push({
			id,
			parentConversationId: input.parentConversationId,
			childRunId: input.childRunId,
			approvalRequestId: input.approvalRequestId,
			delegatedTediId: input.delegatedTediId ?? null,
			status: "pending",
			blockedAt: new Date(now).toISOString(),
			escalateAt: now + BLOCKED_DESCENDANT_GRACE_MS,
			escalatedAt: null,
			clearedAt: null,
		});
		await this.writeBlockedDescendants(rows);
	}

	async clearChildApprovalBlocked(input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId?: string | null;
	}): Promise<void> {
		const organizationId = this.ctx.id.name ?? this.state.organizationId;
		if (organizationId) {
			try {
				await (
					await import("@tedix/db/queries/kernel-approval-mirrors")
				).clearKernelApprovalMirrors((await this.turnContext()).db, {
					organizationId,
					parentConversationId: input.parentConversationId,
					childRunId: input.childRunId,
					approvalRequestId: input.approvalRequestId,
					clearedAt: new Date().toISOString(),
				});
			} catch (error) {
				console.error("[KernelDO] approval mirror clear projection failed", {
					error: error instanceof Error ? error.message : String(error),
					parentConversationId: input.parentConversationId,
					childRunId: input.childRunId,
				});
			}
		}
		const rows = await this.readBlockedDescendants();
		const next = rows.filter(
			(row) =>
				row.parentConversationId !== input.parentConversationId ||
				row.childRunId !== input.childRunId ||
				(input.approvalRequestId
					? row.approvalRequestId !== input.approvalRequestId
					: false),
		);
		if (next.length === rows.length) return;
		await this.writeBlockedDescendants(next);
	}

	/** Track active progress and persist delivery events through the turn lifecycle. */
	private startTurnProgress(
		context: BaseContext,
		runId: string,
		conversationId: string,
		organizationId: string,
		stageTimings?: KernelTurnStageTimings,
		streamAttempt = 0,
	) {
		const throttle = createProgressThrottle<KernelActiveTurn>({
			apply: (activeTurn) => {
				this.setState({ ...this.state, activeTurn });
			},
		});
		// Streaming-answer accumulator: each `progress.answerDelta` (from the
		// planner's streamObject pass / the delivery chunker) is appended so the
		// throttled (≥1s coalesced) push always carries the full answer-so-far —
		// a coalesced push must not drop intermediate deltas. boundKernelActiveTurn
		// caps the retained progress length. The durable run row keeps the
		// final answer; this accumulator is never persisted.
		let answer = "";
		// `turnContext()` intentionally has no waitUntil. Track every D1 write
		// started by the synchronous progress seam and await the tracker from the
		// async turn finalizer so a DO reset/eviction cannot drop dark SSE data.
		const persistence = createProgressPersistenceTracker();
		// Durable answer-delta batcher: flushes the first answerDelta immediately,
		// then persists `message.delta` events every ~1s. One write per steady-state
		// window, not per token. Fail-soft — never affects the turn.
		const persistEnabled = kernelAnswerDeltaPersistEnabled(this.env);
		const deltaBatcher = createAnswerDeltaBatcher({
			flushIntervalMs: ANSWER_DELTA_FLUSH_INTERVAL_MS,
			persist: (chunk, seq) => {
				// Stage-timing mark before the persist gate: the flush moment is what
				// the first-token latency instrumentation measures, whether or not
				// durable delta persistence is enabled. First occurrence only.
				stageTimings?.mark("firstAnswerDeltaFlush");
				if (!persistEnabled) return;
				const createdAt = new Date().toISOString();
				persistence.track(
					loadHomeLiveEvents().then((m) =>
						m.recordHomeAnswerDelta(context, {
							organizationId,
							conversationId,
							runId,
							delta: chunk,
							sequence: seq,
							...(streamAttempt > 0 ? { streamAttempt } : {}),
							createdAt,
						}),
					),
				);
			},
		});
		// Provisional rationale batcher. Same shape and same ~1s cadence as the
		// answer batcher above (first chunk immediate so the operator sees the
		// decision forming instead of a blank screen; one write per later
		// window). The planner's rationale is a sentence or two produced early in
		// the pass, so this adds a couple of `message.reasoning` rows per run —
		// deliberately the same order as today's answer deltas, because
		// `listKernelRuntimeEvents` pages by OFFSET and rows_read grows
		// quadratically in rows-per-run. Display only: nothing reads these rows
		// back into the transcript, the ledger, accounting or approvals.
		const rationaleBatcher = createAnswerDeltaBatcher({
			flushIntervalMs: ANSWER_DELTA_FLUSH_INTERVAL_MS,
			persist: (chunk, seq) => {
				if (!persistEnabled) return;
				const createdAt = new Date().toISOString();
				persistence.track(
					loadHomeLiveEvents().then((m) =>
						m.recordHomeRationaleDelta(context, {
							organizationId,
							conversationId,
							runId,
							delta: chunk,
							sequence: seq,
							createdAt,
						}),
					),
				);
			},
		});
		// Phase transitions: one durable `message.phase` row per DISTINCT phase
		// (a repeated milestone in the same phase is a label refresh, not a
		// transition).
		let phaseSequence = 0;
		let lastPhase: KernelTurnPhase | null = null;
		const recordPhase = (phase: KernelTurnPhase, detail?: string): void => {
			if (phase === lastPhase) return;
			lastPhase = phase;
			phaseSequence += 1;
			const sequence = phaseSequence;
			if (!persistEnabled) return;
			const createdAt = new Date().toISOString();
			persistence.track(
				loadHomeLiveEvents().then((m) =>
					m.recordHomePhaseEvent(context, {
						organizationId,
						conversationId,
						runId,
						sequence,
						phase,
						...(detail ? { detail } : {}),
						createdAt,
					}),
				),
			);
		};
		return {
			onProgress: (progress: KernelTurnProgress): void => {
				const phase: KernelTurnPhase | null = progress.phase ?? null;
				if (phase) recordPhase(phase, progress.detail);
				if (progress.answerDelta) {
					answer += progress.answerDelta;
					deltaBatcher.push(progress.answerDelta);
				}
				// Never accumulated into `answer`: the provisional rationale is a
				// display line, not the turn's text.
				if (progress.rationaleDelta) {
					rationaleBatcher.push(progress.rationaleDelta);
				}
				throttle.push(
					boundKernelActiveTurn({
						runId,
						conversationId,
						stage: progress.stage,
						...(lastPhase ? { phase: lastPhase } : {}),
						...(progress.detail ? { detail: progress.detail } : {}),
						...(answer.length > 0 ? { answer } : {}),
						at: new Date().toISOString(),
					}),
				);
			},
			// End-of-stream flush (turn-work `flushStreamedProgress`): runs
			// synchronously after the planner pass and before the terminal row is
			// stamped, so the trailing partial persists ahead of message.completed.
			flush: (): void => {
				deltaBatcher.flush();
				rationaleBatcher.flush();
			},
			end: async (): Promise<void> => {
				deltaBatcher.end();
				rationaleBatcher.end();
				throttle.end();
				await persistence.drain();
			},
		};
	}

	/**
	 * Run one kernel-eligible Home turn inside the DO's own execution context.
	 * The caller (`enqueueMessage`) has already done the persist-first inserts
	 * and passes the run identity in `input` — this method never mints ids and
	 * never double-inserts. Returns the same result shape the inline path
	 * produces, so `enqueueMessage` can return it verbatim.
	 */
	async processTurn(input: KernelTurnWorkInput): Promise<KernelTurnWorkResult> {
		// Self-restart onto current code if a newer deployment is live (retires the
		// DO-rename tax — see abortIfStaleCode). Must run before any work/persist so
		// the reset is clean; the edge re-drives the turn on the fresh instance.
		this.abortIfStaleCode(input.callerVersionId);
		this.setState({ ...this.state, organizationId: input.organizationId });
		// Start the semantic recall now — before the turn body's dynamic module
		// imports, `turnContext()`, the intercept reads and everything else on the
		// way to context assembly. One recall can take seconds; started inside
		// assembly it becomes the whole `planning → preparing_context` stage.
		// Started here it overlaps the enqueue→work gap and
		// assembly bounds the remaining wait (RELEVANCE_RECALL_BUDGET_MS). The
		// helper never rejects, and `agent-memory.ts` is a dependency-free leaf,
		// so this adds nothing to the DO's eager module graph. Ids only: canonical
		// D1 still hydrates and authorizes every candidate before prompt assembly.
		const relevanceCandidates = this.startIngressRecall(input);
		// Non-blocking planner (flag-gated, default off — see
		// `kernelAsyncPlannerEnabled`): schedule the planner off this RPC so the DO
		// thread is freed immediately and concurrent same-org Home turns interleave
		// instead of serializing behind one planner pass. The work runs in
		// `runPlannerStep` via the alarm (which fires because `alarm()` now calls
		// `super.alarm()`). The persist-first run row is already durable, so the ack
		// `enqueueMessage` builds from the sentinel carries the real run id; the
		// caller recovers the answer via the MCP tasks extension (poll task.id).
		// Every turn is an LLM route now (no fast-path short-circuit), so all turns
		// are eligible for off-thread dispatch when the flag is on.
		if (kernelAsyncPlannerEnabled(this.env)) {
			await this.schedule(0, "runPlannerStep", input);
			return {
				[KERNEL_ASYNC_DISPATCH_MARKER]: true,
			} as unknown as KernelTurnWorkResult;
		}
		return this.runPlannerStep(input, relevanceCandidates);
	}

	/**
	 * Kick off this turn's Agent Memory recall from the raw operator message.
	 * Returns `undefined` (assembly starts its own recall) when the binding or
	 * the message is absent. Never rejects.
	 */
	private startIngressRecall(
		input: KernelTurnWorkInput,
	): Promise<AgentMemoryCandidate[]> | undefined {
		const agentMemory = (this.env as { AGENT_MEMORY?: AgentMemoryNamespace })
			.AGENT_MEMORY;
		if (!agentMemory || !input.content.trim()) return undefined;
		return startRelevanceRecall(agentMemory, {
			orgId: input.organizationId,
			query: input.content,
			limit: HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
		});
	}

	/**
	 * Run one kernel-eligible Home turn body — the route decision, optional write
	 * proposal, direct read, completion patch, and transcript events. Invoked
	 * either inline by `processTurn` (default) or as a scheduled callback
	 * dispatched from `alarm()` when the async planner flag is on. Public because
	 * the agents-SDK schedule callback is resolved by method name. The body is
	 * identical to the former inline `processTurn` — only the call site moved.
	 */
	async runPlannerStep(
		input: KernelTurnWorkInput,
		/** Ingress-started recall from `processTurn`; absent on the scheduled
		 * (async-planner / alarm) path, where assembly starts its own. */
		relevanceCandidates?: Promise<AgentMemoryCandidate[]>,
	): Promise<KernelTurnWorkResult> {
		this.setState({ ...this.state, organizationId: input.organizationId });
		const context = await this.turnContext();
		// One stage-timing collector per turn, shared between the turn body (which
		// marks the serial stage boundaries and attaches the snapshot to the run's
		// terminal metadata write) and the progress seam's answer-delta batcher
		// (which marks the first durable flush). Advisory, in-memory only.
		const stageTimings = createKernelTurnStageTimings();
		const progress = this.startTurnProgress(
			context,
			input.runId,
			input.conversationId,
			input.organizationId,
			stageTimings,
			typeof input.runRowMetadata.redriveCount === "number"
				? input.runRowMetadata.redriveCount
				: 0,
		);
		// Arm the durable stall watchdog (fail-soft): a DO alarm that fires even if
		// this isolate is evicted mid-turn while parked on a hung provider fetch —
		// the case the in-isolate per-pass abort guards cannot cover. Cancelled in
		// `finally` on normal completion; if it still fires, `failStuckTurn`'s CAS
		// no-ops a turn that already settled.
		let watchdogId: string | undefined;
		try {
			watchdogId = (
				await this.schedule(KERNEL_TURN_WATCHDOG_SECONDS, "failStuckTurn", {
					runId: input.runId,
					organizationId: input.organizationId,
					conversationId: input.conversationId,
				})
			)?.id;
		} catch (error) {
			console.warn(
				"[kernel] stall-watchdog arm failed (turn proceeds; reconcile is the fallback)",
				kernelErrorMessage(error),
			);
		}
		// Per-turn abort controller (docs/engineering/cognition/kernel-execution-model.md
		// "Operator cancel"): registered before the turn body runs so a
		// `cancelTurn(runId)` RPC landing concurrently (this DO is
		// single-threaded, but the RPC and this method interleave at `await`
		// points) can always find it. `plannerAbortSignal` is threaded into
		// `runKernelTurnWork`'s deps → `runKernel` → `planKernelRoute`, which
		// combines it with its own internal timeout/idle signals.
		const abortController = new AbortController();
		this.turnAbortControllers.set(input.runId, abortController);
		try {
			const result = await (
				await loadTurnWork()
			).runKernelTurnWork(
				{
					...(await loadKernelTurnDelegation()).buildKernelTurnWorkDeps(
						context,
					),
					onProgress: progress.onProgress,
					flushStreamedProgress: progress.flush,
					plannerAbortSignal: abortController.signal,
					...(relevanceCandidates ? { relevanceCandidates } : {}),
					stageTimings,
				},
				input,
			);
			// Reconciliation scheduling must not delay the turn response.
			this.ctx.waitUntil(this.afterTurnMaintenance(input.organizationId));
			// Inbox-wake: if a child completion was stranded while this turn ran,
			// arm the wake alarm so it fires shortly after the turn ends.
			// onTurnEnded is fail-soft (never throws).
			this.ctx.waitUntil(this.onTurnEnded(input.conversationId));
			return result;
		} finally {
			// Clear active progress on success and failure.
			await progress.end();
			// Cancel the stall watchdog — the turn settled (success or thrown).
			if (watchdogId) {
				try {
					await this.cancelSchedule(watchdogId);
				} catch {
					// Best-effort: if the cancel is missed, failStuckTurn's CAS no-ops
					// a turn that already reached a terminal status.
				}
			}
			// Only remove our own controller — a redriven turn with the same runId
			// (persist-first idempotency: same run row re-enters runPlannerStep)
			// could otherwise delete a fresher controller registered by the new
			// pass after this stale `finally` runs.
			if (this.turnAbortControllers.get(input.runId) === abortController) {
				this.turnAbortControllers.delete(input.runId);
			}
		}
	}

	/**
	 * Abort an in-flight kernel turn's LLM pass. Best-effort RPC called from
	 * `cancelKernelRunCore` (`kernel-runtime.ts`) after it durably marks the run
	 * row `canceled` — this only stops the wasted token burn; the actual
	 * cancel settle is owned by the turn body's pre-materialize cancel gate
	 * (which sees the already-`canceled` DB row regardless of whether this
	 * RPC ever reaches the DO or finds a live controller). Follows the same
	 * public-RPC-entrypoint pattern as `processTurn` — see `abortIfStaleCode`
	 * for the sibling "self-correct via DO RPC" convention.
	 *
	 * Fail-soft by construction: a runId with no live controller (turn already
	 * settled, never ran on this isolate, or ran on a since-evicted isolate)
	 * is a normal no-op, not an error — the caller must never fail the cancel
	 * RPC over this. Returns whether a live controller was actually aborted,
	 * for logging/observability only.
	 */
	async cancelTurn(runId: string): Promise<boolean> {
		return abortKernelTurn(this.turnAbortControllers, runId);
	}

	/**
	 * Durable stall watchdog (DO-alarm callback, looked up by name). Force-fails a
	 * kernel turn that is still active past {@link KERNEL_TURN_WATCHDOG_SECONDS} —
	 * the provider-stall-then-isolate-eviction class that the in-isolate per-pass
	 * abort guards cannot cover (they die with the isolate). Status-guarded so it
	 * never touches a turn that already settled (a watchdog/completion race) and
	 * never terminalizes a parked `requires_approval` turn. Writes a clear
	 * "Model unavailable" signal (not the generic crash-sweep "DO eviction") so the
	 * operator can tell a provider outage from a deploy. Fail-soft throughout.
	 */
	async failStuckTurn(payload: {
		runId?: string;
		organizationId?: string;
		conversationId?: string;
	}): Promise<void> {
		const runId = payload?.runId;
		const organizationId = payload?.organizationId;
		if (!runId || !organizationId) return;
		const context = await this.turnContext();
		try {
			const submissionBridge = await loadRuntimeSubmissionBridge();
			const now = new Date().toISOString();
			const updated = await (
				await import("@tedix/db/queries/kernel-do-storage")
			).failActiveKernelRun(context.db, {
				id: runId,
				organizationId,
				progressDetail: KERNEL_TURN_STUCK_DETAIL,
				now,
			});
			if (!updated) return; // already settled — watchdog lost the race
			await submissionBridge.settleKernelSubmission(context.db, {
				runId,
				organizationId,
				conversationId: payload?.conversationId ?? "",
				outcome: "failed",
				error: KERNEL_TURN_STUCK_DETAIL,
			});
			console.warn(
				`[kernel] stall-watchdog failed a stuck turn (model unavailable) run=${runId}`,
			);
		} catch (error) {
			console.warn(
				"[kernel] failStuckTurn error",
				runId,
				kernelErrorMessage(error),
			);
		}
	}

	/** Ensure detached turns retain a fail-soft reconciliation wake. */
	private async afterTurnMaintenance(organizationId: string): Promise<void> {
		try {
			await this.ensureReconciliationSchedule(organizationId);
		} catch (error) {
			// Preserve the waitUntil contract if scheduling fails.
			console.warn(
				"[kernel] after-turn maintenance failed",
				kernelErrorMessage(error),
			);
		}
	}

	/**
	 * Schedule one `reconcileRuns` sweep {@link RECONCILE_SWEEP_DELAY_SECONDS}s
	 * out unless one is already pending. Dedup via `getSchedules()` — the
	 * synchronous list is valid here because `KernelDO` is the top-level
	 * alarm-owning agent (same reasoning as the isolate DO's diag surface;
	 * the deprecation only affects sub-agents). Fail-soft: scheduling is an
	 * optimization — the next turn re-attempts it.
	 */
	private async ensureReconciliationSchedule(
		organizationId: string,
	): Promise<void> {
		try {
			// `schedule.time` is epoch seconds. A delayed schedule's row is only
			// deleted after its callback completes (agents SDK alarm loop), so the
			// sweep currently executing is still listed — filter to future fire
			// times or the self re-arm inside `reconcileRuns` would always no-op.
			const nowSeconds = Math.floor(Date.now() / 1000);
			const pending = this.getSchedules().some(
				(schedule) =>
					schedule.callback === "reconcileRuns" && schedule.time > nowSeconds,
			);
			if (pending) return;
			await this.schedule(RECONCILE_SWEEP_DELAY_SECONDS, "reconcileRuns", {
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
	 * Scheduled progress-ledger sweep (see progress-ledger.ts for the decision
	 * table). Public because the agents-SDK schedule callback is looked up by
	 * method name. Steps: load the org's non-terminal runs (all conversations,
	 * oldest-updated first so the longest-stuck rows are inside the scan cap),
	 * load the gating approval rows read-only, plan deterministically, apply
	 * each action with a status-guarded conditional update. Re-schedules itself only while
	 * non-terminal runs remain. Fail-soft throughout: a sweep failure logs and
	 * waits for the next turn's `afterTurnMaintenance` to re-arm.
	 */
	async reconcileRuns(payload: { organizationId: string }): Promise<void> {
		const organizationId = payload?.organizationId;
		if (!organizationId) return;
		const context = await this.turnContext();
		try {
			const rows = await (
				await import("@tedix/db/queries/kernel-do-storage")
			).listKernelRunsByStatus(context.db, {
				organizationId,
				statuses: [...NON_TERMINAL_KERNEL_RUN_STATUSES],
				limit: MAX_RECONCILIATION_SCAN_RUNS,
			});
			// Stale-submission safety net — runs before the quiet-org early return,
			// because an already-terminal run is not in the non-terminal scan above,
			// so a submission left 'running' by a missed (fail-soft) settle would
			// otherwise never be caught.
			await this.reconcileStaleSubmissions(context, organizationId);
			if (rows.length === 0) return; // org is quiet — let the alarm lapse

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

			// Read-only approval lookups for requires_approval rows (the same
			// helper the approval workflow + tedi-approvals router use). A failed
			// lookup just omits the row — the planner treats that as "cannot
			// prove expiry" and takes no action.
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

			const actions = planRunReconciliation({
				runs: ledgerRuns,
				approvals,
				now: Date.now(),
			});
			let appliedCount = 0;
			for (const action of actions) {
				const applied = await this.applyLedgerAction(
					context,
					organizationId,
					action,
				);
				if (applied) {
					appliedCount += 1;
				}
			}

			// Delegation-parent backstop: terminalize a parent whose child run has
			// provably failed/canceled but whom the fail-soft event-driven
			// reconcileChildStatus left non-terminal (planRunReconciliation skips
			// delegation parents). Runs on the same loaded rows.
			await this.reconcileStaleDelegationParents(context, organizationId, rows);

			// Success backstop: re-drive the inbox-wake success relay for any
			// delegation parent whose completed child was missed by a dropped wake
			// alarm. reconcileStaleDelegationParents above only propagates failure;
			// this makes the parent←child relay eventually-exactly-once: a dropped
			// one-shot wake self-heals here instead of stranding a completed child
			// with no Home follow-up.
			await this.reconcileUnrelayedDelegations(context, organizationId, rows);

			// Conservative re-arm: anything still (or possibly still) non-terminal
			// gets another sweep — a guard-skipped action means the run changed
			// under us, and a full scan window means there may be more rows.
			if (rows.length - appliedCount > 0) {
				await this.ensureReconciliationSchedule(organizationId);
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
	private async reconcileStaleSubmissions(
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
						// Liveness signal: prefer the run's own latest-event timestamp (kept
						// current by insertKernelRuntimeEvent's latestEventAt patch), falling
						// back to the run row's updatedAt, then the submission's updatedAt.
						const lastSignalRaw =
							runRow.latestEventAt ?? runRow.updatedAt ?? submission.updatedAt;
						const lastSignalMs =
							submissionBridge.parseDbTimestampMs(lastSignalRaw);
						const outcome = submissionBridge.decideKernelSubmissionRecovery({
							runStatus: runRow.status,
							abortRequestedAt: submission.abortRequestedAt,
							lastSignalMs,
							nowMs,
							crashLeaseMs: KERNEL_CRASH_LEASE_MS,
						});
						if (!outcome) continue;
						const conversationId =
							submission.conversationId ?? runRow.conversationId;
						// Crash terminalization: the run row is still non-terminal
						// (running/queued) but the DO died — patch it to failed so the run
						// row is consistent with the submission settle that follows.
						// For delegation parents, re-check current child evidence before
						// crashing. Fresh activity keeps a waiting parent alive; substantive
						// completion settles the parent completed instead of failing (the firecrawl
						// pattern: child completes at t0, parent crash-fails at t0+18m because
						// the DO was evicted with the run still running). Fail-soft: any error
						// in the re-check falls back to the original crash-fail behavior.
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
									// Native command waits publish real observations without
									// completing the child. Recheck freshness under the same
									// terminal/abort precedence before declaring its parent dead.
									if (
										submissionBridge.decideKernelSubmissionRecovery({
											runStatus: runRow.status,
											abortRequestedAt: submission.abortRequestedAt,
											lastSignalMs,
											nowMs,
											crashLeaseMs: KERNEL_CRASH_LEASE_MS,
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
							// Pre-side-effect crash → re-drive instead of sealing failed. The
							// inline kernel routing turn is wrap-or-lose on a deploy/DO
							// eviction; if it crashed before deciding a route and before
							// dispatching a delegation it did nothing externally, so re-running
							// it (bounded by the durable attempt budget) is safe by
							// construction. decideKernelRedrive demands affirmative
							// kernelRoute===null + null delegation columns — anything else, or a
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
									crashLeaseMs: KERNEL_CRASH_LEASE_MS,
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
										// Reconstruct the turn input from the stamp + the row's
										// metadata, and re-schedule the planner step (the same alarm
										// path the async planner uses). Leaves the submission
										// running — the re-driven turn settles it on completion.
										const redriveTurnInput = {
											...(stamp as Record<string, unknown>),
											runRowMetadata: redriveMetadata,
										} as unknown as KernelTurnWorkInput;
										await this.schedule(0, "runPlannerStep", redriveTurnInput);
										console.warn(
											`[kernel.sweep] re-drove pre-side-effect crashed kernel run=${submission.runId} attempt=${(submission.attemptCount ?? 0) + 1}`,
										);
										reconciled += 1;
										continue;
									}
								}
							}
							// Align the run-row patch with the decided outcome: an abort-driven
							// terminalization (durable operator stamp, outcome "canceled")
							// records the honored intent; anything else is the crash-fail.
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
					// Tedi message run: canonical truth is the tedi runtime-event ledger
					// (the choke point that normally settles on a terminal event). Settle
					// from a terminal event if one already exists (a missed fail-soft
					// choke-point settle); otherwise use the run's own event stream as the
					// liveness signal — if it stopped emitting past the crash lease, the
					// turn died, so terminalize it. skill_workflow needs a skill-runtime
					// poll — deferred.
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
					// Liveness floor: max(latest event timestamp, submission.updatedAt) —
					// the run is alive while either its event stream emits or its
					// submission row advances (a just-requeued row bumps updatedAt while
					// the latest event is still the pre-crash one; without the max it
					// would look stale again on the very next pass and burn the budget).
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
						// Phase-aware recovery: engage the journal phase +
						// durable retry budget so a provably-pre-provider crash is
						// distinguished from a crashed-mid-execution turn, plus the durable
						// operator abort intent.
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
					// A "requeue" decision is a provably-pre-provider crash (no side
					// effects) that is safe to re-dispatch in place: append a recovered
					// attempt and re-inject the original input under the same
					// clientRequestId. The executor's terminal branches settle the row
					// themselves; a successful requeue leaves it running.
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
							// Terminal executor branch (aborted / input_missing /
							// tedi_missing / inject_failed) settled the row exactly-once.
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
					// Skill workflow: canonical D1 truth is skill_runs.status, which the
					// skill-runtime's own reconciler cron pushes to terminal even with no
					// client poll. The gap is only the submission settle — today it fires
					// solely from the client-driven runWorkflowStatus path, so a
					// completed-but-never-polled workflow leaves its submission running.
					// Settle exactly-once once skill_runs is terminal; otherwise leave (not
					// yet terminal, or the skill-runtime cron hasn't reconciled it yet).
					const skillRun = await (
						await import("@tedix/db/queries/skill-runs")
					).getSkillRun(
						context.db,
						submission.runId,
						organizationId,
						context.env.ENVIRONMENT,
					);
					if (!skillRun) continue;
					// A failed admission marker is a repairable pre-engine state, and an
					// open restart intent is still fencing the prior terminal snapshot.
					// Neither may settle the current submission attempt.
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
					// Read the intended outcome from the metadata stamp written by Step A.
					// Fall back to "failed" for a reserved row that has no recorded outcome
					// (corrupt latch — fail-closed).
					const reservedOutcome = (
						row.metadata as Record<string, unknown> | null
					)?.reservedOutcome;
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
	 * Apply one ledger action with the same status-guarded conditional-update
	 * pattern as the turn-work completion patch (`WHERE id = ? AND status =
	 * expected`): a concurrent legitimate transition (operator cancel, approval
	 * resolution, turn completion) wins and the action becomes a no-op. On a
	 * successful patch, writes the matching `run.failed`/`run.canceled`
	 * transcript event via the same drizzle insert pattern kernel-runtime's
	 * (non-exported) `insertKernelRuntimeEvent` uses — deterministic id +
	 * `onConflictDoNothing`, so a retried sweep can never duplicate it. The
	 * event is advisory: the run patch (with its `kernelReconciliation`
	 * idempotency marker) is the durable source of truth.
	 */
	/**
	 * Delegation-parent reconcile backstop (run-level analog of
	 * reconcileStaleSubmissions). planRunReconciliation deliberately skips
	 * delegation parents — they belong to the event-driven reconcileChildStatus —
	 * but that propagation is fail-soft and can miss, stranding a parent
	 * non-terminal forever after its child died (a Home turn stuck "running" on a
	 * failed delegation). This re-reads each non-terminal delegation parent's child
	 * outcome (readTerminalChildOutcomesForParents resolves the container child-run
	 * id mapping) and, only when the child provably failed/canceled, terminalizes
	 * the parent to match via the same status-guarded applyLedgerAction (which also
	 * settles the parent submission and emits run.*). A
	 * child that completed or is still live is left untouched, so a live (merely
	 * slow) delegation is never killed. Fail-soft.
	 */
	private async reconcileStaleDelegationParents(
		context: BaseContext,
		organizationId: string,
		rows: KernelRuntimeRun[],
	): Promise<void> {
		try {
			const parents = rows.filter(
				(row) => row.childRunId && row.delegatedTediId,
			);
			if (parents.length === 0) return;
			const childOutcomes = await (
				await loadKernelHomePlan()
			).readTerminalChildOutcomesForParents(context, parents);
			if (childOutcomes.size === 0) return;
			for (const parent of parents) {
				const outcome = childOutcomes.get(parent.id);
				if (!outcome) continue; // child completed / still live → leave
				await this.applyLedgerAction(context, organizationId, {
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
	 * Success backstop for the parent←child relay. The inbox-wake alarm
	 * (`reconcileInboxWakeRuns`) is the fast path that relays a completed child's
	 * result back to its Home conversation via `recordHomeDelegationCompletionMessage`
	 * (the single authoritative disposition writer). That wake is a one-shot push;
	 * if it drops (alarm-context teardown — the documented alarm-drop class) the
	 * completed child is stranded with no Home follow-up, while
	 * `reconcileStaleDelegationParents` only handles failure. This re-drives the
	 * same authoritative relay for every non-terminal delegation parent, so a
	 * dropped success-wake self-heals on the next sweep — converting a best-effort
	 * push into eventually-exactly-once. Idempotent: already-terminal parents and
	 * already-relayed children are no-ops (`reconcileInboxWakeRuns` excludes rows
	 * terminal before the call, and the completion message dedups on
	 * `asyncCompletionAssistantMessageId`). No new writer, no new table.
	 */
	private async reconcileUnrelayedDelegations(
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

	private async applyLedgerAction(
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

			// Durable submission ledger: settle the submission for a reconciled
			// (terminalized) run, exactly-once.
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

	// ─────────────────────────────────────────────────────────────────────────
	// Inbox-wake lifecycle — phase-1 (dark, additive, flag-gated)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Called by `notifyKernelChildComplete` (cognitive-runtime.ts) via DO RPC
	 * when a delegated child run reaches a terminal state.
	 *
	 * Writes to kernel_wake_queue (already done by the caller before this RPC),
	 * then schedules a short debounced DO alarm: if an earlier alarm
	 * is already pending at a sooner time, skip. If an active turn is running
	 * for the conversation, set the stranded flag so `onTurnEnded` arms the
	 * alarm instead.
	 *
	 * Public so the DO RPC binding can call it via stub.scheduleWakeAlarm(…).
	 */
	async scheduleWakeAlarm(
		parentConversationId: string,
		childRunId: string,
		childStatus: string,
	): Promise<void> {
		try {
			// If a turn is actively running for this conversation, strand: arm the
			// alarm from onTurnEnded instead to avoid injecting over an in-flight turn.
			const activeTurn = this.state.activeTurn;
			if (activeTurn && activeTurn.conversationId === parentConversationId) {
				await this.ctx.storage.put(INBOX_WAKE_STRANDED_KEY, true);
				await this.ctx.storage.put(
					INBOX_WAKE_STRANDED_CONV_KEY,
					parentConversationId,
				);
				console.warn(
					"[inboxWake] active turn in progress — stranded wake queued",
					{ parentConversationId, childRunId, childStatus },
				);
				return;
			}
			await this.ensureStorageAlarm(Date.now() + this.inboxWakeDelayMs());
		} catch (error) {
			console.warn(
				"[inboxWake] scheduleWakeAlarm failed",
				kernelErrorMessage(error),
			);
		}
	}

	/**
	 * DO alarm handler: drain unacked wake-queue rows for the org, build a
	 * synthetic "[System: N delegated task(s) completed — results in inbox]"
	 * parent turn, inject it via `startKernelTurn` + `this.processTurn`, then
	 * ack the rows after the turn completes.
	 *
	 * Custom inbox timers remain fail-soft, but SDK `super.alarm()`
	 * failures are rethrown after custom timers run so non-OOM schedule errors stay
	 * visible and the Agents alarm-boundary memory-reset semantics are not masked.
	 */
	async alarm(): Promise<void> {
		let sdkAlarmError: unknown;
		const rethrowSdkAlarmError = () => {
			if (sdkAlarmError !== undefined) throw sdkAlarmError;
		};
		// Dispatch SDK callbacks first, including wakeKernelTimers. Kernel timers
		// are named schedules in the lifecycle queue, so SDK maintenance cannot
		// overwrite an earlier inbox deadline. The no-op wake is retired
		// before custom processing below schedules its next deadline. Keep this
		// boundary to also drain raw alarms persisted before the SDK migration.
		// A dispatch failure must not skip custom timers, and is rethrown after them.
		try {
			await super.alarm();
		} catch (error) {
			sdkAlarmError = error;
			console.warn(
				"[kernel] super.alarm() schedule dispatch failed",
				{
					memoryLimitReset: isDurableObjectMemoryLimitReset(error),
				},
				kernelErrorMessage(error),
			);
		}
		await this.processBlockedDescendantAlarm();
		const context = await this.turnContext();
		// Resolve organizationId: prefer live state (set when a turn starts),
		// fall back to the DO's stable idFromName key which is the org UUID.
		const organizationId =
			this.state.organizationId ?? this.ctx.id.name ?? null;
		if (!organizationId) {
			console.warn("[inboxWake] alarm fired but no organizationId resolvable");
			rethrowSdkAlarmError();
			return;
		}
		try {
			// Drain unacked rows for this org.
			const pendingRows = await (
				await import("@tedix/db/queries/kernel-do-storage")
			).listPendingKernelWakes(context.db, {
				organizationId,
				limit: 50,
			});
			if (pendingRows.length === 0) {
				rethrowSdkAlarmError();
				return;
			}
			// Group by parentConversationId to build one synthetic turn per conversation.
			const byConversation = new Map<
				string,
				Array<(typeof pendingRows)[number]>
			>();
			for (const row of pendingRows) {
				const list = byConversation.get(row.parentConversationId) ?? [];
				list.push(row);
				byConversation.set(row.parentConversationId, list);
			}
			const ackedAt = new Date().toISOString();
			for (const [conversationId, rows] of byConversation) {
				const n = rows.length;
				const wakeContent = `[System: ${n} delegated task${n === 1 ? "" : "s"} completed — summarize the results for the operator in this thread]`;
				const kernelInboxRunIds = rows.map((r) => r.childRunId);
				try {
					const turnInput = await (
						await loadKernelTurnDelegation()
					).startKernelTurn(context, {
						organizationId,
						conversationId,
						content: wakeContent,
						descopeUserId: undefined,
						source: "kernel.inboxWakeAlarm",
						metadata: {
							dispatchMode: "kernel-inbox-wake",
							kernelInboxRunIds,
							inboxWakeRowIds: rows.map((r) => r.id),
						},
					});
					// Run the synthetic wake turn synchronously (not via processTurn,
					// which would re-schedule under the async planner flag) so the
					// wake-queue rows below are acked only after the turn completes.
					await this.runPlannerStep(turnInput);
					// Ack rows after successful turn injection.
					for (const row of rows) {
						try {
							await (
								await import("@tedix/db/queries/kernel-do-storage")
							).acknowledgeKernelWake(context.db, {
								id: row.id,
								ackedAt,
							});
						} catch (ackError) {
							console.warn(
								"[inboxWake] row ack failed",
								row.id,
								kernelErrorMessage(ackError),
							);
						}
					}
				} catch (error) {
					console.warn(
						"[inboxWake] alarm turn injection failed",
						{ conversationId, n },
						kernelErrorMessage(error),
					);
				}
			}
		} catch (error) {
			if (isDurableObjectMemoryLimitReset(error)) {
				console.warn(
					"[inboxWake] alarm drain hit Durable Object memory limit reset",
					kernelErrorMessage(error),
				);
				throw error;
			}
			console.warn("[inboxWake] alarm drain failed", kernelErrorMessage(error));
		}
		rethrowSdkAlarmError();
	}

	/**
	 * Called at the end of a successful kernel turn to arm a stranded wake alarm
	 * if one was deferred while the turn was running.
	 *
	 * Called by `processTurn` after the turn body completes — the stranded flag
	 * and conversationId are read from DO storage, then cleared. If the flag is
	 * set, an alarm at now+500ms is scheduled so the queued completions are
	 * processed shortly after the parent turn ends.
	 */
	async onTurnEnded(conversationId: string): Promise<void> {
		try {
			const stranded = await this.ctx.storage.get<boolean>(
				INBOX_WAKE_STRANDED_KEY,
			);
			const strandedConv = await this.ctx.storage.get<string>(
				INBOX_WAKE_STRANDED_CONV_KEY,
			);
			if (!stranded || strandedConv !== conversationId) return;
			// Clear the stranded flag.
			await this.ctx.storage.delete(INBOX_WAKE_STRANDED_KEY);
			await this.ctx.storage.delete(INBOX_WAKE_STRANDED_CONV_KEY);
			// Schedule the wake alarm at now+500ms.
			await this.ensureStorageAlarm(Date.now() + INBOX_WAKE_STRANDED_DELAY_MS);
		} catch (error) {
			console.warn("[inboxWake] onTurnEnded failed", kernelErrorMessage(error));
		}
	}
}
