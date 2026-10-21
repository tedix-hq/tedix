/** Org-scoped durable kernel execution, reconciliation, progress and wake recovery. */
// Database queries, context, and their consumers load inside async operations.
// A static import here evaluates the full D1 schema on every Worker startup.
import {
	reconcileRuns,
	ensureReconciliationSchedule,
} from "./kernel-run-reconcile";
import {
	processBlockedDescendantAlarm,
	mirrorChildApprovalBlocked,
	clearChildApprovalBlocked,
} from "./kernel-blocked-descendants";
import type { KernelHistoryCheckpoint } from "../rpc/routers/kernel/context-compaction";
import { AIChatAgent } from "@cloudflare/ai-chat";

import { isDurableObjectMemoryLimitReset } from "agents";
import { getKernelContextCache } from "./context-cache";
import {
	type HomeInventorySnapshot,
	inventorySnapshotStorageKey,
	isUsableInventorySnapshot,
} from "./inventory-snapshot";

import type { BaseContext } from "../rpc/context";
import type { KernelTurnWorkResult } from "../rpc/routers/kernel/turn-work";
import type {
	KernelTurnPhase,
	KernelTurnProgress,
	KernelTurnWorkInput,
} from "../rpc/routers/kernel/turn-work-context";
import {
	type AgentMemoryCandidate,
	HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
	startRelevanceRecall,
} from "../integrations/cloudflare/agent-memory";
import { ensureKernelWakeSchedule } from "./kernel-wake-schedule";
import {
	relevanceRecallStorageKey,
	type StoredRelevanceRecall,
	toStoredRelevanceRecall,
	usablePreviousRelevanceRecall,
} from "./relevance-recall-store";
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
	loadRuntimeSubmissionBridge,
	loadTurnWork,
} from "./kernel-lazy";
import { createProgressPersistenceTracker } from "./progress-persistence";
import { createProgressThrottle } from "./progress-throttle";
import {
	boundKernelActiveTurn,
	INITIAL_KERNEL_STATE,
	type KernelActiveTurn,
	type KernelState,
} from "./kernel-state";
import { abortKernelTurn } from "./turn-abort";
import { PageToolBroker } from "@tedix/chat-transport/page-tool-broker";

/**
 * Durable per-turn watchdog bound. The kernel's per-LLM-pass abort guards (llm-guard.ts withIdleAbort /
 * AbortSignal.timeout, ~70s) are in-isolate timers: when a reasoning-model provider stall opens a connection and then
 * emitting no bytes) parks the inline `await runKernelTurnWork` and the DO is then hibernated/evicted/redeployed before
 * the 70s timer fires, the timer dies with the isolate — nothing aborts, nothing settles, and the run sits silently
 * `running` until the 15-min crash sweep mislabels it "DO eviction". This DO alarm survives isolate death (durable
 * schedule) and force-fails the still-running turn with a clear "Model unavailable" signal. Set well above the
 * worst-case healthy turn (route ≤70s + read-loop ≤80s ≈ 150s) so a legitimately slow turn is never clipped, and well
 * under the 15-min lease so the operator learns fast.
 */
const KERNEL_TURN_WATCHDOG_SECONDS = 240;
/** A person tapping confirm in the chat; well inside the turn watchdog. */
const HOME_PAGE_TOOL_CONFIRM_TIMEOUT_MS = 120_000;
const KERNEL_TURN_STUCK_DETAIL =
	"No response from the language model within the timeout — the model (AI Gateway / Azure) appears to be unavailable. Your message is saved; please try again shortly.";

// ─────────────────────────────────────────────────────────────────────────────
// Inbox-wake constants — phase-1 (dark, additive, flag-gated)
// ─────────────────────────────────────────────────────────────────────────────

/** ms from turn-end to stranded-wake alarm fire. */
const INBOX_WAKE_STRANDED_DELAY_MS = 500;
/** Storage key for the stranded-wake flag (persists across hibernation). */
const INBOX_WAKE_STRANDED_KEY = "inboxWakeStranded";
/** Storage key for the conversationId associated with a pending stranded wake. */
const INBOX_WAKE_STRANDED_CONV_KEY = "inboxWakeStrandedConv";

/**
 * Non-blocking planner flag. When "true", `processTurn` schedules the planner off the DO turn body via `schedule(0,
 * "runPlannerStep")` and returns an async-dispatch sentinel, so `enqueueMessage` acks immediately and the org's single
 * DO thread is freed for concurrent Home turns instead of being held for the full planner pass. Default off. Relies on
 * the `super.alarm()` schedule dispatch added to this file's `alarm()` — a scheduled `runPlannerStep` only fires
 * because of it.
 */
function kernelAsyncPlannerEnabled(env: CloudflareEnv): boolean {
	return (
		(env as unknown as Record<string, string>).KERNEL_ASYNC_PLANNER === "true"
	);
}

/**
 * Marker property set on `processTurn`'s return value when the planner was scheduled async (not run inline).
 * `enqueueMessage` reads it to return the ack path. Kept as a bare string literal (mirrored verbatim in
 * kernel-runtime.ts) so neither module has to import it from the other — kernel-do already imports from kernel-runtime,
 * and a value import back would be a cycle.
 */
const KERNEL_ASYNC_DISPATCH_MARKER = "kernelAsyncDispatched";

/**
 * Steady-state batch interval for durable answer-delta persistence. The first delta flushes immediately; later deltas
 * use one D1 write per 1s window instead of per-token, bounding the cost (e.g. a 5s answer ≈ 6 rows). Gated by {@link
 * kernelAnswerDeltaPersistEnabled} (KERNEL_ANSWER_DELTA_PERSIST).
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

function kernelErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Type alias preserving the conceptual `KernelDO` name for type-only imports (`DurableObjectNamespace<KernelDO>`). The
 * RUNTIME class was renamed to `KernelDOv2` in DO migration v9 (apps/api/wrangler.jsonc) — a state-preserving
 * `renamed_classes` rename whose only purpose is to force the continuously-active org-scoped kernel DO to restart onto
 * current code. An active org DO never hibernates (continuous org turns + reconcile alarms), so it otherwise keeps
 * executing stale code across deploys; the rename evicts the old instance and the next `idFromName(org)` boots a fresh
 * DO (new code) over the migrated storage.
 */
export type KernelDO = KernelDOv4;

function historyCheckpointStorageKey(conversationId: string): string {
	return `history-checkpoint:${conversationId}`;
}

export class KernelDOv4 extends AIChatAgent<CloudflareEnv, KernelState> {
	override initialState: KernelState = INITIAL_KERNEL_STATE;

	/**
	 * Re-arm persisted child-completion delivery on every cold activation. `kernel_wake_queue` is canonical and is written
	 * before the child notifier calls this DO. Consequently the RPC that activates a cold instance can recover a
	 * previously dropped alarm before `scheduleWakeAlarm()` itself is entered. This keeps the five-minute reconciliation
	 * sweep as a backstop, not the normal recovery path.
	 */
	override async onStart(): Promise<void> {
		// Warm the turn-context module on every cold activation so the first `processTurn` on this instance does not pay the
		// dynamic import between `enqueuedAt` and `workStartedAt`. Not awaited: the import is memoized and `turnContext()`
		// joins it.
		void this.turnContextModule().catch(() => {});
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
	 * Per-turn abort controllers, keyed by runId. Created in `runPlannerStep` around the `runKernelTurnWork` call and
	 * removed in its `finally` — a DO is single-threaded per isolate, so a plain in-memory `Map` is safe (no cross-request
	 * race). `cancelTurn` aborts the entry for a runId if one is still live; a turn that already settled (or never ran on
	 * this isolate — e.g. after an `abortIfStaleCode` restart) simply has no entry, and the cancel is a fail-soft no-op
	 * there (the existing pre-materialize cancel gate + durable submission-ledger abort stamp still own correctness in
	 * that case — see docs/engineering/cognition/kernel-execution-model.md "Operator cancel").
	 */
	private readonly turnAbortControllers = new Map<string, AbortController>();
	/**
	 * Open page tool calls of Home turns running on this DO: Home asks the person's page, the page answers through
	 * `resolvePageTool`. In memory on purpose: a call outlives neither its turn nor this isolate.
	 */
	private readonly pageToolBroker = new PageToolBroker();

	/**
	 * Synthetic per-turn context: the DO has no inbound oRPC request — auth already happened in the RPC handler for
	 * `processTurn`. `createContext` only needs the env to build the D1 client; the placeholder request supplies
	 * headers/url shape. Deliberately no `waitUntil`: `DurableObjectState.waitUntil` is a lifetime no-op, and this
	 * instance can be aborted (`ctx.abort` version reset) or idled between turns — a promise detached under a fake
	 * waitUntil is silently dropped (live-observed: auto-titles vanishing without a breadcrumb). Deps that branch on
	 * `context.waitUntil` (e.g. the conversation auto-title sink in `buildKernelTurnWorkDeps`) therefore fall into their
	 * awaited path here, which is the correct durability lever. Do not thread `this.ctx.waitUntil` in.
	 */
	private async turnContext(): Promise<BaseContext> {
		const { createContext } = await this.turnContextModule();
		return createContext(new Request("https://kernel.internal/turn"), this.env);
	}

	/**
	 * The `../rpc/context` module, imported once per isolate. Kept dynamic so the DO's eager module graph stays small;
	 * memoized so only the first caller (normally `onStart`) pays the import and every turn after it resolves on a settled
	 * promise. A failed import is dropped so the next caller retries instead of inheriting a poisoned promise.
	 */
	private contextModule: Promise<typeof import("../rpc/context")> | null = null;

	private turnContextModule(): Promise<typeof import("../rpc/context")> {
		this.contextModule ??= import("../rpc/context").catch((error: unknown) => {
			this.contextModule = null;
			throw error;
		});
		return this.contextModule;
	}

	/**
	 * Version-triggered self-restart — retires the DO-rename tax (v9/v10/…). Why: a Durable Object only loads new code
	 * when it shuts down + restarts (docs: durable-objects/concepts/durable-object-lifecycle — "New Worker deployments
	 * with code updates" cause a shutdown, but only once the DO leaves memory, which needs 10s idle + no
	 * setTimeout/WebSocket/in-flight-fetch/ outbound-connection). This org DO is continuously active, so it never
	 * hibernates → keeps stale code across deploys. Renaming the class forced a fresh instance; this replaces that. How:
	 * `this.env.CF_VERSION_METADATA.id` is this instance's own code version (fixed at construction). The edge caller
	 * (`enqueueMessage`) is always on the latest deployed version and passes its id as `callerVersionId`. If they differ,
	 * a newer deployment is live but this instance is stale → `ctx.abort` forcibly resets it (docs:
	 * durable-objects/api/state — "forcibly reset a Durable Object"; uncatchable). The current turn errors out and
	 * re-drives on the fresh instance (persist-first run row + durable submission ledger make it idempotent). No loop: a
	 * freshly-booted instance has own===latest. Benign if the binding ever reports latest instead of own — it simply
	 * no-ops.
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

	private blockedDescendantsHost() {
		const owner = this;
		return {
			storage: this.ctx.storage,
			get state() {
				return owner.state;
			},
			idName: this.ctx.id.name,
			env: this.env,
			setState: (state: KernelState) => this.setState(state),
			turnContext: () => this.turnContext(),
			ensureStorageAlarm: (targetMs: number) =>
				this.ensureStorageAlarm(targetMs),
		};
	}

	private async processBlockedDescendantAlarm(): Promise<void> {
		return processBlockedDescendantAlarm(this.blockedDescendantsHost());
	}

	async mirrorChildApprovalBlocked(input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId: string;
		delegatedTediId?: string | null;
	}): Promise<void> {
		return mirrorChildApprovalBlocked(this.blockedDescendantsHost(), input);
	}

	async clearChildApprovalBlocked(input: {
		parentConversationId: string;
		childRunId: string;
		approvalRequestId?: string | null;
	}): Promise<void> {
		return clearChildApprovalBlocked(this.blockedDescendantsHost(), input);
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
		// Streaming-answer accumulator: each `progress.answerDelta` (from the planner's streamObject pass / the delivery
		// chunker) is appended so the throttled (≥1s coalesced) push always carries the full answer-so-far — a coalesced push
		// must not drop intermediate deltas. boundKernelActiveTurn caps the retained progress length. The durable run row
		// keeps the final answer; this accumulator is never persisted.
		let answer = "";
		// `turnContext()` intentionally has no waitUntil. Track every D1 write started by the synchronous progress seam and
		// await the tracker from the async turn finalizer so a DO reset/eviction cannot drop dark SSE data.
		const persistence = createProgressPersistenceTracker();
		// Post-settlement work the turn body hands over (`deps.holdAfterSettle`: auto-title, trace evidence). `end()` parks
		// its drain on the DO's own `waitUntil` so the settled answer returns to the caller at once while the DO stays alive
		// until the work completes — held, never detached. Awaiting it here cost every turn the title LLM call and the trace
		// bundle write (~4 s measured) after the run row was already terminal.
		const afterSettle = createProgressPersistenceTracker();
		// Durable answer-delta batcher: flushes the first answerDelta immediately, then persists `message.delta` events every
		// ~1s. One write per steady-state window, not per token. Fail-soft — never affects the turn.
		const persistEnabled = kernelAnswerDeltaPersistEnabled(this.env);
		const deltaBatcher = createAnswerDeltaBatcher({
			flushIntervalMs: ANSWER_DELTA_FLUSH_INTERVAL_MS,
			persist: (chunk, seq) => {
				// Stage-timing mark before the persist gate: the flush moment is what the first-token latency instrumentation
				// measures, whether or not durable delta persistence is enabled. First occurrence only.
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
		// Provisional rationale batcher. Same shape and same ~1s cadence as the answer batcher above (first chunk immediate
		// so the operator sees the decision forming instead of a blank screen; one write per later window). The planner's
		// rationale is a sentence or two produced early in the pass, so this adds a couple of `message.reasoning` rows per
		// run — deliberately the same order as today's answer deltas, because `listKernelRuntimeEvents` pages by OFFSET and
		// rows_read grows quadratically in rows-per-run. Display only: nothing reads these rows back into the transcript, the
		// ledger, accounting or approvals.
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
		// Phase transitions: one durable `message.phase` row per DISTINCT phase (a repeated milestone in the same phase is a
		// label refresh, not a transition).
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
				// Never accumulated into `answer`: the provisional rationale is a display line, not the turn's text.
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
			// End-of-stream flush (turn-work `flushStreamedProgress`): runs synchronously after the planner pass and before the
			// terminal row is stamped, so the trailing partial persists ahead of message.completed.
			flush: (): void => {
				deltaBatcher.flush();
				rationaleBatcher.flush();
			},
			end: async (): Promise<void> => {
				deltaBatcher.end();
				rationaleBatcher.end();
				throttle.end();
				await persistence.drain();
				this.ctx.waitUntil(afterSettle.drain());
			},
			holdAfterSettle: (work: Promise<void>): void => afterSettle.track(work),
		};
	}

	/**
	 * Run one kernel-eligible Home turn inside the DO's own execution context. The caller (`enqueueMessage`) has already
	 * done the persist-first inserts and passes the run identity in `input` — this method never mints ids and never
	 * double-inserts. Returns the same result shape the inline path produces, so `enqueueMessage` can return it verbatim.
	 */
	async processTurn(input: KernelTurnWorkInput): Promise<KernelTurnWorkResult> {
		const enteredAtMs = Date.now();
		// Self-restart onto current code if a newer deployment is live (retires the DO-rename tax — see abortIfStaleCode).
		// Must run before any work/persist so the reset is clean; the edge re-drives the turn on the fresh instance.
		this.abortIfStaleCode(input.callerVersionId);
		this.setState({ ...this.state, organizationId: input.organizationId });
		// Start the semantic recall now — before the turn body's dynamic module imports, `turnContext()`, the intercept reads
		// and everything else on the way to context assembly. One recall can take seconds; started inside assembly it becomes
		// the whole `planning → preparing_context` stage. Started here it overlaps the enqueue→work gap; assembly takes it
		// only if it has settled (RELEVANCE_RECALL_BUDGET_MS, default 0) and otherwise blends the conversation's previous
		// stored recall. The helper never rejects, and `agent-memory.ts` is a dependency-free leaf, so this adds nothing to
		// the DO's eager module graph. Ids only: canonical D1 still hydrates and authorizes every candidate before prompt
		// assembly.
		const relevanceCandidates = this.startIngressRecall(input);
		// Non-blocking planner (flag-gated, default off — see `kernelAsyncPlannerEnabled`): schedule the planner off this RPC
		// so the DO thread is freed immediately and concurrent same-org Home turns interleave instead of serializing behind
		// one planner pass. The work runs in `runPlannerStep` via the alarm (which fires because `alarm()` now calls
		// `super.alarm()`). The persist-first run row is already durable, so the ack `enqueueMessage` builds from the
		// sentinel carries the real run id; the caller recovers the answer via the MCP tasks extension (poll task.id). Every
		// turn is an LLM route now (no fast-path short-circuit), so all turns are eligible for off-thread dispatch when the
		// flag is on.
		if (kernelAsyncPlannerEnabled(this.env)) {
			await this.schedule(0, "runPlannerStep", input);
			return {
				[KERNEL_ASYNC_DISPATCH_MARKER]: true,
			} as unknown as KernelTurnWorkResult;
		}
		return this.runPlannerStep(input, relevanceCandidates, enteredAtMs);
	}

	/**
	 * Kick off this turn's Agent Memory recall from the raw operator message. Returns `undefined` (assembly starts its own
	 * recall) when the binding or the message is absent. Never rejects. The recall takes seconds (p50 ~5.4 s measured) and
	 * assembly no longer waits for it, so its result is stored per conversation when it settles and the NEXT turn blends
	 * it (`previousRelevanceRecall`). The store runs under `waitUntil`, after this turn's prompt is built or long after
	 * the turn settled; it never writes into the turn that started it.
	 */
	private startIngressRecall(
		input: KernelTurnWorkInput,
	): Promise<AgentMemoryCandidate[]> | undefined {
		const agentMemory = (this.env as { AGENT_MEMORY?: AgentMemoryNamespace })
			.AGENT_MEMORY;
		if (!agentMemory || !input.content.trim()) return undefined;
		const candidates = startRelevanceRecall(agentMemory, {
			orgId: input.organizationId,
			query: input.content,
			limit: HOME_RELEVANCE_RECALL_CANDIDATE_LIMIT,
		});
		this.ctx.waitUntil(
			this.storeCompletedRecall(
				input.conversationId,
				input.content,
				candidates,
			),
		);
		return candidates;
	}

	/** Persist a settled recall for the conversation's next turn. Fail-soft. */
	private async storeCompletedRecall(
		conversationId: string,
		query: string,
		candidates: Promise<AgentMemoryCandidate[]>,
	): Promise<void> {
		try {
			const row = toStoredRelevanceRecall({
				conversationId,
				query,
				candidates: await candidates,
				completedAt: Date.now(),
			});
			if (!row) return;
			await this.ctx.storage.put(
				relevanceRecallStorageKey(conversationId),
				row,
			);
		} catch (error) {
			console.warn(
				"[kernel] relevance recall store failed (next turn uses static facts)",
				kernelErrorMessage(error),
			);
		}
	}

	/**
	 * The conversation's persisted compaction checkpoint, or null. Fail-soft:
	 * assembly then replays the full history and compaction starts over.
	 */
	private async readPersistedHistoryCheckpoint(
		conversationId: string,
	): Promise<KernelHistoryCheckpoint | null> {
		try {
			const stored = await this.ctx.storage.get<KernelHistoryCheckpoint>(
				historyCheckpointStorageKey(conversationId),
			);
			return stored && typeof stored.summary === "string" ? stored : null;
		} catch (error) {
			console.warn(
				"[kernel] history checkpoint read failed (full replay this turn)",
				kernelErrorMessage(error),
			);
			return null;
		}
	}

	/** Persist a new compaction checkpoint for the conversation's next turn. */
	private async storePersistedHistoryCheckpoint(
		conversationId: string,
		checkpoint: KernelHistoryCheckpoint,
	): Promise<void> {
		try {
			await this.ctx.storage.put(
				historyCheckpointStorageKey(conversationId),
				checkpoint,
			);
		} catch (error) {
			console.warn(
				"[kernel] history checkpoint store failed (next turn refolds)",
				kernelErrorMessage(error),
			);
		}
	}

	/**
	 * The conversation's frozen inventory snapshot, or null. Fail-soft: the
	 * turn then takes a new snapshot (one prefix-cache miss).
	 */
	private async readInventorySnapshot(
		conversationId: string,
	): Promise<HomeInventorySnapshot | null> {
		try {
			const stored = await this.ctx.storage.get<unknown>(
				inventorySnapshotStorageKey(conversationId),
			);
			return isUsableInventorySnapshot(stored) ? stored : null;
		} catch (error) {
			console.warn(
				"[kernel] inventory snapshot read failed (new snapshot this turn)",
				kernelErrorMessage(error),
			);
			return null;
		}
	}

	private async storeInventorySnapshot(
		conversationId: string,
		snapshot: HomeInventorySnapshot,
	): Promise<void> {
		try {
			await this.ctx.storage.put(
				inventorySnapshotStorageKey(conversationId),
				snapshot,
			);
		} catch (error) {
			console.warn(
				"[kernel] inventory snapshot store failed (next turn retakes it)",
				kernelErrorMessage(error),
			);
		}
	}

	/**
	 * The conversation's last completed recall, or null when absent, expired
	 * (30 min cap) or unreadable. Fail-soft: assembly then uses static facts.
	 */
	private async readPreviousRelevanceRecall(
		conversationId: string,
	): Promise<StoredRelevanceRecall | null> {
		try {
			const stored = await this.ctx.storage.get<unknown>(
				relevanceRecallStorageKey(conversationId),
			);
			return usablePreviousRelevanceRecall(stored, {
				conversationId,
				now: Date.now(),
			});
		} catch (error) {
			console.warn(
				"[kernel] relevance recall read failed (static facts this turn)",
				kernelErrorMessage(error),
			);
			return null;
		}
	}

	/**
	 * Run one kernel-eligible Home turn body — the route decision, optional write proposal, direct read, completion patch,
	 * and transcript events. Invoked either inline by `processTurn` (default) or as a scheduled callback dispatched from
	 * `alarm()` when the async planner flag is on. Public because the agents-SDK schedule callback is resolved by method
	 * name. The body is identical to the former inline `processTurn` — only the call site moved.
	 */
	async runPlannerStep(
		input: KernelTurnWorkInput,
		/** Ingress-started recall from `processTurn`; absent on the scheduled
		 * (async-planner / alarm) path, where assembly starts its own. */
		relevanceCandidates?: Promise<AgentMemoryCandidate[]>,
		/** `processTurn` entry clock: splits enqueue→work into edge→DO and DO→work. */
		enteredAtMs?: number,
	): Promise<KernelTurnWorkResult> {
		this.setState({ ...this.state, organizationId: input.organizationId });
		// The scheduled (alarm) path has no ingress recall: start one here so its
		// late result still lands in storage for the conversation's next turn.
		const candidatesInFlight =
			relevanceCandidates ?? this.startIngressRecall(input);
		const [
			context,
			previousRelevanceRecall,
			previousHistoryCheckpoint,
			previousInventorySnapshot,
		] = await Promise.all([
			this.turnContext(),
			this.readPreviousRelevanceRecall(input.conversationId),
			this.readPersistedHistoryCheckpoint(input.conversationId),
			this.readInventorySnapshot(input.conversationId),
		]);
		// One stage-timing collector per turn, shared between the turn body (which marks the serial stage boundaries and
		// attaches the snapshot to the run's terminal metadata write) and the progress seam's answer-delta batcher (which
		// marks the first durable flush). Advisory, in-memory only.
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
		// Arm the durable stall watchdog (fail-soft): a DO alarm that fires even if this isolate is evicted mid-turn while
		// parked on a hung provider fetch — the case the in-isolate per-pass abort guards cannot cover. Cancelled in
		// `finally` on normal completion; if it still fires, `failStuckTurn`'s CAS no-ops a turn that already settled.
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
		// Per-turn abort controller (docs/engineering/cognition/kernel-execution-model.md "Operator cancel"): registered
		// before the turn body runs so a `cancelTurn(runId)` RPC landing concurrently (this DO is single-threaded, but the
		// RPC and this method interleave at `await` points) can always find it. `plannerAbortSignal` is threaded into
		// `runKernelTurnWork`'s deps → `runKernel` → `planKernelRoute`, which combines it with its own internal timeout/idle
		// signals.
		const abortController = new AbortController();
		this.turnAbortControllers.set(input.runId, abortController);
		// Clear active progress and the stall watchdog exactly once, on success
		// (before the late timing marks) and on failure (from `finally`).
		let turnEnded = false;
		const endTurn = async (): Promise<void> => {
			if (turnEnded) return;
			turnEnded = true;
			await progress.end();
			if (watchdogId) {
				try {
					await this.cancelSchedule(watchdogId);
				} catch {
					// Best-effort: if the cancel is missed, failStuckTurn's CAS no-ops a turn that already reached a terminal status.
				}
			}
		};
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
					holdAfterSettle: progress.holdAfterSettle,
					plannerAbortSignal: abortController.signal,
					...(input.pageTools?.length
						? {
								pageToolRelay: (call, signal) =>
									this.pageToolBroker.request({
										runId: input.runId,
										name: call.name,
										args: call.args,
										confirm: call.confirm,
										// A confirm waits for a person, inside the turn watchdog.
										...(call.confirm
											? { timeoutMs: HOME_PAGE_TOOL_CONFIRM_TIMEOUT_MS }
											: {}),
										signal: signal ?? abortController.signal,
										emit: (event) => {
											void loadHomeLiveEvents()
												.then((m) =>
													m.recordHomePageToolRequest(context, {
														organizationId: input.organizationId,
														conversationId: input.conversationId,
														runId: input.runId,
														callId: String(event.callId),
														name: call.name,
														args: call.args,
														confirm: call.confirm,
														createdAt: new Date().toISOString(),
													}),
												)
												.catch((error) => {
													console.warn(
														"[kernel] page tool request not recorded",
														kernelErrorMessage(error),
													);
													this.pageToolBroker.resolve(
														input.runId,
														String(event.callId),
														{
															ok: false,
															content: "The page could not be reached.",
														},
													);
												});
										},
									}),
							}
						: {}),
					...(candidatesInFlight
						? { relevanceCandidates: candidatesInFlight }
						: {}),
					...(previousRelevanceRecall ? { previousRelevanceRecall } : {}),
					...(previousHistoryCheckpoint ? { previousHistoryCheckpoint } : {}),
					onHistoryCheckpoint: (checkpoint) =>
						this.ctx.waitUntil(
							this.storePersistedHistoryCheckpoint(
								input.conversationId,
								checkpoint,
							),
						),
					...(previousInventorySnapshot ? { previousInventorySnapshot } : {}),
					onInventorySnapshot: (snapshot) =>
						this.ctx.waitUntil(
							this.storeInventorySnapshot(input.conversationId, snapshot),
						),
					// This DO is the org's single kernel instance, so the cache it
					// reads through is the one `invalidateContextCache` reaches.
					contextCache: getKernelContextCache(),
					stageTimings,
				},
				input,
			);
			// Reconciliation scheduling must not delay the turn response.
			this.ctx.waitUntil(this.afterTurnMaintenance(input.organizationId));
			// Inbox-wake: if a child completion was stranded while this turn ran, arm the wake alarm so it fires shortly after
			// the turn ends. onTurnEnded is fail-soft (never throws).
			this.ctx.waitUntil(this.onTurnEnded(input.conversationId));
			await endTurn();
			// Late stage marks (after the terminal write took its snapshot) ride on the in-memory result only: the enqueue
			// response shows where the time after `completedAt` went; the run row is never rewritten.
			stageTimings.mark("doEnded");
			const metadata = result?.run?.metadata;
			const timings =
				metadata && typeof metadata === "object"
					? (metadata as Record<string, unknown>).kernelTurnTimings
					: undefined;
			if (timings && typeof timings === "object") {
				const snapshot = timings as Record<string, unknown>;
				result.run.metadata = {
					...(metadata as Record<string, unknown>),
					kernelTurnTimings: {
						...snapshot,
						stages: {
							...(snapshot.stages as Record<string, number> | undefined),
							...stageTimings.lateStages(),
						},
						...(enteredAtMs !== undefined
							? { doEnterToWorkMs: stageTimings.startedAtMs - enteredAtMs }
							: {}),
					},
				} as typeof result.run.metadata;
			}
			return result;
		} finally {
			await endTurn();
			// Only remove our own controller — a redriven turn with the same runId (persist-first idempotency: same run row
			// re-enters runPlannerStep) could otherwise delete a fresher controller registered by the new pass after this stale
			// `finally` runs.
			if (this.turnAbortControllers.get(input.runId) === abortController) {
				this.turnAbortControllers.delete(input.runId);
			}
		}
	}

	/**
	 * Abort an in-flight kernel turn's LLM pass. Best-effort RPC called from `cancelKernelRunCore` (`kernel-runtime.ts`)
	 * after it durably marks the run row `canceled` — this only stops the wasted token burn; the actual cancel settle is
	 * owned by the turn body's pre-materialize cancel gate (which sees the already-`canceled` DB row regardless of whether
	 * this RPC ever reaches the DO or finds a live controller). Follows the same public-RPC-entrypoint pattern as
	 * `processTurn` — see `abortIfStaleCode` for the sibling "self-correct via DO RPC" convention. Fail-soft by
	 * construction: a runId with no live controller (turn already settled, never ran on this isolate, or ran on a
	 * since-evicted isolate) is a normal no-op, not an error — the caller must never fail the cancel RPC over this.
	 * Returns whether a live controller was actually aborted, for logging/observability only.
	 */
	async cancelTurn(runId: string): Promise<boolean> {
		this.pageToolBroker.cancelRun(runId);
		return abortKernelTurn(this.turnAbortControllers, runId);
	}

	/**
	 * The person's page answers one page tool call of a Home turn running here. The router authorized the caller for the
	 * run's conversation; this accepts only an open call of that run, once.
	 */
	async resolvePageTool(
		runId: string,
		callId: string,
		result: { ok: boolean; content: string },
	): Promise<boolean> {
		return this.pageToolBroker.resolve(runId, callId, {
			ok: result.ok === true,
			content: String(result.content ?? "").slice(0, 16_000),
		});
	}

	/**
	 * A write path changed one of the slow-changing context inputs (tedi, app, skill, workflow, policy pack, organization
	 * row). Bump the org's cache version so the next Home turn re-reads from D1 instead of waiting out the TTL. Called
	 * fire-and-forget by `invalidateKernelContextCache`.
	 */
	async invalidateContextCache(reason: string): Promise<void> {
		const organizationId =
			this.state.organizationId ?? this.ctx.id.name ?? null;
		if (!organizationId) return;
		getKernelContextCache().invalidate(organizationId);
		console.info({
			component: "kernel.context",
			event: "cache_invalidated",
			reason,
		});
	}

	/**
	 * Durable stall watchdog (DO-alarm callback, looked up by name). Force-fails a kernel turn that is still active past
	 * {@link KERNEL_TURN_WATCHDOG_SECONDS} — the provider-stall-then-isolate-eviction class that the in-isolate per-pass
	 * abort guards cannot cover (they die with the isolate). Status-guarded so it never touches a turn that already
	 * settled (a watchdog/completion race) and never terminalizes a parked `requires_approval` turn. Writes a clear "Model
	 * unavailable" signal (not the generic crash-sweep "DO eviction") so the operator can tell a provider outage from a
	 * deploy. Fail-soft throughout.
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

	private async ensureReconciliationSchedule(
		organizationId: string,
	): Promise<void> {
		return ensureReconciliationSchedule(
			{
				getSchedules: () => this.getSchedules(),
				schedule: (delay, callback, payload) =>
					this.schedule(delay, callback, payload),
			},
			organizationId,
		);
	}

	/** Existing maintenance invokes this independently of turn and execution settlement. */
	async reconcileRequests(payload: {
		organizationId: string;
	}): Promise<number> {
		const { reconcileDueHomeKernelRequests } =
			await import("./request-home-source");
		return reconcileDueHomeKernelRequests(
			await this.turnContext(),
			payload.organizationId,
		);
	}

	/** Scheduled callback; reconciliation retains the same durable schedule name. */
	async reconcileRuns(payload: { organizationId: string }): Promise<void> {
		return reconcileRuns(
			{
				turnContext: () => this.turnContext(),
				schedule: (delay, callback, input) =>
					this.schedule(delay, callback, input),
				ensureReconciliationSchedule: (id) =>
					this.ensureReconciliationSchedule(id),
			},
			payload,
		);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Inbox-wake lifecycle — phase-1 (dark, additive, flag-gated)
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Called by `notifyKernelChildComplete` (cognitive-runtime.ts) via DO RPC when a delegated child run reaches a
	 * terminal state. Writes to kernel_wake_queue (already done by the caller before this RPC), then schedules a short
	 * debounced DO alarm: if an earlier alarm is already pending at a sooner time, skip. If an active turn is running for
	 * the conversation, set the stranded flag so `onTurnEnded` arms the alarm instead. Public so the DO RPC binding can
	 * call it via stub.scheduleWakeAlarm(…).
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
	 * DO alarm handler: drain unacked wake-queue rows for the org, build a synthetic "[System: N delegated task(s)
	 * completed — results in inbox]" parent turn, inject it via `startKernelTurn` + `this.processTurn`, then ack the rows
	 * after the turn completes. Custom inbox timers remain fail-soft, but SDK `super.alarm()` failures are rethrown after
	 * custom timers run so non-OOM schedule errors stay visible and the Agents alarm-boundary memory-reset semantics are
	 * not masked.
	 */
	async alarm(): Promise<void> {
		let sdkAlarmError: unknown;
		const rethrowSdkAlarmError = () => {
			if (sdkAlarmError !== undefined) throw sdkAlarmError;
		};
		// Dispatch SDK callbacks first, including wakeKernelTimers. Kernel timers are named schedules in the lifecycle queue,
		// so SDK maintenance cannot overwrite an earlier inbox deadline. The no-op wake is retired before custom processing
		// below schedules its next deadline. Keep this boundary to also drain raw alarms persisted before the SDK migration.
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
	 * Called at the end of a successful kernel turn to arm a stranded wake alarm if one was deferred while the turn was
	 * running. Called by `processTurn` after the turn body completes — the stranded flag and conversationId are read from
	 * DO storage, then cleared. If the flag is set, an alarm at now+500ms is scheduled so the queued completions are
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
