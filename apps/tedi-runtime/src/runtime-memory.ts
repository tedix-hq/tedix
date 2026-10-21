import type { TraceBundleOutcome } from "@tedix/api-contract/schemas/harness-version";
import {
	buildTediConversationId,
	isBlindVerificationSession,
	isLeanContextSession,
} from "@tedix/api-contract/utils/runtime-identity";
import {
	type CompiledDirective,
	diagnoseDirectiveGap,
	directiveInfluenced,
	directiveInfluenceRatio,
	markDirectiveMatched,
	recordDirectiveInfluence,
	selectMatchingDirectives,
	serializeMatchedDirectives,
} from "@tedix/context-core/compiler";
import { parseObserverResult } from "@tedix/context-core/observer";
import { OBSERVER_SYSTEM_PROMPT } from "@tedix/context-core/prompts";
import { tokensForSerialized } from "@tedix/context-core/reflector";
import {
	type RetrievableSkill,
	type RetrievedSkillMatch,
	serializeRetrievedSkills,
} from "@tedix/context-core/skill-retrieval";
import type { Observation, ObserverResult } from "@tedix/context-core/types";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import {
	type CompactionResult,
	DEFAULT_KEEP_RECENT_TOKENS,
	TediSessionRepo,
} from "@tedix/tedi-session/session-repo";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	type AdaptiveLearningMode,
	adaptiveLearningModeForTurn,
} from "./adaptive-learning";
import { recordTurnSummaryArtifact } from "./artifact-recorder";
import type { ArtifactsPushReceipt } from "./artifacts-git";
import { DoDedupStore } from "./brain-bridge-do";
import { DoBrainDigestStore } from "./brain-digest-store-do";
import {
	type BrainDigest,
	compileBrainDigest,
	serializeBrainDigest,
} from "./brain/brain-digest";
import { bridgeObservations } from "./brain/bridge";
import { compileDirectives } from "./brain/compiler";
import { auditRationaleCorpus } from "./brain/corpus-audit";
import { runCrystallization } from "./brain/crystallizer";
import type { LlmChatParams, LlmClient } from "./brain/llm-client";
import type {
	HttpPlatformClient,
	SkillSearchEntry,
} from "./brain/platform-client";
import { runRationaleBridge } from "./brain/rationale-bridge";
import { reflect } from "./brain/reflector";
import { promoteWorkItems } from "./brain/task-bridge";
import type { BridgeTurnInput, RecentTurn } from "./bridge-turn-input";
import {
	composeCognitiveAddenda,
	isHomeDelegationWorkOrder,
} from "./cognitive-addenda";
import { buildCompactionLedgerPayload } from "./compaction-ledger";
import { logTediSourceFailure } from "./context-failure-log";
import { DoCrystallizationStateStore } from "./crystallization-store-do";
import { DoDirectiveStore } from "./directive-store-do";
import type { ActiveTurnBinding, AgentTediDO, State } from "./do";
import { selectSkillsWithJev } from "./jev-skill-ranking";
import {
	LEARNING_BRIDGE_TIMEOUT_MS,
	learningPassStatus,
	learningStageDeadline,
	runLearningStage,
} from "./learning-stages";
import {
	createTurnLearningTelemetry,
	type LearningTelemetry,
} from "./learning-telemetry";
import { isEphemeralSession, sanitizeTurnKey } from "./ledger-mirror";
import { type AigMetadata } from "./llm";
import {
	type MemoryRecallReport,
	recallLongTermMemoryBlock,
} from "./memory-recall";
import { TEDI_CONTEXT_WINDOW_TOKENS } from "./model-input-budget";
import {
	type ModelPolicySurface,
	resolveSurfaceModelRef,
} from "./model-policy";
import {
	buildMemorySourceEvidence,
	buildObserverInput,
	ensureTerminalEpisodeObservation,
	type ObserverToolExecutionEvidence,
} from "./observer-execution-evidence";
import { observerCompletion } from "./observer-llm";
import { summarizeContextEntries } from "./pi-compaction";
import { DoRationaleStateStore } from "./rationale-store-do";
import { RuntimeAdmissionDO } from "./runtime-admission-do";
import { RuntimeConfigCache } from "./runtime-config-cache";
import { RuntimeEventOutbox } from "./runtime-event-outbox";
import { logTediRuntimeFailure } from "./runtime-failure-log";
import {
	inferenceOriginHash,
	type NativeRootProof,
	privateInferenceOriginGuard,
} from "./runtime-inference-origin";
import {
	DoSkillGuidanceStore,
	selectGuidanceSkills,
	SkillGuidanceTurnGate,
} from "./skill-guidance-store-do";
import {
	buildRetrievalCorpus,
	DoSkillRetrievalCorpusStore,
	parseSkillRetrievalKnobs,
} from "./skill-retrieval-corpus-store-do";
import { refreshTurnMemory } from "./turn-memory";
import { DoWorkItemPromotionStore } from "./work-item-promotion-store-do";
import {
	commitDailyLogEntries,
	type DailyLogBatch,
	type DailyLogEntry,
	utcDateSlug,
} from "./workspace";

/**
 * Act-time skill-retrieval injection stamp (`recordSkillRetrieval`): which
 * proven skills were matched into this turn's prompt. Deliberately a
 * `context.injected` event, NOT a `skill_usage_events` row — retrieval is not
 * execution, and the execute-to-promote ledger must stay untouched. The
 * retrieved→used rate joins these events with `skill_usage_events` on skillId
 * within the run/conversation window.
 */
type SkillRetrievalTelemetryPayload = {
	source: "skill-retrieval";
	phase: "pre-turn-injection";
	matched: number;
	skills: Array<{
		skillId: string;
		slug: string | null;
		lifecycleState: string | null;
		overlap: number;
	}>;
};

/**
 * The payload shapes that share the `context.injected` ledger kind
 * (deliberately — no new enum value), discriminated by `source` + `phase`:
 * directive pre-turn INJECTION (which compiled directives matched this turn's
 * user text), directive post-turn INFLUENCE (whether each injected directive
 * detectably steered the reply), and skill-retrieval pre-turn INJECTION
 * ({@link SkillRetrievalTelemetryPayload}). Consumers today key on `kind`
 * only; `source`/`phase` are the contract for anyone who needs to tell the
 * shapes apart.
 */
type DirectiveTelemetryPayload =
	| {
			source: "compiled-directives";
			phase: "pre-turn-injection";
			matched: number;
			directives: Array<{
				category: string;
				strength: CompiledDirective["strength"];
				provenanceHash: string;
				evidenceCount: number;
			}>;
	  }
	| {
			source: "compiled-directives";
			phase: "post-turn-influence";
			heuristic: "keyword-overlap";
			evaluated: number;
			influenced: number;
			directives: Array<{
				category: string;
				strength: CompiledDirective["strength"];
				provenanceHash: string;
				influenced: boolean;
				ratio: number;
				successRate: number;
			}>;
	  };

/**
 * Llama 3.3 sometimes wraps JSON in ```json … ``` fences. Strip them so the
 * downstream `parseObserverResult` (which calls JSON.parse directly) doesn't
 * fail on otherwise-valid payloads.
 */
function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/i, "");
	const withoutClose = withoutOpen.replace(/\n?```\s*$/, "");
	return withoutClose.trim();
}

/**
 * Serialize an observation set for Reflector token accounting + LLM input.
 *
 * The container plugin reaches into its tedix-context store layer for this; the
 * isolate has no such store, so we use a stable JSON form. The exact shape only
 * needs to be self-consistent — the Reflector compares before/after token
 * counts of the SAME serializer to decide whether condensation actually shrank
 * the set (the "reflection expanded → keep original" safety check).
 */
function serializeObservationsForReflector(
	observations: Observation[],
): string {
	return JSON.stringify(observations);
}

/**
 * Reflector token threshold. Below this the per-turn Observer output is bridged
 * raw — short turns skip the extra condensation LLM call entirely (no cost).
 * Above it, the shared `reflect()` consolidates the observation set before the
 * brain bridge. Matches tedix-context's ~35k `reflectThresholdTokens` default.
 */
const REFLECT_THRESHOLD_TOKENS = 35_000;
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
	buildAndCacheSkillGuidance(admittedRunId?: string): Promise<string>;
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
	/** Lazy-load the compiled-directive cache from DO SQLite (once per instance). */

	async ensureDirectivesLoaded(this: RuntimeMemoryHost): Promise<void> {
		if (this.directivesLoaded) return;
		try {
			this.compiledDirectives = await this.getDirectiveStore().load();
		} catch (err) {
			logTediSourceFailure("directives", "load", err);
			this.compiledDirectives = [];
		}
		this.directivesLoaded = true;
	},

	/** Lazy-load the cached brain digest from DO SQLite (once per instance). */

	async ensureBrainDigestLoaded(this: RuntimeMemoryHost): Promise<void> {
		if (this.brainDigestLoaded) return;
		try {
			this.brainDigest = await this.getBrainDigestStore().load();
		} catch (err) {
			logTediSourceFailure("brain_digest", "load", err);
			this.brainDigest = null;
		}
		this.brainDigestLoaded = true;
	},

	getSkillGuidanceStore(this: RuntimeMemoryHost): DoSkillGuidanceStore {
		if (!this.skillGuidanceStore) {
			this.skillGuidanceStore = new DoSkillGuidanceStore(this.getSqlRunner());
		}
		return this.skillGuidanceStore;
	},

	/** Lazy-load the cached skill guidance text from DO SQLite (once per instance). */

	ensureSkillGuidanceLoaded(this: RuntimeMemoryHost): void {
		if (this.skillGuidanceLoaded) return;
		try {
			const cached = this.getSkillGuidanceStore().load();
			this.skillGuidanceText = cached?.text ?? null;
		} catch (err) {
			logTediSourceFailure("skill_guidance", "load", err);
			this.skillGuidanceText = null;
		}
		this.skillGuidanceLoaded = true;
	},

	/**
	 * Compact skill guidance block for progressive disclosure. Returns a
	 * one-line-per-skill summary list to inject into the system prompt so the
	 * model knows which of the tedi's own platform skills are available before
	 * deciding to call `read_skill` for the full procedure.
	 *
	 * Served from the DO SQLite cache and refreshed PER TURN by
	 * {@link SkillGuidanceTurnGate} — the cached block goes into this turn and
	 * the rebuild runs behind it, so a skill the tedi recorded is visible on its
	 * next turn rather than after the 4-hour warmer. Returns "" when no skills
	 * exist, so young tedis are unaffected.
	 */

	async skillGuidanceAddendum(this: RuntimeMemoryHost): Promise<string> {
		this.ensureSkillGuidanceLoaded();
		if (!this.skillGuidanceGate) {
			this.skillGuidanceGate = new SkillGuidanceTurnGate({
				build: () => this.buildAndCacheSkillGuidance(),
				background: (task) => this.ctx.waitUntil(task),
			});
		}
		return await this.skillGuidanceGate.textForTurn(
			this.skillGuidanceText ?? "",
		);
	},

	getRetrievalCorpusStore(
		this: RuntimeMemoryHost,
	): DoSkillRetrievalCorpusStore {
		if (!this.retrievalCorpusStore) {
			this.retrievalCorpusStore = new DoSkillRetrievalCorpusStore(
				this.getSqlRunner(),
			);
		}
		return this.retrievalCorpusStore;
	},

	/** Lazy-load the cached retrieval corpus from DO SQLite (once per instance). */

	ensureRetrievalCorpusLoaded(this: RuntimeMemoryHost): void {
		if (this.retrievalCorpusLoaded) return;
		try {
			const cached = this.getRetrievalCorpusStore().load();
			this.retrievalCorpus = cached?.skills ?? null;
		} catch (err) {
			logTediSourceFailure("skill_retrieval", "load", err);
			this.retrievalCorpus = null;
		}
		this.retrievalCorpusLoaded = true;
	},

	/**
	 * Persist the act-time retrieval corpus projected from the org-readable
	 * skill rows (see `buildRetrievalCorpus` — injectable lifecycles only,
	 * capped content). Fed by the SAME `listSkillsForTedi` read that builds the
	 * guidance block, on the same 4-hour refresh. Fail-soft: a persist failure
	 * never breaks guidance or the turn.
	 */

	cacheRetrievalCorpus(
		this: RuntimeMemoryHost,
		entries: SkillSearchEntry[],
	): void {
		try {
			const corpus = buildRetrievalCorpus(entries);
			// Fingerprint gate (mirrors the guidance store's): the guidance builder
			// runs per turn for tedis with no tedi-owned skills, so skip the SQLite
			// rewrite when the projected corpus is byte-identical to the cached one.
			if (
				!this.retrievalCorpusLoaded ||
				JSON.stringify(this.retrievalCorpus) !== JSON.stringify(corpus)
			) {
				this.getRetrievalCorpusStore().save(corpus);
			}
			this.retrievalCorpus = corpus;
			this.retrievalCorpusLoaded = true;
		} catch (err) {
			logTediSourceFailure("skill_retrieval", "cache", err);
		}
	},

	/**
	 * Act-time retrieved-skills addendum — the AWM/Memp "retrieve" leg. Matches
	 * the turn's user text against the cached org-readable corpus (proven/
	 * crystallized/active skills only, org-scoped mined workflows included) and
	 * injects the top-K relevant procedures as a compact token-capped block.
	 *
	 * Baseline selection is deterministic and local: keyword/
	 * tag/tool-sequence overlap with a relevance floor, then lifecycle priority
	 * (crystallized > proven > active — never drafts), then recency-weighted
	 * success rate from the usage-ledger rollups. Tenant-opted Jev may rerank
	 * eligible candidates through the API; unavailable judgments retain the baseline.
	 * The corpus refreshes with skill guidance every 4 hours. Knobs ride Worker vars
	 * (`TEDI_SKILL_RETRIEVAL_TOP_K`, `TEDI_SKILL_RETRIEVAL_MIN_OVERLAP`);
	 * `TOP_K=0` disables. Returns "" when nothing clears the floor, so the
	 * prompt is unchanged (the common case for off-topic turns).
	 *
	 * Telemetry: matched injections are stamped as a `context.injected` runtime
	 * event with `source: "skill-retrieval"` ({@link recordSkillRetrieval}) —
	 * NOT as a skill-usage event (retrieval is not execution; the
	 * `SkillUsageSource` enum and the execute-to-promote ledger stay untouched).
	 * Later reporting requires an exact same-turn tool completion naming the
	 * skill workflow run, its pinned origin turn and skill, and a terminal usage
	 * event. A nearby skill use alone never proves this retrieval was used.
	 */

	async retrievedSkillsAddendum(
		this: RuntimeMemoryHost,
		userText: string,
		telemetryBinding?: ActiveTurnBinding | null,
	): Promise<string> {
		const knobs = parseSkillRetrievalKnobs(
			this.env as unknown as {
				TEDI_SKILL_RETRIEVAL_TOP_K?: string;
				TEDI_SKILL_RETRIEVAL_MIN_OVERLAP?: string;
			},
		);
		if (knobs.topK <= 0) return "";
		this.ensureRetrievalCorpusLoaded();
		if (this.retrievalCorpus === null && !this.retrievalCorpusWarmAttempted) {
			// Cold cache on an already-deployed tedi whose guidance row predates
			// the corpus: one warm attempt per DO instance via the shared skills
			// fetch (idempotent for guidance thanks to its fingerprint gate).
			this.retrievalCorpusWarmAttempted = true;
			await this.buildAndCacheSkillGuidance();
		}
		const corpus = this.retrievalCorpus;
		if (!corpus || corpus.length === 0) return "";
		const ctx = await this.resolveTurnTelemetry({
			binding: telemetryBinding ?? this.activeTurnBinding,
		});
		const matches = await selectSkillsWithJev({
			skills: corpus,
			query: userText,
			options: { topK: knobs.topK, minOverlap: knobs.minOverlap },
			runId: ctx?.runId,
			rank: ctx ? (input) => ctx.platform.rankSkills(input) : undefined,
			onExecutionAttempts: async (receipt) => {
				const first = receipt.executionAttempts[0];
				if (!ctx || !first) return;
				await this.eventOutbox.publish({
					id: `${ctx.runId}:jev-skill-ranking:${first.executionId}`,
					tediId: ctx.tediId,
					kind: "context.injected",
					conversationId: ctx.conversationId,
					runId: ctx.runId,
					payload: { source: "jev-skill-ranking", ...receipt },
					runtime: { backend: "cloudflare-agents" },
					createdAt: new Date().toISOString(),
				});
			},
		});
		if (matches.length === 0) return "";
		void this.recordSkillRetrieval(
			matches,
			telemetryBinding ?? this.activeTurnBinding,
		).catch(() => {
			/* fail-soft — never break a turn on a telemetry write */
		});
		return serializeRetrievedSkills(matches);
	},

	/**
	 * Stamp which skills were act-time-retrieved into this turn's prompt as a
	 * `context.injected` runtime event (mirrors {@link recordDirectiveUsage}).
	 * This is the retrieval half of the retrieved→used metric. Execution is
	 * established separately by exact workflow-run and terminal-usage evidence.
	 */

	async recordSkillRetrieval(
		this: RuntimeMemoryHost,
		matches: RetrievedSkillMatch[],
		binding?: ActiveTurnBinding | null,
	): Promise<void> {
		const ctx = await this.resolveTurnTelemetry({ binding });
		if (!ctx) return;
		const { tediId, runId, conversationId, platform } = ctx;
		const sequence = this.skillRetrievalEventSequence++;
		const payload: SkillRetrievalTelemetryPayload = {
			source: "skill-retrieval",
			phase: "pre-turn-injection",
			matched: matches.length,
			skills: matches.map((m) => ({
				skillId: m.skill.id,
				slug: m.skill.slug ?? null,
				lifecycleState: m.skill.lifecycleState ?? null,
				overlap: m.overlap,
			})),
		};
		await platform.recordRuntimeEvent({
			id: `${runId}:skill-retrieval:${sequence}`,
			tediId,
			kind: "context.injected",
			conversationId,
			runId,
			sequence,
			payload,
			runtime: { backend: "cloudflare-agents" },
			createdAt: new Date().toISOString(),
		});
	},

	/**
	 * Build the compact skill guidance text from platform API and persist to
	 * DO SQLite. Driven per turn by {@link SkillGuidanceTurnGate} (behind the
	 * turn when a cached block exists, blocking only on a cold cache); the
	 * scheduled `onRefreshSkillGuidance` task is now only a 4-hour warmer for an
	 * otherwise idle DO.
	 *
	 * Returns the built text (or "" on failure / no skills) so callers can
	 * inject it immediately without waiting for the cache to warm.
	 */

	async buildAndCacheSkillGuidance(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
	): Promise<string> {
		const platform = await this.getPlatformClient();
		if (!platform) {
			if (admittedRunId)
				throw new Error("Maintenance skill catalog is unavailable");
			return "";
		}
		try {
			const result = await platform.listSkillsForTedi({ limit: 50 });
			const allEntries = result.entries ?? [];
			// Act-time retrieval corpus rides the SAME read: the full org-readable
			// set (lifecycle-gated inside buildRetrievalCorpus) is cached for
			// per-turn relevance matching. Unlike the guidance wall below, corpus
			// entries only ever reach a prompt when they clear a per-turn relevance
			// floor — so caching the org catalog here does not reintroduce the
			// unscoped-block regression.
			if (admittedRunId)
				await this.runtimeAdmission()?.assertAcceptedTurn({
					runId: admittedRunId,
				});
			this.cacheRetrievalCorpus(allEntries);
			// TEDI-OWNED skills only, hard-capped. listByOrg returns the whole org
			// catalog, mostly skills irrelevant to this tedi's work. Injecting that
			// wall into every turn degrades task performance. Org skills stay
			// reachable on demand via `read_skill` by slug; they are NOT
			// auto-advertised (progressive disclosure: compact, relevant
			// discovery — not an always-on catalog).
			const entries = selectGuidanceSkills(allEntries, this.state.tediId);
			if (entries.length === 0) return "";

			const lines: string[] = [
				`You have ${entries.length} platform skill(s) available. Use \`read_skill\` to load the full procedure for any skill listed below before following it.`,
			];
			for (const entry of entries) {
				const slug = entry.slug ?? entry.id;
				const summary = entry.summary ?? entry.description ?? "(no summary)";
				const state = entry.lifecycleState ? ` [${entry.lifecycleState}]` : "";
				lines.push(`- skill ${slug}: ${summary}${state}`);
			}
			const text = lines.join("\n");
			try {
				// Fingerprint gate (adoption-review backlog #8): the rendered block
				// is a pure function of every catalog field it displays, so a
				// byte-identical render means the catalog is unchanged — touch the
				// row's freshness stamp and skip the full-text rewrite.
				const cached = this.getSkillGuidanceStore().load();
				if (cached?.text === text) {
					this.getSkillGuidanceStore().touch();
				} else {
					this.getSkillGuidanceStore().save(text);
				}
				this.skillGuidanceText = text;
				this.skillGuidanceLoaded = true;
			} catch (persistErr) {
				if (admittedRunId) throw persistErr;
				logTediSourceFailure("skill_guidance", "cache", persistErr);
			}
			return text;
		} catch (err) {
			if (admittedRunId) throw err;
			logTediSourceFailure("skill_guidance", "build", err);
			return "";
		}
	},

	/**
	 * Scheduled WARMER for the skill guidance cache. Runs every 4 hours
	 * alongside directive compilation and brain digest. It is no longer what
	 * makes a new skill visible — that is per-turn
	 * ({@link SkillGuidanceTurnGate}) — it just keeps an idle DO's cached block
	 * from aging. Fail-soft: a network blip never breaks the tedi.
	 */

	async onRefreshSkillGuidance(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
	): Promise<void> {
		try {
			await this.buildAndCacheSkillGuidance(admittedRunId);
		} catch (err) {
			if (admittedRunId) throw err;
			logTediSourceFailure("skill_guidance", "refresh", err);
		}
	},

	/** Pins this local operation before billing; the transport invokes it synchronously at each wire. */

	observerBeforeDispatch(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
		cancellationRunId = admittedRunId,
	): () => void {
		const owner = { tediId: this.state.tediId, orgId: this.state.orgId };
		const admission = this.runtimeAdmission();
		if (admission && !admittedRunId)
			throw new Error("Observer inference requires an accepted operation");
		const accepted = admission?.assertAcceptedTurnSync({
			runId: admittedRunId!,
		});
		const nativeIdentity = {
			objectId: this.ctx.id.toString(),
			objectName: this.name,
			path: inferenceOriginHash(this.selfPath),
		};
		const configuration = () => ({
			modelOverride: this.modelOverrideForSurface("observer") ?? null,
			deployment: this.observerDeploymentForTurn(),
			configGeneration: this.runtimeConfigCache.generation,
			modelPolicy: this.runtimeConfigCache.modelPolicy ?? null,
		});
		const configurationHash = inferenceOriginHash(configuration());
		const recheck = () => {
			if (
				this.ctx.id.toString() !== nativeIdentity.objectId ||
				this.name !== nativeIdentity.objectName ||
				inferenceOriginHash(this.selfPath) !== nativeIdentity.path
			)
				throw new Error(
					"Observer original native identity changed before dispatch",
				);
			if (inferenceOriginHash(configuration()) !== configurationHash)
				throw new Error("Observer configuration changed before dispatch");
			if (
				this.state.tediId !== owner.tediId ||
				this.state.orgId !== owner.orgId
			)
				throw new Error("Observer owner changed before dispatch");
			const stored = this.ctx.storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
				)
				.toArray()[0];
			const storedOwner = stored
				? (JSON.parse(stored.state) as { tediId?: unknown; orgId?: unknown })
				: null;
			if (
				(admission && !storedOwner) ||
				(storedOwner &&
					(storedOwner.tediId !== owner.tediId ||
						storedOwner.orgId !== owner.orgId))
			)
				throw new Error("Observer stored owner changed before dispatch");
			const current = this.runtimeAdmission();
			if (Boolean(current) !== Boolean(admission))
				throw new Error("Observer admission selection changed before dispatch");
			if (current && accepted)
				current.assertAcceptedTurnSync({
					runId: accepted.runId,
					expected: accepted,
				});
			if (
				(admittedRunId &&
					this.ctx.storage.kv.get(`wfcancel:${admittedRunId}`)) ||
				(cancellationRunId &&
					this.ctx.storage.kv.get(`wfcancel:${cancellationRunId}`))
			)
				throw new Error("Observer operation canceled before dispatch");
		};
		const root: NativeRootProof = {
			owner: { ...owner, objectId: this.ctx.id.toString() },
			objectName: this.name,
			className: "AgentTediDO",
			path: [],
			generation: accepted?.generation ?? 0,
			...(accepted ? { accepted } : {}),
		};
		const selected = {
			owner: root.owner,
			className: "AgentTediDO",
			generation: root.generation,
			identityName: root.objectName,
			facetName: null,
			path: [],
		};
		if (accepted) {
			const input = this.ctx.storage.sql
				.exec<{ input: string }>(
					"SELECT input FROM runtime_admission_identities WHERE run_id=?",
					accepted.runId,
				)
				.toArray()[0];
			return privateInferenceOriginGuard(
				{
					kind: "accepted_native",
					root: { ...root, accepted },
					selected: { ...selected, accepted },
					operation: null,
					configurationHash,
				},
				recheck,
				input?.input,
			);
		}
		// No operation or claim is fabricated for unselected original owners.
		return privateInferenceOriginGuard(
			{ kind: "unselected_native", root, selected, configurationHash },
			recheck,
		);
	},

	/**
	 * `LlmClient` adapter for shared reflection using the Agent runtime's
	 * configured observer model, gateway transport and inference authorization.
	 */

	getObserverLlmClient(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
		cancellationRunId = admittedRunId,
	): LlmClient {
		const beforeDispatch = this.observerBeforeDispatch(
			admittedRunId,
			cancellationRunId,
		);
		const env = this.env;
		const metadata = this.tediAigMetadata("observer:reflection");
		const modelRef = this.modelOverrideForSurface("observer")?.modelRef;
		const deployment = modelRef?.startsWith("azure-openai/")
			? this.observerDeploymentForTurn()
			: undefined;
		return {
			async chat(params: LlmChatParams) {
				beforeDispatch();
				return {
					content: await observerCompletion({
						beforeDispatch,
						env,
						metadata,
						modelRef,
						deployment,
						messages: params.messages,
						signal: params.signal,
						maxCompletionTokens: params.maxCompletionTokens ?? 2000,
					}),
				};
			},
		};
	},

	/**
	 * Compiled directives (Atlas-style ALWAYS/NEVER/PREFER rules) injected into the
	 * system prompt per-turn in {@link beforeTurn}. Loaded lazily from DO storage on
	 * first use; refreshed by {@link onCompileDirectives}.
	 *
	 * **Directive precision (selective matching).** Rather than serializing the
	 * ENTIRE cache every turn, this mirrors
	 * The prompt-build hook matches
	 * each cached directive's wording against the current turn's user text via
	 * keyword overlap and injects ONLY the matching, well-evidenced directives.
	 *
	 * Side effects (fail-soft):
	 *  - marks matched directives' `lastMatchedAt` (in-memory + persisted via the
	 *    store's `updateLastMatched`), so the 14-day stale-prune keeps used ones;
	 *  - records a `context.injected` runtime event capturing which directives
	 *    (category + provenanceHash) matched — the isolate's usage signal, the
	 *    closest available runtime parity for directive influence telemetry.
	 *
	 * Returns "" when nothing matches (the common case for young tedis or
	 * off-topic turns), so the prompt is unchanged.
	 */

	async directivesPromptAddendum(
		this: RuntimeMemoryHost,
		userText: string,
		telemetryBinding?: ActiveTurnBinding | null,
	): Promise<string> {
		await this.ensureDirectivesLoaded();
		if (this.compiledDirectives.length === 0) return "";

		const matches = selectMatchingDirectives(this.compiledDirectives, userText);
		if (matches.length === 0) return "";

		// 1) Mark matched directives as recently used (in-memory cache) + persist.
		const now = new Date().toISOString();
		for (const m of matches) {
			markDirectiveMatched(this.compiledDirectives, m.index, now);
		}
		try {
			await this.getDirectiveStore().updateLastMatched(
				matches.map((m) => ({
					directive: this.compiledDirectives[m.index]!,
					index: m.index,
				})),
			);
		} catch (err) {
			// Persistence is best-effort; the in-memory mark still applies this turn.
			logTediSourceFailure("directives", "touch", err);
		}

		// 2) Record a lightweight directive-usage signal (best-effort). The
		// binding is threaded EXPLICITLY because the bespoke SSE/workflow turn
		// families don't maintain `this.activeTurnBinding` — relying on it
		// implicitly is why `context.injected` events never fired off the
		// native Pi path.
		void this.recordDirectiveUsage(
			matches,
			telemetryBinding ?? this.activeTurnBinding,
		).catch(() => {
			/* fail-soft — never break a turn on a telemetry write */
		});

		// 3) Carry the injected directives (with their cache index) to the
		// post-turn INFLUENCE check (`recordDirectiveInfluenceForTurn`), the
		// other half of directive influence telemetry: we recorded that
		// these directives were INJECTED; once the assistant reply is known we
		// estimate whether each one INFLUENCED it and recalibrate confidence.
		this.lastInjectedDirectives = matches.map((m) => ({
			directive: this.compiledDirectives[m.index]!,
			index: m.index,
		}));

		return serializeMatchedDirectives(matches);
	},

	/**
	 * Combine the cached governed brain digest with bounded semantic recall from
	 * the platform memory API. That API uses Agent Memory only for candidate IDs
	 * and returns facts after canonical D1 lifecycle and visibility validation.
	 * Recall starts alongside the digest load and is capped at 2 s; trivial
	 * messages skip semantic recall (see `memory-recall.ts`). Preferences and
	 * referenced task state are refreshed separately on every ordinary turn.
	 */

	async brainDigestAddendum(
		this: RuntimeMemoryHost,
		userText: string,
		onRecall?: (report: MemoryRecallReport) => void,
		sessionKey?: string | null,
	): Promise<string> {
		const recallPromise = recallLongTermMemoryBlock({
			userText,
			search: async (query, limit) => {
				const platform = await this.getPlatformClient();
				return platform ? await platform.memorySearch(query, limit) : null;
			},
		});
		await this.ensureBrainDigestLoaded();
		const digest = this.brainDigest
			? serializeBrainDigest(this.brainDigest)
			: "";
		const { block: recall, ...report } = await recallPromise;
		onRecall?.(report);
		const current = await refreshTurnMemory({
			userText,
			remembered: [digest, recall].filter(Boolean).join("\n\n"),
			history: this.messagesForSession(sessionKey ?? DEFAULT_SESSION_KEY),
			refresh: async (references) => {
				const platform = await this.getPlatformClient();
				if (!platform) throw new Error("Task-state platform unavailable");
				return platform.getTurnMemory(references);
			},
		});
		return [digest, recall, current].filter(Boolean).join("\n\n");
	},

	/**
	 * Combined cognitive system-prompt addenda for one turn: the SELECTIVE
	 * compiled-directive block (matched against this turn's user text) plus the
	 * unconditional brain-digest block plus skill guidance plus the act-time
	 * retrieved-skills block (top-K proven procedures matched against this
	 * turn's task — {@link retrievedSkillsAddendum}).
	 *
	 * Shared by ALL turn families — native Pi `beforeTurn` (WS/mesh), the
	 * facet-routed Tedix OS SSE chat path, and the durable workflow facet turn
	 * (`prepareMcpFacetTurn`). Before this helper, ONLY `beforeTurn` injected
	 * these, so the Tedix OS/SSE/workflow paths never saw compiled directives or the
	 * brain digest at all — the tedi's compiled learning was invisible on its
	 * primary product path (and on the benchmark drive-turn path, which is how
	 * the gap was discovered: zero `context.injected` events fleet-wide).
	 *
	 * `sessionKey` is FIRST and required because it decides whether the tedi's
	 * accumulated belief may enter this turn at all: an `evidence:judge:*` turn
	 * is a BLIND VERIFICATION turn and gets nothing (see
	 * {@link composeCognitiveAddenda} / `isBlindVerificationSession`). Every
	 * other session key is unaffected.
	 *
	 * `telemetryBinding` carries (platform, conversationId, runId) for the
	 * `context.injected` ledger event on paths that don't maintain
	 * `this.activeTurnBinding`. Fail-soft: addenda failures never break a turn.
	 */

	async cognitiveAddenda(
		this: RuntimeMemoryHost,
		sessionKey: string | null | undefined,
		userText: string,
		telemetryBinding?: ActiveTurnBinding | null,
	): Promise<string> {
		let memoryRecall: MemoryRecallReport | null = null;
		return await composeCognitiveAddenda({
			sessionKey,
			runId: telemetryBinding?.runId ?? this.activeTurnBinding?.runId ?? null,
			skipDirectives: isHomeDelegationWorkOrder(userText),
			// Report cognitive addenda against the shared configured context window.
			contextWindowTokens: TEDI_CONTEXT_WINDOW_TOKENS,
			sources: {
				directives: () =>
					this.directivesPromptAddendum(userText, telemetryBinding),
				brainDigest: () =>
					this.brainDigestAddendum(
						userText,
						(report) => {
							memoryRecall = report;
						},
						sessionKey,
					),
				// Cached block into this turn, rebuild behind it (and one blocking
				// build on a cold cache) — see {@link skillGuidanceAddendum}.
				skillGuidance: () => this.skillGuidanceAddendum(),
				// Act-time top-K skill retrieval matched against this turn's task
				// (AWM/Memp retrieve leg). Runs AFTER skillGuidance in the compose
				// order, so a cold-start guidance build has already warmed the corpus.
				retrievedSkills: () =>
					this.retrievedSkillsAddendum(userText, telemetryBinding),
			},
			// Same event as the default sink, plus whether recall was skipped,
			// timed out or completed (null when the brain digest was withheld).
			onComposition: (report) =>
				console.log({ event: "tedi.context.addenda", ...report, memoryRecall }),
		});
	},

	/**
	 * Record which compiled directives matched the current turn as a
	 * `context.injected` runtime event. This is the isolate's nearest parity for
	 * directive influence telemetry — there is no dedicated
	 * `recordDirectiveUsage` RPC on `HttpPlatformClient`, so we route through the
	 * existing `recordRuntimeEvent` ledger surface rather than inventing a new RPC.
	 *
	 * This records that matched directives were INJECTED. The complementary
	 * INFLUENCE signal — whether a directive actually steered the reply — is
	 * computed post-turn by {@link recordDirectiveInfluenceForTurn} (called from
	 * `onChatResponse` once the assistant text is known), which recalibrates each
	 * directive's `successRate` confidence. Together they close the
	 * Phase-1 influence-attribution gap, mirroring the runtime's
	 * `usageRatioBoost`/`recordDirectiveBoost` (injected vs. used) spirit.
	 */

	async recordDirectiveUsage(
		this: RuntimeMemoryHost,
		matches: Array<{ directive: CompiledDirective }>,
		binding?: ActiveTurnBinding | null,
	): Promise<void> {
		const ctx = await this.resolveTurnTelemetry({ binding });
		if (!ctx) return;
		const { tediId, runId, conversationId, platform } = ctx;
		const sequence = this.directiveEventSequence++;
		const payload: DirectiveTelemetryPayload = {
			source: "compiled-directives",
			phase: "pre-turn-injection",
			matched: matches.length,
			directives: matches.map(({ directive: d }) => ({
				category: d.category,
				strength: d.strength,
				provenanceHash: d.provenanceHash,
				evidenceCount: d.evidenceCount,
			})),
		};
		await platform.recordRuntimeEvent({
			id: `${runId}:directives:${sequence}`,
			tediId,
			kind: "context.injected",
			conversationId,
			runId,
			sequence,
			payload,
			runtime: { backend: "cloudflare-agents" },
			createdAt: new Date().toISOString(),
		});
	},

	/**
	 * Post-turn INFLUENCE attribution — closes the gap the Phase-1 TODO left in
	 * {@link recordDirectiveUsage}: that path records that matched directives were
	 * INJECTED; this one estimates whether each one INFLUENCED the assistant reply
	 * and feeds the signal back into directive confidence, mirroring the runtime's
	 * `usageRatioBoost`/`recordDirectiveBoost` (which lives on retrieved brain
	 * facts) for compiled directives instead.
	 *
	 * HEURISTIC, not ground truth: there is no causal trace from a directive to a
	 * token, so "influenced" is approximated by keyword overlap between the
	 * directive's wording and the assistant's reply
	 * (`directiveInfluenced` / `DIRECTIVE_INFLUENCE_MIN_RATIO`). Effects are
	 * deliberately weak — a small EMA nudge to `successRate` per turn
	 * (`recordDirectiveInfluence`) — so noise self-corrects over many turns and a
	 * single off-topic reply never flips a directive. We never hard-delete: a
	 * directive that drifts to low confidence is left for the existing
	 * stale-prune + negative-feedback invalidation paths to own.
	 *
	 * Fail-soft + idempotent: consumes `lastInjectedDirectives` (cleared here), so
	 * a second call for the same turn is a no-op; any error is swallowed so the
	 * turn is never broken by a confidence write.
	 */

	async recordDirectiveInfluenceForTurn(
		this: RuntimeMemoryHost,
		assistantText: string,
		binding?: ActiveTurnBinding | null,
	): Promise<void> {
		const injected = this.lastInjectedDirectives;
		this.lastInjectedDirectives = null;
		if (!injected || injected.length === 0) return;
		const reply = assistantText.trim();
		if (!reply) return;

		// Recalibrate confidence in the in-memory cache + collect the persist set.
		const updates: Array<{ directive: CompiledDirective; index: number }> = [];
		const influenceReport: Array<{
			category: string;
			strength: CompiledDirective["strength"];
			provenanceHash: string;
			influenced: boolean;
			ratio: number;
			successRate: number;
		}> = [];
		for (const { directive, index } of injected) {
			// The cache may have been reloaded between inject + now (failure
			// invalidation drops `directivesLoaded`); skip stale indices/rows.
			const current = this.compiledDirectives[index];
			if (!current || current !== directive) continue;
			const ratio = directiveInfluenceRatio(current.directive, reply);
			const influenced = directiveInfluenced(current.directive, reply);
			const successRate = recordDirectiveInfluence(
				this.compiledDirectives,
				index,
				influenced,
			);
			updates.push({ directive: current, index });
			influenceReport.push({
				category: current.category,
				strength: current.strength,
				provenanceHash: current.provenanceHash,
				influenced,
				ratio: Math.round(ratio * 100) / 100,
				successRate: Math.round(successRate * 100) / 100,
			});
		}
		if (updates.length === 0) return;

		// Persist the recalibrated confidence (best-effort, in-place blob UPDATE).
		try {
			await this.getDirectiveStore().recordInfluence(updates);
		} catch (err) {
			logTediSourceFailure("directives", "persist_influence", err);
		}

		// Record a lightweight influence telemetry event (the post-turn half of
		// DirectiveTelemetryPayload). Uses the ACTUAL turn binding (captured in
		// beforeTurn, passed in from onChatResponse before it cleared
		// activeTurnBinding) so the influence event correlates with the turn it
		// scored — the explicit `!binding` guard keeps a late call from
		// rebinding to some OTHER turn's activeTurnBinding via the resolver's
		// fallback.
		try {
			if (!binding?.runId) return;
			const ctx = await this.resolveTurnTelemetry({ binding });
			if (!ctx) return;
			const { tediId, runId, conversationId, platform } = ctx;
			const sequence = this.directiveEventSequence++;
			const payload: DirectiveTelemetryPayload = {
				source: "compiled-directives",
				phase: "post-turn-influence",
				heuristic: "keyword-overlap",
				evaluated: influenceReport.length,
				influenced: influenceReport.filter((r) => r.influenced).length,
				directives: influenceReport,
			};
			await platform.recordRuntimeEvent({
				id: `${runId}:directives:${sequence}`,
				tediId,
				kind: "context.injected",
				conversationId,
				runId,
				sequence,
				payload,
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date().toISOString(),
			});
		} catch (err) {
			logTediSourceFailure("directives", "emit_influence", err);
		}
	},

	/**
	 * Directive-compile alarm. Compiles the tedi's completed rationale corpus
	 * into Atlas-style ALWAYS/NEVER/PREFER directives (`compileDirectives` from
	 * `src/brain/`; runtime parity — `refreshDirectives` in
	 * tedix-context), persists them to DO SQLite, and refreshes the in-memory
	 * cache that {@link directivesPromptAddendum} injects into the system prompt.
	 *
	 * Uses the template (fallback) compiler — no per-compile LLM cost. Returns
	 * `[]` until the corpus crosses `PROMOTION_THRESHOLD` completed records, so
	 * young tedis simply get no directives. Compilation failures propagate to the
	 * owning maintenance operation; the prior cached directives stay active.
	 */

	async onCompileDirectives(
		this: RuntimeMemoryHost,
		admittedRunId: string,
	): Promise<void> {
		if (typeof admittedRunId !== "string" || !admittedRunId.trim())
			throw new Error("Maintenance compilation requires its original run ID");
		await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
		await this.ensureIdentity();
		const nativePlatform = await this.getPlatformClient();
		const platform =
			nativePlatform && this.admittedEffectPort(nativePlatform, admittedRunId);
		if (!platform) throw new Error("Maintenance platform is unavailable");
		// Timeout-guard the compile: it makes an HTTP `getRationaleChain` call,
		// and this runs in the DO's alarm context — a hung upstream must not
		// wedge the DO. The 20s ceiling fails the owning maintenance operation.
		const directives = await Promise.race([
			compileDirectives({ platform }),
			new Promise<CompiledDirective[]>((_, reject) =>
				setTimeout(
					() => reject(new Error("compileDirectives timed out")),
					20_000,
				),
			),
		]);
		await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
		await this.getDirectiveStore().save(directives);
		this.compiledDirectives = directives;
		this.directivesLoaded = true;
		if (directives.length > 0) {
			console.log(
				`[isolate.directives] compiled=${directives.length} tedi=${this.state.slug}`,
			);
		} else {
			// No directives — run the gap diagnostic so operators can see WHY.
			// This is a read of the same rationale chain (cheap, no LLM) and
			// emits a structured log instead of silent [].
			try {
				const { data: records } = await platform.getRationaleChain(50);
				const gap = diagnoseDirectiveGap(
					(records || []).map((r) => ({
						id: r.id,
						action: r.action,
						category: r.category,
						outcome: r.outcome ?? undefined,
						outcomeStatus: r.outcomeStatus,
					})),
				);
				console.log(
					`[isolate.directives] zero-directive gap: reason=${gap.reason} ` +
						`total=${gap.totalRecords} completed=${gap.completedRecords} ` +
						`clusters=${gap.clusters} promoted=${gap.promotedClusters} ` +
						`tedi=${this.state.slug}`,
				);
			} catch {
				// Gap diagnostic is best-effort — never break the alarm.
			}
		}
	},

	// ===========================================================================
	// Memory effects + facet/workflow turns
	// ===========================================================================

	/**
	 * Corpus-audit alarm. Computes rationale-corpus health telemetry
	 * (`auditRationaleCorpus` from `brain/corpus-audit.ts` — the
	 * single source shared with the context bridge) over the
	 * tedi's completed rationale chain and logs the result as telemetry.
	 *
	 * Pure read: only `platform.getRationaleChain`. The container plugin persists
	 * the result to `memory/corpus-audit.json`; the isolate has no workspace dir,
	 * so it logs the stats (matching tedix-context's own console output). The
	 * platform call is timeout-guarded (20s) so a hung upstream cannot wedge the
	 * DO alarm. Fail-soft: errors never break chat; the next alarm retries.
	 */

	async onAuditCorpus(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
	): Promise<void> {
		try {
			await this.ensureIdentity();
			const nativePlatform = await this.getPlatformClient();
			const platform =
				nativePlatform &&
				(admittedRunId
					? this.admittedEffectPort(nativePlatform, admittedRunId)
					: nativePlatform);
			if (!platform) throw new Error("Maintenance platform is unavailable");
			const result = await Promise.race([
				auditRationaleCorpus(platform, 100),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("auditRationaleCorpus timed out")),
						20_000,
					),
				),
			]);
			console.log(
				`[isolate.corpus-audit] records=${result.totalRecords} ` +
					`complete=${Math.round(result.completionRate * 100)}% ` +
					`avgConfidence=${result.avgConfidence} ` +
					`categories=${result.uniqueCategories.length} ` +
					`contrastive=${result.contrastiveViability} lora=${result.loraViability} ` +
					`tedi=${this.state.slug}`,
			);
		} catch (err) {
			if (admittedRunId) throw err;
			logTediSourceFailure("corpus_audit", "audit", err, "error");
			// Fail-soft — never break chat; the next alarm retries.
		}
	},

	/**
	 * Brain-digest alarm. Distills the tedi's top-K brain facts into a stable
	 * knowledge summary (`compileBrainDigest` from `brain/brain-digest.ts`
	 * — the single source shared with the context bridge),
	 * persists it to DO SQLite, and refreshes the in-memory cache that
	 * {@link brainDigestAddendum} injects into the system prompt every turn
	 * ("stable retrieval mode").
	 *
	 * Makes a platform read (`getDomains` + per-domain `memorySearch`) plus one
	 * LLM distill call via {@link getObserverLlmClient}. Both the platform reads
	 * and the LLM call are timeout-guarded (25s ceiling — slightly above the
	 * directive/corpus 20s because the per-domain searches fan out) so a hung
	 * upstream cannot wedge the DO alarm. Returns `null` until the corpus has 3+
	 * facts, so young tedis simply get no digest (the addendum stays empty).
	 * Failures propagate to the owning maintenance operation; the prior cached
	 * digest stays active.
	 */

	async onCompileBrainDigest(
		this: RuntimeMemoryHost,
		admittedRunId: string,
	): Promise<void> {
		if (typeof admittedRunId !== "string" || !admittedRunId.trim())
			throw new Error("Maintenance compilation requires its original run ID");
		await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
		await this.ensureIdentity();
		const nativePlatform = await this.getPlatformClient();
		const platform =
			nativePlatform && this.admittedEffectPort(nativePlatform, admittedRunId);
		if (!platform) throw new Error("Maintenance platform is unavailable");
		const llm = this.getObserverLlmClient(admittedRunId);
		const previousDigest =
			this.brainDigest ?? (await this.getBrainDigestStore().load());
		const digest = await Promise.race([
			compileBrainDigest(platform, {
				llm,
				model: this.env.AZURE_OBSERVER_DEPLOYMENT,
				previousDigest,
			}),
			new Promise<BrainDigest | null>((_, reject) =>
				setTimeout(
					() => reject(new Error("compileBrainDigest timed out")),
					25_000,
				),
			),
		]);
		if (!digest) return;
		await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
		await this.getBrainDigestStore().save(digest);
		this.brainDigest = digest;
		this.brainDigestLoaded = true;
		console.log(
			`[isolate.brain-digest] compiled facts=${digest.factCount} ` +
				`domains=${digest.domains.length} tedi=${this.state.slug}`,
		);
	},

	/**
	 * Single post-turn MEMORY-effects dispatcher: the brain bridge (learning)
	 * and the daily narrative log. Every turn surface (WS chat, MCP, voice,
	 * workflow commit) routes through here so lean-context sessions —
	 * blind verification (`evidence:judge:*`) and lean workflow synthesis
	 * (`workflow:synth:*`) — are excluded from ALL memory surfaces by ONE
	 * structural gate — a future memory surface added here inherits it instead
	 * of needing its own vigilance-based check. The write-side gates inside
	 * `enqueueDailyLogPair` / `onBridgeTurn` remain as defense-in-depth for
	 * queue-replay entry points. Audit/ledger mirroring (`onLedgerMirror`) and
	 * session compaction are deliberately NOT dispatched here: a blind judge
	 * turn stays durable and audited — it only must not be learned from.
	 */

	async dispatchTurnMemoryEffects(
		this: RuntimeMemoryHost,
		input: {
			user: RecentTurn;
			assistant: RecentTurn;
			runId: string;
			sessionKey: string;
			origin: string;
			/** Home Work Item served by this delegated turn, when present. */
			workItemId?: string;
			learningMode?: AdaptiveLearningMode;
			traceId?: string;
			/**
			 * WS1: pre-captured tool-call refs for the run. The workflow-commit path
			 * passes these explicitly because the trace-bundle writer consumes the
			 * per-run step buffer before this dispatcher runs there; every other
			 * surface lets the dispatcher read the buffer directly.
			 */
			toolCallRefs?: string[];
			/** Canonical, content-free tool outcomes captured before trace consumption. */
			executionEvidence?: ObserverToolExecutionEvidence[];
			/** Await the bridge inline (workflow commit needs completion ordering). */
			awaitBridge?: boolean;
			/** Workflow commit logs only genuine inserts. */
			dailyLog?: boolean;
		},
	): Promise<void> {
		if (
			isLeanContextSession(input.sessionKey) ||
			isEphemeralSession(input.sessionKey)
		) {
			createTurnLearningTelemetry(input).finish(
				"skipped",
				"lean_context_session",
			);
			return;
		}
		const toolCallRefs =
			input.toolCallRefs ?? this.toolCallRefsForRun(input.runId);
		const executionEvidence =
			input.executionEvidence ?? this.toolExecutionEvidenceForRun(input.runId);
		const payload = {
			user: input.user,
			assistant: input.assistant,
			runId: input.runId,
			origin: input.origin,
			sessionKey: input.sessionKey,
			...(input.workItemId ? { workItemId: input.workItemId } : {}),
			...(toolCallRefs.length > 0 ? { toolCallRefs } : {}),
			...(executionEvidence.length > 0 ? { executionEvidence } : {}),
			...(input.learningMode !== undefined
				? { learningMode: input.learningMode }
				: {}),
			...(input.traceId ? { traceId: input.traceId } : {}),
		};
		if (
			(input.learningMode ??
				adaptiveLearningModeForTurn({
					userText: input.user.content,
					assistantText: input.assistant.content,
				})) === "disabled"
		) {
			createTurnLearningTelemetry(input).finish("skipped", "learning_disabled");
			return;
		}
		const admission = this.runtimeAdmission();
		if (admission) {
			await this.acceptRuntimeTurn(`${input.runId}:memory`, input.sessionKey, {
				kind: "memory_effects",
				payload,
			});
			const memoryKey = `runtime-admission-memory:${input.runId}`;
			const prior = await this.ctx.storage.get<{
				stage: string;
				payload: BridgeTurnInput;
			}>(memoryKey);
			if (prior && JSON.stringify(prior.payload) !== JSON.stringify(payload))
				throw new Error("Original memory operation changed");
			if (!prior)
				await this.ctx.storage.put(memoryKey, { stage: "accepted", payload });
		}
		if (input.awaitBridge) {
			try {
				await this.onBridgeTurn(payload);
			} catch (e) {
				logTediSourceFailure("brain_bridge", "execute", e);
			}
		} else {
			void this.queue("onBridgeTurn", payload, {
				retry: { maxAttempts: 3 },
			}).catch((e) => logTediSourceFailure("brain_bridge", "queue", e));
		}
		if (input.dailyLog !== false) {
			this.enqueueDailyLogPair(input.user, input.assistant);
		}
	},

	/**
	 * Enqueue a user+assistant pair into {@link State.pendingDailyEntries}
	 * for the admitted periodic {@link onDailyLogFlush} owner.
	 */

	enqueueDailyLogPair(
		this: RuntimeMemoryHost,
		user: RecentTurn,
		assistant: RecentTurn,
	): void {
		// A blind verification turn (`evidence:judge:*`) leaves no trace in the
		// tedi's own narrative memory: the daily log is compacted and read back as
		// context, so logging the judge prompt would reintroduce the claim text the
		// judge is supposed to evaluate independently. Same reasoning as the
		// `onBridgeTurn` gate. Lean workflow-synthesis turns (`workflow:synth:*`)
		// are excluded too: they are self-contained summarizations already
		// recorded in run rationales, so a narrative-memory trace would only
		// re-inject bulk workflow input into compacted context.
		if (isLeanContextSession(user.sessionKey)) return;
		const turnId = `${user.ts}-${assistant.ts}`;
		const entries: DailyLogEntry[] = [
			{ ts: user.ts, role: "user", content: user.content, turnId },
			{
				ts: assistant.ts,
				role: "assistant",
				content: assistant.content,
				turnId,
			},
		];
		const next = [...(this.state.pendingDailyEntries ?? []), ...entries];
		this.setState({ ...this.state, pendingDailyEntries: next });
	},

	/**
	 * Drain {@link State.pendingDailyEntries} into the per-tedi CF Artifacts
	 * repo, grouped by UTC date so a flush that straddles midnight still
	 * writes the right file per day. Serialized via {@link dailyLogWriteLock}
	 * so admitted writes cannot race a non-fast-forward push.
	 *
	 * Fail-soft: on commit/push error, leaves entries in the queue for the
	 * next tick. We snapshot before commit and remove just the drained ids
	 * after, so entries enqueued during the in-flight write are not dropped.
	 *
	 * Repo is provisioned lazily on first flush (see `artifacts-git.ts`).

	 */

	async onDailyLogFlush(
		this: RuntimeMemoryHost,
		admittedRunId?: string,
	): Promise<ArtifactsPushReceipt | null> {
		const run = async (): Promise<ArtifactsPushReceipt | null> => {
			if (!admittedRunId)
				throw new Error(
					"Daily logs require an original admitted maintenance operation",
				);
			await this.assertChatTurnActive(admittedRunId);
			if (this.ctx.storage.kv.get("runtime-admission-artifacts-pending"))
				throw new Error("Previous Artifacts push is unresolved");
			const pending = this.state.pendingDailyEntries ?? [];
			if (pending.length === 0) return null;
			await this.ensureIdentity();
			const { tediId, slug } = this.state;
			if (!tediId) {
				if (admittedRunId)
					throw new Error("Maintenance tedi identity is missing");
				console.warn("[isolate.daily-log] flush skipped: missing tediId");
				return null;
			}
			const nativeArtifacts = this.env.ARTIFACTS;
			const artifacts =
				nativeArtifacts &&
				(admittedRunId
					? this.admittedEffectPort(nativeArtifacts, admittedRunId)
					: nativeArtifacts);
			if (!artifacts) {
				if (admittedRunId)
					throw new Error("Maintenance Artifacts binding is unavailable");
				console.warn(
					"[isolate.daily-log] flush skipped: ARTIFACTS binding missing",
				);
				return null;
			}

			const snapshot = pending.slice();
			const byDate = new Map<string, DailyLogEntry[]>();
			for (const entry of snapshot) {
				const date = utcDateSlug(entry.ts);
				const list = byDate.get(date) ?? [];
				list.push(entry);
				byDate.set(date, list);
			}
			const batches: DailyLogBatch[] = [...byDate.entries()].map(
				([date, entries]) => ({ date, entries }),
			);

			await this.ctx.storage.put("runtime-admission-artifacts-pending", {
				runId: admittedRunId,
				snapshot,
				stage: "running",
			});
			let pushReceipt: ArtifactsPushReceipt | null;
			try {
				if (admittedRunId)
					await this.runtimeAdmission()?.assertAcceptedTurn({
						runId: admittedRunId,
					});
				pushReceipt = await commitDailyLogEntries(artifacts, {
					assertReady: () => this.assertChatTurnActive(admittedRunId),
					accountId: this.env.CF_ACCOUNT_ID,
					// Matches the `namespace` in apps/tedi-runtime/wrangler.jsonc
					// and apps/tedi/cloudflare.config.ts — same repo identity for both
					// runtimes.
					namespace: "tedix-prod",
					tediId,
					slug: slug || tediId,
					batches,
				});
			} catch (err) {
				if (admittedRunId) throw err;
				console.warn(
					"[isolate.daily-log] Artifacts commit failed; leaving queue for retry:",
					err,
				);
				return null;
			}

			if (!pushReceipt)
				throw new Error("Artifacts push acknowledgment is missing");
			await this.runtimeAdmission()?.assertOriginalClaim({
				runId: admittedRunId,
			});
			const drained = new Set(
				snapshot.map((e) => `${e.ts}|${e.role}|${e.turnId}`),
			);
			const remaining = (this.state.pendingDailyEntries ?? []).filter(
				(e) => !drained.has(`${e.ts}|${e.role}|${e.turnId}`),
			);
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.kv.put(
					`runtime-admission-artifacts:${admittedRunId}`,
					{ pushReceipt, snapshot },
				);
				this.setState({ ...this.state, pendingDailyEntries: remaining });
				this.ctx.storage.kv.delete("runtime-admission-artifacts-pending");
			});
			return pushReceipt;
		};

		const next = this.dailyLogWriteLock.then(run, run);
		this.dailyLogWriteLock = next.then(
			() => undefined,
			() => undefined,
		);
		return await next;
	},

	/** Canonical observer write followed by fail-soft durable projections. */

	async runBridgeTurnInner(
		this: RuntimeMemoryHost,
		payload: BridgeTurnInput,
		signal: AbortSignal,
		telemetry: LearningTelemetry,
		deadlineAt: number,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			await this.ensureIdentity();
			const platformClient = await this.getPlatformClient();
			const platform =
				platformClient &&
				this.admittedEffectPort(
					platformClient.forRequest({
						signal,
						traceId: payload.traceId ?? payload.runId,
					}),
					`${payload.runId}:memory`,
				);
			if (!platformClient || !platform) {
				if (this.runtimeAdmission())
					throw new Error("Original memory platform is unavailable");
				telemetry.finish("skipped", "no_platform_client");
				console.warn(
					"[isolate-brain-bridge] no platform client (missing tediId or DESCOPE_ACCESS_KEY); skipping turn",
				);
				return;
			}
			// Each optional stage gets a client bound to its own abort signal.
			const platformFor = (stageSignal: AbortSignal) =>
				this.admittedEffectPort(
					platformClient.forRequest({
						signal: stageSignal,
						traceId: payload.traceId ?? payload.runId,
					}),
					`${payload.runId}:memory`,
				);
			signal.throwIfAborted();

			// Observer surface: `observerModelRef` when the profile sets one, else
			// exactly `env.AZURE_OBSERVER_DEPLOYMENT`. Resolve the policy first so
			// this background bridge does not depend on a prior turn having cached
			// it; `ensureModelPolicy` is itself fail-soft and a no-op once cached.
			await this.ensureModelPolicy().catch(() => {});
			signal.throwIfAborted();
			const observerDeployment = this.modelOverrideForSurface(
				"observer",
			)?.modelRef.startsWith("azure-openai/")
				? this.observerDeploymentForTurn()
				: undefined;
			const observerModelRef = resolveSurfaceModelRef(
				this.runtimeConfigCache.modelPolicy,
				"observer",
			);

			const observerUser = {
				...payload.user,
				sessionKey: payload.sessionKey ?? payload.user.sessionKey,
			};
			const observerInput = buildObserverInput(
				observerUser,
				payload.assistant,
				payload.executionEvidence,
			);

			telemetry.observer.configuredModel =
				observerModelRef ??
				observerDeployment ??
				this.env.AZURE_OBSERVER_DEPLOYMENT;
			telemetry.observer.inputChars = observerInput.length;
			const observerStarted = performance.now();
			let raw: string | undefined;
			let parsed: ObserverResult;
			try {
				const beforeDispatch = this.observerBeforeDispatch(
					`${payload.runId}:memory`,
					payload.runId,
				);
				beforeDispatch();
				raw = await observerCompletion({
					beforeDispatch,
					env: this.env,
					signal,
					deployment: observerDeployment,
					modelRef: observerModelRef,
					metadata: {
						...this.tediAigMetadata("observer:post-turn", {
							runId: payload.runId,
							sessionKey: payload.sessionKey ?? payload.user.sessionKey,
						}),
					},
					messages: [
						{ role: "system", content: OBSERVER_SYSTEM_PROMPT },
						{ role: "user", content: observerInput },
					],
				});
				const cleaned = stripCodeFences(raw);
				parsed = parseObserverResult(cleaned);
				telemetry.observer.status = "completed";
			} catch (err) {
				if (this.runtimeAdmission()) throw err;
				telemetry.observer.status = "failed";
				signal.throwIfAborted();
				console.warn("[isolate-brain-bridge] Observer LLM call failed:", {
					error: errorMessage(err),
				});
				parsed = { observations: [] };
			} finally {
				telemetry.observer.durationMs = Math.round(
					performance.now() - observerStarted,
				);
			}
			signal.throwIfAborted();
			telemetry.observer.observations = parsed.observations.length;
			if (parsed.observations.length === 0) {
				console.log(
					`[isolate-brain-bridge] Observer produced 0 observations (raw_len=${raw?.length ?? 0}); using terminal episode fallback`,
				);
			}
			const rationaleObservations = ensureTerminalEpisodeObservation(
				parsed.observations,
				observerUser,
				payload.assistant,
				payload.executionEvidence,
			);

			// Condense large observation sets before canonical learning; rationale
			// and crystallization still inspect the unmerged observer output below.
			let bridgeObservationsSet = parsed.observations;
			const observationTokens = tokensForSerialized(
				serializeObservationsForReflector(parsed.observations),
			);
			telemetry.reflector.inputTokens = observationTokens;
			telemetry.reflector.status = "below_threshold";
			if (observationTokens >= REFLECT_THRESHOLD_TOKENS) {
				const reflectorStarted = performance.now();
				telemetry.reflector.status = "no_client";
				try {
					const llm = this.getObserverLlmClient(
						`${payload.runId}:memory`,
						payload.runId,
					);
					if (llm) {
						telemetry.reflector.status = "invoked";
						const reflection = await reflect({
							observations: parsed.observations,
							llm,
							model:
								observerModelRef ?? observerDeployment ?? "cloudflare/auto",
							serialize: serializeObservationsForReflector,
							signal,
						});
						bridgeObservationsSet = reflection.observations;
						console.log(
							`[isolate-reflector] tokens=${observationTokens} merged=${reflection.mergedCount} ` +
								`kept=${reflection.keptCount} before=${reflection.tokensBefore} after=${reflection.tokensAfter} tedi=${this.state.slug}`,
						);
					}
				} catch (reflectErr) {
					if (this.runtimeAdmission()) throw reflectErr;
					telemetry.reflector.status = "failed";
					signal.throwIfAborted();
					console.warn(
						"[isolate-reflector] condensation failed; using raw observations:",
						reflectErr,
					);
					bridgeObservationsSet = parsed.observations;
				} finally {
					telemetry.reflector.durationMs = Math.round(
						performance.now() - reflectorStarted,
					);
				}
			}
			telemetry.reflector.outputObservations = bridgeObservationsSet.length;

			signal.throwIfAborted();
			// Essential path: the canonical fact write runs first, under the
			// pass's own signal, before any optional projection starts.
			const bridgeStarted = performance.now();
			let bridgeStatus: "completed" | "failed" = "failed";
			let bridged: number;
			try {
				bridged = await bridgeObservations({
					observations: bridgeObservationsSet,
					minPriority: "medium",
					platform,
					dedup: this.getDedupStore(),
					currentTask: parsed.currentTasks?.[0],
					sourceEvidence: buildMemorySourceEvidence(
						observerUser,
						payload.assistant,
						payload.executionEvidence,
					),
					onMetrics: (metrics) => {
						telemetry.bridge = metrics;
					},
				});
				bridgeStatus = "completed";
			} finally {
				telemetry.stages.bridge = {
					status: bridgeStatus,
					durationMs: Math.round(performance.now() - bridgeStarted),
					budgetMs: Math.max(0, Math.round(deadlineAt - bridgeStarted)),
				};
			}
			console.log(
				`[isolate-brain-bridge] observerModel=${observerDeployment} observed=${parsed.observations.length} bridgeInput=${bridgeObservationsSet.length} bridged=${bridged} tedi=${this.state.slug}`,
			);

			// Optional projections run after the essential fact write, each under
			// its own budget and signal (`runLearningStage`), so one slow stage
			// records `timed_out` in `telemetry.stages` instead of burning the
			// pass's 25s cap. Rationale, crystallizer, task promotion and the
			// turn-summary artifact are independent and run in parallel; the trace
			// bundle needs their ids and runs after them.
			const stageContext = {
				signal,
				deadlineAt,
				strict: Boolean(this.runtimeAdmission()),
				telemetry,
			};
			const [rationaleResult, , , artifactId] = await Promise.all([
				// Rationale bridging uses the full observer set even when fact writes
				// dedupe, and invalidates counter-evidenced compiled directives.
				runLearningStage(stageContext, "rationale", (stageSignal) =>
					runRationaleBridge({
						newObservations: rationaleObservations,
						platform: platformFor(stageSignal),
						stateStore: this.getRationaleStore(),
						// Enables directive invalidation: a failure observation drops
						// ALWAYS directives in the same category (their counter-evidence).
						directives: this.getDirectiveStore(),
						correlation: {
							traceId: payload.runId,
							// WS1 execution links: the bridge attaches the turn's runId +
							// tool-call refs to every record it creates, and uses the runId
							// as the span-checkable proof for success completions. Without
							// these the platform hard-rejects the write.
							runId: payload.runId,
							...(payload.toolCallRefs?.length
								? { toolCallRefs: payload.toolCallRefs }
								: {}),
							...(payload.workItemId ? { workItemId: payload.workItemId } : {}),
							sourceSessionId: payload.user.sessionKey || DEFAULT_SESSION_KEY,
						},
					}),
				),
				// Crystallizer: buffer this turn's procedural observations, then
				// detect patterns recurring ACROSS turns against the rolling buffer
				// and promote them to draft/improved muscle-memory skills. DO SQLite
				// backs the per-pattern dedup, so it is idempotent.
				runLearningStage(stageContext, "crystallizer", async (stageSignal) => {
					const crystalStore = this.getCrystallizationStore();
					crystalStore.bufferObservations(
						parsed.observations,
						payload.assistant.ts,
					);
					const crystallized = await runCrystallization({
						observations: crystalStore.loadBufferedObservations(),
						platform: platformFor(stageSignal),
						stateStore: crystalStore,
					});
					if (crystallized > 0) {
						console.log(
							`[isolate-crystallizer] crystallized=${crystallized} tedi=${this.state.slug}`,
						);
					}
				}),
				// Promote confirmed task intents through the canonical Work Items API.
				// The local store keeps promotion idempotent; provider sync is separate.
				parsed.taskIntents && parsed.taskIntents.length > 0
					? runLearningStage(
							stageContext,
							"task_promotion",
							async (stageSignal) => {
								const promotion = await promoteWorkItems({
									taskIntents: parsed.taskIntents ?? [],
									platform: platformFor(stageSignal),
									store: this.getWorkItemPromotionStore(),
									sessionKey: payload.user.sessionKey || DEFAULT_SESSION_KEY,
									runId: payload.runId,
								});
								if (promotion.detected > 0) {
									console.log(
										`[isolate-task-bridge] detected=${promotion.detected} ` +
											`candidates=${promotion.externalCandidates} ` +
											`promoted=${promotion.promoted} tedi=${this.state.slug}`,
									);
								}
							},
						)
					: undefined,
				// Turn-summary artifact: persist the Observer's structured output as
				// a durable TediArtifact bound to the turn's STABLE runId, under the
				// slug-prefixed conversation id every other isolate emitter uses.
				runLearningStage(stageContext, "artifact", (stageSignal) =>
					recordTurnSummaryArtifact({
						signal: stageSignal,
						platform: platformFor(stageSignal),
						bucket:
							this.env.TEDI_STORAGE &&
							this.admittedEffectPort(
								this.env.TEDI_STORAGE,
								`${payload.runId}:memory`,
							),
						tediId: this.state.tediId,
						conversationId: buildTediConversationId({
							tediRef: this.state.slug || this.state.tediId,
							sessionKey: payload.user.sessionKey,
						}),
						runId: payload.runId,
						turnId: sanitizeTurnKey(payload.runId),
						observerSummary: {
							observations: parsed.observations,
							currentTasks: parsed.currentTasks,
							suggestedResponse: parsed.suggestedResponse,
						},
						userText: payload.user.content,
						assistantText: payload.assistant.content,
					}),
				),
			]);
			// The rationale bridge may have invalidated directives in the store.
			// Drop the in-memory cache so `beforeTurn` reloads the reduced set.
			this.directivesLoaded = false;

			// Persist this run's rationale + artifact ids, then (re-)emit the
			// per-run TraceBundle so it references them. `onLedgerMirror` may emit
			// first with empty arrays; `recordTraceBundle` merges, so this emission
			// completes the bundle regardless of order.
			const traceRunId = payload.runId;
			const rationaleRecordIds = rationaleResult?.recordIds ?? [];
			const collectedArtifactIds = artifactId ? [artifactId] : [];
			this.recordPendingTraceIds(
				traceRunId,
				rationaleRecordIds,
				collectedArtifactIds,
			);
			await runLearningStage(
				stageContext,
				"trace_bundle",
				async (stageSignal) => {
					const stagePlatform = platformFor(stageSignal);
					// Score the just-closed turn against the active harness version
					// FIRST (Slice B), so every production episode feeds meanScore;
					// the returned id links this run's trace bundle to its score.
					const evalResultId =
						(await this.scoreTurn({
							platform: stagePlatform,
							tediId: this.state.tediId,
							orgId: this.state.orgId || undefined,
							runId: traceRunId,
							assistantText: payload.assistant.content,
							outcome: "success",
							unrecoveredError: false,
						})) ?? undefined;
					stageSignal.throwIfAborted();
					if (
						rationaleRecordIds.length === 0 &&
						collectedArtifactIds.length === 0
					)
						return;
					const conversationId = buildTediConversationId({
						tediRef: this.state.slug || this.state.tediId,
						sessionKey: payload.sessionKey || payload.user.sessionKey,
					});
					// Read-only: match the ledger mirror's conversation.created
					// without mutating the seen-set (the mirror owns that).
					const emitConversationCreated = !(
						this.state.ledgerConversationsSeen ?? []
					).includes(conversationId);
					await this.emitTraceBundleForRun({
						platform: stagePlatform,
						tediId: this.state.tediId,
						orgId: this.state.orgId || undefined,
						conversationId,
						sessionKey:
							payload.sessionKey ||
							payload.user.sessionKey ||
							DEFAULT_SESSION_KEY,
						runId: traceRunId,
						startedAt: new Date(payload.user.ts).toISOString(),
						endedAt: new Date(payload.assistant.ts).toISOString(),
						emitConversationCreated,
						evidence: {
							userText: payload.user.content,
							assistantText: payload.assistant.content,
						},
						evalResultId,
					});
				},
			);
			signal.throwIfAborted();
		} catch (err) {
			if (this.runtimeAdmission()) throw err;
			telemetry.finish("failed");
			console.error("[isolate-brain-bridge] turn bridge failed:", {
				error: errorMessage(err),
			});
			// Fail-soft — never break chat.
		}
	},

	/**
	 * Brain-bridge entry point (queued via `this.queue`). Hard 25s ceiling on the
	 * reflection pipeline (observer / reflector / brain / rationale / crystallizer
	 * / directive / artifact).
	 *
	 * Root cause: the failure mode that wedges a tedi is **queued reflection-job
	 * starvation**, NOT a "hung platform HTTP call" — the platform RPC client (`HttpPlatformClient.rpc`) already has a 15s
	 * `AbortController` timeout. The unguarded paths were the isolate's own Azure
	 * LLM `fetch()`es (observer + reflector), which had no signal. Because the DO
	 * queue is serialized (`messageConcurrency="queue"`), one job that outlives
	 * its handler starves every later job + request, and the poison persists in DO
	 * SQLite across restarts.
	 *
	 * So the timeout is now REAL, not just a `Promise.race`: an `AbortController`
	 * is threaded into the observer + reflector LLM calls, and on timeout we abort
	 * it so the underlying `fetch` actually cancels (rather than leaking). We catch
	 * (no rethrow) so the queue advances without a retry storm. 25s is well above
	 * legit reflection cost and safely under the 30s MCP edge timeout.
	 */

	async onBridgeTurn(
		this: RuntimeMemoryHost,
		payload: BridgeTurnInput,
	): Promise<void> {
		const telemetry = createTurnLearningTelemetry(payload);
		// Ephemeral (test/validation) sessions skip the brain bridge too — there's
		// no durable run to attach learned observations/rationale to (the ledger
		// mirror is skipped), so bridging would orphan them. The turn still ran +
		// replied; only the durable side-effects are skipped. See
		// `isEphemeralSession`.
		//
		// BLIND VERIFICATION (`evidence:judge:*`) sessions skip it for the opposite
		// reason: the turn is durable and audited, but the tedi must not LEARN from
		// judging its own citations. Observing a judge turn would fold the claim
		// text ("demand rose BECAUSE of the heatwave") back into the brain as a
		// memory — the exact belief the next verification is supposed to test
		// independently. Read-blindness without write-blindness is a one-turn delay,
		// not a fix.
		const bridgeSessionKey = payload.sessionKey ?? payload.user.sessionKey;
		if (
			isEphemeralSession(bridgeSessionKey) ||
			isBlindVerificationSession(bridgeSessionKey)
		) {
			telemetry.finish(
				"skipped",
				isEphemeralSession(bridgeSessionKey)
					? "ephemeral_session"
					: "blind_verification",
			);
			return;
		}
		const learningMode =
			payload.learningMode ??
			adaptiveLearningModeForTurn({
				userText: payload.user.content,
				assistantText: payload.assistant.content,
			});
		if (learningMode === "disabled") {
			telemetry.finish("skipped", "learning_disabled");
			console.log(
				`[isolate-brain-bridge] adaptive learning disabled before observer tedi=${this.state.slug}`,
			);
			return;
		}
		const admission = this.runtimeAdmission();
		const memoryRunId = `${payload.runId}:memory`;
		const memoryKey = `runtime-admission-memory:${payload.runId}`;
		if (admission) {
			await admission.assertOriginalClaim({
				runId: memoryRunId,
				sessionKey: bridgeSessionKey,
				input: { kind: "memory_effects", payload },
			});
			const journal = await this.ctx.storage.get<{
				stage: string;
				payload: BridgeTurnInput;
			}>(memoryKey);
			if (
				!journal ||
				JSON.stringify(journal.payload) !== JSON.stringify(payload)
			)
				throw new Error("Original memory dispatch changed");
			if (journal.stage === "completed") {
				await this.completeRuntimeTurn(
					memoryRunId,
					`${memoryRunId}:effects`,
					journal,
				);
				return;
			}
			if (journal.stage !== "accepted")
				throw new Error("Original memory effects remain uncertain");
			await admission.assertAcceptedTurn({ runId: memoryRunId });
			await this.ctx.storage.put(memoryKey, { ...journal, stage: "running" });
			await admission.assertAcceptedTurn({ runId: memoryRunId });
		}
		const controller = new AbortController();
		const deadlineAt = learningStageDeadline(performance.now());
		const timer = setTimeout(() => {
			controller.abort(new Error("onBridgeTurn timed out (25s)"));
		}, LEARNING_BRIDGE_TIMEOUT_MS);
		try {
			await this.runBridgeTurnInner(
				payload,
				controller.signal,
				telemetry,
				deadlineAt,
			);
			if (admission) {
				controller.signal.throwIfAborted();
				await admission.assertAcceptedTurn({ runId: memoryRunId });
				const receipt = { stage: "completed", payload };
				await this.ctx.storage.put(memoryKey, receipt);
				await this.completeRuntimeTurn(
					memoryRunId,
					`${memoryRunId}:effects`,
					receipt,
				);
			}
		} catch (err) {
			telemetry.finish("failed");
			console.error("[isolate-brain-bridge] onBridgeTurn aborted/failed:", {
				error: errorMessage(err),
			});
			if (admission) throw err;
		} finally {
			clearTimeout(timer);
			telemetry.finish(
				learningPassStatus({
					aborted: controller.signal.aborted,
					observerStatus: telemetry.observer.status,
				}),
			);
		}
	},

	/**
	 * Per-session compaction callback (queued, retried). Runs AFTER the assistant
	 * turn is committed so the just-appended turns are part of the window. The DO
	 * has no `waitUntil`, so compaction goes through the same durable
	 * `this.queue(...)` substrate as `onBridgeTurn` / `onLedgerMirror` rather than
	 * a bare fire-and-forget that a hibernating DO could drop.
	 *
	 * `compactSession` itself is a FAST NO-OP unless the session exceeds the
	 * keep-recent-token budget (it walks the branch and returns early when the
	 * head fits), so it is safe to enqueue every turn. The summarizer port is
	 * best-effort: a `null`/throw makes the repo append no marker and never throws
	 * into the queue. Non-destructive — the marker is an append-only read-time
	 * overlay; the original `session_entries` rows stay on disk.
	 */

	async onCompactSession(
		this: RuntimeMemoryHost,
		payload: {
			sessionKey: string;
			operationId: string;
		},
	): Promise<void> {
		if (typeof payload.operationId !== "string")
			throw new Error("Compaction callback lacks accepted operation");
		await this.runCompaction(
			payload.sessionKey,
			undefined,
			payload.operationId,
		);
	},

	async prepareCompaction(
		this: RuntimeMemoryHost,
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
	) {
		await this.ensureIdentity();
		const modelRef = this.modelOverrideForSurface("observer")?.modelRef ?? null;
		const input = {
			kind: "session-compaction",
			sessionKey,
			options: {
				keepRecentTokens: opts?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
				modelRef,
				deployment: modelRef?.startsWith("azure-openai/")
					? (this.observerDeploymentForTurn() ?? null)
					: null,
			},
			source: JSON.parse(
				JSON.stringify(this.sessionRepo.getBranch(sessionKey)),
			) as ReturnType<TediSessionRepo["getBranch"]>,
		};
		const operationId = `${this.state.tediId}:compaction:${await this.runtimeReceiptHash(input)}`;
		await this.acceptRuntimeTurn(operationId, sessionKey, input);
		const key = `runtime-compaction:${operationId}`;
		return this.ctx.storage.transactionSync(() => {
			const previous = this.ctx.storage.kv.get<{
				input: typeof input;
				stage: "accepted" | "running" | "completed";
				result?: CompactionResult | null;
				modelReceipt?: unknown;
			}>(key);
			if (previous && JSON.stringify(previous.input) !== JSON.stringify(input))
				throw new Error("Compaction immutable input changed");
			if (!previous) this.ctx.storage.kv.put(key, { input, stage: "accepted" });
			return operationId;
		});
	},

	/**
	 * Run one compaction pass AND make it OBSERVABLE — the shared seam behind both
	 * the queued {@link onCompactSession} (per-turn, default budget) and the admin
	 * FORCE hook (`/__admin/force-compact`, tiny budget). Delegates the cut to
	 * `sessionRepo.compactSession` (non-destructive read-time overlay), then, ONLY
	 * when a marker was actually appended, emits ONE canonical `context.compacted`
	 * runtime event into D1 `tedi_runtime_events` so the compaction is queryable in
	 * the ledger.
	 *
	 * The event id embeds `runId` + `firstKeptEntryId` so a retried compaction at
	 * the same cut is idempotent (matches the `session_entries` marker PK, which is
	 * also keyed on `firstKeptEntryId`). `conversationId` uses the same
	 * `${slug||tediId}:${sessionKey}` shape as every other isolate ledger emitter.
	 * Best-effort throughout: the cut itself never throws into a turn, and the
	 * event emission is wrapped so a ledger hiccup never undoes a successful cut.
	 *
	 * Returns the {@link CompactionResult} (or null) so the FORCE route can echo it
	 * back to the operator as proof.
	 */

	async summarizeAdmittedCompaction(
		this: RuntimeMemoryHost,
		entries: Parameters<typeof summarizeContextEntries>[1],
		previousSummary: string | undefined,
		sessionKey: string,
		options: { modelRef: string | null; deployment: string | null },
	) {
		return summarizeContextEntries(
			this.env,
			entries,
			previousSummary,
			this.tediAigMetadata("observer:session-compaction", { sessionKey }),
			{
				modelRef: options.modelRef ?? undefined,
				deployment: options.deployment ?? undefined,
			},
		);
	},

	async runCompaction(
		this: RuntimeMemoryHost,
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
		acceptedOperationId?: string,
	): Promise<CompactionResult | null> {
		const operationId =
			acceptedOperationId ?? (await this.prepareCompaction(sessionKey, opts));
		const key = `runtime-compaction:${operationId}`;
		type Journal = {
			input: {
				kind: string;
				sessionKey: string;
				options: {
					keepRecentTokens: number;
					modelRef: string | null;
					deployment: string | null;
				};
				source: ReturnType<TediSessionRepo["getBranch"]>;
			};
			stage: "accepted" | "running" | "completed";
			result?: CompactionResult | null;
			modelReceipt?: unknown;
		};
		const original = this.ctx.storage.kv.get<Journal>(key);
		if (
			!original ||
			original.input.sessionKey !== sessionKey ||
			original.input.kind !== "session-compaction"
		)
			throw new Error("Missing original compaction operation");
		const admission = this.runtimeAdmission();
		await admission?.assertOriginalClaim({
			runId: operationId,
			sessionKey,
			input: original.input,
		});
		const finish = async (result: CompactionResult | null) => {
			const receipt = this.ctx.storage.kv.get<Journal>(key);
			if (
				!receipt ||
				receipt.stage !== "completed" ||
				JSON.stringify(receipt.input) !== JSON.stringify(original.input)
			)
				throw new Error("Compaction terminal receipt missing");
			await this.completeRuntimeTurn(operationId, operationId, {
				inputHash: await this.runtimeReceiptHash(original.input),
				result,
				modelReceipt: receipt.modelReceipt ?? null,
			});
			return result;
		};
		if (original.stage === "completed") return finish(original.result ?? null);
		await admission?.assertAcceptedTurn({
			runId: operationId,
			sessionKey,
			input: original.input,
		});
		this.ctx.storage.transactionSync(() => {
			const current = this.ctx.storage.kv.get<Journal>(key);
			if (
				!current ||
				current.stage !== "accepted" ||
				JSON.stringify(current.input) !== JSON.stringify(original.input)
			)
				throw new Error(
					"Compaction already dispatched; reconciliation required",
				);
			if (
				JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
				JSON.stringify(original.input.source)
			)
				throw new Error("Compaction source branch changed");
			this.ctx.storage.kv.put(key, { ...current, stage: "running" });
		});
		let modelCalled = false;
		const result = await this.sessionRepo.compactSession(
			sessionKey,
			async (entries, previousSummary) => {
				await admission?.assertAcceptedTurn({
					runId: operationId,
					sessionKey,
					input: original.input,
				});
				if (
					JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
					JSON.stringify(original.input.source)
				)
					throw new Error("Compaction source branch changed before model");
				modelCalled = true;
				const summary = await this.summarizeAdmittedCompaction(
					entries,
					previousSummary,
					sessionKey,
					original.input.options,
				);
				if (!summary?.trim())
					throw new Error(
						"Compaction model result unknown; reconciliation required",
					);
				const current = this.ctx.storage.kv.get<Journal>(key);
				if (
					!current ||
					current.stage !== "running" ||
					JSON.stringify(current.input) !== JSON.stringify(original.input)
				)
					throw new Error("Compaction dispatched journal changed");
				this.ctx.storage.kv.put(key, {
					...current,
					modelReceipt: {
						summaryHash: await this.runtimeReceiptHash(summary),
						entriesHash: await this.runtimeReceiptHash({
							entries,
							previousSummary: previousSummary ?? null,
						}),
					},
				});
				await admission?.assertAcceptedTurn({
					runId: operationId,
					sessionKey,
					input: original.input,
				});
				if (
					JSON.stringify(this.sessionRepo.getBranch(sessionKey)) !==
					JSON.stringify(original.input.source)
				)
					throw new Error("Compaction source branch changed before commit");
				return summary;
			},
			{ keepRecentTokens: original.input.options.keepRecentTokens },
		);
		if (modelCalled && !result?.compacted)
			throw new Error(
				"Compaction dispatched without verified commit; reconciliation required",
			);
		const settle = async () => {
			const current = this.ctx.storage.kv.get<Journal>(key);
			if (
				!current ||
				current.stage !== "running" ||
				JSON.stringify(current.input) !== JSON.stringify(original.input)
			)
				throw new Error("Compaction dispatched journal changed");
			this.ctx.storage.kv.put(key, { ...current, stage: "completed", result });
			return finish(result);
		};
		if (!result?.compacted) return settle();

		// Observability: emit ONE canonical ledger event for the real cut.
		try {
			await this.ensureIdentity();
			const { tediId, slug } = this.state;
			if (!tediId) throw new Error("Compaction owner missing");
			const platform = await this.getPlatformClient();
			if (!platform) throw new Error("Compaction ledger port missing");
			const conversationId = buildTediConversationId({
				tediRef: slug || tediId,
				sessionKey,
			});
			// Compaction is a SESSION event, not a turn, so it gets its own
			// deterministic non-turn id keyed on the compaction marker (always
			// present after a real cut — `if (!result?.compacted) return` above
			// guarantees it). Deliberately NOT a `{surface}` runId, so it never
			// collides with turn runIds or their `{runId}:{seq}` event ids.
			const runId = `${tediId}:compaction:${sanitizeTurnKey(String(result.markerTs))}`;
			const payload = buildCompactionLedgerPayload(sessionKey, result);
			await admission?.assertAcceptedTurn({
				runId: operationId,
				sessionKey,
				input: original.input,
			});
			await platform.recordRuntimeEvent({
				id: `${runId}:compaction:${payload.firstKeptEntryId}`,
				tediId,
				kind: "context.compacted",
				conversationId,
				runId,
				sequence: 0,
				payload,
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date().toISOString(),
			});
		} catch (err) {
			// Ledger emission is best-effort — the cut already succeeded.
			logTediRuntimeFailure("tedi.runtime.compaction_ledger_emit_failed", err);
			throw err;
		}
		return settle();
	},

	/**
	 * Enqueue a best-effort per-session compaction pass through the durable queue.
	 * Called from every SUCCESS turn fan-out (right after the daily-log enqueue).
	 * `compactSession` no-ops cheaply when under budget, so this is safe per turn.
	 */

	async enqueueCompaction(
		this: RuntimeMemoryHost,
		sessionKey: string,
	): Promise<void> {
		const operationId = await this.prepareCompaction(sessionKey);
		await this.queue(
			"onCompactSession",
			{ sessionKey, operationId },
			{ retry: { maxAttempts: 2 } },
		);
	},
};
