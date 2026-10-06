/**
 * Rationale bridge — auto-create/complete rationale records from observations.
 *
 * Mirrors `tedix-context/src/rationale-bridge.ts` with two changes:
 * - the platform writer is injected (`PlatformClient`) so isolate tedis can
 *   plug in a service-binding implementation
 * - directive load/persist/invalidate is delegated to a callback so the
 *   store (file in container, DO storage in isolate) stays pluggable.
 */

import {
	type CompiledDirective,
	NEVER_PROMOTION_THRESHOLD,
	invalidateByCategory,
} from "@tedix/context-core/compiler";
import {
	matchKeywordOverlap,
	matchWordOverlapRatio,
} from "@tedix/context-core/text-utils";
import type { Observation } from "@tedix/context-core/types";
import { sha256Hex16 } from "./hash.js";
import type { MemorySearchResult, PlatformClient } from "./platform-client.js";

// ── Public retrieval shapes ─────────────────────────────────────────────────

export interface RetrievedFactSource {
	factId: string;
	domain?: string;
	confidence?: number;
	score?: number;
}

export interface RetrievedEvidence {
	factIds: string[];
	sources: RetrievedFactSource[];
	retrievalQuery: string;
	retrievalMode: "assemble" | "search";
	retrievedAt: string;
}

export interface RationaleCorrelation {
	traceId?: string;
	/**
	 * WS1 execution link: the STABLE runtime runId of the turn being bridged —
	 * the same id the ledger mirror writes the run's event chain under. Attached
	 * to every record this bridge creates so episodes are span-checkable.
	 */
	runId?: string;
	/**
	 * WS1 execution link: tool-call refs from the runtime event ledger for THIS
	 * turn (e.g. `{runId}:step:{stepNumber}:{toolName}`). Attached to every
	 * record this bridge creates.
	 */
	toolCallRefs?: string[];
	workItemId?: string;
	objectiveId?: string;
	sourceSessionId?: string;
}

// ── State ────────────────────────────────────────────────────────────────────

interface OpenRecord {
	id: string;
	actionHash: string;
	action: string;
	category: string;
	createdAt: number;
	traceId?: string;
	runId?: string;
	workItemId?: string;
	objectiveId?: string;
	sourceSessionId?: string;
}

export interface RationaleBridgeState {
	records: OpenRecord[];
}

export interface RationaleStateStore {
	load(): Promise<RationaleBridgeState>;
	save(state: RationaleBridgeState): Promise<void>;
}

export interface DirectiveStore {
	load(): Promise<CompiledDirective[]>;
	save(directives: CompiledDirective[]): Promise<void>;
}

const MAX_OPEN = 50;
const STALE_MS = 24 * 60 * 60 * 1000;
const AUTO_CLOSE_MS = 8 * 60 * 60 * 1000;
/**
 * Minimum age before a HEURISTIC (non-run-matched) success completion.
 * Records whose runId matches the current correlation runId complete
 * same-turn instead — the shared run is span-checkable proof, and per-turn
 * runId rotation means "wait a turn" would equal "never complete".
 */
const SUCCESS_AGE_MS = 5 * 60_000;
const SEMANTIC_DEDUP_THRESHOLD = 0.5;
/**
 * How many OPEN records of the same semantic pattern may coexist before new
 * occurrences are suppressed. Must be >= the compiler's strictest promotion
 * bar (NEVER_PROMOTION_THRESHOLD in @tedix/context-core/compiler) or
 * directive compilation is unreachable for consistently-repeated behavior —
 * see the repetition-is-evidence note at the creation site. Derived directly
 * from that constant so the invariant cannot drift; a characterization test
 * (similarity-characterization.test.ts) pins it as well.
 */
export const SEMANTIC_DUP_MAX_PER_PATTERN = NEVER_PROMOTION_THRESHOLD;
const BRIDGE_EVIDENCE_SOURCE = "brain-bridge/rationale-bridge";

function is404(err: unknown): boolean {
	return err instanceof Error && err.message.includes("(404)");
}

function hasCorrelation(record: OpenRecord): boolean {
	return Boolean(
		record.traceId ||
		record.runId ||
		record.workItemId ||
		record.objectiveId ||
		record.sourceSessionId,
	);
}

function correlationMatches(
	record: OpenRecord,
	correlation: RationaleCorrelation | undefined,
): boolean {
	if (!hasCorrelation(record)) return true;
	if (!correlation) return false;
	const checks: Array<[string | undefined, string | undefined]> = [
		[record.traceId, correlation.traceId],
		[record.runId, correlation.runId],
		[record.sourceSessionId, correlation.sourceSessionId],
		[record.workItemId, correlation.workItemId],
		[record.objectiveId, correlation.objectiveId],
	];
	return checks.every(([recordValue, currentValue]) => {
		if (!recordValue) return true;
		return currentValue === recordValue;
	});
}

// ── Category selection ──────────────────────────────────────────────────────

const CATEGORY_PATTERNS: ReadonlyArray<{
	category: string;
	match: (text: string) => boolean;
}> = [
	{
		category: "skill_creation",
		match: (t) =>
			/\b(skill|muscle\s*memory|register|crystalliz)/i.test(t) &&
			/\b(create|add|new|register|crystalliz|record)/i.test(t),
	},
	{
		category: "skill_update",
		match: (t) =>
			/\b(skill|muscle\s*memory)/i.test(t) &&
			/\b(update|improve|refine|edit|fix|tighten)/i.test(t),
	},
	{
		category: "deployment",
		match: (t) =>
			!/\b(?:do\s+not|don'?t|without\s+(?:separate\s+)?approval|read[-\s]*only|no\s+public\s+change|no\s+publish(?:ing)?)\b.{0,120}\b(?:deploy|ship|push\s+to\s+main|release|publish|rollout|workflow_dispatch|gh\s+workflow|wrangler\s+deploy)\b/i.test(
				t,
			) &&
			/\b(deploy|ship|push\s+to\s+main|release|publish|rollout|workflow_dispatch|gh\s+workflow|wrangler\s+deploy)\b/i.test(
				t,
			),
	},
	{
		category: "content",
		match: (t) =>
			/\b(blog|article|post|aeo|seo|emdash|cms|content\s+(source|gap|operations))\b/i.test(
				t,
			),
	},
	{
		category: "communication",
		match: (t) =>
			/\b(discord|telegram|whatsapp|slack|email|notify|message_send|run_tedi_turn)\b/i.test(
				t,
			),
	},
	{
		category: "recovery",
		match: (t) =>
			/\b(error|failed|failure|500|404|broken|crash|exit|panic|wedge|stuck|fix(ed)?|workaround|recover|rollback)\b/i.test(
				t,
			),
	},
	{
		category: "health_check",
		match: (t) =>
			/\b(health|healthy|uptime|alive|responsive|heartbeat|liveness|readiness|status\s+check)\b/i.test(
				t,
			),
	},
	{
		category: "config_change",
		match: (t) =>
			/\b(config|configuration|setting|policy|preference|secret|env\s*var|wrangler\.jsonc)\b/i.test(
				t,
			),
	},
	{
		category: "optimization",
		match: (t) =>
			/\b(optim|faster|slower|reduce|cache|index|throughput|latency|compress|dedup|prune|consolidate|compound)\b/i.test(
				t,
			),
	},
];

const OBS_TYPE_FALLBACK: Record<string, string> = {
	error: "recovery",
	preference: "config_change",
	pattern: "optimization",
};

function pickRationaleCategory(obs: {
	type: string;
	content: string;
	details?: string[];
}): string {
	const text = [obs.content, ...(obs.details ?? [])].join(" ").slice(0, 2000);
	for (const { category, match } of CATEGORY_PATTERNS) {
		if (match(text)) return category;
	}
	return OBS_TYPE_FALLBACK[obs.type] ?? "custom";
}

/**
 * PERSISTED framing: keys `OpenRecord.actionHash` in the rationale state
 * store and the platform `turn-episode:` idempotency keys. Do not change.
 */
function actionHash(text: string): string {
	return sha256Hex16(text.toLowerCase().trim());
}

function isRationaleLifecycleObservation(obs: Observation): boolean {
	const text = [obs.content, ...obs.details].join(" ").slice(0, 2000);
	if (!/(?:^|[^a-z0-9])rationale[-_\s]*records?\b/i.test(text)) return false;
	return /\b(complete(?:d)?|create(?:d)?|delete(?:d)?|list(?:ed)?|mutation|payload|returned|tedix\.(?:create|complete|delete|list)_rationale_records?)\b/i.test(
		text,
	);
}

function isReadOnlyGuardrailObservation(obs: Observation): boolean {
	const text = [obs.content, ...obs.details].join(" ").slice(0, 2000);
	return (
		/\b(?:next\s+safe\s+action|safe\s+next\s+action|read[-\s]*only|separate\s+approval)\b/i.test(
			text,
		) &&
		/\b(?:do\s+not|don'?t|without\s+(?:separate\s+)?approval|no\s+public\s+change|no\s+publish(?:ing)?|do\s+not\s+publish|do\s+not\s+mutate)\b/i.test(
			text,
		)
	);
}

/** Order-preserving de-dupe of rationale-record ids. */
function dedupeIds(ids: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

// ── Evidence helpers ────────────────────────────────────────────────────────

function buildRationaleEvidence(
	retrievalEvidence: RetrievedEvidence | undefined,
	obs: Observation,
	correlation?: RationaleCorrelation,
): Record<string, unknown> {
	return {
		source: BRIDGE_EVIDENCE_SOURCE,
		...(correlation?.traceId ? { traceId: correlation.traceId } : {}),
		...(correlation?.runId ? { runId: correlation.runId } : {}),
		...(correlation?.sourceSessionId
			? { sourceSessionId: correlation.sourceSessionId }
			: {}),
		...(correlation?.workItemId ? { workItemId: correlation.workItemId } : {}),
		...(correlation?.objectiveId
			? { objectiveId: correlation.objectiveId }
			: {}),
		observation: {
			type: obs.type,
			priority: obs.priority,
			date: obs.date,
			time: obs.time,
		},
		...(retrievalEvidence
			? {
					factIds: retrievalEvidence.factIds,
					retrievedFacts: retrievalEvidence.sources,
					retrievalQuery: retrievalEvidence.retrievalQuery,
					retrievalMode: retrievalEvidence.retrievalMode,
					retrievedAt: retrievalEvidence.retrievedAt,
				}
			: {}),
	};
}

function evidenceFromSearchResult(
	query: string,
	result: MemorySearchResult,
): RetrievedEvidence | undefined {
	const sources: RetrievedFactSource[] = [];
	for (const item of result.results ?? []) {
		const factId = item.fact?.id ?? item.factId;
		if (!factId) continue;
		sources.push({
			factId,
			domain: item.fact?.domain,
			confidence: item.fact?.confidence,
			score: item.score,
		});
		if (sources.length >= 8) break;
	}
	if (sources.length === 0) return undefined;
	return {
		factIds: sources.map((source) => source.factId),
		sources,
		retrievalQuery: query,
		retrievalMode: "search",
		retrievedAt: new Date().toISOString(),
	};
}

async function evidenceForObservation(
	platform: PlatformClient,
	cachedEvidence: RetrievedEvidence | undefined,
	obs: Observation,
	logger: Logger,
): Promise<RetrievedEvidence | undefined> {
	if (cachedEvidence?.factIds.length) return cachedEvidence;
	const query = [obs.content, ...obs.details].join(" ").slice(0, 500);
	if (!query.trim()) return undefined;
	try {
		const result = await platform.memorySearch(query, 5);
		return evidenceFromSearchResult(query, result);
	} catch (err) {
		logger.log(
			`[brain-bridge] Rationale: targeted evidence search skipped (${err instanceof Error ? err.message : String(err)})`,
		);
		return undefined;
	}
}

// ── Options + entrypoint ────────────────────────────────────────────────────

export type RationaleMetricsCallback = (input: {
	created: number;
	completed: number;
	autoClosedPartial: number;
}) => void;

interface Logger {
	log(msg: string): void;
}

export interface RationaleBridgeOptions {
	newObservations: Observation[];
	platform: PlatformClient;
	stateStore: RationaleStateStore;
	/** Optional directive store for negative-feedback invalidation. */
	directives?: DirectiveStore;
	retrievalEvidence?: RetrievedEvidence;
	correlation?: RationaleCorrelation;
	onMetrics?: RationaleMetricsCallback;
	logger?: Logger;
}

const defaultLogger: Logger = { log: (msg) => console.log(msg) };

/**
 * Ids of the rationale records this bridge invocation touched, so the caller can
 * reference them from a per-run TraceBundle. `created` are records opened this
 * turn; `completed` are records closed this turn (success/failure/auto-close).
 * `recordIds` is the de-duplicated union of both, in first-seen order.
 */
export interface RationaleBridgeResult {
	created: string[];
	completed: string[];
	recordIds: string[];
}

export async function runRationaleBridge(
	options: RationaleBridgeOptions,
): Promise<RationaleBridgeResult> {
	const {
		newObservations,
		platform,
		stateStore,
		directives,
		retrievalEvidence,
		correlation,
		onMetrics,
		logger = defaultLogger,
	} = options;

	const createdIds: string[] = [];
	const completedIds: string[] = [];
	const buildResult = (): RationaleBridgeResult => ({
		created: createdIds,
		completed: completedIds,
		recordIds: dedupeIds([...createdIds, ...completedIds]),
	});

	if (newObservations.length === 0) return buildResult();

	const state = await stateStore.load();
	const now = Date.now();
	const episode = newObservations
		.filter((obs) => obs.type === "episode")
		.sort(
			(a, b) =>
				({ high: 3, medium: 2, low: 1 })[b.priority] -
				{ high: 3, medium: 2, low: 1 }[a.priority],
		)[0];

	let metricsCreated = 0;
	let metricsCompleted = 0;
	let metricsAutoClosedPartial = 0;
	let currentRunRationaleTouched = false;
	let currentRunRationaleCompleted = false;
	let currentRunRationaleCreated = false;

	// Prune stale records (>24h)
	state.records = state.records.filter((r) => now - r.createdAt < STALE_MS);
	if (
		episode &&
		correlation?.runId &&
		state.records.some((record) => record.runId === correlation.runId)
	) {
		currentRunRationaleTouched = true;
		currentRunRationaleCreated = true;
	}

	// 1. Create rationale records from decision observations
	for (const obs of newObservations) {
		if (
			obs.type !== "decision" &&
			(obs.type !== "procedural" || obs.priority !== "high")
		)
			continue;
		if (obs.priority === "low") continue;
		if (isRationaleLifecycleObservation(obs)) continue;
		if (isReadOnlyGuardrailObservation(obs)) continue;
		// A terminal episode is the run-level learning row. Preserve the first
		// substantive rationale for the run, but do not create multiple open
		// records whose shared run cost would later be counted more than once.
		if (episode && correlation?.runId && currentRunRationaleCreated) continue;

		const hash = actionHash(obs.content);
		if (state.records.length >= MAX_OPEN) break;

		// REPETITION IS EVIDENCE, not noise. The directive compiler promotes a
		// pattern only once >=PROMOTION_THRESHOLD same-pattern records exist (and
		// a higher bar for all-failure "never" patterns), so dedup must not
		// silently discard repeated occurrences of the same decision — that made
		// directive compilation UNREACHABLE for consistent behavior: an
		// identically-phrased decision was exact-hash-dropped after its first
		// occurrence, so the best learning signal never reached the threshold
		// while a noise pattern with varied wording compiled instead. Exact-wording repeats are the
		// STRONGEST evidence — a well-generalized observer phrases the same
		// decision identically — so they count against the same per-pattern cap
		// as semantic near-dups: allow up to SEMANTIC_DUP_MAX_PER_PATTERN open
		// records per pattern (enough to clear the never-bar), then suppress to
		// keep clutter bounded.
		const similarOpen = state.records.filter(
			(r) =>
				r.actionHash === hash ||
				matchWordOverlapRatio(obs.content, r.action) >=
					SEMANTIC_DEDUP_THRESHOLD,
		).length;
		if (similarOpen >= SEMANTIC_DUP_MAX_PER_PATTERN) continue;

		const category = pickRationaleCategory(obs);
		const confidence = obs.priority === "high" ? 0.85 : 0.65;

		try {
			const observationEvidence = await evidenceForObservation(
				platform,
				retrievalEvidence,
				obs,
				logger,
			);
			const result = await platform.createRationaleRecord({
				...(episode && correlation?.runId
					? {
							idempotencyKey: `turn-episode:${actionHash(correlation.runId)}`,
						}
					: {}),
				action: obs.content.slice(0, 500),
				rationale:
					obs.details.length > 0
						? obs.details.slice(0, 3).join("; ")
						: `Observed ${obs.type} (${obs.priority} priority)`,
				category,
				confidence,
				evidence: buildRationaleEvidence(observationEvidence, obs, correlation),
				// WS1: auto-attach the turn's execution links. The platform
				// hard-rejects unlinked writes, so the caller MUST thread the
				// run correlation (runId + tool-call refs) into this bridge.
				...(correlation?.runId ? { runId: correlation.runId } : {}),
				...(correlation?.workItemId
					? { workItemId: correlation.workItemId }
					: {}),
				...(correlation?.toolCallRefs?.length
					? { toolCallRefs: correlation.toolCallRefs }
					: {}),
			});

			if (result?.id) {
				// An idempotent create may return a row another pass already settled.
				// Keep that receipt in this run's evidence, never reopen it locally.
				if (result.outcomeStatus && result.outcomeStatus !== "pending") {
					state.records = state.records.filter(
						(record) => record.id !== result.id,
					);
					completedIds.push(result.id);
					currentRunRationaleTouched = Boolean(correlation?.runId);
					currentRunRationaleCompleted = Boolean(correlation?.runId);
					logger.log(
						`[brain-bridge] Rationale: reconciled terminal create ${result.id} (${result.outcomeStatus})`,
					);
					continue;
				}
				state.records.push({
					id: result.id,
					actionHash: hash,
					action: obs.content.slice(0, 200),
					category,
					createdAt: now,
					...(correlation?.traceId ? { traceId: correlation.traceId } : {}),
					...(correlation?.runId ? { runId: correlation.runId } : {}),
					...(correlation?.workItemId
						? { workItemId: correlation.workItemId }
						: {}),
					...(correlation?.objectiveId
						? { objectiveId: correlation.objectiveId }
						: {}),
					...(correlation?.sourceSessionId
						? { sourceSessionId: correlation.sourceSessionId }
						: {}),
				});
				createdIds.push(result.id);
				currentRunRationaleTouched = Boolean(correlation?.runId);
				currentRunRationaleCreated = Boolean(correlation?.runId);
				metricsCreated++;
				logger.log(
					`[brain-bridge] Rationale: created record ${result.id} for "${obs.content.slice(0, 50)}"`,
				);
			}
		} catch (err) {
			logger.log(
				`[brain-bridge] Rationale: create skipped (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}

	// 2. Auto-complete from error observations → failure (with blame attribution)
	for (const obs of newObservations) {
		if (obs.type !== "error") continue;

		const matched = state.records.filter(
			(r) =>
				correlationMatches(r, correlation) &&
				matchKeywordOverlap(obs.content, r.action) >= 3 &&
				// A fail-soft tool can error, be retried/recovered, and still finish the
				// SAME turn successfully. The observer reports both facts. Closing the
				// decision as failure here before the procedural-success pass produced
				// contradictory terminal receipts for one run. When a same-batch
				// procedural observation matches this exact action, leave the record
				// open for the success pass below; unrelated errors still fail normally.
				!newObservations.some(
					(candidate) =>
						candidate.type === "procedural" &&
						candidate.priority !== "low" &&
						matchKeywordOverlap(candidate.content, r.action) >= 3,
				),
		);
		for (const rec of matched) {
			try {
				const blameChain: Array<{
					component:
						| "brain_fact"
						| "directive"
						| "skill"
						| "graph_edge"
						| "missing_skill";
					contribution: "high" | "medium" | "low";
					reason: string;
				}> = [];

				const lowerContent = obs.content.toLowerCase();
				if (
					lowerContent.includes("directive") ||
					/\b(always|never)\s+(use|run|check|call|do|set|skip)\b/.test(
						lowerContent,
					)
				) {
					blameChain.push({
						component: "directive",
						contribution: "high",
						reason: obs.content.slice(0, 200),
					});
				} else if (
					/\bskill\b/.test(lowerContent) ||
					lowerContent.includes("procedure") ||
					lowerContent.includes("muscle memory")
				) {
					blameChain.push({
						component: "skill",
						contribution: "high",
						reason: obs.content.slice(0, 200),
					});
				} else if (
					lowerContent.includes("no handler") ||
					lowerContent.includes("not found") ||
					/\bmissing\s+(skill|handler|tool|config)\b/.test(lowerContent)
				) {
					blameChain.push({
						component: "missing_skill",
						contribution: "high",
						reason: obs.content.slice(0, 200),
					});
				} else {
					blameChain.push({
						component: "brain_fact",
						contribution: "medium",
						reason: obs.content.slice(0, 200),
					});
				}

				await platform.completeRationaleRecord({
					id: rec.id,
					outcome: obs.content.slice(0, 500),
					outcomeStatus: "failure",
					blameChain,
				});
				state.records = state.records.filter((r) => r.id !== rec.id);
				completedIds.push(rec.id);
				if (rec.runId === correlation?.runId) {
					currentRunRationaleTouched = true;
					currentRunRationaleCompleted = true;
				}
				metricsCompleted++;
				logger.log(
					`[brain-bridge] Rationale: completed ${rec.id} as failure (blame: ${blameChain[0]?.component})`,
				);

				// Invalidate ALWAYS directives in the failed category
				if (directives) {
					try {
						const loaded = await directives.load();
						const { invalidated, remaining } = invalidateByCategory(
							loaded,
							rec.category,
							"always",
						);
						if (invalidated.length > 0) {
							await directives.save(remaining);
							logger.log(
								`[brain-bridge] Rationale: invalidated ${invalidated.length} ALWAYS directive(s) in category "${rec.category}" due to failure`,
							);
						}
					} catch (invErr) {
						logger.log(
							`[brain-bridge] Rationale: directive invalidation skipped (${invErr instanceof Error ? invErr.message : String(invErr)})`,
						);
					}
				}
			} catch (err) {
				if (is404(err)) {
					state.records = state.records.filter((r) => r.id !== rec.id);
					logger.log(
						`[brain-bridge] Rationale: evicted ${rec.id} (not found in D1)`,
					);
				} else {
					logger.log(
						`[brain-bridge] Rationale: complete skipped (${err instanceof Error ? err.message : String(err)})`,
					);
				}
			}
		}
	}

	// 3. Auto-complete from procedural success
	for (const obs of newObservations) {
		if (obs.type !== "procedural" || obs.priority === "low") continue;

		const matched = state.records.filter((r) => {
			if (!correlationMatches(r, correlation)) return false;
			if (matchKeywordOverlap(obs.content, r.action) < 3) return false;
			// Run-matched records complete SAME-TURN: the record was created in
			// this run and the success observation settled in the same run, so
			// the turn's runId is a span-checkable proof (checked against the
			// ledger's run event chain). Correlation runIds rotate per turn, so
			// an age gate here made automatic success completion structurally
			// unreachable — records could only ever age out as `partial`,
			// starving the trajectory miner's episode supply.
			const runMatched = Boolean(
				r.runId && correlation?.runId && r.runId === correlation.runId,
			);
			if (runMatched) return true;
			// Non-run-matched (heuristic) completion keeps the age gate: without
			// a shared run there is no same-turn execution evidence, so require
			// the decision to have survived a monitoring window first.
			return now - r.createdAt > SUCCESS_AGE_MS;
		});
		for (const rec of matched) {
			try {
				// WS1 proof gate: the success claim is evidenced by the run the
				// success observation was made in (span-checkable against the
				// ledger). Without a proof ref the platform stores `unverified`.
				const proofRef = correlation?.runId
					? { kind: "run" as const, ref: correlation.runId }
					: correlation?.toolCallRefs?.[0]
						? { kind: "tool_call" as const, ref: correlation.toolCallRefs[0] }
						: undefined;
				await platform.completeRationaleRecord({
					id: rec.id,
					outcome: obs.content.slice(0, 500),
					outcomeStatus: "success",
					...(proofRef ? { proofRef } : {}),
				});
				state.records = state.records.filter((r) => r.id !== rec.id);
				completedIds.push(rec.id);
				if (rec.runId === correlation?.runId) {
					currentRunRationaleTouched = true;
					currentRunRationaleCompleted = true;
				}
				metricsCompleted++;
				logger.log(`[brain-bridge] Rationale: completed ${rec.id} as success`);
			} catch (err) {
				if (is404(err)) {
					state.records = state.records.filter((r) => r.id !== rec.id);
					logger.log(
						`[brain-bridge] Rationale: evicted ${rec.id} (not found in D1)`,
					);
				} else {
					logger.log(
						`[brain-bridge] Rationale: complete skipped (${err instanceof Error ? err.message : String(err)})`,
					);
				}
			}
		}
	}

	// 4. Settle the run's terminal learning row
	// A completed Observer episode is the terminal learning row for ordinary
	// delegated work. If the run opened a substantive rationale but no procedural
	// or error observation completed it, settle that existing row from the episode
	// instead of creating a second row. Otherwise project one idempotent episode.
	// Runtime settlement alone is not business success: an omitted verdict
	// degrades to partial.
	if (
		episode &&
		correlation?.runId &&
		currentRunRationaleTouched &&
		!currentRunRationaleCompleted
	) {
		const pending = state.records.find(
			(record) => record.runId === correlation.runId,
		);
		if (pending) {
			try {
				const outcomeStatus = episode.outcomeStatus ?? "partial";
				await platform.completeRationaleRecord({
					id: pending.id,
					outcome: episode.content.slice(0, 500),
					outcomeStatus,
					proofRef: { kind: "run", ref: correlation.runId },
				});
				state.records = state.records.filter(
					(record) => record.id !== pending.id,
				);
				completedIds.push(pending.id);
				currentRunRationaleCompleted = true;
				metricsCompleted++;
				logger.log(
					`[brain-bridge] Rationale: settled ${pending.id} from terminal episode as ${outcomeStatus}`,
				);
			} catch (err) {
				logger.log(
					`[brain-bridge] Rationale: episode settlement skipped (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}
	} else if (episode && correlation?.runId && !currentRunRationaleTouched) {
		try {
			const observationEvidence = await evidenceForObservation(
				platform,
				retrievalEvidence,
				episode,
				logger,
			);
			const category = pickRationaleCategory(episode);
			const outcomeStatus = episode.outcomeStatus ?? "partial";
			const result = await platform.createRationaleRecord({
				idempotencyKey: `turn-episode:${actionHash(correlation.runId)}`,
				action: episode.content.slice(0, 500),
				rationale:
					episode.details.length > 0
						? episode.details.slice(0, 3).join("; ")
						: "Observer recorded a completed turn episode",
				category,
				confidence: episode.priority === "high" ? 0.85 : 0.65,
				evidence: {
					...buildRationaleEvidence(observationEvidence, episode, correlation),
					kind: "turn_execution_episode",
					taskType: category,
				},
				runId: correlation.runId,
				...(correlation.workItemId
					? { workItemId: correlation.workItemId }
					: {}),
				...(correlation.toolCallRefs?.length
					? { toolCallRefs: correlation.toolCallRefs }
					: {}),
				outcomeStatus,
				outcome: episode.content.slice(0, 500),
			});
			if (result?.id) {
				createdIds.push(result.id);
				completedIds.push(result.id);
				metricsCreated++;
				metricsCompleted++;
				logger.log(
					`[brain-bridge] Rationale: projected terminal episode ${result.id} as ${outcomeStatus}`,
				);
			}
		} catch (err) {
			logger.log(
				`[brain-bridge] Rationale: episode projection skipped (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}

	// 5. Time-decay auto-close
	const aged = state.records.filter((r) => now - r.createdAt > AUTO_CLOSE_MS);
	for (const rec of aged) {
		try {
			// Local monitoring state is a cache. A prior pass or another actor may
			// have settled D1 already; preserve its outcome instead of retrying a
			// contradictory partial completion on every subsequent chat turn.
			const canonical = await platform.getRationaleRecord(rec.id);
			if (canonical.outcomeStatus !== "pending") {
				state.records = state.records.filter((record) => record.id !== rec.id);
				logger.log(
					`[brain-bridge] Rationale: reconciled terminal record ${rec.id} (${canonical.outcomeStatus}); auto-close skipped`,
				);
				continue;
			}
			await platform.completeRationaleRecord({
				id: rec.id,
				outcome: "No failure observed within monitoring window",
				outcomeStatus: "partial",
			});
			state.records = state.records.filter((r) => r.id !== rec.id);
			metricsAutoClosedPartial++;
			logger.log(
				`[brain-bridge] Rationale: auto-closed ${rec.id} as partial (8h timeout)`,
			);
		} catch (err) {
			if (is404(err)) {
				state.records = state.records.filter((r) => r.id !== rec.id);
				logger.log(
					`[brain-bridge] Rationale: evicted ${rec.id} (not found in D1)`,
				);
			} else {
				logger.log(
					`[brain-bridge] Rationale: auto-close skipped (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}
	}

	if (
		metricsCreated > 0 ||
		metricsCompleted > 0 ||
		metricsAutoClosedPartial > 0
	) {
		try {
			onMetrics?.({
				created: metricsCreated,
				completed: metricsCompleted,
				autoClosedPartial: metricsAutoClosedPartial,
			});
		} catch (err) {
			logger.log(
				`[brain-bridge] Rationale: metrics recording skipped (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}

	await stateStore.save(state);

	// NOTE: time-decay auto-close (#4) intentionally does NOT contribute to
	// `completedIds` — those records aged out of OLD runs (>8h) and would
	// pollute the current run's TraceBundle with unrelated decisions. Only
	// records created this turn or completed against THIS turn's observations
	// are referenced.
	return buildResult();
}
