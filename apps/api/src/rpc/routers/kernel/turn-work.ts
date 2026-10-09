/**
 * kernel turn work — the detached-execution body of
 * `kernelRuntime.enqueueMessage`'s kernel path (route decision, optional write
 * proposal, completion patch, transcript events).
 *
 * Why this is a separate module, and the dated findings behind the ordering
 * below: `docs/engineering/cognition/kernel-execution-model.md`.
 *
 * Contracts:
 *  - Runs in two execution contexts: inline in the HTTP request (awaited +
 *    `context.waitUntil`) and inside `KernelDO.processTurn`, where a
 *    disconnected caller cannot cancel the turn.
 *  - Persist-first: the `message.received` / `run.started` / run-row inserts
 *    happen before this function is called. The run row is patched
 *    running → terminal/requires_approval here with a conditional update, so
 *    operator cancels and double execution cannot clobber a terminal state.
 *  - Dependencies (the `./run-store` insert helpers, render helpers, the
 *    `activeKernel`/`activeKernelWriteProposalPlanner` test seams) are injected
 *    via {@link KernelTurnWorkDeps}; see `buildKernelTurnWorkDeps`.
 *  - This module must not import `kernel-runtime.ts` — the router imports this
 *    module, so a value import back would create a cycle.
 */

import { aggregateTurnUsage } from "./turn-usage";
import {
	type KernelExecutionAttempt,
	kernelSpanContext,
} from "./gateway-attribution";
import type { AgentMemoryCandidate } from "../../../integrations/cloudflare/agent-memory";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { BodyExecutionResult } from "@tedix/api-contract/schemas/body-certification";
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
import {
	decideKernelWriteApproval,
	type KernelGovernancePolicy,
	type KernelWriteApprovalDecision,
	resolveApprovalTtlHours,
	resolveKernelFanOutCap,
} from "@tedix/api-contract/utils/approval-policy";
import { buildBodyExecutionResult } from "@tedix/api-contract/utils/body-execution-result";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { traceBundleId as buildTraceBundleId } from "@tedix/context-core/harness-version";
import type { DbClient } from "@tedix/db/client";
import {
	createApprovalRequest,
	getApprovalRequestById,
} from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	getKernelRuntimeRun,
	type KernelRuntimeRunUpdate,
	transitionKernelRuntimeRunStatus,
} from "@tedix/db/queries/kernel-runtime-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import { priceKernelUsage } from "../../../services/provider-model-pricing";
import {
	kernelRunStatusToSubmissionOutcome,
	settleKernelSubmission,
} from "../../../kernel/runtime-submission-bridge";
import {
	createKernelTurnStageTimings,
	type KernelTurnStageTimings,
	type KernelTurnType,
} from "../../../kernel/turn-stage-timings";
import {
	type AutoDelegationDispatcher,
	type AutoDelegationDispatchResult,
	shouldAutoDispatch,
} from "./auto-dispatch";
import {
	type BillingPolicyDenialCode,
	billingPolicyDenialCode,
} from "./billing-reservation";
import {
	adviseTurnCost,
	type CostAdvisorVerdict,
	readCostAdvisorMode,
} from "./cost-advisor";
import {
	type HomeDelegationAgentReview,
	renderHeldDelegationLine,
} from "./delegation-approver";
import { homeNarrationMetadata } from "./home-narration";
import type { KernelResult, runKernel } from "./index";
import { recordKernelTraceEvidence } from "./kernel-trace-recording";
import { type KernelEnv, kernelModel } from "./llm";
import {
	DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
	nonNullRecord,
} from "./runtime-shared";
import {
	classifyAffirmative,
	readPendingWorkflowHint,
	type WorkflowConfirmDispatcher,
	type WorkflowDispatchResult,
} from "./workflow-confirm";
import type { HomeToolWritePayload } from "./write-executor";
import {
	type KernelWriteProposal,
	type KernelWriteProposalDeclined,
	type planKernelWriteProposal,
	renderWriteDeclined,
	type WriteProposalEnv,
} from "./write-proposal";

const KERNEL_RUNTIME_BACKEND = "custom";
const SYNTHESIS_FALLBACK_BRANCH_CHARS = 800;

function evidenceBackedSynthesisFallback(
	countNotice: string,
	transcriptBlocks: readonly string[],
): string {
	if (transcriptBlocks.length === 0) return countNotice;
	return [
		countNotice,
		"Evidence from delegated branches:",
		...transcriptBlocks.map((block) =>
			block.length > SYNTHESIS_FALLBACK_BRANCH_CHARS
				? `${block.slice(0, SYNTHESIS_FALLBACK_BRANCH_CHARS)}…`
				: block,
		),
	].join("\n\n");
}

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
		proposal: Pick<KernelWriteProposal, "appSlug" | "args" | "toolName">;
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
	/**
	 * Optional trusted-write auto-resolve sink. When a `propose_tool_write` turn's
	 * write is policy-trusted+low-risk or session pre-authorized
	 * ({@link decideKernelWriteApproval}), the turn body has already created the
	 * approval audit row; this dep resolves that same row through the canonical
	 * latch (resolvedBy:'policy') + records the `approval.approved` audit event +
	 * executes via the same settle path a human approval would. Fail-soft: a null
	 * return (or a throw) leaves the row pending so the write stays a human gate —
	 * the audit row is never silently skipped. Absent in tests / when the kernel
	 * write executor is unconfigured — the write then parks as a normal human card.
	 */
	autoResolveKernelWrite?: (input: {
		approvalRequestId: string;
		organizationId: string;
		runId: string;
		conversationId: string;
		decision: KernelWriteApprovalDecision;
	}) => Promise<{
		executed: boolean;
		finalStatus: TediRunStatus | null;
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

/** Explicit or run-stamped parent tedi of a nested delegation. */
function readParentTediId(...sources: Array<unknown>): string | null {
	for (const source of sources) {
		if (source && typeof source === "object") {
			const value = (source as { parentTediId?: unknown }).parentTediId;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return null;
}

/**
 * Fail-soft progress emission: progress is advisory state-push only, so a
 * sink error (broken setState, serialization issue, anything) is swallowed —
 * it must never fail or delay the turn.
 */
function emitProgress(
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
function emitProgressEvent(
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

/**
 * Operator-facing notice when the kernel route decision could not be produced
 * because the configured routing model did not produce a valid decision. There is no heuristic fallback: a turn the
 * LLM never routed settles `failed` with this clear message, so a provider/gateway
 * outage is legible instead of masked by a fabricated answer.
 */
const KERNEL_MODEL_UNAVAILABLE_MESSAGE =
	"I couldn't finish routing this turn because the configured model did not produce a valid route decision. Your message is saved; please retry shortly.";

/**
 * Operator-facing notice when the kernel turn was denied by the workspace's
 * runtime-entitlement/billing admission — a deterministic policy denial, not a
 * provider failure. Kept distinct from {@link KERNEL_MODEL_UNAVAILABLE_MESSAGE}
 * so a suspended billing account never impersonates an infra outage. The turn
 * still settles `failed`.
 */
function renderKernelBillingBlockedMessage(
	code: BillingPolicyDenialCode,
): string {
	return `I couldn't run this turn — runtime inference is blocked for this workspace by its billing/entitlement state (${code}). This is a policy denial, not a provider outage; retrying won't help until the entitlement changes. A workspace administrator can review and update it on the Team page's Runtime entitlement card.`;
}

function durationMs(startedAt: string, endedAt: string): number | null {
	const started = Date.parse(startedAt);
	const ended = Date.parse(endedAt);
	if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
	return Math.max(0, ended - started);
}

function summaryExcerpt(content: string | null | undefined): string | null {
	const trimmed = content?.trim();
	if (!trimmed) return null;
	return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

/**
 * Compact route-decision snapshot for the durable event ledger. The full
 * decision stays on the run row (`metadata.kernelRoute`); this payload is small
 * by design: no answer text, no tool args, no message bodies, rationale capped
 * at ~300 chars. Optional keys (targetTediId/workflowHint) are omitted rather
 * than null when inapplicable. Why it exists:
 * `docs/engineering/cognition/kernel-execution-model.md`.
 */
function compactRouteDecision(
	route: KernelResult["route"] | null | undefined,
): Record<string, unknown> | null {
	if (!route) return null;
	const rationale =
		typeof route.rationale === "string" ? route.rationale.trim() : "";
	return {
		routeKind: route.routeKind,
		confidence: typeof route.confidence === "number" ? route.confidence : null,
		effortClass: route.effortClass ?? null,
		...(route.targetTediId ? { targetTediId: route.targetTediId } : {}),
		...(route.workflowHint ? { workflowHint: route.workflowHint } : {}),
		rationale:
			rationale.length > 300 ? `${rationale.slice(0, 297)}...` : rationale,
	};
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

export type KernelTurnWorkResult = Awaited<
	ReturnType<typeof runKernelTurnWork>
>;

/**
 * Inbox-wake reconciliation intercept — extracted verbatim from the former
 * inline block in {@link runKernelTurnWork}. When the DO alarm handler
 * injected this synthetic turn after one or more child delegations completed,
 * this reconciles the parent runs and settles this run, returning a result.
 * Returns `null` when the turn is not a wake turn (or the dep is absent),
 * so the caller falls through to normal turn processing.
 */
async function runInboxWakeIntercept(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const {
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		content,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
	} = input;

	// ── Inbox-wake reconciliation intercept ───────────────────────────────────
	// When the DO alarm handler injected this synthetic turn after one or more
	// child delegations completed (`source=kernel.inboxWakeAlarm`,
	// `kernelInboxRunIds` in runtimeMetadata), reconcile the parent run rows
	// (found by `childRunId IN kernelInboxRunIds`) against current child-run
	// event evidence, then settle this run and return early — skipping the LLM
	// planner entirely.
	//
	// ID namespace: the dep receives `childRunIds`, not parent run IDs. The dep
	// itself queries parents by `childRunId` column (kernel-runtime.ts).
	//
	// Fail-soft throughout: dep absent → fall through; reconcile error →
	// fail-soft returns []; wake turn still settles as completed.
	const inboxChildRunIds = (() => {
		const ids = runtimeMetadata?.kernelInboxRunIds;
		return Array.isArray(ids) && ids.length > 0
			? ids.filter((id): id is string => typeof id === "string")
			: null;
	})();
	// A wake turn (source kernel.inboxWakeAlarm) must be fully handled here and
	// never fall through to normal routing — even when kernelInboxRunIds is
	// empty/absent (a stale or already-consumed wake). Otherwise the synthetic
	// "[System: … delegated task completed …]" turn reaches answer_in_home and
	// emits a canned "This is Home:" greeting. Empty/absent ids → reconcile []
	// → no fresh delivery → quiet no-op below (never a canned greeting).
	if (
		runtimeMetadata?.source === "kernel.inboxWakeAlarm" &&
		deps.reconcileInboxWakeRuns
	) {
		emitProgress(deps, "Reconciling delegated tasks");
		const {
			runs: reconciledRuns,
			synthesisBranches = [],
			freshlySettledChildRunIds,
			canonicalDirectCompletionChildRunIds = new Set<string>(),
		} = await deps.reconcileInboxWakeRuns({
			organizationId,
			childRunIds: inboxChildRunIds ?? [],
		});

		// Direct runs are delivered by the deterministic completion event on their
		// parent run. Exclude those canonical owners even when this wake is the path
		// that freshly settled them; otherwise the wake would persist the same child
		// answer under its own synthetic run id. The remaining sets are fallback-only
		// direct runs plus plan convergence branches.
		const freshlyCompletedRuns = reconciledRuns.filter(
			(r) =>
				r.status === "completed" &&
				r.childRunId !== null &&
				freshlySettledChildRunIds.has(r.childRunId as string) &&
				!canonicalDirectCompletionChildRunIds.has(r.childRunId as string),
		);
		const freshlyFailedRuns = reconciledRuns.filter(
			(r) =>
				r.status === "failed" &&
				r.childRunId !== null &&
				freshlySettledChildRunIds.has(r.childRunId as string) &&
				!canonicalDirectCompletionChildRunIds.has(r.childRunId as string),
		);
		const directBranchIds = new Set(
			[...freshlyCompletedRuns, ...freshlyFailedRuns]
				.map((run) => run.childRunId)
				.filter((id): id is string => typeof id === "string"),
		);
		// A plan branch is individually persisted as it settles, but Home emits one
		// converged delivery only when the parent plan becomes terminal. At that
		// point synthesisBranches contains every terminal branch, not merely the
		// child whose wake happened to close the plan.
		const planBranches = synthesisBranches.filter(
			(branch) => !directBranchIds.has(branch.childRunId),
		);
		const completedBranches = [
			...freshlyCompletedRuns.flatMap((run) =>
				run.childRunId && run.delegatedTediId
					? [
							{
								childRunId: run.childRunId,
								delegatedTediId: run.delegatedTediId,
							},
						]
					: [],
			),
			...planBranches
				.filter((branch) => branch.status === "completed")
				.map((branch) => ({
					childRunId: branch.childRunId,
					delegatedTediId: branch.delegatedTediId,
				})),
		];
		const freshCompletedCount = completedBranches.length;
		const freshFailedCount =
			freshlyFailedRuns.length +
			planBranches.filter(
				(branch) => branch.status === "failed" || branch.status === "canceled",
			).length;
		const hasNewDelivery = freshCompletedCount > 0 || freshFailedCount > 0;

		const wakeProgress = deps.homeRunProgress({
			eventCount: reconciledRuns.length,
			status: "completed",
		});
		emitProgress(deps, "Finalizing");
		const wakeMeta = {
			...runRowMetadata,
			kernelInboxWake: {
				reconciledChildRunIds: inboxChildRunIds ?? [],
				canonicalDirectCompletionChildRunIds: [
					...canonicalDirectCompletionChildRunIds,
				],
				completedCount: freshCompletedCount,
				failedCount: freshFailedCount,
				// Audit: all child run IDs that were already delivered before this wake
				alreadyDeliveredChildRunIds: (inboxChildRunIds ?? []).filter(
					(id) => !freshlySettledChildRunIds.has(id),
				),
			},
		};
		await transitionKernelRuntimeRunStatus(deps.db, {
			id: runId,
			organizationId,
			fromStatus: "running",
			patch: {
				status: "completed",
				progressValue: wakeProgress.current,
				progressLabel: wakeProgress.label,
				progressDetail: wakeProgress.detail,
				completedAt,
				updatedAt: completedAt,
				metadata: wakeMeta,
			},
		});

		// When there is nothing new to deliver — direct children are already owned
		// by their canonical parent completion events, or every child was handled by
		// a prior reconcile — complete this wake turn quietly: ack the run and emit
		// run.completed but write no assistant message.
		if (!hasNewDelivery) {
			console.warn({
				component: "kernel.turn_work",
				event: "inbox_wake_no_new_delivery",
				inboxChildCount: inboxChildRunIds?.length ?? 0,
				reconciledCount: reconciledRuns.length,
			});
			await deps.insertKernelRuntimeEvent({
				organizationId,
				kind: "run.completed",
				conversationId,
				runId,
				payload: {
					status: "completed",
					approvalRequestId: null,
					inputMessageId: userMessageId,
					outputMessageId: assistantMessageId,
					childConversationId: null,
					childRunId: null,
					error: null,
					delegationError: null,
					delegationWorkOrder: null,
					homePlan,
					// Deterministic wake intercept — no route planner ran this turn.
					route: null,
				},
				runtimeMetadata: { ...runtimeMetadata, wakeNoOp: true },
				createdAt: completedAt,
			});
			// Exactly-once inline settle: this early return skips the shared settle
			// at the end of the turn, and an unsettled wake submission otherwise
			// stays `running` until the reconcile sweep — an operator-visible
			// phantom spinner (fail-soft inside the helper).
			await settleKernelSubmission(deps.db, {
				runId,
				organizationId,
				conversationId,
				outcome: "settled",
			});
			const wakeRun: HomeRun = {
				id: runId,
				organizationId,
				conversationId,
				status: "completed",
				inputMessageId: userMessageId,
				outputMessageId: assistantMessageId,
				delegatedTediId: null,
				childRunId: null,
				runtime: {
					backend: KERNEL_RUNTIME_BACKEND,
					externalId: runId,
					metadata: { ...runtimeMetadata },
				},
				startedAt: createdAt,
				completedAt,
				createdAt,
				updatedAt: completedAt,
				metadata: wakeMeta,
				progress: wakeProgress,
			};
			return {
				idempotencyKey: runId,
				conversationId,
				status: "needs_delegation" as const,
				run: wakeRun,
				homePlan: undefined,
				// Sentinel: no assistant message written to the conversation.
				assistantMessage: {
					id: assistantMessageId,
					organizationId,
					conversationId,
					runId,
					role: "assistant" as const,
					status: "completed" as const,
					content: "",
					runtime: {
						backend: KERNEL_RUNTIME_BACKEND as typeof KERNEL_RUNTIME_BACKEND,
						metadata: {},
					},
					createdAt: completedAt,
					startedAt: completedAt,
					completedAt,
					metadata: {
						wakeNoOp: true,
						homeSubject: true,
						approvalRequestId: null,
						delegatedTediId: null,
						childConversationId: null,
						childRunId: null,
						delegationError: null,
						delegationWorkOrder: null,
						homePlan,
					},
				},
				error: undefined,
			};
		}

		// There is at least one freshly-completed or freshly-failed child — build
		// and deliver the wake message.
		const countParts: string[] = [];
		if (freshCompletedCount > 0)
			countParts.push(
				`${freshCompletedCount} task${freshCompletedCount === 1 ? "" : "s"} completed`,
			);
		if (freshFailedCount > 0) countParts.push(`${freshFailedCount} failed`);
		// Deterministic wake notice — a factual count of the delegated work that
		// just settled (this branch only runs when at least one child finished).
		const fallbackContent =
			countParts.length > 0
				? `Update from delegated work: ${countParts.join(", ")}.`
				: content;
		const convergedPlanParent = synthesisBranches[0]?.parentRunId ?? null;
		const convergedParentRow = convergedPlanParent
			? await getKernelRuntimeRun(deps.db, {
					id: convergedPlanParent,
					organizationId,
				})
			: undefined;
		const convergedParentMetadata = nonNullRecord(convergedParentRow?.metadata);
		const redriveInput = nonNullRecord(convergedParentMetadata?.redriveInput);
		const originalOperatorRequest =
			typeof redriveInput?.content === "string"
				? redriveInput.content.trim()
				: "";

		// Secondary fix — Synthesis path: when there are freshly completed children
		// and the dep is wired, run a bounded LLM synthesis pass that interprets the
		// child's full output for the operator.
		// Fail-soft in every branch: any error falls back to the count.
		// Previously this ran over all completed children (including already-delivered
		// ones); now it runs only over freshlyCompletedRuns, which is the correct set.
		let wakeAssistantContent = fallbackContent;
		// Relay-first (harness contract): a single freshly-completed child's final
		// assistant message is the return value — relay it verbatim instead of
		// re-interpreting the transcript. Synthesis stays for multi-child
		// deliveries (cross-child interpretation) and for children that ended
		// without a final message. Fail-soft: null → synthesis/count below.
		let relayedFinalMessage: string | null = null;
		if (
			freshCompletedCount === 1 &&
			freshFailedCount === 0 &&
			deps.readChildRunFinalAssistantMessage
		) {
			const only = completedBranches[0];
			if (
				only &&
				typeof only.delegatedTediId === "string" &&
				typeof only.childRunId === "string"
			) {
				try {
					relayedFinalMessage = await deps.readChildRunFinalAssistantMessage({
						tediId: only.delegatedTediId,
						runId: only.childRunId,
						organizationId,
					});
				} catch (error) {
					console.warn({
						component: "kernel.turn_work",
						event: "wake_final_message_relay_failed",
						error: safeExceptionTopology(error),
					});
				}
			}
		}
		if (relayedFinalMessage) {
			wakeAssistantContent = relayedFinalMessage;
		} else if (freshCompletedCount > 0 && deps.readChildRunFullResult) {
			try {
				// Collect full transcript blocks even when the model is unavailable or
				// times out. The deterministic fallback must still carry branch evidence,
				// not regress to a bare task count after successful child work.
				const completedWithIds = completedBranches.sort((a, b) =>
					a.childRunId.localeCompare(b.childRunId),
				);
				const transcriptBlocks = (
					await Promise.all(
						completedWithIds.map(async (run) => {
							const fullResult = await deps.readChildRunFullResult?.({
								tediId: run.delegatedTediId,
								runId: run.childRunId,
								organizationId,
							});
							return fullResult
								? `=== Worker: ${run.delegatedTediId} (run ${run.childRunId}) ===\n${fullResult}`
								: null;
						}),
					)
				).filter((block): block is string => block !== null);
				wakeAssistantContent = evidenceBackedSynthesisFallback(
					fallbackContent,
					transcriptBlocks,
				);

				const model = kernelModel(
					deps.env as unknown as KernelEnv,
					undefined,
					organizationId,
				);
				if (model && transcriptBlocks.length > 0) {
					const { tracedAi } = await import("../../../lib/traced-ai");
					const workerBlock = transcriptBlocks.join("\n\n");
					const userBlock = originalOperatorRequest
						? `=== Original operator request ===\n${originalOperatorRequest}\n\n${workerBlock}`
						: workerBlock;
					const abortController = new AbortController();
					const timeoutId = setTimeout(() => abortController.abort(), 15_000);
					try {
						const synthResult = await tracedAi.generateText({
							model: model.model,
							system: DELEGATION_SYNTHESIS_SYSTEM_PROMPT,
							runtimeContext: kernelSpanContext({
								organizationId,
								source: "delegation_synthesis",
							}),
							telemetry: { functionId: "kernel.delegation_synthesis" },
							messages: [{ role: "user", content: userBlock }],
							maxOutputTokens: 1200,
							abortSignal: abortController.signal,
						});
						const synthesized = synthResult.text?.trim();
						if (synthesized) {
							// Use the LLM synthesis verbatim — it is the interpreted
							// operator-facing answer over the children's full output.
							wakeAssistantContent = synthesized;
						}
					} finally {
						clearTimeout(timeoutId);
					}
				}
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "delegation_synthesis_failed",
					error: safeExceptionTopology(error),
				});
				// wakeAssistantContent already set to fallbackContent above
			}
		}

		const wakeAssistantEvent = await deps.insertKernelRuntimeEvent({
			...(convergedPlanParent
				? {
						id: homeRuntimeEventId({
							organizationId,
							kind: "message.completed",
							conversationId,
							runId: convergedPlanParent,
							suffix: "plan-convergence",
						}),
						messageId: `${convergedPlanParent}:plan-convergence:assistant`,
						runId: convergedPlanParent,
					}
				: { messageId: assistantMessageId, runId }),
			organizationId,
			kind: "message.completed",
			conversationId,
			payload: {
				role: "assistant",
				content: wakeAssistantContent,
				channel: "home",
				metadata: {
					...(convergedPlanParent
						? {
								homePlanConvergence: true,
								parentHomeRunId: convergedPlanParent,
								branchRunIds: synthesisBranches.map(
									(branch) => branch.childRunId,
								),
							}
						: {}),
					homeSubject: true,
					approvalRequestId: null,
					delegatedTediId: null,
					childConversationId: null,
					childRunId: null,
					delegationError: null,
					delegationWorkOrder: null,
					homePlan,
				},
			},
			runtimeMetadata: { ...runtimeMetadata },
			createdAt: assistantAt,
		});
		const deliveredAssistantMessageId =
			wakeAssistantEvent.messageId ?? assistantMessageId;
		if (convergedPlanParent) {
			const parentStatus: TediRunStatus = synthesisBranches.some(
				(branch) => branch.required && branch.status !== "completed",
			)
				? "failed"
				: "completed";
			await transitionKernelRuntimeRunStatus(deps.db, {
				id: convergedPlanParent,
				organizationId,
				fromStatus: "running",
				patch: {
					status: parentStatus,
					outputMessageId: deliveredAssistantMessageId,
					preview: wakeAssistantContent,
					progressValue: 100,
					progressLabel: parentStatus === "completed" ? "Complete" : "Failed",
					progressDetail: `${synthesisBranches.length} coordinated assignments converged`,
					completedAt,
					updatedAt: completedAt,
					metadata: {
						...convergedParentMetadata,
						homePlanConvergencePending: false,
						homePlanSynthesizedAt: wakeAssistantEvent.createdAt,
						homePlanSynthesisMessageId: deliveredAssistantMessageId,
						kernelInboxRunIds: synthesisBranches.map(
							(branch) => branch.childRunId,
						),
						source: "kernelRuntime.homePlanConvergence",
					},
				},
			});
		}
		await deps.insertKernelRuntimeEvent({
			organizationId,
			kind: "run.completed",
			conversationId,
			runId,
			payload: {
				status: "completed",
				approvalRequestId: null,
				inputMessageId: userMessageId,
				outputMessageId: deliveredAssistantMessageId,
				childConversationId: null,
				childRunId: null,
				error: null,
				delegationError: null,
				delegationWorkOrder: null,
				homePlan,
				// Deterministic wake intercept — no route planner ran this turn.
				route: null,
			},
			runtimeMetadata: { ...runtimeMetadata },
			createdAt: completedAt,
		});
		// Exactly-once inline settle — same rationale as the quiet no-op branch:
		// this early return never reaches the shared end-of-turn settle, and an
		// unsettled wake submission stays `running` until the reconcile sweep.
		await settleKernelSubmission(deps.db, {
			runId,
			organizationId,
			conversationId,
			outcome: "settled",
		});
		const wakeRun: HomeRun = {
			id: runId,
			organizationId,
			conversationId,
			status: "completed",
			inputMessageId: userMessageId,
			outputMessageId: deliveredAssistantMessageId,
			delegatedTediId: null,
			childRunId: null,
			runtime: {
				backend: KERNEL_RUNTIME_BACKEND,
				externalId: runId,
				metadata: { ...runtimeMetadata },
			},
			startedAt: createdAt,
			completedAt,
			createdAt,
			updatedAt: completedAt,
			metadata: wakeMeta,
			progress: wakeProgress,
		};
		return {
			idempotencyKey: runId,
			conversationId,
			status: "needs_delegation" as const,
			run: wakeRun,
			homePlan: undefined,
			assistantMessage: {
				id: deliveredAssistantMessageId,
				organizationId,
				conversationId,
				runId: wakeAssistantEvent.runId ?? runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: wakeAssistantContent,
				runtime: wakeAssistantEvent.runtime,
				createdAt: wakeAssistantEvent.createdAt,
				startedAt: wakeAssistantEvent.createdAt,
				completedAt,
				metadata: wakeAssistantEvent.payload,
			},
			error: undefined,
		};
	}
	return null;
}

/**
 * Workflow confirm→dispatch intercept — extracted verbatim from the former
 * inline block in {@link runKernelTurnWork}. When the operator's turn is a
 * clear affirmative to a prior `run_workflow` route proposal, dispatches the
 * named skill workflow and settles this run. Returns `null` when the
 * intercept does not apply, so the caller falls through to normal kernel
 * planning.
 */
async function runWorkflowConfirmIntercept(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const {
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		content,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
	} = input;

	// ── Workflow confirm→dispatch intercept ────────────────────────────────────
	// When the operator replied with a clear affirmative ("yes", "go ahead", …)
	// and the most recent completed prior run in this conversation proposed a
	// `run_workflow` route, dispatch the named skill workflow now — skip the LLM
	// planning pass entirely (saves tokens, gives deterministic dispatch).
	//
	// Fail-soft at every gate: missing dep → fall through; read fails → fall
	// through; dispatch fails → normal error reply (never a crash).
	//
	// No double-dispatch: this turn's run row carries `kernelWorkflowConfirm`
	// metadata but no `kernelRoute.run_workflow`, so it shadows the original
	// pending route as the most-recent run — a second affirmative on the next
	// turn reads this run first and finds no pending hint. A re-enqueue of the
	// same runId also can't re-fire: the patch below moves the run off `running`,
	// and the read excludes the current run by id.
	if (deps.dispatchWorkflowConfirm && classifyAffirmative(content)) {
		const pendingHint = await readPendingWorkflowHint(deps.db, {
			organizationId,
			conversationId,
			excludeRunId: runId,
		});
		if (pendingHint) {
			emitProgress(deps, `Starting ${pendingHint} workflow`);
			let dispatchResult: WorkflowDispatchResult | null = null;
			try {
				dispatchResult = await deps.dispatchWorkflowConfirm({
					organizationId,
					conversationId,
					homeRunId: runId,
					workflowSlug: pendingHint,
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "workflow_confirm_dispatch_failed",
					error: safeExceptionTopology(error),
				});
				dispatchResult = {
					workflowRunId: "",
					status: "failed",
					error: deps.errorMessage(error).slice(0, 200),
				};
			}
			if (dispatchResult) {
				const workflowOk = dispatchResult.status === "dispatched";
				const workflowContent = workflowOk
					? `Started — workflow \`${pendingHint}\` is running (run id: ${dispatchResult.workflowRunId}).`
					: `Couldn't start the \`${pendingHint}\` workflow${dispatchResult.error ? `: ${dispatchResult.error}` : "."}`;
				const workflowStatus: "completed" | "failed" = workflowOk
					? "completed"
					: "failed";
				const workflowProgress = deps.homeRunProgress({
					eventCount: 0,
					status: workflowStatus,
				});
				const workflowMeta = {
					...runRowMetadata,
					kernelWorkflowConfirm: {
						workflowSlug: pendingHint,
						workflowRunId: dispatchResult.workflowRunId || null,
						workflowTediId: dispatchResult.workflowTediId ?? null,
						status: dispatchResult.status,
						...(dispatchResult.error
							? { error: dispatchResult.error.slice(0, 200) }
							: {}),
					},
				};
				emitProgress(deps, "Finalizing");
				await transitionKernelRuntimeRunStatus(deps.db, {
					id: runId,
					organizationId,
					fromStatus: "running",
					patch: {
						status: workflowStatus,
						progressValue: workflowProgress.current,
						progressLabel: workflowProgress.label,
						progressDetail: workflowProgress.detail,
						completedAt,
						updatedAt: completedAt,
						metadata: workflowMeta,
					},
				});
				const assistantEvent = await deps.insertKernelRuntimeEvent({
					organizationId,
					kind: "message.completed",
					conversationId,
					runId,
					messageId: assistantMessageId,
					payload: {
						role: "assistant",
						content: workflowContent,
						channel: "home",
						metadata: {
							homeSubject: true,
							approvalRequestId: null,
							delegatedTediId: null,
							childConversationId: null,
							childRunId: null,
							delegationError: null,
							delegationWorkOrder: null,
							homePlan,
						},
					},
					runtimeMetadata: { ...runtimeMetadata },
					createdAt: assistantAt,
				});
				await deps.insertKernelRuntimeEvent({
					organizationId,
					kind: "run.completed",
					conversationId,
					runId,
					messageId: assistantMessageId,
					payload: {
						status: workflowStatus,
						approvalRequestId: null,
						inputMessageId: userMessageId,
						outputMessageId: assistantMessageId,
						childConversationId: null,
						childRunId: null,
						error: workflowOk
							? null
							: (dispatchResult.error ?? "workflow dispatch failed"),
						delegationError: null,
						delegationWorkOrder: null,
						homePlan,
						// Deterministic confirm→dispatch intercept — no route planner ran
						// this turn (the run_workflow route landed on the prior turn).
						route: null,
					},
					runtimeMetadata: { ...runtimeMetadata },
					createdAt: completedAt,
				});
				const workflowRun: import("@tedix/api-contract/schemas/kernel-runtime").HomeRun =
					{
						id: runId,
						organizationId,
						conversationId,
						status: workflowStatus,
						inputMessageId: userMessageId,
						outputMessageId: assistantMessageId,
						delegatedTediId: null,
						childRunId: null,
						runtime: {
							backend: KERNEL_RUNTIME_BACKEND,
							externalId: runId,
							metadata: { ...runtimeMetadata },
						},
						startedAt: createdAt,
						completedAt,
						createdAt,
						updatedAt: completedAt,
						metadata: workflowMeta,
						progress: workflowProgress,
					};
				return {
					idempotencyKey: runId,
					conversationId,
					status: workflowOk
						? ("needs_delegation" as const)
						: ("failed" as const),
					run: workflowRun,
					homePlan: undefined,
					assistantMessage: {
						id: assistantMessageId,
						organizationId,
						conversationId,
						runId,
						role: "assistant" as const,
						status: "completed" as const,
						content: workflowContent,
						runtime: assistantEvent.runtime,
						createdAt: assistantEvent.createdAt,
						startedAt: assistantEvent.createdAt,
						completedAt,
						metadata: assistantEvent.payload,
					},
					error: undefined,
				};
			}
		}
	}
	return null;
}

/**
 * Pre-materialize cancel gate (P0). An operator cancel that landed while the
 * kernel was in flight already won the run-row status; this settles the turn
 * with a short truthful canceled marker instead of materializing the routed
 * answer/ack. Also the landing spot for an aborted planner pass
 * (`AbortController.abort()` from `KernelDO.cancelTurn` — see
 * `docs/engineering/cognition/kernel-execution-model.md` "Operator cancel"): the aborted
 * kernel call rejects, `kernelResult` is null, but `currentRunStatus` already
 * reads "canceled" (`cancelKernelRunCore` durably marks the run canceled
 * before calling the DO's `cancelTurn`), so this same gate settles it as a
 * clean cancel — never as a model-unavailable provider failure. Returns
 * `null` when the run was not canceled, so the caller falls through to the
 * normal terminal-patch + settle path.
 */
async function runPreMaterializeCancelGate(params: {
	deps: KernelTurnWorkDeps;
	organizationId: string;
	conversationId: string;
	runId: string;
	userMessageId: string;
	assistantMessageId: string;
	createdAt: string;
	assistantAt: string;
	completedAt: string;
	homePlan: HomePlan | null;
	runRowMetadata: Record<string, unknown>;
	runtimeMetadata: Record<string, unknown>;
	canceledBeforeDispatch: boolean;
	currentRunStatus: string | null;
	currentRunMetadata: Record<string, unknown> | null;
	autoDispatchSucceeded: boolean;
	autoDelegatedTediId: string | null;
	autoChildRunId: string | null;
	autoDispatch: AutoDelegationDispatchResult | null;
}) {
	const {
		deps,
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
		canceledBeforeDispatch,
		currentRunStatus,
		currentRunMetadata,
		autoDispatchSucceeded,
		autoDelegatedTediId,
		autoChildRunId,
		autoDispatch,
	} = params;

	// ── Pre-materialize cancel gate (P0) ───────────────────────────────────────
	// An operator cancel that landed while the kernel was in flight already won
	// the run-row status (the terminal patch below is guarded `WHERE
	// status='running'`). Settle the canceled turn with a short truthful marker
	// message: it becomes the turn's completion content, so Tedix OS renders it
	// with no frontend change. No run.completed event is written — the cancel
	// core already emitted run.canceled. Why the gate exists:
	// `docs/engineering/cognition/kernel-execution-model.md`.
	const turnCanceled =
		canceledBeforeDispatch || currentRunStatus === "canceled";
	if (turnCanceled) {
		emitProgress(deps, "Canceled");
		const canceledContent = autoDispatchSucceeded
			? "Turn canceled — stopping the delegated run."
			: "Turn canceled — no work was dispatched.";
		// A dispatch that slipped through before the cancel landed: persist the
		// parent↔child link onto the (already canceled) run row — the cancel core
		// saw childRunId null and skipped its child-stop cascade, and the guarded
		// terminal patch below will never link it. With the link durable, the
		// run-set reconcile stops the still-running child on the next read.
		// Status is deliberately NOT touched (`WHERE status='canceled'`).
		if (autoDispatchSucceeded && autoDelegatedTediId && autoChildRunId) {
			const canceledLinkMetadata = {
				...currentRunMetadata,
				childConversationId: autoDispatch?.childConversationId ?? null,
				childRunId: autoChildRunId,
				delegatedTediId: autoDelegatedTediId,
				delegationStatus: autoDispatch?.status ?? "queued",
				homeAutoDispatch: {
					delegatedTediId: autoDelegatedTediId,
					childRunId: autoChildRunId,
					status: autoDispatch?.status ?? "queued",
					canceledAfterDispatch: true,
				},
			};
			try {
				await transitionKernelRuntimeRunStatus(deps.db, {
					id: runId,
					organizationId,
					fromStatus: "canceled",
					patch: {
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						metadata: canceledLinkMetadata,
					},
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "canceled_child_link_persist_failed",
					error: safeExceptionTopology(error),
				});
			}

			// Do not wait for the next Tedix OS run-set poll to discover the link. The
			// child may finish during that read interval, which previously produced
			// a contradictory `Completed` receipt after the parent was canceled.
			// Stop now through the same canonical cognitiveRuntime.stopRun path;
			// The durable child link above remains the retry/backstop if this
			// best-effort RPC fails or the Worker is interrupted mid-call.
			if (deps.stopCanceledAutoDelegation) {
				try {
					await deps.stopCanceledAutoDelegation({
						organizationId,
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						childConversationId: autoDispatch?.childConversationId ?? null,
						reason: "Parent Home run canceled by operator",
					});
				} catch (error) {
					console.warn({
						component: "kernel.turn_work",
						event: "canceled_child_stop_failed",
						error: safeExceptionTopology(error),
					});
				}
			}
		}
		const canceledEvent = await deps.insertKernelRuntimeEvent({
			organizationId,
			kind: "message.completed",
			conversationId,
			runId,
			messageId: assistantMessageId,
			...(autoDispatchSucceeded && autoDelegatedTediId
				? { delegatedTediId: autoDelegatedTediId }
				: {}),
			...(autoDispatchSucceeded && autoChildRunId
				? { childRunId: autoChildRunId }
				: {}),
			payload: {
				role: "assistant",
				content: canceledContent,
				channel: "home",
				metadata: {
					homeSubject: true,
					turnCanceled: true,
					// One delegation = one row: when the dispatch had already landed
					// this turn also carries the delegation receipt, whose status slot
					// resolves to "Canceled". The prose ("Turn canceled — stopping the
					// delegated run.") restates it, so the read path blanks it. The
					// no-dispatch variant ("Turn canceled — no work was dispatched.")
					// is not stamped: it renders no receipt, so its prose is the only
					// record the operator's cancel landed.
					...(autoDispatchSucceeded
						? homeNarrationMetadata("turn_canceled_delegated")
						: {}),
					approvalRequestId: null,
					delegatedTediId: autoDispatchSucceeded ? autoDelegatedTediId : null,
					childConversationId: autoDispatchSucceeded
						? (autoDispatch?.childConversationId ?? null)
						: null,
					childRunId: autoDispatchSucceeded ? autoChildRunId : null,
					delegationError: null,
					delegationWorkOrder: null,
					homePlan,
				},
			},
			runtimeMetadata: { ...runtimeMetadata, turnCanceled: true },
			createdAt: assistantAt,
		});
		// Exactly-once submission settle: the operator cancel is this run's
		// terminal outcome (fail-soft inside the helper).
		await settleKernelSubmission(deps.db, {
			runId,
			organizationId,
			conversationId,
			outcome: "canceled",
		});
		const canceledProgress = deps.homeRunProgress({
			eventCount: 0,
			status: "canceled",
		});
		const canceledRun: HomeRun = {
			id: runId,
			organizationId,
			conversationId,
			status: "canceled",
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			delegatedTediId: autoDispatchSucceeded ? autoDelegatedTediId : null,
			childRunId: autoDispatchSucceeded ? autoChildRunId : null,
			runtime: {
				backend: KERNEL_RUNTIME_BACKEND,
				externalId: runId,
				metadata: { ...runtimeMetadata, turnCanceled: true },
			},
			startedAt: createdAt,
			completedAt,
			createdAt,
			updatedAt: completedAt,
			metadata: currentRunMetadata ?? runRowMetadata,
			progress: canceledProgress,
		};
		return {
			idempotencyKey: runId,
			conversationId,
			// The enqueue contract's narrow union has no `canceled` member; the
			// neutral terminal (same choice as the quiet inbox-wake no-op) carries
			// the truthful run snapshot (run.status === "canceled", DB authoritative).
			status: "needs_delegation" as const,
			run: canceledRun,
			homePlan: undefined,
			assistantMessage: {
				id: assistantMessageId,
				organizationId,
				conversationId,
				runId,
				role: "assistant" as const,
				status: "completed" as const,
				content: canceledContent,
				runtime: canceledEvent.runtime,
				createdAt: canceledEvent.createdAt,
				startedAt: canceledEvent.createdAt,
				completedAt,
				metadata: canceledEvent.payload,
			},
			error: undefined,
		};
	}
	return null;
}

/**
 * Approved-write layer (v1) — extracted verbatim from the former inline block
 * in {@link runKernelTurnWork}. A `propose_tool_write` route plans one
 * concrete write call and parks it behind a human approval card; the run
 * never executes anything before approval. Fail-soft at every gate: when
 * planning or approval-row creation fails, the turn keeps the
 * recommendation-text fallback behavior (`writeProposal` stays null).
 */
async function planAndParkKernelWriteProposal(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
	kernelResult: KernelResult | null,
	workspaceContext: Parameters<
		typeof planKernelWriteProposal
	>[0]["workspaceContext"],
	executionAttempts: KernelExecutionAttempt[],
): Promise<{
	writeProposal: KernelWriteProposal | null;
	writeProposalDeclined: KernelWriteProposalDeclined | null;
	writeApprovalRequestId: string | null;
}> {
	const { organizationId, conversationId, runId, content, createdAt } = input;
	// Approved-write layer (v1): a propose_tool_write route plans one
	// concrete write call and parks it behind a human approval card —
	// the run never executes anything before approval. Fail-soft at
	// every gate: when planning or approval-row creation fails, the
	// turn keeps today's recommendation-text behavior.
	let writeProposal: KernelWriteProposal | null = null;
	let writeProposalDeclined: KernelWriteProposalDeclined | null = null;
	if (kernelResult?.route?.routeKind === "propose_tool_write") {
		emitProgress(deps, "Drafting write proposal");
		writeProposal = await deps
			.writeProposalPlanner({
				db: deps.db,
				env: deps.env as unknown as WriteProposalEnv,
				organizationId,
				route: kernelResult.route,
				actingUserId: input.descopeUserId,
				content,
				workspaceContext,
				gatewayContext: { organizationId, runId, sessionKey: conversationId },
				onExecutionAttempts: (attempts) => executionAttempts.push(...attempts),
				model:
					kernelModel(
						deps.env as unknown as KernelEnv,
						undefined,
						organizationId,
					)?.model ?? null,
				onDecline: (declined) => {
					writeProposalDeclined = declined;
				},
			})
			.catch((error) => {
				console.warn({
					component: "kernel.turn_work",
					event: "write_proposal_planning_failed",
					error: safeExceptionTopology(error),
				});
				writeProposalDeclined = {
					stage: "error",
					detail: deps.errorMessage(error).slice(0, 200),
				};
				return null;
			});
	}
	let writeApprovalRequestId: string | null = null;
	if (writeProposal) {
		try {
			const anchorTediId =
				await deps.resolveKernelWriteAnchorTediId(organizationId);
			if (anchorTediId) {
				const writeApprovalId =
					await deps.homeToolWriteApprovalRequestId(runId);
				const writePayload: HomeToolWritePayload = {
					kind: "home_tool_write",
					appSlug: writeProposal.appSlug,
					toolName: writeProposal.toolName,
					args: writeProposal.args,
					organizationId,
					homeRunId: runId,
					conversationId,
					initiatedByUserId: input.descopeUserId ?? null,
					transport: writeProposal.transport,
				};
				const existingApproval = await getApprovalRequestById(
					deps.db,
					writeApprovalId,
				);
				if (!existingApproval) {
					const writeApprovalTtlHours = resolveApprovalTtlHours(
						input.governancePolicy,
					);
					await createApprovalRequest(deps.db, {
						id: writeApprovalId,
						tediId: anchorTediId,
						orgId: organizationId,
						actionType: "home.tool_write",
						description: `Approve Kernel write: ${writeProposal.toolName} on ${writeProposal.appSlug}`,
						payload: toJsonRecord(writePayload),
						createdAt,
						expiresAt: deps.offsetIso(
							createdAt,
							writeApprovalTtlHours * 60 * 60 * 1000,
						),
					});
					await insertAuditEvent(deps.db, {
						organizationId,
						actorId: "kernel",
						actorType: "kernel",
						action: "approval.requested",
						resourceType: "approval_request",
						resourceId: writeApprovalId,
						metadata: {
							source: "kernelRuntime.proposeToolWrite",
							actionType: "home.tool_write",
							homeRunId: runId,
							conversationId,
							appSlug: writeProposal.appSlug,
							toolName: writeProposal.toolName,
							riskTier: writeProposal.riskTier,
							initiatedByUserId: input.descopeUserId ?? null,
						},
					});
				}
				writeApprovalRequestId = writeApprovalId;
			} else {
				console.warn({
					component: "kernel.turn_work",
					event: "write_approval_anchor_missing",
				});
			}
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "write_approval_creation_failed",
				error: safeExceptionTopology(error),
			});
			writeApprovalRequestId = null;
		}
	}
	return { writeProposal, writeProposalDeclined, writeApprovalRequestId };
}

/**
 * Run one kernel-eligible Home turn end to end. Behavior-preserving extraction
 * of the `turnWork` IIFE from `kernelRuntime.enqueueMessage` — see module doc.
 */
/**
 * Read side: extract this run's delegation-chain depth from its metadata
 * (stamped by `kernelDelegateRunner` as parent+1). Reads `runRowMetadata` first,
 * then `runtimeMetadata`; a non-numeric/absent value ⇒ 0 (a top-level Home turn).
 */
export function readDelegationDepth(...sources: Array<unknown>): number {
	for (const source of sources) {
		if (source && typeof source === "object") {
			const value = (source as { delegationDepth?: unknown }).delegationDepth;
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
	}
	return 0;
}

export async function runKernelTurnWork(
	deps: KernelTurnWorkDeps,
	input: KernelTurnWorkInput,
) {
	const {
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		content,
		modelRef,
		createdAt,
		assistantAt,
		completedAt,
		approvalRequestId,
		delegationWorkOrder,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
	} = input;

	// Per-stage first-token latency instrumentation (advisory — see
	// kernel/turn-stage-timings.ts). Created at entry so `enqueueToWorkMs`
	// (persist-first insert → turn-body start: edge/DO dispatch + isolate wait)
	// is measured from the true body start. Intercepted turns (inbox wake,
	// workflow confirm) return early and never snapshot — only the main kernel
	// body attaches `metadata.kernelTurnTimings`, on its existing terminal
	// metadata write.
	const stageTimings = deps.stageTimings ?? createKernelTurnStageTimings();

	const persistedExecutionPolicy =
		input.runtimeMetadata.executionPolicy === "observe_only" ||
		input.runRowMetadata.executionPolicy === "observe_only"
			? "observe_only"
			: input.runtimeMetadata.executionPolicy === "normal" ||
				  input.runRowMetadata.executionPolicy === "normal"
				? "normal"
				: undefined;
	const executionPolicy =
		input.executionPolicy ?? persistedExecutionPolicy ?? "normal";
	const observeOnly = executionPolicy === "observe_only";
	{
		const { claimKernelExecutionPolicy } =
			await import("../../../kernel/runtime-submission-bridge");
		await claimKernelExecutionPolicy(deps.db, {
			runId,
			organizationId,
			conversationId,
			idempotencyKey: runId,
			delegatedTediId: null,
			executionPolicy,
		});
	}
	const wakeResult = observeOnly
		? null
		: await runInboxWakeIntercept(deps, input);
	if (wakeResult) return wakeResult;

	const workflowConfirmResult = observeOnly
		? null
		: await runWorkflowConfirmIntercept(deps, input);
	if (workflowConfirmResult) return workflowConfirmResult;

	// Delegation depth: read this run's chain depth once (stamped on the run
	// metadata by kernelDelegateRunner as parent+1). Reused by both the planner's
	// own delegate-decision gate and the auto-dispatch metadata below, so an
	// auto-delegated child inherits parent+1 instead of being re-stamped to 1.
	const currentDelegationDepth = readDelegationDepth(
		runRowMetadata,
		runtimeMetadata,
	);
	const objectiveId =
		typeof runtimeMetadata.objectiveId === "string" &&
		runtimeMetadata.objectiveId.length > 0
			? runtimeMetadata.objectiveId
			: undefined;
	const workspaceContextRecord = nonNullRecord(
		runtimeMetadata.workspaceContext,
	);
	const workspaceWorkpiece = nonNullRecord(workspaceContextRecord?.workpiece);
	const workspaceKind = workspaceWorkpiece?.kind;
	const workspaceContext: Parameters<typeof runKernel>[0]["workspaceContext"] =
		typeof workspaceContextRecord?.workspaceId === "string" &&
		typeof workspaceContextRecord.workspaceName === "string"
			? {
					workspaceId: workspaceContextRecord.workspaceId,
					workspaceName: workspaceContextRecord.workspaceName,
					...((workspaceKind === "gadget" || workspaceKind === "output") &&
					typeof workspaceWorkpiece?.id === "string" &&
					typeof workspaceWorkpiece.name === "string"
						? {
								workpiece: {
									kind: workspaceKind,
									id: workspaceWorkpiece.id,
									name: workspaceWorkpiece.name,
								},
							}
						: {}),
				}
			: undefined;
	emitProgress(deps, "Planning route", undefined, undefined, "planning");
	stageTimings.mark("routePlanStarted");
	// Billing-policy denial thread: the planner rethrows the canonical
	// `Inference blocked by billing policy: <code>` admission denial instead of
	// folding it into the provider-outage null (route-planner.ts). Classify it
	// here so the settle below renders the honest billing notice; every other
	// throw stays the fail-soft null → model-unavailable path.
	const executionAttempts: KernelExecutionAttempt[] = [];
	let billingDenialCode: BillingPolicyDenialCode | null = null;
	const kernelResult = await deps
		.kernel({
			onExecutionAttempts: (attempts) => executionAttempts.push(...attempts),
			attachments: input.attachments,
			...(deps.relevanceCandidates
				? { relevanceCandidates: deps.relevanceCandidates }
				: {}),
			db: deps.db,
			env: deps.env as unknown as Parameters<typeof runKernel>[0]["env"],
			organizationId,
			// Advisory mid-turn progress is re-wrapped through emitProgress so
			// planner emissions inherit the same fail-soft guarantee as milestones.
			// Stage marks piggyback on the same seam: the first planner emission
			// (in practice the post-context-assembly "thinking" milestone) splits
			// context assembly from the LLM call, and the first answerDelta is the
			// turn's first streamed token. mark() is first-occurrence-only.
			onProgress: (progress) => {
				stageTimings.mark("plannerFirstProgress");
				if (progress.answerDelta) stageTimings.mark("firstAnswerDelta");
				emitProgressEvent(
					deps,
					observeOnly && progress.answerDelta
						? { ...progress, answerDelta: undefined }
						: progress,
				);
			},
			// Acting user used for org context and authority assembly.
			descopeUserId: input.descopeUserId,
			content,
			modelRef,
			runId,
			workItemId:
				typeof runtimeMetadata.workItemId === "string"
					? runtimeMetadata.workItemId
					: undefined,
			inferenceSource:
				typeof runtimeMetadata.source === "string"
					? `kernel:${runtimeMetadata.source}`
					: "kernel:route",
			// Kernel conversational memory: the conversation id scopes the
			// bounded history read; the user message id excludes this turn's
			// already-persisted `message.received` row (persist-first ordering
			// above) so it is not duplicated alongside `content`.
			conversationId,
			currentUserMessageId: userMessageId,
			// Per-turn operator abort (docs/engineering/cognition/kernel-execution-model.md
			// "Operator cancel"): absent on the inline turn-work path. When
			// present (KernelDO), combined by planKernelRoute with its own
			// internal timeout/idle signals so a cancel actually stops the
			// in-flight LLM call.
			abortSignal: deps.plannerAbortSignal,
			// Read side: surface this run's chain depth (stamped on the run
			// metadata by kernelDelegateRunner as parent+1) so the kernel's own
			// delegate decision enforces MAX_DELEGATION_DEPTH end-to-end. Read from
			// runRowMetadata first, then runtimeMetadata; absent ⇒ 0 (top-level).
			delegationDepth: currentDelegationDepth,
			parentTediId: readParentTediId(runRowMetadata, runtimeMetadata),
			requesterTediId: deps.requesterTediId ?? null,
			workspaceContext,
			selectedWorkspaceDocument: input.selectedWorkspaceDocument,
		})
		.catch((e) => {
			billingDenialCode = billingPolicyDenialCode(e);
			if (billingDenialCode) {
				console.warn({
					component: "kernel.turn_work",
					event: "billing_policy_denied",
					code: billingDenialCode,
				});
			} else {
				console.warn({
					component: "kernel.turn_work",
					event: "kernel_planner_failed",
					error: safeExceptionTopology(e),
				});
			}
			return null;
		});
	stageTimings.mark("routePlanEnded");
	// The streamed pass is over: persist the trailing answer/rationale partial
	// now, before `settledAt` is read below, so the last delta row sorts ahead
	// of `message.completed` instead of ~0.8s behind it (see the dep's doc).
	if (deps.flushStreamedProgress) {
		try {
			deps.flushStreamedProgress();
		} catch {
			// Advisory only — never let a progress sink break the turn.
		}
	}
	// Harness evidence v1:
	// the route planner stamps a deterministic content-hash `routerVersion` on
	// every successful decision (route-planner.ts → StampedKernelRouteDecision).
	// Lift it to a top-level key on the run/event metadata so persisted evidence
	// is groupable by router version without descending into the nested
	// `kernelRoute` object. JSON-only — no schema change (the runtime D1 tables
	// have no `harness_version_id` column; that's a parked schema slice). The
	// static `KernelResult.route` type is `KernelRouteDecision` and does not
	// surface `routerVersion` (it is stamped post-parse, server-side), so we
	// read it defensively and fail soft: absent/non-string ⇒ null, never throw.
	// Null/absent on answer-less or error turns is backward compatible.
	const routerVersion: string | null = (() => {
		const candidate = (kernelResult?.route as { routerVersion?: unknown })
			?.routerVersion;
		return typeof candidate === "string" ? candidate : null;
	})();
	// Started here, resolved right before the terminal metadata needs it: the
	// ensure is its own D1 round trip and nothing between here and the terminal
	// writes reads it, so it overlaps the write-proposal / dispatch work instead
	// of serializing ahead of it. Fail-soft: null on any failure, never throws.
	const kernelHarnessVersionWork: Promise<HarnessSubjectVersion | null> =
		routerVersion && deps.ensureKernelHarnessVersion
			? Promise.resolve()
					.then(() =>
						deps.ensureKernelHarnessVersion?.({
							organizationId,
							routerVersion,
							createdAt,
						}),
					)
					.then((ensured) => ensured?.version ?? null)
					.catch((error: unknown) => {
						console.warn({
							component: "kernel.turn_work",
							event: "harness_version_ensure_failed",
							error: safeExceptionTopology(error),
						});
						return null;
					})
			: Promise.resolve(null);
	// Per-turn cost advisor (advise / shadow-telemetry mode only).
	// Derives a shadow verdict from the existing route decision — no second LLM
	// call. The verdict is recorded into run metadata below as
	// `kernelCostAdvisor` and never alters the model actually used (applied:false
	// always in this pass). Off by default; flip KERNEL_COST_ADVISOR_MODE=advise
	// to activate shadow telemetry. See kernel/cost-advisor.ts.
	// TODO: implement optimize mode (actually swap the model) once shadow data
	// proves the tier mapping is accurate enough to act on.
	const costAdvisorMode = readCostAdvisorMode(
		deps.env as unknown as Record<string, unknown>,
	);
	let costAdvisorVerdict: CostAdvisorVerdict | null = null;
	if (costAdvisorMode !== "off" && kernelResult?.route) {
		costAdvisorVerdict = adviseTurnCost({
			mode: costAdvisorMode,
			route: kernelResult.route,
			currentModelDeployment: deps.currentModelDeployment ?? null,
		});
	}
	stageTimings.mark("writeProposalPlanStarted");
	const { writeProposal, writeProposalDeclined, writeApprovalRequestId } =
		observeOnly
			? {
					writeProposal: null,
					writeProposalDeclined: null,
					writeApprovalRequestId: null,
				}
			: await planAndParkKernelWriteProposal(
					deps,
					input,
					kernelResult,
					workspaceContext,
					executionAttempts,
				);
	stageTimings.mark("writeProposalPlanEnded");
	const writeProposalActive = Boolean(writeProposal && writeApprovalRequestId);
	const delegationApprovalActive = Boolean(
		!observeOnly &&
		kernelResult?.route?.routeKind === "delegate_tedi" &&
		kernelResult.delegation?.decision.mode === "needs_approval",
	);
	// Trusted-write tier (fail-closed): the audit row is always created above;
	// this decides whether it parks behind a human card (default) or auto-resolves
	// through the same latch (resolvedBy:'policy'). A low-risk write on a policy-
	// trusted tool, or any session pre-authorized tool, removes the per-click tax
	// without losing the audit trail. Everything else stays human-gated.
	const writeApprovalDecision: KernelWriteApprovalDecision | null =
		writeProposal && writeApprovalRequestId
			? decideKernelWriteApproval({
					policy: input.governancePolicy,
					sessionAllowlist: input.sessionWriteAllowlist,
					proposal: {
						appSlug: writeProposal.appSlug,
						toolName: writeProposal.toolName,
						riskTier: writeProposal.riskTier,
					},
				})
			: null;
	const writeWillAutoResolve = Boolean(
		writeProposalActive &&
		writeApprovalDecision?.autoResolve &&
		deps.autoResolveKernelWrite,
	);
	// Agent-in-the-loop review of a held delegation: an agent-routable hold
	// with a resolved approver becomes a held Work Item plus a Work approval
	// proposal for that tedi. Anything that prevents it keeps the operator card.
	const heldDelegation = delegationApprovalActive
		? (kernelResult?.delegation ?? null)
		: null;
	let delegationAgentReview: HomeDelegationAgentReview | null = null;
	if (
		heldDelegation?.decision.approvalRoute === "agent" &&
		heldDelegation.approver
	) {
		const approver = heldDelegation.approver;
		const unavailable = (reason: string): HomeDelegationAgentReview => ({
			status: "unavailable",
			approverTediId: approver.tediId,
			approverTediLabel: approver.label,
			reason: reason.slice(0, 300),
		});
		const boundWorkItemId =
			typeof runRowMetadata.workItemId === "string"
				? runRowMetadata.workItemId
				: typeof runtimeMetadata.workItemId === "string"
					? runtimeMetadata.workItemId
					: null;
		if (!deps.requestDelegationAgentReview) {
			delegationAgentReview = unavailable(
				"agent review is not wired in this runtime",
			);
		} else if (boundWorkItemId) {
			delegationAgentReview = unavailable(
				`this run is already bound to Work Item ${boundWorkItemId}`,
			);
		} else {
			const requestedAt = deps.nowIso();
			const route = kernelResult?.route;
			try {
				delegationAgentReview = await deps.requestDelegationAgentReview({
					organizationId,
					conversationId,
					homeRunId: runId,
					content,
					objectiveId,
					approverTediId: approver.tediId,
					approverTediLabel: approver.label,
					targetTediId: heldDelegation.workOrder.targetTediId,
					targetTediLabel: heldDelegation.workOrder.targetTediLabel ?? null,
					holdReason: heldDelegation.decision.reason,
					route: {
						risk: route?.risk ?? "unknown",
						targetActivityId: route?.targetActivityId ?? null,
						effortClass: route?.effortClass ?? null,
						rationale: route?.rationale ?? "",
					},
					workOrder: heldDelegation.workOrder as unknown as Record<
						string,
						unknown
					>,
					executionRequirement: heldDelegation.workOrder.executionRequirement,
					requestedAt,
					expiresAt: new Date(
						Date.parse(requestedAt) +
							resolveApprovalTtlHours(input.governancePolicy) * 3_600_000,
					).toISOString(),
				});
			} catch (error) {
				console.warn({
					component: "kernel.turn_work",
					event: "delegation_agent_review_request_failed",
					error: safeExceptionTopology(error),
				});
				delegationAgentReview = unavailable(deps.errorMessage(error));
			}
		}
	}
	const agentReviewPending = delegationAgentReview?.status === "pending";
	if (writeProposalActive || delegationApprovalActive) {
		// The approval row exists — the run parks as requires_approval; either a
		// human resolves the card, or (when trusted) the auto-resolve sink settles
		// it in-turn right after parking.
		emitProgress(
			deps,
			writeWillAutoResolve
				? "Auto-approving trusted write"
				: agentReviewPending
					? `Awaiting ${delegationAgentReview?.approverTediLabel ?? "approver"} decision`
					: "Awaiting approval",
		);
	}
	const declinedRecord =
		writeProposalDeclined as KernelWriteProposalDeclined | null;

	// Autonomous delegation dispatch: when the verdict is `auto` and a dispatcher
	// is wired, spawn a supervised child run on the target tedi. Fail-soft — a
	// dispatch error is recorded on the run (homeAutoDispatch.status="failed")
	// and the parent turn is marked failed instead of pretending a handoff was
	// delivered. Dormant by data: tedis default requiresApproval:true, so the gate
	// returns needs_approval (not auto) until a tedi is explicitly opted in via
	// policy.
	//
	// Fan-out cap (a spawn_bounds-style pattern): the dispatch spawn call itself
	// counts as the first delegation, so a cap of N admits N-1 child dispatches
	// per turn. A single kernel auto-dispatch path always issues exactly 1 child,
	// so the cap fires only when maxDelegationsPerTurn < 2 (cap of 1 = the spawn
	// call alone fills it → kill-switch). Fail-closed past the cap: blocked
	// dispatch produces an explicit "fan-out cap reached" error, not a silent drop.
	//
	// KERNEL_MAX_DELEGATIONS: env-configurable override (default 32). Takes
	// precedence over the governance-policy cap when set. Fail-soft: bad value
	// falls through to resolveKernelFanOutCap(governancePolicy).
	const fanOutCap = (() => {
		const raw = (deps.env as unknown as { KERNEL_MAX_DELEGATIONS?: string })
			.KERNEL_MAX_DELEGATIONS;
		if (raw !== undefined && raw !== "") {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n >= 1) return n;
		}
		return resolveKernelFanOutCap(input.governancePolicy);
	})();
	let autoDispatch: AutoDelegationDispatchResult | null = null;
	let autoDelegationWorkItemId: string | null = null;
	const autoDelegation =
		!observeOnly &&
		kernelResult?.delegation &&
		shouldAutoDispatch(kernelResult.delegation)
			? kernelResult.delegation
			: null;
	// Every auto-dispatched child is an MCP-supervised execution. Its credential
	// exchange and runtime binding require the durable `{homeRunId, workItemId}`
	// pair; dispatching a child without the Work Item creates an unauthorizable
	// run that fails before its first tool call. Explicit delegation intent still
	// controls routing, but cannot control this execution-identity prerequisite.
	const mintDelegationWorkItem = Boolean(autoDelegation);
	// Spawn-bound counting (spawn_bounds-style semantics): the dispatch spawn
	// call itself is the first counted delegation, so `fanOutCap < 2` means the
	// spawn call alone fills the cap — no room for this turn's single child.
	const fanOutCapBlocked = fanOutCap < 2;
	// ── Pre-dispatch cancel gate (P0) ──────────────────────────────────────────
	// An operator cancel that lands while the kernel is planning must prevent
	// the child dispatch entirely. Re-read the run row immediately before a
	// dispatch would fire: cancelKernelRunCore durably moves the row to
	// `canceled` while this turn is in flight, so a canceled row here means the
	// operator already aborted — skip the spawn and settle the turn with the
	// canceled marker below. Fail-open on a read error: the dispatch proceeds
	// exactly as today and the post-cancel run-set reconcile (run-store) stops
	// the child on the next read.
	let canceledBeforeDispatch = false;
	if (deps.dispatchAutoDelegation && autoDelegation && !fanOutCapBlocked) {
		try {
			const gateRow = await getKernelRuntimeRun(deps.db, {
				id: runId,
				organizationId,
			});
			canceledBeforeDispatch = gateRow?.status === "canceled";
		} catch {
			canceledBeforeDispatch = false;
		}
	}
	// When canceledBeforeDispatch is true neither branch fires: no dispatch and
	// no fan-out-cap failure record — the turn is already canceled and the
	// canceled settle below owns the terminal transcript state.
	if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation &&
		fanOutCapBlocked
	) {
		// Fail-closed: record an explicit cap-exceeded failure so the run row
		// surfaces the block reason rather than silently completing without dispatch.
		autoDispatch = {
			childRunId: "",
			status: "failed",
			error: `fan-out cap reached: maxDelegationsPerTurn=${fanOutCap} counts the dispatch spawn itself, leaving no room for a child delegation this turn — fan out in waves across turns (raise maxDelegationsPerTurn to widen each wave)`,
		};
	} else if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation &&
		(!deps.createDelegationWorkItem || !deps.predictAutoDelegationChildRunId)
	) {
		// Fail closed rather than creating the known-invalid `homeRunId`-only
		// child context. Production wiring supplies both dependencies; this guards
		// future runtimes and test hosts that accidentally omit the authority mint.
		autoDispatch = {
			childRunId: "",
			status: "failed",
			error:
				"supervised delegation requires Work Item minting and a deterministic child run id",
		};
	} else if (
		!canceledBeforeDispatch &&
		deps.dispatchAutoDelegation &&
		autoDelegation
	) {
		emitProgress(
			deps,
			`Dispatching to `,
			autoDelegation.workOrder.targetTediLabel || undefined,
			undefined,
			"delegating",
		);
		stageTimings.mark("dispatchStarted");
		try {
			if (
				mintDelegationWorkItem &&
				deps.createDelegationWorkItem &&
				deps.predictAutoDelegationChildRunId
			) {
				const predictedChildRunId = deps.predictAutoDelegationChildRunId({
					homeRunId: runId,
					delegatedTediId: autoDelegation.workOrder.targetTediId,
				});
				autoDelegationWorkItemId = await deps.createDelegationWorkItem({
					assigneeTediId: autoDelegation.workOrder.targetTediId,
					childRunId: predictedChildRunId,
					content,
					conversationId,
					createdAt,
					executionRequirement: autoDelegation.workOrder.executionRequirement,
					homeRunId: runId,
					organizationId,
					objectiveId,
				});
			}
			autoDispatch = await deps.dispatchAutoDelegation({
				attachments: input.attachments,
				homeRunId: runId,
				homeConversationId: conversationId,
				userMessageId,
				content,
				delegatedTediId: autoDelegation.workOrder.targetTediId,
				organizationId,
				workOrder: autoDelegation.workOrder,
				...(autoDelegationWorkItemId
					? { workItemId: autoDelegationWorkItemId }
					: {}),
				// Depth propagation: thread this run's chain depth so the child
				// runner stamps the auto-delegated child at parent+1. Without this the
				// child was always stamped 1 and MAX_DELEGATION_DEPTH never bounded the
				// self-propagating auto-delegation runaway.
				delegationDepth: currentDelegationDepth,
			});
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "auto_dispatch_failed",
				error: safeExceptionTopology(error),
			});
			autoDispatch = {
				childRunId: "",
				status: "failed",
				error: deps.errorMessage(error),
			};
		}
		stageTimings.mark("dispatchEnded");
	}
	const autoDelegatedTediId =
		autoDispatch && autoDelegation
			? autoDelegation.workOrder.targetTediId
			: null;
	const autoChildRunId = autoDispatch?.childRunId
		? autoDispatch.childRunId
		: null;
	const autoDispatchSucceeded =
		autoDispatch?.status === "queued" &&
		Boolean(autoDelegatedTediId && autoChildRunId);
	const autoDispatchFailed = autoDispatch?.status === "failed";
	// Work-Item auto-tracking for a router-decided single delegation. The eager
	// create on the explicit `delegateToTediId` path (kernel-runtime.ts) never
	// fires here — a `delegate_tedi` route runs in this turn body, not on that
	// path — so a router-decided delegation was untracked. Mirror it: effective
	// assignee = the resolved-route tedi (`autoDelegatedTediId`). Idempotent
	// (sourceIntentId=childRunId dedupes a re-fired turn) + fail-soft (helper
	// returns null). The plan path is excluded by construction — homePlan turns
	// are not kernelEligible and never reach this body (approvePlanAssignments
	// owns plan Work Items), so there is no double-create.
	autoDelegationWorkItemId ??=
		mintDelegationWorkItem &&
		deps.createDelegationWorkItem &&
		autoDelegation &&
		autoDispatchSucceeded &&
		autoDelegatedTediId &&
		autoChildRunId
			? await deps.createDelegationWorkItem({
					assigneeTediId: autoDelegatedTediId,
					childRunId: autoChildRunId,
					content,
					conversationId,
					createdAt,
					executionRequirement: autoDelegation.workOrder.executionRequirement,
					homeRunId: runId,
					organizationId,
					objectiveId,
				})
			: null;

	// When a propose_tool_write route was declined internally (declinedRecord set,
	// writeProposalActive false), the planner's optimistic "Confirm and I'll
	// prepare it for approval" text must not reach the operator — the write moat
	// held and nothing was created. Render an honest per-stage line instead.
	// When an active human approval exists, use the card. A trusted write that
	// will resolve through policy/session authorization must not falsely tell the
	// operator that a human click is still required; its terminal execution
	// receipt follows through the same audited approval latch. Otherwise, fall
	// back to the honest declined line or the kernel answer.
	// The kernel is LLM-only: a null `kernelResult` means the selected model was
	// unavailable or failed to produce a valid decision. There is no heuristic responder — the turn
	// settles `failed` with a clear model-unavailable notice so the outage is
	// legible rather than masked behind a fabricated answer. The one exception:
	// a billing-policy admission denial (billingDenialCode set) also yields a
	// null kernelResult but renders the honest billing-blocked notice — a policy
	// denial must never impersonate a provider outage.
	const modelUnavailable = !kernelResult;
	const assistantContent = observeOnly
		? `Observation only: Kernel selected ${kernelResult?.route?.routeKind ?? "no route"}. No tools, workflows, approvals, writes, Work Items, or delegations were executed.`
		: modelUnavailable
			? billingDenialCode
				? renderKernelBillingBlockedMessage(billingDenialCode)
				: KERNEL_MODEL_UNAVAILABLE_MESSAGE
			: writeProposalActive && writeProposal && writeApprovalRequestId
				? writeWillAutoResolve
					? `${writeApprovalDecision?.source === "session" ? "Authorized for this conversation" : "Authorized by tenant policy"}: executing \`${writeProposal.toolName}\` on ${writeProposal.appSlug}.`
					: deps.kernelWriteCardContent({
							approvalRequestId: writeApprovalRequestId,
							proposal: writeProposal,
						})
				: declinedRecord && kernelResult?.route
					? renderWriteDeclined(declinedRecord, kernelResult.route)
					: heldDelegation?.approver && !agentReviewPending
						? // The approver could not be engaged: the operator decides.
							renderHeldDelegationLine(
								heldDelegation.workOrder.targetTediLabel?.trim() ||
									"the selected tedi",
								null,
							)
						: (kernelResult?.assistantContent ??
							KERNEL_MODEL_UNAVAILABLE_MESSAGE);
	const dispatchAwareStatus: TediRunStatus = modelUnavailable
		? "failed"
		: writeProposalActive || delegationApprovalActive
			? "requires_approval"
			: autoDispatchSucceeded
				? "queued"
				: autoDispatchFailed
					? "failed"
					: "completed";
	const dispatchAwareProgress = deps.homeRunProgress({
		eventCount: autoDispatchSucceeded ? 1 : 0,
		status: dispatchAwareStatus,
	});
	// Real terminal wall clock. The persist-first `completedAt` argument is a
	// +2ms ordering placeholder minted before the asynchronous turn body starts;
	// exposing it as the run completion timestamp made an 11s turn look like a
	// 2ms turn even though bodyExecutionResult carried the correct duration.
	const settledAt = deps.nowIso();
	const dispatchAwareCompletedAt =
		dispatchAwareStatus === "queued" ||
		dispatchAwareStatus === "requires_approval"
			? null
			: settledAt;
	const dispatchWorkOrder = autoDelegation?.workOrder ?? delegationWorkOrder;
	const terminalPayloadStatus = modelUnavailable
		? "failed"
		: observeOnly
			? "completed"
			: writeProposalActive || delegationApprovalActive
				? "requires_approval"
				: autoDispatchSucceeded
					? "queued"
					: autoDispatchFailed
						? "failed"
						: "needs_delegation";
	// Three independent reads the terminal metadata needs, in flight together:
	// the harness version (started after the kernel returned), the usage price
	// (D1 rate lookups per attempt) and the current run row (metadata merge +
	// cancel gate below). No write touches the run row between here and the
	// cancel gate, so reading it before pricing observes the same state.
	const [kernelHarnessVersion, price, currentRun] = await Promise.all([
		kernelHarnessVersionWork,
		priceKernelUsage(deps.env, { attempts: executionAttempts }),
		getKernelRuntimeRun(deps.db, { id: runId, organizationId }).catch(
			() => undefined,
		),
	]);
	const traceBundleId = kernelHarnessVersion ? buildTraceBundleId(runId) : null;
	// Aggregate routing, ranking, and post-route judgments from unique receipts.
	// Missing provider counters stay unknown instead of understating turn usage.
	const routeUsage = aggregateTurnUsage(
		kernelResult?.routeUsage,
		executionAttempts,
	);
	// Route-decision half of the orchestration trace: a compact snapshot of the
	// kernel's typed route decision for the terminal event payload. Null only
	// when the planner produced no route (model unavailable) — every routed turn
	// (answer_in_home included) carries it.
	const routeDecision = compactRouteDecision(kernelResult?.route);
	// Complete turn total is known only when every execution reports usage.
	const turnTokensUsed: number | null =
		routeUsage?.inputTokens !== null &&
		routeUsage?.outputTokens !== null &&
		routeUsage !== null
			? (routeUsage.inputTokens ?? 0) + (routeUsage.outputTokens ?? 0) || null
			: null;
	const modelCostUsd = price.costUsd;
	// True end-of-turn wall clock. The `createdAt`/`completedAt` inputs are
	// persist-first placeholders (createdAt + 2ms) minted by `startKernelTurn`
	// before this work ran, so deriving duration from them reported ~2ms instead
	// of the real multi-second turn. Stamp the settle moment from the injected
	// clock so body-execution `endedAt`/`durationMs` reflect actual latency.
	// Latency split by what the turn actually was: the route decision, not the
	// dispatch outcome — a delegate_tedi route whose dispatch failed still paid
	// the delegated turn's serial pre-answer work.
	const turnType: KernelTurnType =
		kernelResult?.route?.routeKind === "propose_tool_write"
			? "write_proposal"
			: kernelResult?.route?.routeKind === "delegate_tedi"
				? "delegated"
				: "answer";
	const bodyExecutionResult: BodyExecutionResult = buildBodyExecutionResult({
		id: `${runId}:body-execution-result`,
		bodyKind: "kernel",
		status: modelUnavailable
			? "failed"
			: writeProposalActive
				? "blocked"
				: autoDispatchFailed
					? "failed"
					: "completed",
		runId,
		tediId: null,
		orgId: organizationId,
		conversationId,
		sessionKey: conversationId,
		harnessVersionId: kernelHarnessVersion?.id ?? null,
		traceBundleId,
		startedAt: createdAt,
		endedAt: settledAt,
		durationMs: durationMs(createdAt, settledAt),
		summary: summaryExcerpt(assistantContent),
		structuredResult: {
			homeStatus: dispatchAwareStatus,
			routeKind: kernelResult?.route?.routeKind ?? null,
			routerVersion,
			harnessSubjectKind: kernelHarnessVersion?.subjectKind ?? null,
			harnessSubjectId: kernelHarnessVersion?.subjectId ?? null,
			writeProposalActive,
			autoDispatchStatus: autoDispatch?.status ?? null,
		},
		// Route-planner LLM usage/cost (null fields when the planner fell back).
		...(routeUsage ? { usage: routeUsage } : {}),
		cost: {
			billingType: "included",
			biller: "kernel",
			modelCostUsd,
			totalCostUsd: modelCostUsd,
			pricing: price.pricing,
		},
		error: modelUnavailable
			? billingDenialCode
				? {
						kind: "policy" as const,
						message: `Runtime inference blocked by billing policy (${billingDenialCode})`,
						retryable: false,
					}
				: {
						kind: "model" as const,
						message:
							"Configured kernel model did not produce a valid route decision",
						retryable: true,
					}
			: null,
		session: {
			beforeRef: null,
			afterRef: `kernel_runtime_runs:${runId}`,
			adapterSessionRef: null,
			clearSession: false,
		},
		approvalIds: writeApprovalRequestId ? [writeApprovalRequestId] : [],
		runtimeServices: ["kernel-runtime", "home", "mcp"],
	});
	const turnRunMetadata = {
		...runRowMetadata,
		...(writeProposalActive && writeProposal
			? {
					approvalRequestId: writeApprovalRequestId,
					kernelWriteProposal: {
						appSlug: writeProposal.appSlug,
						toolName: writeProposal.toolName,
						args: writeProposal.args,
						riskTier: writeProposal.riskTier,
						transport: writeProposal.transport,
					},
				}
			: {}),
		// Trusted-write gating decision (auto-resolve vs human gate) for audit.
		...(writeApprovalDecision
			? {
					kernelWriteApproval: {
						autoResolve: writeApprovalDecision.autoResolve,
						source: writeApprovalDecision.source,
						reason: writeApprovalDecision.reason,
						willAutoResolve: writeWillAutoResolve,
					},
				}
			: {}),
		// Fail-soft must not be fail-silent: when a propose_tool_write route
		// produced no card, the run records why (diagnosis without log tails).
		...(declinedRecord
			? {
					kernelWriteProposalDeclined: {
						stage: declinedRecord.stage,
						...(declinedRecord.detail
							? { detail: declinedRecord.detail.slice(0, 200) }
							: {}),
					},
				}
			: {}),
		kernelRoute: observeOnly ? null : (kernelResult?.route ?? null),
		...(observeOnly
			? {
					kernelObservation: {
						selectedRoute: kernelResult?.route ?? null,
						outcome: kernelResult?.route
							? "effects_suppressed"
							: "observation_failed",
					},
				}
			: {}),
		kernelEvidence: null,
		// delegate_tedi authorization evidence: the constructed work order + the
		// fail-closed dispatch verdict (mode auto|needs_approval|blocked). Recorded
		// for observability + the next-slice auto-dispatch; null on non-delegation
		// turns. JSON-only — no schema change (runtime D1 metadata is a JSON bag).
		homeDelegation: observeOnly
			? null
			: kernelResult?.delegation
				? {
						...kernelResult.delegation,
						...(delegationAgentReview
							? { agentReview: delegationAgentReview }
							: {}),
					}
				: null,
		...(observeOnly
			? { executionPolicy: "observe_only", effectsSuppressed: true }
			: {}),
		...(autoDelegatedTediId && autoChildRunId
			? {
					childConversationId: autoDispatch?.childConversationId ?? null,
					childRunId: autoChildRunId,
					delegatedTediId: autoDelegatedTediId,
					delegationStatus: autoDispatch?.status ?? "queued",
				}
			: {}),
		// Linkage: stamp the Work Item id so reconcile resolves it from the
		// run-metadata fast path (resolveDelegationWorkItemId), same as the
		// explicit `delegateToTediId` path. Fallback = sourceIntentId=childRunId.
		...(autoDelegationWorkItemId
			? { workItemId: autoDelegationWorkItemId }
			: {}),
		// Autonomous dispatch outcome (present only when the verdict was `auto`
		// and dispatch was attempted). Records the spawned child run id + status
		// so the operator can follow the supervised run; null on every other turn.
		...(autoDispatch
			? {
					homeAutoDispatch: {
						delegatedTediId: autoDelegatedTediId,
						childRunId: autoChildRunId,
						status: autoDispatch.status,
						...(autoDispatch.error
							? { error: autoDispatch.error.slice(0, 200) }
							: {}),
					},
				}
			: {}),
		// Shadow cost-advisor verdict (advise mode only — never applied).
		// Derived from the existing effortClass/confidence signals; no second LLM
		// call. Present only when KERNEL_COST_ADVISOR_MODE=advise|optimize.
		// Null when mode=off (default) or when no effortClass was produced.
		...(costAdvisorVerdict ? { kernelCostAdvisor: costAdvisorVerdict } : {}),
		// Top-level mirror of the route's content-hash version (also nested in
		// `kernelRoute.routerVersion`) so the run row is queryable by version
		// without descending into the route object. Null on route-less turns.
		...(routerVersion ? { routerVersion } : {}),
		...(kernelResult
			? {
					contextManifest: {
						...kernelResult.contextManifest,
						inputTokens: routeUsage?.inputTokens ?? null,
					},
				}
			: {}),
		...(kernelHarnessVersion
			? {
					harnessVersionId: kernelHarnessVersion.id,
					harnessSubjectKind: kernelHarnessVersion.subjectKind,
					harnessSubjectId: kernelHarnessVersion.subjectId,
				}
			: {}),
		// Per-stage first-token latency snapshot (kernel/turn-stage-timings.ts):
		// turn-type + cold/warm-isolate tags, enqueue→work gap, and ms offsets
		// for each stage boundary the turn passed. Rides this existing terminal
		// metadata write — never a separate persist — and reaches the operator
		// via readRun → Tedix OS loadHomeRun like every other metadata key.
		kernelTurnTimings: stageTimings.snapshot({
			enqueuedAt: createdAt,
			settledAt,
			turnType,
		}),
		bodyExecutionResult,
	};
	const currentRunMetadata = recordOrNull(currentRun?.metadata);
	const currentRunStatus =
		typeof currentRun?.status === "string" ? currentRun.status : null;
	const preMaterializeCanceled = await runPreMaterializeCancelGate({
		deps,
		organizationId,
		conversationId,
		runId,
		userMessageId,
		assistantMessageId,
		createdAt,
		assistantAt,
		completedAt,
		homePlan,
		runRowMetadata,
		runtimeMetadata,
		canceledBeforeDispatch,
		currentRunStatus,
		currentRunMetadata,
		autoDispatchSucceeded,
		autoDelegatedTediId,
		autoChildRunId,
		autoDispatch,
	});
	if (preMaterializeCanceled) return preMaterializeCanceled;
	const mergedTurnRunMetadata = currentRunMetadata
		? { ...currentRunMetadata, ...turnRunMetadata }
		: turnRunMetadata;
	// Last advisory stage before the terminal patch + transcript events land.
	emitProgress(deps, "Finalizing", undefined, undefined, "finalizing");
	// running → terminal/requires_approval only: an operator cancel
	// that landed while the kernel was in flight wins over this patch.
	const runTransition = {
		id: runId,
		organizationId,
		fromStatus: "running" as const,
		patch: {
			status: dispatchAwareStatus,
			progressValue: dispatchAwareProgress.current,
			progressLabel: dispatchAwareProgress.label,
			progressDetail: dispatchAwareProgress.detail,
			completedAt: dispatchAwareCompletedAt,
			updatedAt: settledAt,
			metadata: toJsonRecord(mergedTurnRunMetadata),
			// Parent↔child link columns for reconciliation parity with the forced
			// delegateToTediId path — set only on a successful auto-dispatch.
			...(autoDelegatedTediId && autoChildRunId
				? { delegatedTediId: autoDelegatedTediId, childRunId: autoChildRunId }
				: {}),
		},
	};
	const assistantEventInput: HomeTurnRuntimeEventInput = {
		organizationId,
		kind: "message.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		delegatedTediId: autoDelegatedTediId ?? undefined,
		childRunId: autoChildRunId ?? undefined,
		payload: {
			role: "assistant",
			content: assistantContent,
			channel: "home",
			// Usage invariant: kernel turns always report token counts when the
			// route-planner LLM round-trip succeeds. Null on fail-soft turns only.
			...(turnTokensUsed !== null ? { tokensUsed: turnTokensUsed } : {}),
			// Canonical per-turn usage breakdown (the same `routeUsage` object the
			// bodyExecutionResult carries) under `payload.usage`, so the cognitive
			// ledger's typed `TediRuntimeEvent.usage` field is populated on read.
			// `tokensUsed` stays as the scalar analytics mirror.
			...(routeUsage ? { usage: routeUsage } : {}),
			metadata: {
				homeSubject: true,
				approvalRequestId: writeApprovalRequestId ?? approvalRequestId,
				delegatedTediId: autoDelegatedTediId,
				childConversationId: autoDispatch?.childConversationId ?? null,
				childRunId: autoChildRunId,
				delegationError: autoDispatch?.error ?? null,
				delegationWorkOrder: dispatchWorkOrder,
				homePlan,
				// One delegation = one row. A succeeded auto-dispatch stamps
				// `delegatedTediId` + `childRunId` above, which is exactly what Tedix OS
				// builds the delegation receipt from — so this turn already renders
				// "Delegated to {tedi} · Working…" and the ack prose ("On it —
				// delegating to {tedi} now…") is a duplicate. Gated on the dispatch
				// outcome, not on the ack text: a `needs_approval` delegation writes
				// no child run, renders no receipt, and keeps its prose (it is the
				// only surface asking the operator to approve).
				...(autoDispatchSucceeded &&
				kernelResult?.route?.routeKind === "delegate_tedi"
					? homeNarrationMetadata("delegation_ack")
					: {}),
				...(writeProposalActive && writeProposal
					? {
							kernelWriteProposal: {
								appSlug: writeProposal.appSlug,
								toolName: writeProposal.toolName,
								args: writeProposal.args,
								transport: writeProposal.transport,
							},
						}
					: {}),
			},
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: autoDispatch?.childConversationId,
			delegationStatus: autoDispatch?.status,
			delegationError: autoDispatch?.error,
			delegationWorkOrder: dispatchWorkOrder,
			// Stamp the router version onto the event ledger (not just the run
			// row) so the transcript event carries the harness version too.
			...(routerVersion ? { routerVersion } : {}),
			...(kernelHarnessVersion
				? {
						harnessVersionId: kernelHarnessVersion.id,
						harnessSubjectKind: kernelHarnessVersion.subjectKind,
						harnessSubjectId: kernelHarnessVersion.subjectId,
					}
				: {}),
		},
		// This row is appended after every streamed answer delta. Do not reuse the
		// persist-first `assistantAt` placeholder (+1 ms from enqueue): the durable
		// offset stream is ordered by (createdAt, id), so backdating this late insert
		// places the final frame behind an already-advanced live cursor and leaves OS
		// stuck on the preceding `finalizing` phase forever.
		createdAt: settledAt,
	};
	const terminalEventInput: HomeTurnRuntimeEventInput = {
		organizationId,
		// A model-unavailable turn (no route) emits run.failed; any parked decision
		// emits approval.requested instead of a terminal run event — the run is
		// waiting on the human card; otherwise the turn completed.
		kind: modelUnavailable
			? "run.failed"
			: writeProposalActive || delegationApprovalActive
				? "approval.requested"
				: "run.completed",
		conversationId,
		runId,
		messageId: assistantMessageId,
		delegatedTediId: autoDelegatedTediId ?? undefined,
		childRunId: autoChildRunId ?? undefined,
		payload: {
			status: terminalPayloadStatus,
			approvalRequestId: writeApprovalRequestId ?? approvalRequestId,
			inputMessageId: userMessageId,
			outputMessageId: assistantMessageId,
			childConversationId: autoDispatch?.childConversationId ?? null,
			childRunId: autoChildRunId,
			error: modelUnavailable
				? billingDenialCode
					? `Billing policy denied inference (${billingDenialCode})`
					: "Model unavailable"
				: null,
			delegationError: autoDispatch?.error ?? null,
			delegationWorkOrder: dispatchWorkOrder,
			homePlan,
			// Compact route decision (routeKind/confidence/effortClass/rationale…) —
			// the decision half of the orchestration-trace dataset. `homePlan` above
			// is always null on the kernel path, so without this the persisted
			// run.completed row carried no record of what the kernel decided. The
			// full decision stays in run metadata (`kernelRoute`); the payload stays
			// compact by design.
			route: routeDecision,
			// Usage invariant: carry token counts on the terminal event so analytics
			// queries can sum across run.completed rows without joining message.completed.
			...(turnTokensUsed !== null ? { tokensUsed: turnTokensUsed } : {}),
			// Canonical per-turn usage breakdown promoted into `TediRuntimeEvent.usage`.
			...(routeUsage ? { usage: routeUsage } : {}),
		},
		runtimeMetadata: {
			...runtimeMetadata,
			childConversationId: autoDispatch?.childConversationId,
			delegationStatus: autoDispatch?.status,
			delegationError: autoDispatch?.error,
			delegationWorkOrder: dispatchWorkOrder,
			...(routerVersion ? { routerVersion } : {}),
			...(kernelHarnessVersion
				? {
						harnessVersionId: kernelHarnessVersion.id,
						harnessSubjectKind: kernelHarnessVersion.subjectKind,
						harnessSubjectId: kernelHarnessVersion.subjectId,
					}
				: {}),
		},
		// Keep the terminal receipt strictly after `message.completed` in the same
		// run-local offset stream even when settlement completes within one clock ms.
		createdAt: deps.offsetIso(settledAt, 1),
	};
	// The terminal run patch, `message.completed` and the terminal receipt land
	// together: one D1 batch when the batched persist is wired, otherwise the
	// same three writes in sequence. The stream order (message.completed before
	// the receipt) is carried by `createdAt`, not by write order.
	let assistantEvent: KernelRuntimeEvent;
	let terminalEvent: KernelRuntimeEvent;
	if (deps.persistTurnSettlement) {
		const persisted = await deps.persistTurnSettlement({
			run: runTransition,
			events: [assistantEventInput, terminalEventInput],
		});
		assistantEvent = persisted.assistantEvent;
		terminalEvent = persisted.terminalEvent;
	} else {
		await transitionKernelRuntimeRunStatus(deps.db, runTransition);
		assistantEvent = await deps.insertKernelRuntimeEvent(assistantEventInput);
		terminalEvent = await deps.insertKernelRuntimeEvent(terminalEventInput);
	}
	// Reconcile the auxiliary submission ledger only after the operator-visible
	// transcript is durable. Submission settlement is fail-soft, multi-step
	// (reserve → finalize → `submission.settled`, stamped with the wall clock,
	// so it stays last in the stream) and can contend on D1; it must never
	// hold the answer behind it. Non-terminal kernel statuses leave the
	// submission in flight as before.
	const submissionOutcome =
		kernelRunStatusToSubmissionOutcome(dispatchAwareStatus);
	if (submissionOutcome) {
		await settleKernelSubmission(deps.db, {
			runId,
			organizationId,
			conversationId,
			outcome: submissionOutcome,
		});
	}
	// Post-settlement work that must not delay the settled answer. `holdAfterSettle`
	// (inline path: `context.waitUntil`; KernelDO: a tracker drained after the
	// live turn state clears) keeps each promise alive; without a holder the
	// turn body awaits them before resolving, so nothing is ever detached in a
	// context that could drop it. Every held promise is caught: a lost title or
	// trace bundle is logged, never a broken settle.
	const heldAfterSettle: Promise<void>[] = [];
	const holdAfterSettle = (event: string, work: Promise<unknown>): void => {
		const safe = work.then(
			() => undefined,
			(error: unknown) => {
				console.warn({
					component: "kernel.turn_work",
					event,
					error: safeExceptionTopology(error),
				});
			},
		);
		if (deps.holdAfterSettle) deps.holdAfterSettle(safe);
		else heldAfterSettle.push(safe);
	};
	// Conversation auto-title (ChatGPT parity): when this settle completed the
	// conversation's first exchange and no label exists yet, generate a short
	// title from the exchange, after the terminal patch and transcript events
	// are durable — a lost title is acceptable, a broken settle is not. Skipped
	// on model-unavailable turns (no real reply to summarize). The dep owns the
	// guard + LLM + persist. A `void` return means the dep already parked the
	// work on a real `waitUntil`; a returned promise is held as above (bounded:
	// 10s LLM abort inside). The try/catch shields a synchronously throwing sink.
	if (!modelUnavailable && deps.generateConversationTitle) {
		try {
			const titleWork = deps.generateConversationTitle({
				organizationId,
				conversationId,
				runId,
				userContent: content,
				assistantContent,
			});
			if (titleWork)
				holdAfterSettle("conversation_title_dispatch_failed", titleWork);
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "conversation_title_dispatch_failed",
				error: safeExceptionTopology(error),
			});
		}
	}
	// Wake the approval tedi only after the run parked: its decision resolves
	// against the requires_approval row.
	if (
		agentReviewPending &&
		delegationAgentReview?.proposalId &&
		deps.wakeDelegationAgentReview
	) {
		try {
			const wake = deps.wakeDelegationAgentReview({
				organizationId,
				proposalId: delegationAgentReview.proposalId,
			});
			if (wake) await wake;
		} catch (error) {
			console.warn({
				component: "kernel.turn_work",
				event: "delegation_agent_review_wake_failed",
				error: safeExceptionTopology(error),
			});
		}
	}
	// Trusted-write auto-resolve (after parking): the run is now requires_approval
	// and the approval.requested event has landed — the audit row exists. When the
	// write is policy-trusted+low-risk or session pre-authorized, settle it through
	// the same latch a human approval uses (resolvedBy:'policy'), executing the
	// stored call in-turn. Fail-soft: a null result leaves the row pending so a
	// human can still resolve it — the per-click tax is removed only on a clean
	// auto-resolution, never the audit trail.
	let writeAutoResolveResult: {
		executed: boolean;
		finalStatus: TediRunStatus | null;
	} | null = null;
	if (
		writeWillAutoResolve &&
		writeApprovalRequestId &&
		writeApprovalDecision &&
		deps.autoResolveKernelWrite
	) {
		writeAutoResolveResult = await deps
			.autoResolveKernelWrite({
				approvalRequestId: writeApprovalRequestId,
				organizationId,
				runId,
				conversationId,
				decision: writeApprovalDecision,
			})
			.catch((error) => {
				console.warn({
					component: "kernel.turn_work",
					event: "write_auto_resolve_failed",
					error: safeExceptionTopology(error),
				});
				return null;
			});
	}
	// Trace evidence (R2 folder + D1 bundle index) is read by later harness
	// views, never by the settled answer or the client's next read — held, not
	// awaited.
	if (kernelHarnessVersion && traceBundleId && deps.recordKernelTraceBundle) {
		const traceWork = recordKernelTraceEvidence({
			kernelHarnessVersion,
			traceBundleId,
			recordKernelTraceBundle: deps.recordKernelTraceBundle,
			writeKernelTraceBundle: deps.writeKernelTraceBundle,
			errorMessage: deps.errorMessage,
			organizationId,
			conversationId,
			runId,
			createdAt: completedAt,
			assistantEventId: assistantEvent.id,
			terminalEventId: terminalEvent.id,
			runRowMetadata,
			kernelResult,
			assistantContent,
			bodyExecutionResult,
			outcome:
				writeProposalActive || delegationApprovalActive
					? "escalated"
					: "success",
			routerVersion,
			contextManifest: turnRunMetadata.contextManifest ?? {},
		});
		holdAfterSettle("trace_evidence_record_failed", traceWork);
	}
	// No holder was injected: the turn body itself keeps the post-settlement
	// work alive (each promise is already caught above).
	if (heldAfterSettle.length > 0) await Promise.all(heldAfterSettle);
	// When a trusted write auto-resolved in-turn, the settle hook transitioned the
	// run past requires_approval to its terminal state — reflect that in the
	// returned snapshot so the immediate response isn't a stale "requires_approval".
	// (Fail-soft: no clean execution ⇒ the parked snapshot stands and a human card
	// remains.)
	const autoResolvedStatus =
		writeAutoResolveResult?.executed && writeAutoResolveResult.finalStatus
			? writeAutoResolveResult.finalStatus
			: null;
	const effectiveStatus: TediRunStatus =
		autoResolvedStatus ?? dispatchAwareStatus;
	const effectiveCompletedAt = autoResolvedStatus
		? settledAt
		: dispatchAwareCompletedAt;
	const run: HomeRun = {
		id: runId,
		organizationId,
		conversationId,
		status: effectiveStatus,
		inputMessageId: userMessageId,
		outputMessageId: assistantMessageId,
		delegatedTediId: autoDelegatedTediId,
		childRunId: autoChildRunId,
		runtime: {
			backend: KERNEL_RUNTIME_BACKEND,
			externalId: runId,
			metadata: {
				...runtimeMetadata,
				childConversationId: autoDispatch?.childConversationId,
				delegationStatus: autoDispatch?.status,
				delegationError: autoDispatch?.error,
				delegationWorkOrder: dispatchWorkOrder,
			},
		},
		startedAt: createdAt,
		completedAt: effectiveCompletedAt,
		createdAt,
		updatedAt: settledAt,
		metadata: mergedTurnRunMetadata,
		progress: dispatchAwareProgress,
	};
	return {
		idempotencyKey: runId,
		conversationId,
		// Top-level turn status stays the parked/dispatch snapshot to keep the
		// enqueue contract's narrow union. An auto-resolved write settles the run in
		// the same turn (run.status above reflects it, DB is authoritative); callers
		// reconcile the terminal state on their next read. A model-unavailable turn
		// is a hard failure (no route was produced).
		status: modelUnavailable
			? ("failed" as const)
			: writeProposalActive || delegationApprovalActive
				? ("requires_approval" as const)
				: autoDispatchSucceeded
					? ("queued" as const)
					: autoDispatchFailed
						? ("failed" as const)
						: ("needs_delegation" as const),
		run,
		homePlan: undefined,
		assistantMessage: {
			id: assistantMessageId,
			organizationId,
			conversationId,
			runId,
			role: "assistant" as const,
			status: "completed" as const,
			content: assistantContent,
			runtime: assistantEvent.runtime,
			createdAt: assistantEvent.createdAt,
			startedAt: assistantEvent.createdAt,
			completedAt: run.completedAt,
			metadata: assistantEvent.payload,
		},
		error: undefined,
	};
}
