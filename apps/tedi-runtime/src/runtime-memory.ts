import type { TraceBundleOutcome } from "@tedix/api-contract/schemas/harness-version";
import type { CompiledDirective } from "@tedix/context-core/compiler";
import type {
	RetrievableSkill,
	RetrievedSkillMatch,
} from "@tedix/context-core/skill-retrieval";
import type {
	CompactionResult,
	TediSessionRepo,
} from "@tedix/tedi-session/session-repo";
import type { DoDedupStore } from "./brain-bridge-do";
import type { DoBrainDigestStore } from "./brain-digest-store-do";
import type { BrainDigest } from "./brain/brain-digest";
import type { LlmClient } from "./brain/llm-client";
import type {
	HttpPlatformClient,
	SkillSearchEntry,
} from "./brain/platform-client";
import type { BridgeTurnInput, RecentTurn } from "./bridge-turn-input";
import type { DoCrystallizationStateStore } from "./crystallization-store-do";
import type { DoDirectiveStore } from "./directive-store-do";
import type { AgentTediDO } from "./do";
import type { ActiveTurnBinding, State } from "./runtime-state";
import type { LearningTelemetry } from "./learning-telemetry";
import type { AigMetadata } from "./llm";
import type { MemoryRecallReport } from "./memory-recall";
import type { ModelPolicySurface } from "./model-policy";
import type { ObserverToolExecutionEvidence } from "./observer-execution-evidence";
import type { summarizeContextEntries } from "./pi-compaction";
import type { DoRationaleStateStore } from "./rationale-store-do";
import type { RuntimeAdmissionDO } from "./runtime-admission-do";
import type { RuntimeConfigCache } from "./runtime-config-cache";
import type { RuntimeEventOutbox } from "./runtime-event-outbox";
import type {
	DoSkillGuidanceStore,
	SkillGuidanceTurnGate,
} from "./skill-guidance-store-do";
import type { DoSkillRetrievalCorpusStore } from "./skill-retrieval-corpus-store-do";
import type { DoWorkItemPromotionStore } from "./work-item-promotion-store-do";
import {
	ensureDirectivesLoaded,
	directivesPromptAddendum,
	recordDirectiveUsage,
	recordDirectiveInfluenceForTurn,
	onCompileDirectives,
} from "./runtime-memory-directives";
import {
	ensureBrainDigestLoaded,
	getSkillGuidanceStore,
	ensureSkillGuidanceLoaded,
	skillGuidanceAddendum,
	getRetrievalCorpusStore,
	ensureRetrievalCorpusLoaded,
	cacheRetrievalCorpus,
	retrievedSkillsAddendum,
	recordSkillRetrieval,
	buildAndCacheSkillGuidance,
	onRefreshSkillGuidance,
	brainDigestAddendum,
	cognitiveAddenda,
} from "./runtime-memory-recall";
import {
	observerBeforeDispatch,
	getObserverLlmClient,
} from "./runtime-memory-observe";
import { runBridgeTurnInner, onBridgeTurn } from "./runtime-memory-reflect";
import {
	onAuditCorpus,
	onCompileBrainDigest,
	dispatchTurnMemoryEffects,
	enqueueDailyLogPair,
	onDailyLogFlush,
} from "./runtime-memory-effects";
import {
	onCompactSession,
	prepareCompaction,
	summarizeAdmittedCompaction,
	runCompaction,
	enqueueCompaction,
} from "./runtime-memory-compaction";

export interface RuntimeMemoryHost {
	directivesLoaded: boolean;
	compiledDirectives: CompiledDirective[];
	getDirectiveStore(): DoDirectiveStore;
	brainDigestLoaded: boolean;
	brainDigest: BrainDigest | null;
	getBrainDigestStore(): DoBrainDigestStore;
	skillGuidanceStore: DoSkillGuidanceStore | null;
	getSqlRunner(): ConstructorParameters<typeof DoSkillGuidanceStore>[0];
	skillGuidanceLoaded: boolean;
	getSkillGuidanceStore(): DoSkillGuidanceStore;
	skillGuidanceText: string | null;
	ensureSkillGuidanceLoaded(): void;
	skillGuidanceGate: SkillGuidanceTurnGate | null;
	buildAndCacheSkillGuidance(admittedRunId?: string): Promise<string | null>;
	ctx: DurableObjectState<{}>;
	retrievalCorpusStore: DoSkillRetrievalCorpusStore | null;
	retrievalCorpusLoaded: boolean;
	getRetrievalCorpusStore(): DoSkillRetrievalCorpusStore;
	retrievalCorpus: RetrievableSkill[] | null;
	env: Cloudflare.Env;
	ensureRetrievalCorpusLoaded(): void;
	retrievalCorpusWarmAttempted: boolean;
	resolveTurnTelemetry(opts?: {
		binding?: ActiveTurnBinding | null;
		fallbackRunId?: string;
		fallbackConversationId?: string;
		warnLabel?: string;
	}): Promise<{
		tediId: string;
		runId: string;
		conversationId: string;
		platform: HttpPlatformClient;
	} | null>;
	activeTurnBinding: ActiveTurnBinding | null;
	eventOutbox: RuntimeEventOutbox;
	recordSkillRetrieval(
		matches: RetrievedSkillMatch[],
		binding?: ActiveTurnBinding | null,
	): Promise<void>;
	skillRetrievalEventSequence: number;
	getPlatformClient(): Promise<HttpPlatformClient | null>;
	runtimeAdmission(): RuntimeAdmissionDO | null;
	cacheRetrievalCorpus(entries: SkillSearchEntry[]): void;
	state: State;
	name: string;
	selfPath: AgentTediDO["selfPath"];
	modelOverrideForSurface(
		surface: ModelPolicySurface,
	): { modelRef: string } | undefined;
	observerDeploymentForTurn(): string;
	runtimeConfigCache: RuntimeConfigCache;
	observerBeforeDispatch(
		admittedRunId?: string,
		cancellationRunId?: string,
	): () => void;
	tediAigMetadata(
		source?: string,
		correlation?: {
			runId?: string;
			sessionKey?: string;
			workItemId?: string;
		},
	): AigMetadata;
	ensureDirectivesLoaded(): Promise<void>;
	recordDirectiveUsage(
		matches: Array<{ directive: CompiledDirective }>,
		binding?: ActiveTurnBinding | null,
	): Promise<void>;
	lastInjectedDirectives: Array<{
		directive: CompiledDirective;
		index: number;
	}> | null;
	ensureBrainDigestLoaded(): Promise<void>;
	messagesForSession(sessionKey: string): {
		role: "user" | "assistant";
		content: string;
		text: string;
		ts: number;
		timestamp: number;
	}[];
	directivesPromptAddendum(
		userText: string,
		telemetryBinding?: ActiveTurnBinding | null,
	): Promise<string>;
	brainDigestAddendum(
		userText: string,
		onRecall?: (report: MemoryRecallReport) => void,
		sessionKey?: string | null,
	): Promise<string>;
	skillGuidanceAddendum(): Promise<string>;
	retrievedSkillsAddendum(
		userText: string,
		telemetryBinding?: ActiveTurnBinding | null,
	): Promise<string>;
	directiveEventSequence: number;
	ensureIdentity(hints?: {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	}): Promise<void>;
	admittedEffectPort<T extends object>(port: T, runId: string): T;
	getObserverLlmClient(
		admittedRunId?: string,
		cancellationRunId?: string,
	): LlmClient;
	toolCallRefsForRun(runId: string): string[];
	toolExecutionEvidenceForRun(runId: string): ObserverToolExecutionEvidence[];
	enqueueDailyLogPair(user: RecentTurn, assistant: RecentTurn): void;
	acceptRuntimeTurn(
		runId: string,
		sessionKey: string,
		input: unknown,
		reuseAccepted?: boolean,
	): Promise<void>;
	onBridgeTurn(payload: BridgeTurnInput): Promise<void>;
	queue: AgentTediDO["queue"];
	setState: AgentTediDO["setState"];
	assertChatTurnActive(runId: string | null | undefined): Promise<void>;
	dailyLogWriteLock: Promise<void>;
	ensureModelPolicy(): Promise<void>;
	getDedupStore(): DoDedupStore;
	getRationaleStore(): DoRationaleStateStore;
	getCrystallizationStore(): DoCrystallizationStateStore;
	getWorkItemPromotionStore(): DoWorkItemPromotionStore;
	recordPendingTraceIds(
		runId: string,
		rationaleRecordIds: string[],
		artifactIds: string[],
	): void;
	scoreTurn(opts: {
		platform: HttpPlatformClient;
		tediId: string;
		orgId: string | undefined;
		runId: string;
		assistantText: string;
		outcome: TraceBundleOutcome;
		unrecoveredError?: boolean;
	}): Promise<string | null>;
	emitTraceBundleForRun(opts: {
		platform: HttpPlatformClient;
		tediId: string;
		orgId: string | undefined;
		conversationId: string;
		sessionKey?: string;
		/** Pre-built STABLE runId — same id the ledger 4-event chain keys on. */
		runId: string;
		startedAt?: string;
		endedAt?: string;
		emitConversationCreated: boolean;
		/**
		 * Raw-evidence inputs (bridge path only). When present, the redacted
		 * `harness/runs/<runId>/...` folder is written to R2 and `bundleUri` is set.
		 * Absent on the ledger-mirror path (ids only); `recordTraceBundle` coalesces
		 * the non-null `bundleUri` so whichever path supplies evidence wins.
		 */
		evidence?: { userText: string; assistantText: string };
		/**
		 * Live-turn score id for THIS run (Slice B). When supplied (the bridge path
		 * scores the turn first), it is stamped onto the bundle so
		 * `trace_bundles.evalResultId` links the bundle to the score it earned.
		 * `recordTraceBundle` coalesces the non-null id so whichever path supplies
		 * it wins; the ledger-mirror path leaves it unset.
		 */
		evalResultId?: string;
	}): Promise<void>;
	completeRuntimeTurn(
		runId: string,
		sourceId: string,
		receipt: unknown,
	): Promise<void>;
	runBridgeTurnInner(
		payload: BridgeTurnInput,
		signal: AbortSignal,
		telemetry: LearningTelemetry,
		deadlineAt: number,
	): Promise<void>;
	runCompaction(
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
		acceptedOperationId?: string,
	): Promise<CompactionResult | null>;
	sessionRepo: TediSessionRepo;
	runtimeReceiptHash(value: unknown): Promise<string>;
	prepareCompaction(
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
	): Promise<string>;
	summarizeAdmittedCompaction(
		entries: Parameters<typeof summarizeContextEntries>[1],
		previousSummary: string | undefined,
		sessionKey: string,
		options: { modelRef: string | null; deployment: string | null },
	): Promise<string | null>;
}

export const runtimeMemory = {
	ensureDirectivesLoaded,
	ensureBrainDigestLoaded,
	getSkillGuidanceStore,
	ensureSkillGuidanceLoaded,
	skillGuidanceAddendum,
	getRetrievalCorpusStore,
	ensureRetrievalCorpusLoaded,
	cacheRetrievalCorpus,
	retrievedSkillsAddendum,
	recordSkillRetrieval,
	buildAndCacheSkillGuidance,
	onRefreshSkillGuidance,
	observerBeforeDispatch,
	getObserverLlmClient,
	directivesPromptAddendum,
	brainDigestAddendum,
	cognitiveAddenda,
	recordDirectiveUsage,
	recordDirectiveInfluenceForTurn,
	onCompileDirectives,
	onAuditCorpus,
	onCompileBrainDigest,
	dispatchTurnMemoryEffects,
	enqueueDailyLogPair,
	onDailyLogFlush,
	runBridgeTurnInner,
	onBridgeTurn,
	onCompactSession,
	prepareCompaction,
	summarizeAdmittedCompaction,
	runCompaction,
	enqueueCompaction,
};
