/**
 * Grounding primitives — pure logic behind the host-side `env.EVIDENCE` bridge.
 *
 * This module holds every decision a tenant workflow must not be able to make
 * for itself: what counts as an exact quote, which passage a claim is checked
 * against, how a judge verdict maps to a three-way label, and how a grounding
 * score is computed. `evidence.ts` wires these to the network (scrape + judge)
 * and to durable artifacts; nothing here touches I/O, so it is unit-testable in
 * plain Bun and cannot be shadowed by tenant code.
 *
 * The verification ladder:
 *
 *  1. EXACT — the quote appears verbatim (normalized) in the scraped page.
 *     A pass is proof: `attributable` / `exact_quote_found`.
 *  2. ENTAILMENT — exact substring is a SUFFICIENT condition for support, never
 *     a NECESSARY one (models paraphrase; most real quotes fail stage 1 for that
 *     reason alone). Ask an LLM judge whether the CITED passage supports the
 *     claim — and only the cited passage. Pooling every source into one blob
 *     lets a claim that is "supported somewhere" be attributed to the wrong page.
 *
 * The label is three-way, not binary. `extrapolatory` — the passage is related
 * but does not state the claim (a page reports a price rise, separately mentions
 * a heatwave, and never links them) — is the real-world failure mode and the
 * default whenever the judge is unsure. Only `attributable` sets `verified`.
 *
 * And the judge itself is not trusted. It is the same tedi that wrote the claim
 * (deliberately — it has the domain expertise), so its verdict is only
 * defensible if it is CHECKABLE. An `attributable` verdict must therefore carry
 * a `span`: the verbatim sentence(s) from the passage that state the claim. The
 * span is checked with the same exact-match machinery a citation is checked
 * with; a span that does not occur in the passage the judge was shown is a
 * hallucination, and the verdict is downgraded to `unsupported`. That is the
 * whole trick: the judge does not get to assert, it has to point.
 */

import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import * as z from "zod";

export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Minimum normalized quote length for a stage-1 exact match. Shorter needles
 * hit by accident, and an accidental hit is a fabricated citation.
 */
export const MIN_EXACT_QUOTE_CHARS = 28;

/**
 * Judge batch size. Small batches keep replies parseable and limit the number
 * of items affected by an unavailable or malformed response.
 */
export const ENTAILMENT_BATCH_SIZE = 4;

/** Characters of scraped markdown handed to the judge for a single item. */
export const PASSAGE_WINDOW_CHARS = 1200;

/**
 * Longest verbatim span we keep from a judge. Long enough for the sentence or
 * two that actually state a claim, short enough that a judge cannot smuggle a
 * whole passage back as its "evidence" and blow the sealed exchange past the
 * inline artifact cap.
 */
export const JUDGE_SPAN_MAX_CHARS = 600;

/** Bounds on the sealed judge exchange. Audit evidence, not a transcript dump. */
export const JUDGE_PROMPT_SEAL_CHARS = 9_000;
export const JUDGE_REPLY_SEAL_CHARS = 3_000;
export const JUDGE_ERROR_SEAL_CHARS = 500;

/** MCP surface the platform uses to fetch the page a citation points at. */
export const EVIDENCE_SCRAPE_NAMESPACE = "firecrawl";
export const EVIDENCE_SCRAPE_METHOD = "firecrawl_scrape";

/**
 * MCP surface the platform uses to READ a cited passage and judge it.
 *
 * The judge uses the platform model path, requiring no separate vendor
 * credential and sharing the capability gate, receipts, and idempotency
 * identity used by other tool calls.
 */
export const EVIDENCE_JUDGE_NAMESPACE = "tedi";
export const EVIDENCE_JUDGE_METHOD = "run_tedi_turn";

/**
 * Capability manifest the PLATFORM uses to fetch a cited page and judge it.
 * Deliberately not the skill's manifest: grounding is a platform guarantee, so
 * a skill inherits verification without declaring scrape access — and a skill
 * with no network capability still cannot read a page through it, because
 * `verify()` returns labels and digests, never page content.
 */
export const PLATFORM_EVIDENCE_MANIFEST: CapabilityManifest = {
	mcp: {
		[EVIDENCE_SCRAPE_NAMESPACE]: [EVIDENCE_SCRAPE_METHOD],
		[EVIDENCE_JUDGE_NAMESPACE]: [EVIDENCE_JUDGE_METHOD],
	},
	network: false,
	rationale: { mode: "off" },
	expectedAnnotations: { destructive: false, readOnly: false },
	grounding: { required: false, minCausalScore: 1, enforce: "warn" },
	schedule: null,
	reliability: null,
	// The judge is a platform call, not a tenant reasoner: no env.REASON grant.
	reason: { enabled: false, maxCalls: null },
};

export type EvidenceStatus =
	/** The cited page states the claim. The only status that grounds a claim. */
	| "attributable"
	/** Related, but the page does not state the claim. Default when unsure. */
	| "extrapolatory"
	/** The page states the opposite. */
	| "contradictory"
	/** Could not be established (scrape failed, judge unavailable, no verdict). */
	| "unsupported";

export type EvidenceReason =
	| "exact_quote_found"
	| "entailment_supported"
	| "entailment_extrapolatory"
	| "entailment_contradictory"
	| "entailment_unavailable"
	| "entailment_unparseable"
	/** Judge said `attributable` but produced no span to back it. */
	| "judge_span_missing"
	/**
	 * Judge said `attributable` and produced a span that does not occur in the
	 * passage it was shown (or is too short to mean anything). The judge
	 * hallucinated its own evidence — the verdict is discarded.
	 */
	| "judge_span_unverified"
	| "judge_unavailable"
	| "quote_missing"
	| "scrape_failed"
	| "scrape_empty";

export type ClaimKind = "observation" | "causal" | "recommendation";

/** Which rung of the ladder produced this item's verdict. */
export type EvidenceStage = "exact" | "entailment" | "none";

/**
 * How a judge verdict was obtained — the reliability ladder's receipt.
 *
 * `retry`/`item_fallback` recover a missing verdict. `span_repair` is different:
 * the verdict was there, but it asserted `attributable` without the verbatim span
 * that backs it, and one re-ask produced the span. Keep them distinct — folding
 * span repair into `retry` makes a format failure indistinguishable from a
 * dropped verdict in the sealed record, and they need different fixes.
 */
export type JudgeRecovery = "batch" | "retry" | "item_fallback" | "span_repair";

export interface EvidenceItem {
	id: string;
	subjectId: string | null;
	url: string;
	title: string | null;
	publishedDate: string | null;
	quote: string;
	claim: string;
	/** SHA-256 of the exact scraped bytes the verdict was taken against. */
	sha256: string | null;
	fetchedAt: string | null;
	status: EvidenceStatus;
	reason: EvidenceReason;
	/** True only for `attributable`. Never authored by tenant code. */
	verified: boolean;
	/** Content digest of (url, quote, subject) — the item's stable identity. */
	digest: string;
	/** `entailment` means the judge was consulted, whether or not it answered. */
	stage: EvidenceStage;
	/**
	 * What the judge said and what decided it. Every field is optional because
	 * records sealed before a given field existed are still valid evidence — but
	 * None of them is load-bearing for trust: `status`/`verified` above are
	 * computed host-side from the span check, not from anything here.
	 */
	judge?: {
		label: string;
		reason?: string;
		/** Judge identity — who decided this. */
		model: string;
		recovery: JudgeRecovery;
		/**
		 * The verbatim sentence(s) from the cited passage that state the claim.
		 * Present only when it was checked against that passage and found — so it
		 * can be shown to a user as "here is the sentence that backs this claim".
		 */
		span?: string;
		/** False on an `attributable` label whose span did not survive the check. */
		spanVerified?: boolean;
		/** Which prompt contract produced this verdict. */
		promptVersion?: string;
		/** SHA-256 of the exact prompt text the judge was sent. */
		promptHash?: string;
		/** Sealed judge exchange (prompt + raw reply) this verdict came from. */
		exchangePath?: string;
	} | null;
}

export interface ClaimInput {
	id: string;
	kind: ClaimKind;
	evidenceIds: string[];
	text?: string;
}

export interface UnsupportedClaim {
	claimId: string;
	kind: ClaimKind;
	/** Statuses actually observed for the claim's cited evidence, host-side. */
	statuses: EvidenceStatus[];
	reason: "no_evidence_cited" | "no_attributable_evidence";
}

export interface JudgeStats {
	/** Items that reached the judge (stage-1 misses with a scraped page). */
	requested: number;
	/** Items the judge returned a usable verdict for, after all recovery. */
	resolved: number;
	/** Verdicts recovered by the one retry of a missing/unparseable batch. */
	recoveredByRetry: number;
	/** Verdicts recovered by the final one-item-per-call fallback. */
	recoveredByItemFallback: number;
	/** Items that never got a verdict → `unsupported`, never `attributable`. */
	unavailable: number;
	/**
	 * `attributable` verdicts thrown out because the judge could not point at a
	 * real sentence in the passage it was shown. This is the judge's hallucination
	 * rate, measured rather than assumed — a number that climbs is a judge (or a
	 * prompt) that has stopped being trustworthy.
	 */
	spanRejected: number;
	/**
	 * Attributable verdicts whose missing span was recovered by one re-ask.
	 * A high number here means the judge is bad at the reply format, not that it
	 * is lying — track it separately from `spanRejected`, which counts spans that
	 * were produced and did not match the passage (i.e. fabrications we caught).
	 */
	spanRepaired: number;
}

export interface GroundingSummary {
	schemaVersion: number;
	evidenceItems: number;
	attributableItems: number;
	exactMatches: number;
	entailedMatches: number;
	causalClaims: number;
	groundedCausalClaims: number;
	/** grounded causal claims / causal claims. 1 when there are none. */
	causalGroundingScore: number;
	/** grounded claims / all claims. 1 when there are none. */
	groundingScore: number;
	unsupported: UnsupportedClaim[];
	/** Entailment-judge reliability, derived from the sealed evidence records. */
	judge: JudgeStats;
}

export interface GroundingPolicySnapshot {
	required: boolean;
	minCausalScore: number;
	/** Present on policies pinned after the enforcement ratchet shipped. */
	enforce?: "warn" | "fail";
}

export type GroundingPolicyVerdictCode =
	| "grounding_satisfied"
	| "grounding_score_not_called"
	| "grounding_below_min_causal_score";

export interface GroundingPolicyVerdict {
	schemaVersion: number;
	verdict: "ok" | "warn";
	code: GroundingPolicyVerdictCode;
	message: string;
	policy: GroundingPolicySnapshot;
	causalGroundingScore: number | null;
	groundingScore: number | null;
}

/**
 * Fold the cosmetic differences between a model's quote and a scraper's
 * markdown: unicode form, curly quotes, dashes, non-breaking space, case, and
 * whitespace runs. Everything that survives is signal.
 */
export function normalizeEvidenceText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[‘’‚‛′]/g, "'")
		.replace(/[“”„‟″]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/…/g, "...")
		.replace(/[   ]/g, " ")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Stage 1. A normalized substring hit on a quote of real length is proof the
 * page said it. Shorter than {@link MIN_EXACT_QUOTE_CHARS} we refuse to call it
 * proof — the false-positive rate on a short needle is the whole problem.
 */
export function exactQuoteMatch(page: string, quote: string): boolean {
	const needle = normalizeEvidenceText(quote);
	if (needle.length < MIN_EXACT_QUOTE_CHARS) return false;
	return normalizeEvidenceText(page).includes(needle);
}

export type JudgeSpanCheck =
	| { ok: true; span: string }
	| {
			ok: false;
			reason: "judge_span_missing" | "judge_span_unverified";
			span: string | null;
	  };

/**
 * The anti-hallucination control.
 *
 * Apply to the judge exactly what we apply to the tedi's own citations: make it
 * quote. An `attributable` verdict must come with the verbatim sentence(s) from
 * the passage that state the claim, and that span is checked with the same
 * normalization and the same length floor a stage-1 quote is checked with. The
 * judge is the same model that wrote the claim, so a bare label plus a twelve
 * word reason is an assertion, not a proof — nothing stops it from blessing a
 * passage that never said the thing. A string match does.
 *
 * A judge that cannot copy a real sentence out of the passage in front of it has
 * proven nothing, and its verdict is discarded. Fabricating a span that survives
 * this check requires reproducing text that is actually in the passage — at
 * which point the claim is, in fact, supported.
 */
export function verifyJudgeSpan(
	passage: string,
	span: string | null | undefined,
): JudgeSpanCheck {
	if (typeof span !== "string" || !span.trim()) {
		return { ok: false, reason: "judge_span_missing", span: null };
	}
	const bounded = span.slice(0, JUDGE_SPAN_MAX_CHARS).trim();
	// Same floor as stage 1: a needle this short hits by accident, and an
	// accidental hit is exactly the fabricated citation we are trying to catch.
	if (normalizeEvidenceText(bounded).length < MIN_EXACT_QUOTE_CHARS) {
		return { ok: false, reason: "judge_span_unverified", span: bounded };
	}
	// The span must occur in the passage the judge was actually shown — not in
	// the page, not in the corpus, not in the model's memory of the page.
	if (!exactQuoteMatch(passage, bounded)) {
		return { ok: false, reason: "judge_span_unverified", span: bounded };
	}
	return { ok: true, span: bounded };
}

/**
 * One parsed verdict as it enters the sealed judge exchange, span check
 * included. This is the row a reviewer reads to watch a judge overreach and
 * get caught — so it must mirror {@link resolveEntailmentLabel}: only an
 * `attributable` label owes a span, and only that label is checked. A refusal
 * used to be stamped `spanVerified: false` plus
 * `spanRejection: "judge_span_missing"` here, which made every honest
 * `extrapolatory` read like a judge caught fabricating. `spanVerified: null`
 * means "no check applied", not "failed".
 */
export function sealedVerdict(
	verdict: EntailmentVerdict,
	items: EntailmentJudgeItem[],
): Record<string, unknown> {
	const item = items.find((candidate) => candidate.id === verdict.id);
	const attributable =
		typeof verdict.label === "string" &&
		verdict.label.trim().toLowerCase() === "attributable";
	const check =
		item && attributable ? verifyJudgeSpan(item.passage, verdict.span) : null;
	return {
		id: verdict.id,
		label: verdict.label,
		...(verdict.reason ? { reason: verdict.reason } : {}),
		span: check?.span ?? null,
		spanVerified: check ? check.ok : null,
		...(check && !check.ok ? { spanRejection: check.reason } : {}),
	};
}

// --- Research cache -------------------------------------------------------
// Pure logic behind env.EVIDENCE.cacheGet/cachePut (the R2 I/O lives in the
// bridge). The cache memoizes the DISCOVERY phase (public web research), never a
// verdict — verify()/score() still run host-side on whatever it returns.

export interface ResearchCacheEntry {
	schemaVersion: number;
	storedAt: number;
	skillId?: string;
	key?: string;
	value: unknown;
}

export interface ResearchCacheRead {
	hit: boolean;
	value: unknown;
	ageMs: number | null;
}

/**
 * R2 key for a research-cache entry. Scoped by the host-trusted `skillId` so a
 * tenant can only address its own skill's cache — it supplies just the key
 * suffix (e.g. `2026-W29:4021234`), never the skill prefix. Both segments are
 * sanitized to a safe R2 key charset.
 */
export function researchCachePath(skillId: string, key: string): string {
	const skill = (skillId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
	const safeKey = key.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 300);
	return `research-cache/${skill}/${safeKey}.json`;
}

/**
 * Interpret a stored cache body under a freshness bound. A miss (null body,
 * unparseable, or older than `maxAgeMs`) means the discovery phase simply runs.
 * `nowMs` is supplied by the caller so this stays pure and Bun-testable.
 */
export function readResearchCache(
	body: string | null | undefined,
	opts: { maxAgeMs?: number; nowMs: number },
): ResearchCacheRead {
	const miss: ResearchCacheRead = { hit: false, value: null, ageMs: null };
	if (!body) return miss;
	let entry: ResearchCacheEntry | null = null;
	try {
		entry = JSON.parse(body) as ResearchCacheEntry;
	} catch {
		return miss;
	}
	const storedAt = Number(entry?.storedAt ?? 0);
	const ageMs =
		Number.isFinite(storedAt) && storedAt > 0 ? opts.nowMs - storedAt : null;
	if (opts.maxAgeMs != null && ageMs != null && ageMs > opts.maxAgeMs) {
		return { hit: false, value: null, ageMs };
	}
	return { hit: true, value: entry?.value ?? null, ageMs };
}

/** Serialize a cache entry body. `nowMs` supplied by the caller (purity). */
export function writeResearchCache(input: {
	skillId: string;
	key: string;
	value: unknown;
	nowMs: number;
}): string {
	return JSON.stringify({
		schemaVersion: 1,
		storedAt: input.nowMs,
		skillId: input.skillId,
		key: input.key,
		value: input.value,
	});
}

/** Content-addressed identity of an evidence item: (url, quote, subject). */
export function evidenceItemDigestInput(input: {
	url: string;
	quote: string;
	subjectId: string | null;
}): string {
	return [
		input.url,
		normalizeEvidenceText(input.quote),
		input.subjectId ?? "",
		// NUL separator, written as an ESCAPE: a raw 0x00 byte here makes grep and
		// ripgrep classify this whole file as binary and silently skip it.
	].join("\u0000");
}

/**
 * Run-scoped evidence id. Derived from the item's INDEX so it is identical on
 * every retry of the step that produced it (a counter would drift as soon as a
 * step re-ran). `digestSuffix` is only supplied on the collision path: a second
 * `verify()` call in the same run whose item N is a *different* item than the
 * already-sealed item N. Without the suffix that item would silently inherit
 * the earlier item's verdict — the same cross-source conflation this primitive
 * exists to prevent.
 */
export function evidenceItemId(index: number, digestSuffix?: string): string {
	const base = `e${index + 1}`;
	return digestSuffix ? `${base}_${digestSuffix.slice(0, 8)}` : base;
}

/** Durable artifact path for one evidence snapshot. */
export function evidenceArtifactPath(id: string): string {
	return `evidence/${id}.json`;
}

/**
 * Durable artifact path for one judge exchange (one call: its prompt, its raw
 * reply, its parsed verdicts).
 *
 * Keyed by the call's sequence within the verification pass AND the hash of the
 * prompt actually sent. The hash makes the path content-addressed (a replayed
 * call seals once); the sequence keeps a retry of the *same* prompt — the one
 * case where two calls are byte-identical, e.g. a batch that threw and was
 * retried whole — from being swallowed by first-writer-wins, so a failed
 * exchange and its recovery are both on the record.
 */
export function judgeExchangeArtifactPath(
	sequence: number,
	promptHash: string,
): string {
	const seq = String(sequence).padStart(2, "0");
	return `evidence/judge/${seq}-${promptHash.slice(0, 12)}.json`;
}

export const GROUNDING_SUMMARY_PATH = "evidence/grounding.json";
export const GROUNDING_POLICY_PATH = "evidence/policy.json";

function passageTerms(quote: string): string[] {
	return [
		...new Set(
			normalizeEvidenceText(quote)
				.split(/[^a-z0-9äöüåæøéèíóúñ%.,-]+/i)
				.map((term) => term.replace(/^[.,-]+|[.,-]+$/g, ""))
				.filter((term) => term.length >= 4),
		),
	];
}

/**
 * Select the passage a claim is checked against: the window of scraped markdown
 * with the best term overlap with the quote.
 *
 * This is the anti-conflation control. The judge only ever sees the passage the
 * item itself cites — never a pooled blob of every source — so a claim that is
 * "supported somewhere in the corpus" cannot be attributed to a page that never
 * said it.
 */
export function selectCitedPassage(
	markdown: string,
	quote: string,
	windowChars: number = PASSAGE_WINDOW_CHARS,
): string {
	if (markdown.length <= windowChars) return markdown;
	const terms = passageTerms(quote);
	if (terms.length === 0) return markdown.slice(0, windowChars);

	const haystack = normalizeEvidenceText(markdown);
	// Normalization can change length; score on a proportional projection of the
	// raw text so the returned window is always real source bytes.
	const stride = Math.max(Math.floor(windowChars / 4), 1);
	let bestStart = 0;
	let bestScore = -1;
	for (let start = 0; start < markdown.length; start += stride) {
		const rawWindow = markdown.slice(start, start + windowChars);
		const window = normalizeEvidenceText(rawWindow);
		let score = 0;
		for (const term of terms) if (window.includes(term)) score++;
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
			if (score === terms.length) break;
		}
	}
	// No term hit anywhere: hand over the head of the document rather than an
	// arbitrary window, so the judge sees the page's actual subject.
	if (bestScore <= 0 && !haystack.includes(normalizeEvidenceText(quote))) {
		return markdown.slice(0, windowChars);
	}
	return markdown.slice(bestStart, bestStart + windowChars);
}

export interface EntailmentJudgeItem {
	id: string;
	claim: string;
	passage: string;
}

export interface EntailmentVerdict {
	id: string;
	label: string;
	reason?: string;
	/**
	 * Verbatim sentence(s) copied from this item's passage. Mandatory for
	 * `attributable` — see {@link verifyJudgeSpan}. A refusal
	 * (`extrapolatory` / `contradictory`) needs no evidence and carries none.
	 */
	span?: string;
}

/**
 * What one judge CALL returned. The bare array stays legal (a judge that has no
 * provenance to report, e.g. a test stub); the object form lets the real judge
 * hand back what decided the verdict — which prompt, hashed, and where the raw
 * exchange was sealed — so the verdict is replayable rather than merely stated.
 */
export interface EntailmentJudgeResult {
	verdicts: EntailmentVerdict[] | null;
	promptVersion?: string;
	promptHash?: string;
	exchangePath?: string;
}

/**
 * A judge returns verdicts for the items it was given. Returning `null`, a
 * short array, or an unrecognized label are all expected failure modes — the
 * ladder below recovers what it can and under-counts the rest.
 */
export type EntailmentJudge = (
	items: EntailmentJudgeItem[],
) => Promise<EntailmentVerdict[] | EntailmentJudgeResult | null>;

/** Provenance of the call a verdict came out of. */
export interface JudgeProvenance {
	promptVersion?: string;
	promptHash?: string;
	exchangePath?: string;
}

export interface ResolvedEntailment extends JudgeProvenance {
	status: EvidenceStatus;
	reason: EvidenceReason;
	label: string;
	judgeReason?: string;
	recovery: JudgeRecovery;
	/** The judge's span, kept only when it was verified against the passage. */
	span?: string;
	/** True only when an `attributable` label came with a span that checks out. */
	spanVerified: boolean;
}

/**
 * Bump this WHENEVER {@link buildJudgePrompt} changes — the string below is a
 * contract with the judge, and a verdict is only replayable if the run records
 * which version of that contract produced it. A silently edited prompt with a
 * stale version makes every sealed verdict unfalsifiable.
 */
export const JUDGE_PROMPT_VERSION = "v2-span";

/**
 * The judge's instructions. One claim, one passage, a three-way label — and, for
 * `attributable`, the sentence it is pointing at. The span demand is the load
 * bearing part: it turns "trust the judge" into "check the judge", because a
 * span is verified by string match ({@link verifyJudgeSpan}) before the verdict
 * is allowed to ground anything.
 */
const JUDGE_INSTRUCTIONS = [
	"You are a strict citation auditor. For each item you are given ONE claim and ONE passage taken from the exact page that item cites.",
	"Decide whether THAT passage supports THAT claim. Judge only against the passage shown for that item — never against another item's passage or your own knowledge.",
	"",
	"Labels:",
	'- "attributable": the passage states or directly supports the claim, including a paraphrase of it.',
	'- "contradictory": the passage states the opposite of the claim.',
	'- "extrapolatory": the passage is related but does not actually state the claim. This includes the case where the passage mentions the effect and separately mentions a possible cause but never links them. USE THIS WHENEVER YOU ARE NOT SURE.',
	"",
	'A causal claim ("X rose BECAUSE of Y") is only "attributable" if the passage itself asserts the causal link. A passage that reports X and separately mentions Y is "extrapolatory".',
	"",
	'EVIDENCE RULE — for "attributable" you MUST also return "span": the sentence or sentences FROM THAT ITEM\'S PASSAGE that state the claim.',
	"- Copy the span CHARACTER FOR CHARACTER out of the passage. Do not paraphrase it, translate it, summarize it, shorten it, or repair its punctuation.",
	"- The span must be a contiguous run of text that appears in the passage. Quote whole sentences.",
	`- The span is checked against the passage by exact string match. A span that does not appear in the passage is treated as fabricated and the "attributable" verdict is THROWN OUT, so do not invent one. Spans shorter than ${MIN_EXACT_QUOTE_CHARS} characters are rejected.`,
	'- If no sentence in the passage states the claim, you cannot produce a span — that means the label is not "attributable". Use "extrapolatory".',
	'- "extrapolatory" and "contradictory" need no span: return an empty string.',
	"",
	'Reply with strict JSON only: {"verdicts":[{"id":"<id>","label":"attributable|extrapolatory|contradictory","span":"<verbatim sentence(s) from this item\'s PASSAGE, or empty string>","reason":"<12 words max>"}]}',
	"Return exactly one verdict per item id.",
	"",
].join("\n");

/**
 * The exact prompt one judge call sends. Pure — the sealed exchange records its
 * hash, so the input to any verdict can be reconstructed and re-run.
 */
export function buildJudgePrompt(items: EntailmentJudgeItem[]): string {
	return [
		JUDGE_INSTRUCTIONS,
		...items.map((item) =>
			[
				`--- ITEM ${item.id} ---`,
				`CLAIM: ${item.claim}`,
				`PASSAGE: ${item.passage}`,
			].join("\n"),
		),
	].join("\n");
}

/**
 * Map one judge label to a Tedix status. Conservative by construction:
 *
 *  - only an explicit `attributable` WITH A VERIFIED SPAN grounds a claim;
 *  - `unsure` and anything the judge hedges is `extrapolatory`;
 *  - a label we do not recognize is `unsupported` — an unparseable verdict is
 *    not evidence, and guessing here is exactly how ungrounded claims ship.
 *
 * `passage` is the text the judge was shown for this item, and it is what an
 * `attributable` span is checked against. It defaults to empty, which fails the
 * check: a caller that cannot say what the judge read cannot be told the judge
 * was right.
 */
export function resolveEntailmentLabel(
	verdict: EntailmentVerdict | undefined | null,
	recovery: JudgeRecovery = "batch",
	passage = "",
): ResolvedEntailment | null {
	if (!verdict || typeof verdict.label !== "string") return null;
	const label = verdict.label.trim().toLowerCase();
	const judgeReason =
		typeof verdict.reason === "string"
			? verdict.reason.slice(0, 400)
			: undefined;
	const base = { label, judgeReason, recovery };
	if (label === "attributable") {
		const span = verifyJudgeSpan(passage, verdict.span);
		if (!span.ok) {
			// The judge asserted support and could not point at it. Downgrade — an
			// unbacked "attributable" is worth exactly as much as no verdict, and
			// treating it as grounding is how a biased judge launders a claim.
			return {
				...base,
				status: "unsupported",
				reason: span.reason,
				spanVerified: false,
				...(span.span ? { span: span.span } : {}),
			};
		}
		return {
			...base,
			status: "attributable",
			reason: "entailment_supported",
			span: span.span,
			spanVerified: true,
		};
	}
	// Refusals need no evidence: a judge that declines to attribute is not
	// claiming anything that has to be checked.
	if (label === "contradictory") {
		return {
			...base,
			status: "contradictory",
			reason: "entailment_contradictory",
			spanVerified: false,
		};
	}
	if (label === "extrapolatory" || label === "unsure" || label === "unclear") {
		return {
			...base,
			status: "extrapolatory",
			reason: "entailment_extrapolatory",
			spanVerified: false,
		};
	}
	// A label we do not recognize is not a verdict. Refusing to guess here is
	// what keeps a garbled judge response from minting a grounded claim.
	return {
		...base,
		status: "unsupported",
		reason: "entailment_unparseable",
		spanVerified: false,
	};
}

/** Accept both judge shapes: a bare verdict array, or a result with provenance. */
function normalizeJudgeResult(
	result: EntailmentVerdict[] | EntailmentJudgeResult | null,
): EntailmentJudgeResult {
	if (Array.isArray(result)) return { verdicts: result };
	if (!result || typeof result !== "object") return { verdicts: null };
	return result;
}

function indexVerdicts(
	result: EntailmentJudgeResult,
	wanted: Map<string, EntailmentJudgeItem>,
	recovery: JudgeRecovery,
): Map<string, ResolvedEntailment> {
	const out = new Map<string, ResolvedEntailment>();
	const { verdicts, ...provenance } = result;
	if (!Array.isArray(verdicts)) return out;
	for (const verdict of verdicts) {
		if (!verdict || typeof verdict.id !== "string") continue;
		const item = wanted.get(verdict.id);
		if (!item || out.has(verdict.id)) continue;
		// Checked against the passage this item was judged on — never a sibling's.
		const resolved = resolveEntailmentLabel(verdict, recovery, item.passage);
		if (resolved) out.set(verdict.id, { ...resolved, ...provenance });
	}
	return out;
}

async function judgeBatch(
	judge: EntailmentJudge,
	items: EntailmentJudgeItem[],
	recovery: JudgeRecovery,
): Promise<Map<string, ResolvedEntailment>> {
	const wanted = new Map(items.map((item) => [item.id, item]));
	try {
		return indexVerdicts(
			normalizeJudgeResult(await judge(items)),
			wanted,
			recovery,
		);
	} catch {
		// A throwing judge is a missing verdict, not a failed run.
		return new Map();
	}
}

/**
 * Stage 2 with the reliability ladder the prototype lacked.
 *
 * The prototype issued one batched judge call per subject and dropped every
 * item the response happened to omit (`entailment_unavailable`), losing real
 * evidence and silently under-reporting grounding. Three changes fix it:
 *
 *  1. batches of at most {@link ENTAILMENT_BATCH_SIZE};
 *  2. One retry of the items a batch failed to answer;
 *  3. a final per-item call for anything still missing.
 *
 * Whatever survives all three is `unsupported` / `entailment_unavailable` —
 * grounding is under-counted, never over-counted.
 *
 * The ladder recovers missing verdicts only. A verdict that came back and failed
 * its span check is a verdict: it stands as `unsupported` and is never re-asked.
 * Retrying it would be rolling the dice until the judge produces a span that
 * happens to pass — the opposite of a check.
 */
export async function runEntailmentJudge(
	items: EntailmentJudgeItem[],
	judge: EntailmentJudge | null,
	batchSize: number = ENTAILMENT_BATCH_SIZE,
): Promise<{ verdicts: Map<string, ResolvedEntailment>; stats: JudgeStats }> {
	const stats: JudgeStats = {
		requested: items.length,
		resolved: 0,
		recoveredByRetry: 0,
		recoveredByItemFallback: 0,
		unavailable: 0,
		spanRejected: 0,
		spanRepaired: 0,
	};
	const verdicts = new Map<string, ResolvedEntailment>();
	if (items.length === 0) return { verdicts, stats };
	if (!judge) {
		stats.unavailable = items.length;
		return { verdicts, stats };
	}

	const size = Math.max(1, Math.min(batchSize, ENTAILMENT_BATCH_SIZE));
	for (let start = 0; start < items.length; start += size) {
		const batch = items.slice(start, start + size);
		const first = await judgeBatch(judge, batch, "batch");
		for (const [id, resolved] of first) verdicts.set(id, resolved);

		// One retry for whatever the batch failed to answer.
		const missing = batch.filter((item) => !verdicts.has(item.id));
		if (missing.length > 0) {
			const retried = await judgeBatch(judge, missing, "retry");
			for (const [id, resolved] of retried) {
				verdicts.set(id, resolved);
				stats.recoveredByRetry++;
			}
		}

		// Per-item fallback for anything the retry still missed. One item per call
		// removes every batching failure mode (truncation, id mismatch, drift).
		for (const item of batch) {
			if (verdicts.has(item.id)) continue;
			const single = await judgeBatch(judge, [item], "item_fallback");
			const resolved = single.get(item.id);
			if (resolved) {
				verdicts.set(item.id, resolved);
				stats.recoveredByItemFallback++;
			}
		}

		// Span repair — one re-ask, and only for a missing span.
		//
		// This rung exists because of a measured failure, not a theory: on the
		// calibration set the judge labelled correctly but simply dropped the
		// `span` field on 13/19 items, so every attributable verdict was discarded
		// and grounding collapsed to exact-match-only. That is non-compliance with
		// the reply FORMAT, and repairing a format is legitimate.
		//
		// The distinction that must never blur: we re-ask when a span is missing
		// (`judge_span_missing`). We never re-ask when a span was PRESENT and did
		// not match the passage (`judge_span_unverified`) — that verdict is a
		// fabrication we caught, and re-rolling until the judge produces a span
		// that passes is shopping for a verdict, which is the exact opposite of a
		// check. A fabricated span stays dead.
		const spanless = batch.filter((item) => {
			const verdict = verdicts.get(item.id);
			return (
				verdict?.label === "attributable" &&
				!verdict.spanVerified &&
				verdict.reason === "judge_span_missing"
			);
		});
		if (spanless.length > 0) {
			const repaired = await judgeBatch(judge, spanless, "retry");
			for (const [id, resolved] of repaired) {
				// Only accept the re-ask if it actually produced a verified span AND
				// still says attributable. A judge that changes its mind on the re-ask
				// keeps its (weaker) new answer; it never gets upgraded by retrying.
				const previous = verdicts.get(id);
				if (resolved.label === "attributable" && resolved.spanVerified) {
					verdicts.set(id, { ...resolved, recovery: "span_repair" });
					stats.spanRepaired++;
				} else if (previous && resolved.label !== "attributable") {
					verdicts.set(id, resolved);
				}
			}
		}
	}

	stats.resolved = verdicts.size;
	stats.unavailable = items.length - verdicts.size;
	stats.spanRejected = [...verdicts.values()].filter(
		(verdict) => verdict.label === "attributable" && !verdict.spanVerified,
	).length;
	return { verdicts, stats };
}

// ---------------------------------------------------------------------------
// Judge calibration — measuring the DEPLOYED judge, not re-implementing it.
//
// `calibrate()` runs the same production pipeline (`createMcpJudge` →
// `runEntailmentJudge`, blind sessions, batching, retries, span repair, span
// verification) over caller-supplied FIXED passages. No scraping: calibration
// must not depend on live pages — the gold labels were assigned per passage,
// so the fixed passage is the unit under test.
// ---------------------------------------------------------------------------

/**
 * Calibration batch bounds. Thirty items is a full gold set in one call while
 * keeping the judge traffic (≤4 per batch → ≤8 batches plus recovery) inside
 * one workflow step; the passage cap covers a {@link PASSAGE_WINDOW_CHARS}
 * window with generous headroom without letting a caller ship whole documents
 * through the judge path.
 */
export const CALIBRATION_MAX_ITEMS = 30;
export const CALIBRATION_PASSAGE_MAX_CHARS = 4_000;

/**
 * Calibration items as supplied by the caller. Ids must be unique — verdicts
 * are keyed by id, so a duplicate would silently share (and overwrite) a
 * sibling's verdict instead of being measured on its own.
 */
export const CalibrationItemsSchema = z
	.array(
		z.object({
			id: z.string().min(1).max(200),
			claim: z.string().min(1).max(2_000),
			passage: z.string().min(1).max(CALIBRATION_PASSAGE_MAX_CHARS),
		}),
	)
	.min(1)
	.max(CALIBRATION_MAX_ITEMS)
	.refine(
		(items) => new Set(items.map((item) => item.id)).size === items.length,
		{ message: "calibration item ids must be unique" },
	);

export interface CalibrationItemResult {
	id: string;
	/** The judge's RAW label — what it said, before the span check. Null when
	 *  the judge never produced a verdict for this item. */
	label: string | null;
	/** The POST-span-check status — what `verify()` would have recorded. */
	status: EvidenceStatus;
	reason: EvidenceReason;
	spanVerified: boolean;
	span: string | null;
	recovery: JudgeRecovery | null;
}

export interface CalibrationSummary {
	schemaVersion: number;
	items: CalibrationItemResult[];
	stats: JudgeStats;
	/** Which prompt contract was measured. */
	promptVersion: string;
	/** Judge identity — who was measured. */
	judge: string;
}

/**
 * Fold judge verdicts back onto the calibration items, in input order. Pure —
 * the resolution (label → status, span check, downgrade of fabricated spans)
 * already happened inside `runEntailmentJudge` via the same
 * `resolveEntailmentLabel`/`verifyJudgeSpan` path production verdicts take, so
 * calibration measures exactly the pipeline that ships. An item the judge
 * never answered is reported the way `verify()` would report it:
 * `unsupported` / `entailment_unavailable`.
 */
export function buildCalibrationResults(
	items: EntailmentJudgeItem[],
	verdicts: Map<string, ResolvedEntailment>,
): CalibrationItemResult[] {
	return items.map((item) => {
		const verdict = verdicts.get(item.id);
		if (!verdict) {
			return {
				id: item.id,
				label: null,
				status: "unsupported" as const,
				reason: "entailment_unavailable" as const,
				spanVerified: false,
				span: null,
				recovery: null,
			};
		}
		return {
			id: item.id,
			label: verdict.label,
			status: verdict.status,
			reason: verdict.reason,
			spanVerified: verdict.spanVerified,
			span: verdict.span ?? null,
			recovery: verdict.recovery,
		};
	});
}

/**
 * Reconstruct judge reliability from the sealed evidence records. Derived, not
 * reported: the numbers come from the same host-written records the score does,
 * so a run's claimed recovery rate is always the one that actually happened.
 */
export function deriveJudgeStats(evidence: EvidenceItem[]): JudgeStats {
	const consulted = evidence.filter((item) => item.stage === "entailment");
	const answered = consulted.filter((item) => Boolean(item.judge));
	return {
		requested: consulted.length,
		resolved: answered.length,
		recoveredByRetry: answered.filter(
			(item) => item.judge?.recovery === "retry",
		).length,
		recoveredByItemFallback: answered.filter(
			(item) => item.judge?.recovery === "item_fallback",
		).length,
		unavailable: consulted.length - answered.length,
		// Sealed proof of how often the judge claimed support it could not point at.
		// Explicit `false` only: a record sealed before spans existed is unknown,
		// not rejected.
		spanRejected: answered.filter(
			(item) =>
				item.judge?.label === "attributable" &&
				item.judge?.spanVerified === false,
		).length,
		// A span the judge only produced when asked twice. Format non-compliance,
		// not dishonesty — but if this climbs, the prompt is the thing to fix.
		spanRepaired: answered.filter(
			(item) => item.judge?.recovery === "span_repair",
		).length,
	};
}

/**
 * Compute the grounding summary. Callers pass evidence that was labeled
 * host-side; this never reads a tenant-authored status.
 */
export function scoreGrounding(input: {
	claims: ClaimInput[];
	evidence: EvidenceItem[];
}): GroundingSummary {
	const byId = new Map(input.evidence.map((item) => [item.id, item]));
	const attributable = input.evidence.filter(
		(item) => item.status === "attributable",
	);

	const unsupported: UnsupportedClaim[] = [];
	let groundedClaims = 0;
	let causalClaims = 0;
	let groundedCausalClaims = 0;

	for (const claim of input.claims) {
		const cited = claim.evidenceIds
			.map((id) => byId.get(id))
			.filter((item): item is EvidenceItem => Boolean(item));
		const grounded = cited.some((item) => item.status === "attributable");
		if (claim.kind === "causal") causalClaims++;
		if (grounded) {
			groundedClaims++;
			if (claim.kind === "causal") groundedCausalClaims++;
		} else {
			unsupported.push({
				claimId: claim.id,
				kind: claim.kind,
				statuses: cited.map((item) => item.status),
				reason:
					claim.evidenceIds.length === 0
						? "no_evidence_cited"
						: "no_attributable_evidence",
			});
		}
	}

	return {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		evidenceItems: input.evidence.length,
		attributableItems: attributable.length,
		exactMatches: attributable.filter(
			(item) => item.reason === "exact_quote_found",
		).length,
		entailedMatches: attributable.filter(
			(item) => item.reason === "entailment_supported",
		).length,
		causalClaims,
		groundedCausalClaims,
		// A skill that makes no causal claim is trivially grounded on causality.
		causalGroundingScore:
			causalClaims === 0 ? 1 : groundedCausalClaims / causalClaims,
		groundingScore:
			input.claims.length === 0 ? 1 : groundedClaims / input.claims.length,
		unsupported,
		judge: deriveJudgeStats(input.evidence),
	};
}

/**
 * Pull markdown out of whatever the scrape tool returned. Firecrawl's shape has
 * drifted across gateway/code-mode paths (bare string, `{ markdown }`,
 * `{ data: { markdown } }`), and an unrecognized shape must read as "no page" —
 * an empty page can only ever produce `unsupported`, never a grounded claim.
 */
export function extractScrapedMarkdown(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	for (const key of ["markdown", "content", "text", "html", "rawHtml"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	for (const key of ["data", "result", "document", "page"]) {
		const nested = record[key];
		if (nested && typeof nested === "object") {
			const found = extractScrapedMarkdown(nested);
			if (found) return found;
		}
	}
	return "";
}

/**
 * Grounding policy verdict for a run.
 *
 * WARN, never fail. `grounding.required: true` means the workflow was supposed
 * to call `EVIDENCE.score()`; hard-failing the run on a missed call would break
 * every skill written before this primitive existed, and a run that produced
 * real work should not be destroyed to punish a missing receipt. The verdict is
 * durable evidence — the dashboard and API read it generically — so an
 * ungrounded run is visible without being unrecoverable.
 */
export function evaluateGroundingPolicy(
	policy: GroundingPolicySnapshot,
	summary: GroundingSummary | null,
): GroundingPolicyVerdict {
	const base = {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		policy,
		causalGroundingScore: summary?.causalGroundingScore ?? null,
		groundingScore: summary?.groundingScore ?? null,
	};
	if (!summary) {
		return {
			...base,
			verdict: "warn",
			code: "grounding_score_not_called",
			message:
				"the skill manifest declares capabilities.grounding.required: true but the workflow never called env.EVIDENCE.score(), so this run published claims with no grounding receipt",
		};
	}
	if (summary.causalGroundingScore < policy.minCausalScore) {
		const ungrounded = summary.unsupported
			.filter((claim) => claim.kind === "causal")
			.map((claim) => claim.claimId);
		return {
			...base,
			verdict: "warn",
			code: "grounding_below_min_causal_score",
			message: `causal grounding ${summary.causalGroundingScore.toFixed(2)} is below the manifest minimum ${policy.minCausalScore.toFixed(2)}${
				ungrounded.length
					? ` — ungrounded causal claims: ${ungrounded.join(", ")}`
					: ""
			}`,
		};
	}
	return {
		...base,
		verdict: "ok",
		code: "grounding_satisfied",
		message: `causal grounding ${summary.causalGroundingScore.toFixed(2)} satisfies the manifest minimum ${policy.minCausalScore.toFixed(2)}`,
	};
}
