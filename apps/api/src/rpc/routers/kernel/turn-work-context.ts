export const KERNEL_RUNTIME_BACKEND = "custom";

import type {
	DirectKernelWriteInput,
	executeDirectKernelWrite,
} from "./write-approval-settlement";
import type { KernelHistoryCheckpoint } from "./context-compaction";
import type { AgentMemoryCandidate } from "../../../integrations/cloudflare/agent-memory";
import type { StoredRelevanceRecall } from "../../../kernel/relevance-recall-store";
import type { KernelContextCache } from "../../../kernel/context-cache";
import type { KernelTraceBundleEvidence } from "./kernel-trace-bundle-writer";
import type {
	TediRunStatus,
	TediMessageAttachment,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import type {
	HarnessSubjectTraceBundle,
	HarnessSubjectVersion,
} from "@tedix/api-contract/schemas/harness-version";
import type {
	HomePlan,
	HomeRun,
	KernelRuntimeEvent,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type {
	KernelGovernancePolicy,
	KernelWriteApprovalDecision,
} from "@tedix/api-contract/utils/approval-policy";
import type { DbClient } from "@tedix/db/client";
import type { KernelRuntimeRunUpdate } from "@tedix/db/queries/kernel-runtime-runs";
import type { KernelTurnStageTimings } from "../../../kernel/turn-stage-timings";
import type { AutoDelegationDispatcher } from "./auto-dispatch";
import type { HomeDelegationAgentReview } from "./delegation-approver";
import type { runKernel } from "./index";
import type { WorkflowConfirmDispatcher } from "./workflow-confirm";
import type {
	KernelWriteProposal,
	planKernelWriteProposal,
} from "./write-proposal";

/**
 * Advisory mid-turn progress milestone. Emitted via the optional
 * {@link KernelTurnWorkDeps.onProgress} seam so a DO-processed turn can push
 * live "what is the kernel doing" state to connected clients while the run
 * row sits at its persist-first `running` snapshot. Stages are operator-grade
 * labels ("Planning route", "Reading globex", …), not a machine contract —
 * consumers must treat them as display text.
 */
/**
 * Machine-readable turn phase vocabulary. Mirrors `CHAT_RUNTIME_PHASES` in
 * `packages/chat-transport/src/runtime-frames.ts` (the cross-surface contract
 * the OS renders from); apps/api does not depend on that package, so the
 * values are restated here and pinned by `turn-work.test.ts`. Labels stay
 * display text; the phase is the stable contract.
 */
export const KERNEL_TURN_PHASES = [
	"preparing_context",
	"planning",
	"generating",
	"using_tool",
	"delegating",
	"finalizing",
] as const;
export type KernelTurnPhase = (typeof KERNEL_TURN_PHASES)[number];

export interface KernelTurnProgress {
	stage: string;
	detail?: string;
	/**
	 * Optional machine-readable phase for the milestone. Coarse milestones that
	 * map onto the shared vocabulary carry it; KernelDO persists a
	 * `message.phase` live event per phase transition. Absent ⇒ display-only
	 * stage text (legacy milestones).
	 */
	phase?: KernelTurnPhase;
	/**
	 * Optional answer token delta — the streaming-answer variant. Emitted by the
	 * planner's single `streamObject` pass (answer_in_home) and the deterministic
	 * delivery chunker, so the Tedix OS can render the answer progressively
	 * instead of as one block. Delivery only: the durable run row keeps the final
	 * answer. Coarse milestones omit it.
	 */
	answerDelta?: string;
	/**
	 * Optional provisional rationale delta — the planner's `rationale` field as
	 * it streams, forwarded on every route (including the ones whose `answer`
	 * is null for the whole pass). Display only: it is never the durable answer
	 * and never feeds the ledger, accounting, approvals or cost attribution.
	 * The settled route supersedes it; an abort discards it.
	 */
	rationaleDelta?: string;
}

/** Runtime-event insert shape the turn body needs (subset of the full insert
 * helper input in `./run-store`, injected via `buildKernelTurnWorkDeps` in
 * `kernel-runtime.ts`). */
export interface HomeTurnRuntimeEventInput {
	id?: string;
	organizationId: string;
	kind:
		| "message.completed"
		| "run.completed"
		| "run.failed"
		| "approval.requested";
	conversationId: string;
	runId?: string;
	messageId?: string;
	delegatedTediId?: string;
	childRunId?: string;
	payload?: Record<string, unknown>;
	runtimeMetadata?: Record<string, unknown>;
	createdAt?: string;
}

/**
 * Explicit dependencies for {@link runKernelTurnWork}. `kernel` and
 * `writeProposalPlanner` must be read through the kernel-runtime test seams at
 * call time (`activeKernel` / `activeKernelWriteProposalPlanner`) so the
 * existing `kernelRuntimeTestHooks` stubbing keeps working.
 */
export interface KernelTurnWorkDeps {
	db: DbClient;
	env: CloudflareEnv;
	kernel: typeof runKernel;
	/**
	 * Semantic recall started at DO ingress (`KernelDO.processTurn`) so the
	 * multi-second Agent Memory call overlaps the pre-planning gap. Forwarded
	 * verbatim to `runKernel` → `assembleHomeContext`; absent on the inline
	 * (non-DO) path, where assembly starts its own.
	 */
	relevanceCandidates?: Promise<AgentMemoryCandidate[]>;
	/**
	 * The conversation's last completed recall read from KernelDO storage at
	 * turn start (age-checked there). Forwarded to `runKernel`.
	 */
	previousRelevanceRecall?: StoredRelevanceRecall | null;
	/** The conversation's persisted compaction checkpoint (KernelDO storage). */
	previousHistoryCheckpoint?: KernelHistoryCheckpoint | null;
	/** Receives a NEW compaction checkpoint so the DO can persist it. */
	onHistoryCheckpoint?: (checkpoint: KernelHistoryCheckpoint) => void;
	/**
	 * Per-org TTL cache for the slow-changing context inputs
	 * (`context-cache.ts`). Supplied by the org `KernelDO`, which is also where
	 * write-path invalidation lands; absent on the inline (non-DO) path.
	 */
	contextCache?: KernelContextCache;
	writeProposalPlanner: typeof planKernelWriteProposal;
	insertKernelRuntimeEvent: (
		input: HomeTurnRuntimeEventInput,
	) => Promise<KernelRuntimeEvent>;
	/**
	 * Optional batched terminal persist: the conditional running→terminal run
	 * patch, the `message.completed` row and the terminal receipt in ONE D1
	 * batch (`run-store.ts` `persistKernelTurnSettlement`). Absent ⇒ the same
	 * three writes run sequentially through `transitionKernelRuntimeRunStatus`
	 * and {@link insertKernelRuntimeEvent}, which is what tests stub.
	 */
	persistTurnSettlement?: (input: {
		holdAfterSettle?: (work: Promise<void>) => void;
		run: {
			id: string;
			organizationId: string;
			fromStatus: "running";
			patch: KernelRuntimeRunUpdate;
		};
		events: readonly [
			assistant: HomeTurnRuntimeEventInput,
			terminal: HomeTurnRuntimeEventInput,
		];
	}) => Promise<{
		assistantEvent: KernelRuntimeEvent;
		terminalEvent: KernelRuntimeEvent;
	}>;
	/**
	 * Optional holder for post-settlement work (conversation auto-title, trace
	 * evidence) that must not delay the settled answer. The promise handed over
	 * never rejects. Inline /rpc path: `context.waitUntil`. KernelDO: a tracker
	 * drained after the live turn state is cleared and before the RPC returns,
	 * because a promise detached in a DO can be dropped on abort/idle. Absent ⇒
	 * the turn body awaits the work itself before resolving.
	 */
	holdAfterSettle?: (work: Promise<void>) => void;
	resolveKernelWriteAnchorTediId: (
		organizationId: string,
	) => Promise<string | null>;
	homeToolWriteApprovalRequestId: (runId: string) => Promise<string>;
	homeRunProgress: (input: {
		eventCount: number;
		status: TediRunStatus | undefined;
	}) => {
		current: number;
		detail: string;
		label: string;
		total: number;
	};
	kernelWriteCardContent: (input: {
		approvalRequestId: string;
		proposal: Pick<
			KernelWriteProposal,
			"appSlug" | "args" | "toolName" | "outputTitle"
		>;
	}) => string;
	errorMessage: (value: unknown) => string;
	offsetIso: (baseIso: string, offsetMs: number) => string;
	/**
	 * Real wall-clock "now" as an ISO string, read at turn settle. The turn's
	 * `createdAt`/`assistantAt`/`completedAt` inputs are persist-first
	 * placeholders minted before this work runs (`createdAt`, +1ms, +2ms — see
	 * `startKernelTurn`), so they collapse the multi-second turn into ~2ms. The
	 * body-execution telemetry stamps its `endedAt`/`durationMs` from this clock
	 * instead, giving true end-to-end latency. Injected for deterministic tests.
	 */
	nowIso: () => string;
	/**
	 * Writes/reads the active org-scoped Kernel harness subject version. This is
	 * fail-soft evidence plumbing: a DB/schema rollout issue must not break a Home
	 * turn, but successful writes stamp `bodyExecutionResult.harnessVersionId`.
	 */
	ensureKernelHarnessVersion?: (input: {
		organizationId: string;
		routerVersion: string;
		createdAt: string;
	}) => Promise<{ version: HarnessSubjectVersion; bumped: boolean } | null>;
	recordKernelTraceBundle?: (
		bundle: HarnessSubjectTraceBundle,
	) => Promise<void>;
	writeKernelTraceBundle?: (
		evidence: KernelTraceBundleEvidence,
	) => Promise<string | null>;
	/**
	 * Optional advisory progress sink (runtime wiring, deliberately a dep and
	 * not input: `buildKernelTurnWorkDeps` callers stay unchanged, and the DO can
	 * spread it on top — `{ ...buildKernelTurnWorkDeps(ctx), onProgress }`).
	 * Every invocation is fail-soft via {@link emitProgress}: a throwing sink
	 * must never affect the turn. The callback is also threaded into the kernel
	 * call so routing can report progress.
	 */
	onProgress?: (progress: KernelTurnProgress) => void;
	/**
	 * Optional end-of-stream hook for the durable answer/rationale delta
	 * batches (`kernel-do.ts` `startTurnProgress`). Called exactly once per
	 * turn, synchronously, the moment the planner pass has returned and before
	 * the settle wall clock is read or the terminal `message.completed` row is
	 * inserted — so the batcher's trailing partial is stamped ahead of the
	 * terminal row in the `(createdAt, id)` stream. Readers latch on the
	 * terminal row, so a later flush is dropped as a straggler (measured; see
	 * `docs/engineering/cognition/kernel-execution-model.md`).
	 * Fail-soft: a throwing hook never affects the turn.
	 */
	flushStreamedProgress?: () => void;
	/**
	 * Optional autonomous-dispatch sink. Production wiring injects this for
	 * Kernel→tedi delegation; the authorization gate is the typed
	 * `shouldAutoDispatch` verdict, not an environment switch. Tests may omit the
	 * sink to exercise recognition-only behavior.
	 */
	dispatchAutoDelegation?: AutoDelegationDispatcher;
	/**
	 * Stop an auto-delegated child that was admitted while the parent cancel was
	 * racing the dispatch request. This is the immediate fence; run-set
	 * reconciliation remains the durable retry/backstop if this call or its
	 * metadata persist fails.
	 */
	stopCanceledAutoDelegation?: (input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
		childConversationId: string | null;
		reason: string;
	}) => Promise<{
		attempted: boolean;
		outcome: "succeeded" | "failed" | "skipped";
		error?: string;
	}>;
	/**
	 * Optional Work-Item eager-create sink for a router-decided single delegation.
	 * Mirrors the explicit `delegateToTediId` path's `createDelegationWorkItem`
	 * (kernel-runtime.ts): a `delegate_tedi` route whose verdict auto-dispatches
	 * produces no Work Item without this. Keyed to the child run id
	 * (`sourceIntentId`) so it is idempotent across a re-fired turn. Fail-soft:
	 * the helper returns null on any error, so a Work-Item write never breaks the
	 * turn. Absent in tests that don't exercise auto-dispatch tracking.
	 */
	createDelegationWorkItem?: (input: {
		assigneeTediId: string;
		childRunId: string;
		content: string;
		conversationId: string;
		createdAt: string;
		executionRequirement: ExecutionRequirement;
		homeRunId: string;
		objectiveId?: string;
		organizationId: string;
		workItemId?: string;
	}) => Promise<string | null>;
	/** Predicts the deterministic auto-delegated child run before enqueue so its
	 * Work Item can be created and threaded into the initial child dispatch. */
	predictAutoDelegationChildRunId?: (input: {
		homeRunId: string;
		delegatedTediId: string;
	}) => string;
	/**
	 * Optional workflow-confirm dispatcher. When the previous turn produced a
	 * `run_workflow` route (the kernel prompted "Want me to start it?") and the
	 * current turn is a clear affirmative, this dispatches the named skill workflow.
	 * Absent ⇒ the turn falls through to normal kernel planning (safe — operator
	 * sees the LLM re-confirm or re-route). Fail-soft: a dispatch failure is a
	 * normal error reply, never a turn crash.
	 */
	dispatchWorkflowConfirm?: WorkflowConfirmDispatcher;
	/** Audit-first execution while the admitted turn still owns its running row. */
	executeDirectWrite?: (
		input: DirectKernelWriteInput,
	) => ReturnType<typeof executeDirectKernelWrite>;
	/** Compatibility sink for runtimes without direct execution. Uses the human approval latch. */
	autoResolveKernelWrite?: (input: {
		approvalRequestId: string;
		organizationId: string;
		runId: string;
		conversationId: string;
		decision: KernelWriteApprovalDecision;
	}) => Promise<{
		executed: boolean;
		finalStatus: TediRunStatus | null;
		assistantEvent: KernelRuntimeEvent | null;
	} | null>;
	/**
	 * Optional currently-configured kernel model deployment name — threaded into
	 * the cost advisor so the shadow verdict's `suggestedModel` field is populated.
	 * Absent when the env is unconfigured (kernel inactive) — advisor records null.
	 */
	currentModelDeployment?: string | null;
	/**
	 * Optional per-turn stage-timing collector (first-token latency
	 * instrumentation — see `kernel/turn-stage-timings.ts`). The KernelDO
	 * creates it so the same collector also receives the answer-delta batcher's
	 * `firstAnswerDeltaFlush` mark from `startTurnProgress`; the inline path
	 * omits it and the turn body creates its own. Advisory only: marks are
	 * in-memory, and the snapshot rides the run's existing terminal metadata
	 * write (`metadata.kernelTurnTimings`) — never an extra D1 write.
	 */
	stageTimings?: KernelTurnStageTimings;
	/**
	 * Optional per-turn operator-abort signal. The KernelDO creates a runId-
	 * keyed `AbortController` around the `runKernelTurnWork` call
	 * (`kernel-do.ts` `runPlannerStep`) and threads its `.signal` here; a
	 * subsequent `cancelTurn(runId)` RPC (called best-effort from
	 * `cancelKernelRunCore`) aborts it. Forwarded verbatim into `deps.kernel`
	 * (`runKernel` → `planKernelRoute`), which combines it with its own
	 * internal timeout/idle signals. Absent on the inline (non-DO) turn-work
	 * path — no per-turn abort there (see
	 * `docs/engineering/cognition/kernel-execution-model.md` "Operator cancel").
	 */
	plannerAbortSignal?: AbortSignal;
	/**
	 * Optional inbox-wake reconciler. When present and the turn carries
	 * `runtimeMetadata.source==="kernel.inboxWakeAlarm"` with a
	 * non-empty `kernelInboxRunIds` array, the turn body calls this instead of the
	 * generic LLM planner. The dep receives the child run IDs from the metadata; it
	 * resolves the parent rows by `childRunId` column and reconciles them.
	 * Returns both the reconciled runs and the set of childRunIds that are freshly
	 * settled (non-terminal before reconcile, terminal after) so the wake intercept
	 * can distinguish new deliveries from ones already handled by the on-read path.
	 * Absent in tests that do not exercise the wake path.
	 */
	reconcileInboxWakeRuns?: (input: {
		organizationId: string;
		childRunIds: string[];
	}) => Promise<{
		runs: Array<HomeRun>;
		freshlySettledBranches?: Array<{
			childRunId: string;
			delegatedTediId: string;
			parentRunId: string;
			required: boolean;
			status: "completed" | "failed" | "canceled";
		}>;
		synthesisBranches?: Array<{
			childRunId: string;
			delegatedTediId: string;
			parentRunId: string;
			required: boolean;
			status: "completed" | "failed" | "canceled";
		}>;
		freshlySettledChildRunIds: ReadonlySet<string>;
		canonicalDirectCompletionChildRunIds?: ReadonlySet<string>;
	}>;
	/**
	 * Optional delegation-synthesis reader. The wake intercept calls this for each completed child run to get the full result
	 * transcript (up to 24 KiB). The transcript is then passed to a bounded LLM synthesis
	 * pass so the operator receives a thorough interpreted answer rather than a bare count.
	 * Absent in tests that do not exercise the synthesis path.
	 * Fail-soft: null return → fall back to count + preview (today's behavior).
	 */
	readChildRunFullResult?: (input: {
		tediId: string;
		runId: string;
		organizationId: string;
	}) => Promise<string | null>;
	/**
	 * Optional child final-message reader. Relay-first (harness contract): when
	 * the wake intercept delivers exactly one freshly-completed child, its final
	 * assistant message is the return value and is relayed verbatim — the LLM
	 * synthesis pass is reserved for multi-child deliveries and for children
	 * that ended without an operator-facing final message. Fail-soft: absent
	 * dep or null return → synthesis/count fallback (prior behavior).
	 */
	readChildRunFinalAssistantMessage?: (input: {
		tediId: string;
		runId: string;
		organizationId: string;
	}) => Promise<string | null>;
	/**
	 * Optional conversation auto-title sink (ChatGPT-parity sidebar labels).
	 * Called after the run row and transcript events are durable, only on turns
	 * that produced a real assistant reply. The dep owns the whole pipeline
	 * (first-exchange guard, cheap LLM call, `conversation.updated` persist)
	 * and must be fail-soft internally — the call site additionally try/catches
	 * so a throwing/rejecting sink can never affect the settled turn.
	 *
	 * Durability contract (who holds the promise):
	 * - Dep returns `void` ⇒ the dep registered the work with a real
	 *   `waitUntil` (inline /rpc HTTP path) — fire-and-forget, the settle does
	 *   not wait on title completion.
	 * - Dep returns a `Promise` ⇒ the context has no waitUntil (e.g. the
	 *   KernelDO's synthetic `turnContext()`). The turn body hands it to
	 *   {@link holdAfterSettle} (the KernelDO drains it after the live turn
	 *   state clears, before the RPC returns) or, without a holder, awaits it
	 *   itself — so the promise cannot be dropped when the DO is aborted/idled
	 *   between turns. Bounded: the helper has a 10s LLM abort and never throws.
	 * Absent in tests that don't exercise titling.
	 */
	generateConversationTitle?: (input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		userContent: string;
		assistantContent: string;
	}) => Promise<void> | void;
	/**
	 * Tedi principal that asked Home for this turn (`context.tediId`), when a
	 * tedi did. The agent approver must be independent of it.
	 */
	requesterTediId?: string | null;
	/**
	 * Optional agent-review sink for an agent-routable delegation hold with a
	 * resolved approver: creates the held Work Item (accepted, not admitted,
	 * `requiredAuthorities: ["home_delegation"]`) and the Work approval
	 * proposal addressed to the approver tedi. A throw leaves the operator card
	 * (`agentReview.status: "unavailable"`). Absent ⇒ the operator decides.
	 */
	requestDelegationAgentReview?: (
		input: HomeDelegationAgentReviewRequest,
	) => Promise<HomeDelegationAgentReview>;
	/**
	 * Optional approver wake after the run parked. Same durability contract as
	 * {@link generateConversationTitle}: `void` ⇒ parked on a real waitUntil,
	 * a promise ⇒ awaited. The cron redrive re-wakes pending proposals, so a
	 * failed wake is logged, not fatal.
	 */
	wakeDelegationAgentReview?: (input: {
		organizationId: string;
		proposalId: string;
	}) => Promise<void> | void;
}

/** Input of {@link KernelTurnWorkDeps.requestDelegationAgentReview}. */
export interface HomeDelegationAgentReviewRequest {
	organizationId: string;
	conversationId: string;
	homeRunId: string;
	content: string;
	objectiveId?: string;
	approverTediId: string;
	approverTediLabel: string;
	targetTediId: string;
	targetTediLabel: string | null;
	holdReason: string;
	route: {
		risk: string;
		targetActivityId: string | null;
		effortClass: string | null;
		rationale: string;
	};
	workOrder: Record<string, unknown>;
	executionRequirement: ExecutionRequirement;
	requestedAt: string;
	expiresAt: string;
}

/**
 * Everything the former IIFE closed over, made explicit and serializable so it
 * can cross a Durable Object RPC boundary. All identifiers/timestamps are
 * computed by the persist-first phase in `enqueueMessage` (or
 * `startKernelTurn` for WS-initiated turns) — the turn body never mints
 * its own run identity.
 */
export interface KernelTurnWorkInput {
	/** Authorized at ingress; never taken from caller-supplied metadata. */
	selectedWorkspaceDocument?: string | null;
	executionPolicy?: "normal" | "observe_only";
	organizationId: string;
	conversationId: string;
	/**
	 * The edge caller's deployed Worker version id (`env.CF_VERSION_METADATA.id`).
	 * The edge is always on the latest deployment; the KernelDO compares this to its
	 * own boot version and self-restarts (`ctx.abort`) if a newer deployment is live
	 * but the (continuously-active, never-hibernating) DO is still on stale code.
	 * Ignored on the inline turn-work path (only the DO reads it). Optional/absent
	 * → no restart check.
	 */
	callerVersionId?: string | null;
	/** Run id == idempotency key (run row already inserted, status "running"). */
	runId: string;
	userMessageId: string;
	assistantMessageId: string;
	content: string;
	attachments?: TediMessageAttachment[];
	/** Server-validated per-turn model request, carried from Home ingress. */
	modelRef?: string;
	/** Acting user (`context.descopeUserId ?? context.user?.sub`). */
	descopeUserId?: string;
	createdAt: string;
	assistantAt: string;
	completedAt: string;
	/** Always null on the kernel path (no workstation attachment). */
	approvalRequestId: string | null;
	/** Always null on the kernel path. */
	delegationWorkOrder: Record<string, unknown> | null;
	/** Always null on the kernel path (kernelEligible excludes planned turns). */
	homePlan: HomePlan | null;
	runRowMetadata: Record<string, unknown>;
	runtimeMetadata: Record<string, unknown>;
	/**
	 * Parsed governance policy for this turn's org. Used by the fan-out cap and
	 * approval TTL. Absent when no policy pack is configured — fall back to safe
	 * defaults inside the turn body.
	 */
	governancePolicy?: KernelGovernancePolicy | null;
	/**
	 * Conversation-scoped write pre-authorization allowlist (session pre-auth).
	 * Tool entries (`"app:tool"` / `"app:*"`) the operator explicitly trusted for
	 * this conversation; checked before parking a write behind a human card. Absent
	 * ⇒ no session grants ⇒ fail-closed (every write human-gated unless policy
	 * trusts it). See {@link decideKernelWriteApproval}.
	 */
	sessionWriteAllowlist?: string[] | null;
}

/**
 * Fail-soft progress emission: progress is advisory state-push only, so a
 * sink error (broken setState, serialization issue, anything) is swallowed —
 * it must never fail or delay the turn.
 */
export function emitProgress(
	deps: KernelTurnWorkDeps,
	stage: string,
	detail?: string,
	answerDelta?: string,
	phase?: KernelTurnPhase,
): void {
	emitProgressEvent(deps, {
		stage,
		...(detail ? { detail } : {}),
		...(answerDelta ? { answerDelta } : {}),
		...(phase ? { phase } : {}),
	});
}

/** Fail-soft forward of an already-shaped progress event (planner passthrough). */
export function emitProgressEvent(
	deps: KernelTurnWorkDeps,
	progress: KernelTurnProgress,
): void {
	if (!deps.onProgress) return;
	try {
		deps.onProgress(progress);
	} catch {
		// Advisory only — never let a progress sink break the turn.
	}
}
