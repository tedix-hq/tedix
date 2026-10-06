export const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"was",
	"were",
	"are",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"must",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"and",
	"but",
	"or",
	"nor",
	"not",
	"so",
	"yet",
	"both",
	"either",
	"neither",
	"each",
	"every",
	"all",
	"any",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"only",
	"own",
	"same",
	"than",
	"too",
	"very",
	"just",
	"because",
	"if",
	"when",
	"where",
	"how",
	"what",
	"which",
	"who",
	"whom",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"they",
	"them",
	"their",
	"there",
	"we",
	"us",
	"our",
	"he",
	"him",
	"his",
	"she",
	"her",
	"i",
	"me",
	"my",
	"you",
	"your",
	"then",
	"while",
	"about",
	"between",
	"under",
	"over",
	"also",
	"still",
	"already",
	"using",
	"used",
	"doing",
	"done",
	"config",
	"session",
	"update",
	"message",
	"response",
	"request",
	"result",
	"output",
	"input",
	"data",
	"file",
	"path",
	"status",
	"check",
	"create",
	"delete",
	"list",
	"call",
	"handle",
]);

export interface TokenizeOptions {
	/** Keep tokens strictly LONGER than this many characters. */
	minLength: number;
	/** Tokens in this set are dropped. Omit for no stop-word filtering. */
	stopWords?: ReadonlySet<string>;
	/**
	 * - "alphanumeric": lowercase, replace every non-[a-z0-9] char with a
	 *   space, then split — punctuation SPLITS tokens ("memory-search" →
	 *   "memory", "search").
	 * - "whitespace": lowercase and split on whitespace only — punctuation is
	 *   preserved inside tokens ("memory_search" stays one token). Used by the
	 *   directive matcher in compiler.ts, whose thresholds are tuned to it.
	 */
	split: "alphanumeric" | "whitespace";
}

/**
 * The one tokenizer behind every text-similarity path in the cognition
 * packages. Callers pin their semantics through explicit options — the named
 * presets below ({@link significantWords}, {@link matchTokens}, compiler.ts's
 * directive matcher) are threshold-tuned; do not change a preset's parameters
 * without re-deriving its callers' thresholds.
 *
 * Returns tokens in order WITH duplicates — several overlap counters count
 * multiplicity deliberately.
 */
export function tokenizeWords(
	text: string,
	options: TokenizeOptions,
): string[] {
	const lowered = text.toLowerCase();
	const source =
		options.split === "alphanumeric"
			? lowered.replace(/[^a-z0-9\s]/g, " ")
			: lowered;
	return source
		.split(/\s+/)
		.filter((w) => w.length > options.minLength && !options.stopWords?.has(w));
}

/**
 * Count of `tokens` (WITH multiplicity — a token appearing twice counts
 * twice) that are present in `vocabulary`.
 */
export function overlapCount(
	tokens: readonly string[],
	vocabulary: ReadonlySet<string>,
): number {
	let count = 0;
	for (const token of tokens) {
		if (vocabulary.has(token)) count++;
	}
	return count;
}

/**
 * Preset: length > 2, {@link STOP_WORDS}, alphanumeric split. Used by skill
 * retrieval (skill-retrieval.ts) and the crystallizer's pattern keys. NOT the
 * directive matcher's tokenizer — that one (compiler.ts) splits on whitespace
 * only and keeps every token longer than 3 chars.
 */
export function significantWords(text: string): string[] {
	return tokenizeWords(text, {
		minLength: 2,
		stopWords: STOP_WORDS,
		split: "alphanumeric",
	});
}

/**
 * Compact stop-word set for the brain-bridge matching paths (rationale
 * dedup/completion matching, crystallizer skill dedup). Deliberately much
 * smaller than {@link STOP_WORDS}: those paths match short action strings
 * where aggressive filtering starves the overlap counters.
 */
export const MATCH_STOP_WORDS: ReadonlySet<string> = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"have",
	"been",
	"into",
	"their",
	"they",
	"about",
]);

/**
 * Preset: length > 3, {@link MATCH_STOP_WORDS}, alphanumeric split — the
 * brain-bridge matching tokenizer.
 */
export function matchTokens(text: string): string[] {
	return tokenizeWords(text, {
		minLength: 3,
		stopWords: MATCH_STOP_WORDS,
		split: "alphanumeric",
	});
}

/**
 * DIRECTIONAL keyword overlap on {@link matchTokens}: how many of `a`'s
 * tokens (with multiplicity) appear anywhere in `b`. Threshold-tuned callers
 * (all compare `>= 3`): rationale-bridge failure/success completion matching,
 * crystallizer skill dedup.
 */
export function matchKeywordOverlap(a: string, b: string): number {
	return overlapCount(matchTokens(a), new Set(matchTokens(b)));
}

/**
 * DIRECTIONAL overlap ratio on {@link matchTokens}: the fraction of `a`'s
 * tokens (with multiplicity) found in `b`. NOT symmetric — the denominator is
 * `a`'s token count. Threshold-tuned caller: rationale-bridge semantic dedup
 * (`>= SEMANTIC_DEDUP_THRESHOLD`, with the NEW observation as `a`).
 */
export function matchWordOverlapRatio(a: string, b: string): number {
	const ta = matchTokens(a);
	if (ta.length === 0) return 0;
	return overlapCount(ta, new Set(matchTokens(b))) / ta.length;
}
