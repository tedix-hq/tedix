/**
 * Atlas-style Compiled Memory — pure promotion logic.
 *
 * Compiles rationale records into directives that guide future decisions.
 * Based on Atlas (arXiv:2603.15666): memory as distillation, not storage.
 *
 * 3-step promotion gate:
 * - 3+ successful outcomes of same action pattern → "ALWAYS: ..."
 * - 3+ failed outcomes of same action pattern → "NEVER: ..."
 * - Mixed outcomes → "PREFER: ... (N success, M failure)"
 *
 * HTTP fetching, LLM compilation, and disk persistence live in the runtime
 * (Agent runtime or brain-bridge). This module is platform-neutral: it
 * clusters records, classifies directive strength, and produces the
 * template-based fallback directives.
 */

import { tokenizeWords } from "./text-utils.js";

export interface CompiledDirective {
	/** "always" | "never" | "prefer" */
	strength: "always" | "never" | "prefer";
	/** The compiled instruction */
	directive: string;
	/** Category from rationale records */
	category: string;
	/** How many rationale records support this directive */
	evidenceCount: number;
	/** Success/failure ratio */
	successRate: number;
	/** When this directive was last compiled */
	compiledAt: string;
	/** IDs of rationale records that produced this directive */
	rationaleIds: string[];
	/** Truncated SHA-256 hash of sorted rationaleIds for change detection */
	provenanceHash: string;
	/** ISO timestamp of last time this directive matched an observation (null = never matched) */
	lastMatchedAt: string | null;
}

export interface ContrastiveExamples {
	successes: Array<{
		action: string;
		rationale: string;
		outcome: string | null;
	}>;
	failures: Array<{
		action: string;
		rationale: string;
		outcome: string | null;
	}>;
}

export interface RationaleRecordInput {
	id?: string;
	action: string;
	rationale?: string;
	category: string;
	outcome?: string;
	outcomeStatus: string;
}

export interface RationalePattern {
	action: string;
	category: string;
	successCount: number;
	failureCount: number;
	/** IDs of all rationale records in this pattern cluster */
	recordIds: string[];
	records: RationaleRecordInput[];
	contrastive?: ContrastiveExamples;
}

export const PROMOTION_THRESHOLD = 3;
/**
 * All-failure clusters (which classify as "never") need MORE evidence than
 * positive/mixed ones before they compile into a directive. A "never" directive
 * tells the agent to STOP doing something — if it is wrong it removes a
 * capability (e.g. a spurious "never cancel orders" learned from failed tasks
 * that failed for unrelated reasons), so the downside is asymmetric. Requiring a
 * higher bar makes accidental capability-suppression far less likely. "always" /
 * "prefer" keep the normal {@link PROMOTION_THRESHOLD}.
 */
export const NEVER_PROMOTION_THRESHOLD = 5;
export const MAX_CONTRASTIVE_ENRICHMENTS = 3;

/**
 * Classify a pattern's directive strength based on success/failure counts.
 * - All-success with >= PROMOTION_THRESHOLD → "always"
 * - All-failure with >= PROMOTION_THRESHOLD → "never"
 * - Mixed (or below threshold for the pure ones) → "prefer"
 */
export function classifyDirective(
	successCount: number,
	failureCount: number,
): CompiledDirective["strength"] {
	if (failureCount === 0 && successCount >= PROMOTION_THRESHOLD)
		return "always";
	if (successCount === 0 && failureCount >= PROMOTION_THRESHOLD) return "never";
	return "prefer";
}

// =============================================================================
// Diagnostic gap analysis
// =============================================================================

export type DirectiveGapReason =
	/** No rationale records exist at all. */
	| "no_records"
	/** Fewer completed (success|failure) records than PROMOTION_THRESHOLD. */
	| "insufficient_completed"
	/** Enough completed records but every cluster is a singleton (nothing clusters). */
	| "singleton_clusters"
	/** Clusters exist but none meet the promotion gate threshold. */
	| "below_threshold"
	/** At least one cluster would be promoted — compilation should succeed. */
	| "ok";

export interface DirectiveGapDiagnosis {
	totalRecords: number;
	completedRecords: number;
	clusters: number;
	singletonClusters: number;
	promotedClusters: number;
	reason: DirectiveGapReason;
}

/**
 * Explain why `compileDirectives` would return zero directives for a given
 * rationale corpus.
 *
 * Pure and cheap — no LLM, no HTTP.  Run it wherever you can supply the raw
 * `records` array (e.g. the `onCompileDirectives` alarm, a brain-audit
 * endpoint, or a diagnostic tool) to get a structured reason rather than a
 * silent empty result.
 *
 * Returns `reason: "ok"` when at least one cluster meets the promotion gate
 * — i.e. when `compileDirectives` should produce at least one directive.
 */
export function diagnoseDirectiveGap(
	records: RationaleRecordInput[],
): DirectiveGapDiagnosis {
	const totalRecords = records.length;

	if (totalRecords === 0) {
		return {
			totalRecords: 0,
			completedRecords: 0,
			clusters: 0,
			singletonClusters: 0,
			promotedClusters: 0,
			reason: "no_records",
		};
	}

	const completed = filterCompleted(records);
	const completedRecords = completed.length;

	if (completedRecords < PROMOTION_THRESHOLD) {
		return {
			totalRecords,
			completedRecords,
			clusters: 0,
			singletonClusters: 0,
			promotedClusters: 0,
			reason: "insufficient_completed",
		};
	}

	const patterns = clusterByPattern(completed);
	const clusters = patterns.length;
	const singletonClusters = patterns.filter(
		(p) => p.successCount + p.failureCount === 1,
	).length;
	const promoted = applyPromotionGate(patterns);
	const promotedClusters = promoted.length;

	if (clusters > 0 && clusters === singletonClusters) {
		return {
			totalRecords,
			completedRecords,
			clusters,
			singletonClusters,
			promotedClusters: 0,
			reason: "singleton_clusters",
		};
	}

	if (promotedClusters === 0) {
		return {
			totalRecords,
			completedRecords,
			clusters,
			singletonClusters,
			promotedClusters: 0,
			reason: "below_threshold",
		};
	}

	return {
		totalRecords,
		completedRecords,
		clusters,
		singletonClusters,
		promotedClusters,
		reason: "ok",
	};
}

/**
 * Filter rationale records to only those with a terminal outcome
 * ("success" | "failure"). Pending/unknown outcomes are excluded.
 */
export function filterCompleted(
	records: RationaleRecordInput[],
): RationaleRecordInput[] {
	return records.filter(
		(r) => r.outcomeStatus === "success" || r.outcomeStatus === "failure",
	);
}

/**
 * Minimum overlap-coefficient between a record's salient tokens and a cluster's
 * core tokens to merge them. 0.5 = the smaller of the two token sets must be at
 * least half-covered by the intersection.
 */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.5;

/**
 * Generic / domain-ubiquitous tokens that carry no action signal. These appear
 * in nearly every rationale record, so keying on them shatters (or over-merges)
 * clusters. Dropped before similarity is computed. Deliberately conservative —
 * it removes filler and the most generic agent/workflow nouns, NOT action verbs
 * (authenticate, exchange, cancel, refund…) which ARE the clustering signal.
 */
const CLUSTER_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"for",
	"with",
	"from",
	"into",
	"onto",
	"than",
	"then",
	"this",
	"that",
	"these",
	"those",
	"there",
	"here",
	"what",
	"when",
	"where",
	"which",
	"while",
	"because",
	"cannot",
	"could",
	"would",
	"should",
	"will",
	"shall",
	"must",
	"have",
	"has",
	"had",
	"been",
	"being",
	"they",
	"them",
	"their",
	"theirs",
	"using",
	"used",
	"does",
	"doing",
	"done",
	"made",
	"make",
	"need",
	"needs",
	"want",
	"wants",
	"take",
	"takes",
	"taking",
	"taken",
	"before",
	"after",
	"first",
	"next",
	"any",
	"all",
	"not",
	"yet",
	"still",
	"also",
	"only",
	"more",
	"most",
	"some",
	"such",
	// domain-ubiquitous nouns/roles — present in almost every retail rationale
	"agent",
	"assistant",
	"retail",
	"customer",
	"user",
	"account",
	"order",
	"orders",
	"item",
	"items",
	"action",
	"actions",
	"request",
	"requested",
	"requests",
	"step",
	"workflow",
	"process",
	"information",
	"details",
	"details",
	"number",
	"record",
]);

const ID_LIKE = /\d/;

/**
 * Salient tokens of an action string: lowercased alphanumerics, length > 3,
 * excluding numbers / IDs and {@link CLUSTER_STOPWORDS}. These are what the
 * similarity clustering compares — the action's *meaning-bearing* terms.
 */
export function salientTokens(action: string): Set<string> {
	const out = new Set<string>();
	for (const w of action
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)) {
		if (w.length <= 3) continue;
		if (ID_LIKE.test(w)) continue; // drop "w3916020", item ids, ZIP codes, etc.
		if (CLUSTER_STOPWORDS.has(w)) continue;
		out.add(w);
	}
	return out;
}

/**
 * Crude but deterministic stem: the 5-char prefix. Morphological variation in
 * this corpus lives almost entirely in suffixes, so the prefix unifies
 * authenticate / authentication / authenticating → "authe", exchange /
 * exchanging / exchanged → "excha", cancel / cancelling / cancellation →
 * "cance". No suffix-rule table needed and no cross-verb collisions in practice
 * (clustering is also category-partitioned and needs ≥50% overlap).
 */
function stem(token: string): string {
	return token.slice(0, 5);
}

/** Stemmed view of a salient-token set — what the clustering actually compares. */
function stemSet(tokens: Set<string>): Set<string> {
	const out = new Set<string>();
	for (const t of tokens) out.add(stem(t));
	return out;
}

/** |A ∩ B| / min(|A|, |B|) — robust to one set being much larger. */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const t of small) if (large.has(t)) inter++;
	return inter / small.size;
}

interface ClusterAcc extends RationalePattern {
	/** salient token set per member, parallel to records[] */
	tokenSets: Set<string>[];
}

/**
 * Core tokens of a cluster = tokens shared by ≥2 members once the cluster has
 * grown past a singleton. A singleton's core is its full salient set (so the
 * second similar record can match on any shared term). Requiring frequency ≥ 2
 * for multi-member clusters keeps one-off incidental tokens out of the matchable
 * signature, which prevents single-link chaining across unrelated records.
 */
function clusterCore(acc: ClusterAcc): Set<string> {
	if (acc.tokenSets.length === 1) return acc.tokenSets[0]!;
	const freq = new Map<string, number>();
	for (const ts of acc.tokenSets)
		for (const t of ts) freq.set(t, (freq.get(t) ?? 0) + 1);
	const core = new Set<string>();
	for (const [t, n] of freq) if (n >= 2) core.add(t);
	return core;
}

/**
 * Cluster rationale records into patterns by category + SEMANTIC token overlap.
 *
 * Records are partitioned by category, then greedily assigned to the existing
 * same-category cluster whose core tokens best overlap the record's salient
 * tokens (overlap-coefficient ≥ {@link CLUSTER_SIMILARITY_THRESHOLD}). This
 * recognizes that "authenticate the customer before any order action" and
 * "authenticate the customer first using email" are the SAME pattern even though
 * their literal wording differs — the previous first-3-words exact key shattered
 * such records into singletons, so nothing ever crossed the promotion gate.
 */
export function clusterByPattern(
	records: RationaleRecordInput[],
): RationalePattern[] {
	const byCategory = new Map<string, ClusterAcc[]>();

	for (const rec of records) {
		const tokens = stemSet(salientTokens(rec.action));
		const isSuccess = rec.outcomeStatus === "success";
		const clusters = byCategory.get(rec.category) ?? [];

		// Pick the best-matching existing cluster (highest overlap above threshold).
		let best: ClusterAcc | null = null;
		let bestScore = CLUSTER_SIMILARITY_THRESHOLD;
		for (const c of clusters) {
			const score = overlapCoefficient(tokens, clusterCore(c));
			if (score >= bestScore) {
				bestScore = score;
				best = c;
			}
		}

		if (best) {
			if (isSuccess) best.successCount++;
			else best.failureCount++;
			best.records.push(rec);
			best.tokenSets.push(tokens);
			if (rec.id) best.recordIds.push(rec.id);
		} else {
			clusters.push({
				action: rec.action,
				category: rec.category,
				successCount: isSuccess ? 1 : 0,
				failureCount: isSuccess ? 0 : 1,
				recordIds: rec.id ? [rec.id] : [],
				records: [rec],
				tokenSets: [tokens],
			});
			byCategory.set(rec.category, clusters);
		}
	}

	const out: RationalePattern[] = [];
	for (const clusters of byCategory.values()) {
		for (const c of clusters) {
			// Drop the internal tokenSets accumulator from the public shape.
			const { tokenSets: _drop, ...pattern } = c;
			out.push(pattern);
		}
	}
	return out;
}

/**
 * Keep only patterns that meet the promotion threshold. Positive/mixed patterns
 * need {@link PROMOTION_THRESHOLD} total records; all-failure patterns (which
 * would compile into a riskier "never" directive) need the higher
 * {@link NEVER_PROMOTION_THRESHOLD} — see that constant for the rationale.
 */
export function applyPromotionGate(
	patterns: RationalePattern[],
): RationalePattern[] {
	return patterns.filter((p) => {
		const total = p.successCount + p.failureCount;
		const bar =
			p.successCount === 0 ? NEVER_PROMOTION_THRESHOLD : PROMOTION_THRESHOLD;
		return total >= bar;
	});
}

/**
 * Compute a truncated SHA-256 hash of sorted rationale record IDs.
 * Uses Web Crypto (`globalThis.crypto.subtle`) so it works in Workers,
 * Node ≥20, and the browser without a Node-specific import.
 */
export async function computeProvenanceHash(ids: string[]): Promise<string> {
	const sorted = [...ids].sort().join(",");
	const data = new TextEncoder().encode(sorted);
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
		?.subtle;
	if (!subtle) {
		// Last-resort fallback: a stable but weak hash. Runtimes targeting
		// production should always have Web Crypto available.
		let h = 0;
		for (let i = 0; i < sorted.length; i++) {
			h = (h * 31 + sorted.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(16).padStart(16, "0").slice(0, 16);
	}
	const buf = await subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(buf);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]!.toString(16).padStart(2, "0");
	}
	return hex.slice(0, 16);
}

/**
 * Fallback compilation without LLM — simple template-based.
 * Produces a CompiledDirective per pattern using a verb prefix.
 */
export async function fallbackCompile(
	patterns: RationalePattern[],
	now: string = new Date().toISOString(),
): Promise<CompiledDirective[]> {
	const out: CompiledDirective[] = [];
	for (const p of patterns) {
		const total = p.successCount + p.failureCount;
		const rate = total > 0 ? p.successCount / total : 0;
		const strength = classifyDirective(p.successCount, p.failureCount);
		const verb =
			strength === "always"
				? "Always"
				: strength === "never"
					? "Never"
					: "Prefer to";
		const action = p.records[0]?.action || p.action;
		const directive = `${verb}: ${action.charAt(0).toLowerCase() + action.slice(1)}`;
		const provenanceHash = await computeProvenanceHash(p.recordIds);
		out.push({
			strength,
			directive,
			category: p.category,
			evidenceCount: p.records.length,
			successRate: rate,
			compiledAt: now,
			rationaleIds: p.recordIds,
			provenanceHash,
			lastMatchedAt: null,
		});
	}
	return out;
}

/**
 * Invalidate directives by category (and optionally strength).
 *
 * Used for negative feedback — when failure rationale lands in a category
 * with an ALWAYS directive, that directive should be reconsidered.
 */
export function invalidateByCategory(
	directives: CompiledDirective[],
	category: string,
	strength?: CompiledDirective["strength"],
): { invalidated: CompiledDirective[]; remaining: CompiledDirective[] } {
	const invalidated: CompiledDirective[] = [];
	const remaining: CompiledDirective[] = [];

	for (const d of directives) {
		const matchesCategory = d.category === category;
		const matchesStrength = strength === undefined || d.strength === strength;

		if (matchesCategory && matchesStrength) {
			invalidated.push(d);
		} else {
			remaining.push(d);
		}
	}

	return { invalidated, remaining };
}

/**
 * Mark a directive as recently matched by setting lastMatchedAt to now.
 */
export function markDirectiveMatched(
	directives: CompiledDirective[],
	index: number,
	now: string = new Date().toISOString(),
): void {
	if (index >= 0 && index < directives.length) {
		directives[index]!.lastMatchedAt = now;
	}
}

/* ── Influence attribution ──────────────────────────────────────────────────
 *
 * A directive was INJECTED into the prompt (selective matching above). But did
 * it INFLUENCE the answer? This is the post-turn feedback half applied to
 * compiled directives instead of retrieved brain facts.
 *
 * IMPORTANT: this is a HEURISTIC signal, not ground truth. We do not have a
 * causal trace from a directive to a token in the response. We approximate
 * "influence" by keyword overlap between the directive's wording and the
 * assistant's reply — a directive whose distinctive words resurface in the
 * answer probably steered it; one whose words are entirely absent probably did
 * not. The signal is intentionally weak (small confidence nudges, no hard
 * deletion) so noise self-corrects over many turns rather than thrashing the
 * directive cache. Negative-feedback deletion is owned by
 * `invalidateByCategory`.
 */

/** Influence overlap (>= this fraction of directive words echoed) ⇒ "influenced". */
export const DIRECTIVE_INFLUENCE_MIN_RATIO = 0.34;
/** Confidence step toward 1 on influence / toward 0 on injected-but-unused. */
export const DIRECTIVE_INFLUENCE_STEP = 0.08;

/**
 * Heuristic influence ratio of a directive over a response: the fraction of the
 * directive's significant words that also appear in the response text.
 *
 * Pure + cheap (two `significantWords` Sets, one loop). Returns 0 when the
 * directive has no significant words or the response is empty — i.e. "no
 * evidence of influence", which the caller treats as injected-but-unused.
 */
export function directiveInfluenceRatio(
	directiveText: string,
	responseText: string,
): number {
	const directiveWords = significantWords(directiveText);
	if (directiveWords.size === 0) return 0;
	const responseWords = significantWords(responseText);
	if (responseWords.size === 0) return 0;
	let overlap = 0;
	for (const w of directiveWords) {
		if (responseWords.has(w)) overlap++;
	}
	return overlap / directiveWords.size;
}

/**
 * Decide whether an injected directive influenced the response, using
 * {@link directiveInfluenceRatio} against {@link DIRECTIVE_INFLUENCE_MIN_RATIO}.
 */
export function directiveInfluenced(
	directiveText: string,
	responseText: string,
): boolean {
	return (
		directiveInfluenceRatio(directiveText, responseText) >=
		DIRECTIVE_INFLUENCE_MIN_RATIO
	);
}

/**
 * Nudge a directive's `successRate` (its calibrated confidence) based on a
 * post-turn influence signal. Mutates `directives[index]` in place.
 *
 * - influenced ⇒ move `successRate` toward 1 by {@link DIRECTIVE_INFLUENCE_STEP}
 * - injected-but-unused ⇒ move toward 0 by the same step
 *
 * This is an exponential-moving-average style update (a small fraction of the
 * remaining distance to the target), so a single noisy turn never flips a
 * directive, but a sustained signal drifts confidence the right way. The result
 * is clamped to [0, 1]. `evidenceCount`, provenance, and `rationaleIds` are left
 * untouched — those are owned by the compiler; this only recalibrates
 * confidence without rewriting the fact.
 *
 * Returns the new `successRate` (or the unchanged value when index is invalid).
 */
export function recordDirectiveInfluence(
	directives: CompiledDirective[],
	index: number,
	influenced: boolean,
	step: number = DIRECTIVE_INFLUENCE_STEP,
): number {
	if (index < 0 || index >= directives.length) return 0;
	const d = directives[index]!;
	const prev = Number.isFinite(d.successRate) ? d.successRate : 0;
	const clampedPrev = prev < 0 ? 0 : prev > 1 ? 1 : prev;
	const target = influenced ? 1 : 0;
	const next = clampedPrev + (target - clampedPrev) * step;
	const clamped = next < 0 ? 0 : next > 1 ? 1 : next;
	d.successRate = clamped;
	return clamped;
}

/** A directive selected for a given turn, with its index in the source array. */
export interface DirectiveMatch {
	directive: CompiledDirective;
	index: number;
	/** Number of overlapping significant words between query and directive. */
	overlap: number;
}

/** Minimum significant-word length to count toward overlap. */
export const DIRECTIVE_MATCH_MIN_WORD_LEN = 3;
/** Minimum word overlap for a directive to be selected. */
export const DIRECTIVE_MATCH_MIN_OVERLAP = 3;
/** Minimum supporting evidence for a directive to be selected. */
export const DIRECTIVE_MATCH_MIN_EVIDENCE = 3;
/** Minimum query length (chars) before selection runs at all. */
export const DIRECTIVE_MATCH_MIN_QUERY_LEN = 10;

/**
 * Tokenize text into a set of lowercase significant words (length > minLen).
 *
 * Deliberately a DIFFERENT preset of the shared tokenizer than text-utils'
 * `significantWords`: whitespace split only (so `memory_search` stays one
 * token) and NO stop-word filtering. The influence/match thresholds above are
 * tuned to these semantics — do not swap in the alphanumeric preset.
 */
function significantWords(
	text: string,
	minLen = DIRECTIVE_MATCH_MIN_WORD_LEN,
): Set<string> {
	return new Set(
		tokenizeWords(text, { minLength: minLen, split: "whitespace" }),
	);
}

/**
 * Selectively match compiled directives against the current turn's text.
 *
 * Instead of injecting ALL directives broadly, only inject those whose wording
 * overlaps the query and that carry enough evidence.
 *
 * Selection rule (per directive):
 *   - query must be at least {@link DIRECTIVE_MATCH_MIN_QUERY_LEN} chars
 *   - count overlap between the directive's significant words and the query's
 *   - select when overlap >= {@link DIRECTIVE_MATCH_MIN_OVERLAP}
 *       AND evidenceCount >= {@link DIRECTIVE_MATCH_MIN_EVIDENCE}
 *
 * Pure: does not mutate `directives`. Caller marks matches + records usage.
 *
 * @param directives compiled directive cache
 * @param query the current turn's user text (optionally plus recent context)
 */
export function selectMatchingDirectives(
	directives: CompiledDirective[],
	query: string,
): DirectiveMatch[] {
	if (!query || query.length < DIRECTIVE_MATCH_MIN_QUERY_LEN) return [];
	if (directives.length === 0) return [];

	const queryWords = significantWords(query);
	if (queryWords.size === 0) return [];

	const matched: DirectiveMatch[] = [];
	for (let i = 0; i < directives.length; i++) {
		const d = directives[i]!;
		if (d.evidenceCount < DIRECTIVE_MATCH_MIN_EVIDENCE) continue;

		const directiveWords = significantWords(d.directive);
		let overlap = 0;
		for (const w of directiveWords) {
			if (queryWords.has(w)) overlap++;
		}
		if (overlap >= DIRECTIVE_MATCH_MIN_OVERLAP) {
			matched.push({ directive: d, index: i, overlap });
		}
	}
	return matched;
}

/**
 * Serialize ONLY the selected directives into a compact, turn-scoped addendum.
 *
 * Renders the per-turn "Active Directives" boost used by the Agent runtime
 * prompt assembler.
 * Returns "" when nothing matched, so the prompt is unchanged.
 */
export function serializeMatchedDirectives(matches: DirectiveMatch[]): string {
	if (matches.length === 0) return "";
	const lines = matches.map(({ directive: d }) => {
		const prefix =
			d.strength === "always"
				? "ALWAYS"
				: d.strength === "never"
					? "NEVER"
					: "PREFER";
		return `- [${prefix}, ${d.evidenceCount} evidence]: ${d.directive}`;
	});
	return `## Active Directives (matched ${matches.length} of compiled patterns)\n\n${lines.join("\n")}`;
}
