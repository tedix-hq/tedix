import {
	type BrowserHostnamePolicy,
	type TediBudgets,
	type ToolPolicy,
} from "@tedix/api-contract/schemas/tedi";
import { type WebSearchPolicy } from "@tedix/api-contract/schemas/web-search";
import { type HarnessLoopPolicy } from "@tedix/context-core/harness-version";
import { type HttpPlatformClient } from "./brain/platform-client";
import { type TelegramChannelLike } from "./telegram-config";
import { type TraceToolStep } from "./trace-bundle-writer";
import { type DailyLogEntry, type IdentityReadDiagnostics } from "./workspace";

/**
 * Persisted Agent state of `AgentTediDO` and the active-turn binding it hands
 * to the runtime modules. Types and initial values only; the DO owns every
 * read and write.
 */
export interface State {
	tediId: string;
	orgId: string;
	slug: string;
	identityLoaded: boolean;
	systemPrompt: string;
	/**
	 * Latest identity hydration diagnostic. This is the isolate counterpart to
	 * the container-side `artifactsStatus` file: status surfaces can distinguish
	 * repo missing, file missing, R2 fallback, and successful Artifacts reads.
	 */
	identityDiagnostics?: IdentityReadDiagnostics;
	/**
	 * Version tag of the code-derived prompt scaffolding baked into
	 * `systemPrompt`. Bumped whenever {@link AGENT_RUNTIME_PROMPT} changes so
	 * warm DOs (whose state survives a code deploy) recompose on their next turn
	 * instead of pinning a stale prompt behind the `identityLoaded` cache.
	 */
	systemPromptVersion?: string;
	/**
	 * Per-tedi Telegram channel config (`tedis.channels.telegram`), loaded from
	 * D1 during identity resolution and persisted so `getMessengers()` (read once
	 * in `onStart`, sync) can give this tedi its OWN bot. `undefined` = not yet
	 * loaded, `null` = loaded, no per-tedi config (use Worker-env fallback).
	 */
	telegramChannel?: TelegramChannelLike | null;
	/**
	 * Set of conversationIds the DO has already emitted a `conversation.created`
	 * runtime event for. Tracked so each conversation gets exactly one
	 * `conversation.created` event over its lifetime.
	 */
	ledgerConversationsSeen: string[];
	/**
	 * Buffered daily-log entries pending an R2 flush. Drained by
	 * {@link AgentTediDO.onDailyLogFlush} which runs on a 5-minute
	 * `scheduleEvery` cadence or eagerly when the buffer crosses
	 * {@link DAILY_LOG_FLUSH_THRESHOLD}. Persisted via Agent state so a DO
	 * eviction between turns doesn't drop pending log entries.
	 */
	pendingDailyEntries: DailyLogEntry[];
	/**
	 * Last verified-owner subject (Descope user id) that connected to this DO.
	 * Set from `X-Tedi-Auth-Subject` (stamped by the parent Worker's
	 * `authenticateAcpUpgrade` in `apps/tedi-runtime/src/index.ts`) so brain /
	 * rationale / audit records have access to who authenticated the
	 * connection. Updated on every onConnect / onRequest with a valid header;
	 * unset only on explicit identity reset.
	 */
	authSubject?: string;
	/**
	 * Cached active HarnessVersion id + its component-hash map for this tedi.
	 * Set by {@link AgentTediDO.ensureActiveHarnessVersion} so each turn can
	 * (a) stamp the active `harnessVersionId` into trace bundles without an RPC,
	 * and (b) skip the ensure RPC when the live component set is unchanged. The
	 * API remains authoritative on bump/version; this is a hot-path cache only.
	 */
	harnessVersionId?: string;
	harnessComponents?: Record<string, string>;
	/**
	 * Agent-loop descriptor parsed back from the active HarnessVersion's stamped
	 * `loop_policy` component. It preserves the auditable final-step rule;
	 * maxSteps is re-resolved against current D1 governance on every use so a
	 * legacy version cannot pin an obsolete entitlement. Absent until the first
	 * ensure resolves, with {@link HARNESS_LOOP_POLICY} as the fail-soft default.
	 */
	harnessLoopPolicy?: HarnessLoopPolicy;
	/**
	 * Per-run rationale-record + artifact ids collected during {@link
	 * AgentTediDO.onBridgeTurn} (the bridge fan-out step), keyed by the
	 * deterministic trace runId (`${tediId}:${surface}:${userTs}`). Read by
	 * {@link AgentTediDO.emitTraceBundleForRun} so the per-run TraceBundle can
	 * reference the run's real rationale records + artifacts.
	 *
	 * The bundle emits from a SEPARATE queue step (`onLedgerMirror`) than the
	 * bridge (`onBridgeTurn`) with no completion-ordering guarantee, so the ids
	 * are persisted here rather than passed inline; the bundle also re-emits at
	 * the END of `onBridgeTurn` once the ids exist, and `recordTraceBundle`
	 * merges id arrays so whichever step lands second completes the bundle.
	 *
	 * Bounded ring (newest last) — pruned to {@link MAX_PENDING_TRACE_IDS} so DO
	 * state stays small across a long-lived conversation.
	 */
	pendingTraceIds?: PendingTraceIds[];
	/**
	 * Per-run buffer of step tool/usage telemetry (captured in `recordStepEvent`
	 * from native provider settlement) so the post-turn trace-bundle writer can
	 * emit `tool-calls.jsonl` without a `diagnostics_channel` dependency. Bounded
	 * ring, pruned to {@link MAX_PENDING_TRACE_IDS}.
	 */
	pendingToolSteps?: PendingToolSteps[];
	/** Effective per-tedi tool governance loaded from D1 during identity hydration. */
	toolPolicy?: ToolPolicy;
	/** Organization browser boundary composed with the per-tedi tool policy. */
	organizationBrowserEgress?: BrowserHostnamePolicy;
	/** Organization web search switch; absent or invalid means off. */
	organizationWebSearch?: WebSearchPolicy;
	/** Effective per-tedi operational budgets loaded from D1 during identity hydration. */
	budgets?: TediBudgets;
	/** Wall-clock freshness marker for the D1-backed governance cache. */
	governanceLoadedAt?: number;
}

/** Per-run rationale + artifact id collection for trace-bundle emission. */
interface PendingTraceIds {
	runId: string;
	rationaleRecordIds: string[];
	artifactIds: string[];
}

/** Per-run step tool/usage telemetry for the trace bundle's tool-calls.jsonl. */
interface PendingToolSteps {
	runId: string;
	steps: TraceToolStep[];
}

export interface ActiveTurnBinding {
	conversationId: string;
	homeRunId?: string;
	runId: string;
	sessionKey?: string;
	traceId?: string;
	workItemId?: string;
	toolArgumentConstraints?: Record<string, string>;
	toolNamespacePrefix?: string;
	toolAllowedCallables?: readonly string[];
	embeddedSessionToken?: string;
	platform: HttpPlatformClient;
}

export const INITIAL_STATE: State = {
	tediId: "",
	orgId: "",
	slug: "",
	identityLoaded: false,
	systemPrompt: "",
	ledgerConversationsSeen: [],
	pendingDailyEntries: [],
};

/** Bounded ring size for {@link State.pendingTraceIds}. */
export const MAX_PENDING_TRACE_IDS = 50;
