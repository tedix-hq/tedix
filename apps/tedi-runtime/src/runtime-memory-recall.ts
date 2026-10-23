import {
	type RetrievedSkillMatch,
	serializeRetrievedSkills,
} from "@tedix/context-core/skill-retrieval";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { serializeBrainDigest } from "./brain/brain-digest";
import type { SkillSearchEntry } from "./brain/platform-client";
import {
	composeCognitiveAddenda,
	isHomeDelegationWorkOrder,
} from "./cognitive-addenda";
import { logTediSourceFailure } from "./context-failure-log";
import type { ActiveTurnBinding } from "./runtime-state";
import { selectSkillsWithJev } from "./jev-skill-ranking";
import {
	DELEGATED_MEMORY_RECALL_BUDGET_MS,
	DELEGATED_MEMORY_RECALL_LIMIT,
	type MemoryRecallReport,
	recallLongTermMemoryBlock,
} from "./memory-recall";
import { TEDI_CONTEXT_WINDOW_TOKENS } from "./model-input-budget";
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
import type { RuntimeMemoryHost } from "./runtime-memory";

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

/** Lazy-load the cached brain digest from DO SQLite (once per instance). */
export async function ensureBrainDigestLoaded(
	this: RuntimeMemoryHost,
): Promise<void> {
	if (this.brainDigestLoaded) return;
	try {
		this.brainDigest = await this.getBrainDigestStore().load();
	} catch (err) {
		logTediSourceFailure("brain_digest", "load", err);
		this.brainDigest = null;
	}
	this.brainDigestLoaded = true;
}

export function getSkillGuidanceStore(
	this: RuntimeMemoryHost,
): DoSkillGuidanceStore {
	if (!this.skillGuidanceStore) {
		this.skillGuidanceStore = new DoSkillGuidanceStore(this.getSqlRunner());
	}
	return this.skillGuidanceStore;
}

/** Lazy-load the cached skill guidance text from DO SQLite (once per instance). */
export function ensureSkillGuidanceLoaded(this: RuntimeMemoryHost): void {
	if (this.skillGuidanceLoaded) return;
	try {
		const cached = this.getSkillGuidanceStore().load();
		this.skillGuidanceText = cached?.text ?? null;
	} catch (err) {
		logTediSourceFailure("skill_guidance", "load", err);
		this.skillGuidanceText = null;
	}
	this.skillGuidanceLoaded = true;
}

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
export async function skillGuidanceAddendum(
	this: RuntimeMemoryHost,
): Promise<string> {
	this.ensureSkillGuidanceLoaded();
	if (!this.skillGuidanceGate) {
		this.skillGuidanceGate = new SkillGuidanceTurnGate({
			build: () => this.buildAndCacheSkillGuidance(),
			background: (task) => this.ctx.waitUntil(task),
		});
	}
	return await this.skillGuidanceGate.textForTurn(this.skillGuidanceText ?? "");
}

export function getRetrievalCorpusStore(
	this: RuntimeMemoryHost,
): DoSkillRetrievalCorpusStore {
	if (!this.retrievalCorpusStore) {
		this.retrievalCorpusStore = new DoSkillRetrievalCorpusStore(
			this.getSqlRunner(),
		);
	}
	return this.retrievalCorpusStore;
}

/** Lazy-load the cached retrieval corpus from DO SQLite (once per instance). */
export function ensureRetrievalCorpusLoaded(this: RuntimeMemoryHost): void {
	if (this.retrievalCorpusLoaded) return;
	try {
		const cached = this.getRetrievalCorpusStore().load();
		this.retrievalCorpus = cached?.skills ?? null;
	} catch (err) {
		logTediSourceFailure("skill_retrieval", "load", err);
		this.retrievalCorpus = null;
	}
	this.retrievalCorpusLoaded = true;
}

/**
 * Persist the act-time retrieval corpus projected from the org-readable
 * skill rows (see `buildRetrievalCorpus` — injectable lifecycles only,
 * capped content). Fed by the SAME `listSkillsForTedi` read that builds the
 * guidance block, on the same 4-hour refresh. Fail-soft: a persist failure
 * never breaks guidance or the turn.
 */
export function cacheRetrievalCorpus(
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
}

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
export async function retrievedSkillsAddendum(
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
}

/**
 * Stamp which skills were act-time-retrieved into this turn's prompt as a
 * `context.injected` runtime event (mirrors {@link recordDirectiveUsage}).
 * This is the retrieval half of the retrieved→used metric. Execution is
 * established separately by exact workflow-run and terminal-usage evidence.
 */
export async function recordSkillRetrieval(
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
}

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
export async function buildAndCacheSkillGuidance(
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
}

/**
 * Scheduled WARMER for the skill guidance cache. Runs every 4 hours
 * alongside directive compilation and brain digest. It is no longer what
 * makes a new skill visible — that is per-turn
 * ({@link SkillGuidanceTurnGate}) — it just keeps an idle DO's cached block
 * from aging. Fail-soft: a network blip never breaks the tedi.
 */
export async function onRefreshSkillGuidance(
	this: RuntimeMemoryHost,
	admittedRunId?: string,
): Promise<void> {
	try {
		await this.buildAndCacheSkillGuidance(admittedRunId);
	} catch (err) {
		if (admittedRunId) throw err;
		logTediSourceFailure("skill_guidance", "refresh", err);
	}
}

/**
 * Combine the cached governed brain digest with bounded semantic recall from
 * the platform memory API. That API uses Agent Memory only for candidate IDs
 * and returns facts after canonical D1 lifecycle and visibility validation.
 * Recall starts alongside the digest load and is capped at 2 s; trivial
 * messages skip semantic recall (see `memory-recall.ts`). Preferences and
 * referenced task state are refreshed separately on every ordinary turn.
 */
export async function brainDigestAddendum(
	this: RuntimeMemoryHost,
	userText: string,
	onRecall?: (report: MemoryRecallReport) => void,
	sessionKey?: string | null,
): Promise<string> {
	const recallPromise = recallLongTermMemoryBlock({
		userText,
		...(isHomeDelegationWorkOrder(userText)
			? {
					budgetMs: DELEGATED_MEMORY_RECALL_BUDGET_MS,
					limit: DELEGATED_MEMORY_RECALL_LIMIT,
				}
			: {}),
		search: async (query, limit) => {
			const platform = await this.getPlatformClient();
			return platform ? await platform.memorySearch(query, limit) : null;
		},
	});
	await this.ensureBrainDigestLoaded();
	const digest = this.brainDigest ? serializeBrainDigest(this.brainDigest) : "";
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
}

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
export async function cognitiveAddenda(
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
}
