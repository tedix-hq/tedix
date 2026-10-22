import { type AgentMemoryCandidate } from "../../../integrations/cloudflare/agent-memory";
import type {
	RelevanceRecallOutcome,
	StoredRelevanceRecall,
} from "../../../kernel/relevance-recall-store";

/**
 * Whether the kernel surfaces per-tedi selection priors into the roster.
 * Default on: the `SELECTION_PRIOR_MIN_SAMPLE` floor keeps it inert until ledger
 * data accrues, so enabling it is zero-impact on a cold org. Set
 * `KERNEL_SELECTION_PRIORS=off` (or `false`/`0`) to hard-disable the read.
 */
export function selectionPriorsEnabled(): boolean {
	const raw = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.KERNEL_SELECTION_PRIORS;
	if (raw === undefined) return true;
	const v = raw.trim().toLowerCase();
	return !(v === "off" || v === "false" || v === "0" || v === "no");
}

// ── Query-scoped slot ranking ────────────────────────────────────────────────

/**
 * Rank items by cheap lexical relevance to the operator message, preserving
 * the original order among ties (original order = the query's own recency /
 * priority ordering, so a query with no signal degrades to today's behavior).
 *
 * Deterministic, no LLM, no I/O — safe on the synchronous routing hot path.
 * Used to decide which candidates fill the fixed-shape context slots when an
 * inventory outgrows its render cap; never to grow the slots themselves.
 *
 * Exported for tests.
 */
export function rankByQueryRelevance<T>(
	items: readonly T[],
	query: string | undefined,
	textOf: (item: T) => string,
): T[] {
	const terms = [
		...new Set(
			(query ?? "")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((term) => term.length > 2),
		),
	];
	if (terms.length === 0 || items.length === 0) return [...items];
	const scored = items.map((item, index) => {
		const text = textOf(item).toLowerCase();
		let score = 0;
		for (const term of terms) {
			if (text.includes(term)) score++;
		}
		return { item, index, score };
	});
	if (!scored.some((entry) => entry.score > 0)) return [...items];
	return scored
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

// ── Context-budget guard ──────────────────────────────────────────────────────
//
// The prompt is bounded by measured pressure against the serving model's context
// window — not by a turn count. `estimateContextChars` accounts for everything
// actually sent (system-prompt reserve + rendered context + history + operator
// message); when that crosses COMPACTION_TRIGGER_RATIO of the budget the
// transcript is compacted (oldest turns → one checkpoint, see
// `context-compaction.ts`). Truncating the lowest-priority sections
// (history → facts → rationale) survives only as the last resort below
// compaction, for a prompt whose fixed sections alone will not fit.
//
// Sizing: render `renderHomeContextPrompt` with every list at its render cap
// and every field at MAX_FIELD_CHARS to measure the worst-case non-history
// context; the route-planner SYSTEM_PROMPT is pinned by a test against
// SYSTEM_PROMPT_RESERVE_CHARS below.

/**
 * Chars reserved for the route-planner SYSTEM_PROMPT, which `assembleHomeContext`
 * cannot import without a cycle (`route-planner.ts` imports the renderer from
 * this module). Measured at 8 140 chars; pinned from the planner side by a
 * test, so growing the system prompt past it fails loudly instead of silently
 * eating the margin.
 */
export const SYSTEM_PROMPT_RESERVE_CHARS = 8_200;

/**
 * Tokens held back from the window for the planner's completion. The route
 * decision is a small typed object, but an `answer_in_home` route's
 * operator-facing answer text is produced by the same call, so the reserve
 * covers both. (The comment this replaces estimated 1 500 for completion alone.)
 */
export const RESERVED_COMPLETION_TOKENS = 2_000;

/** Context window of the Azure Home planner deployment (`azure-openai/gpt-5.6-luna`). */
export const AZURE_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Context window of the Workers AI fallback the planner uses when Azure is
 * unavailable (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) — 24 000 tokens per
 * Cloudflare's model documentation.
 *
 * This lane is why the budget is now derived per-model rather than fixed. While
 * history was capped at ~4 KB the fallback could never overflow; with the cap
 * gone, sending an Azure-sized prompt down this lane would hard-fail the turn.
 */
export const WORKERS_AI_CONTEXT_WINDOW_TOKENS = 24_000;

/**
 * How many times one assembly pass will fold before falling through to the
 * destructive truncation ladder. Re-checking after every fold is the point — a
 * single fold can leave the prompt over the trigger — but the walk must
 * terminate, and each fold costs a summarizer call.
 */
export const MAX_COMPACTION_FOLDS = 3;

/** Prompt budget for a model with the given context window. */
export function maxPromptTokensForWindow(contextWindowTokens: number): number {
	return Math.max(0, contextWindowTokens - RESERVED_COMPLETION_TOKENS);
}

/**
 * Default prompt budget: the Azure window minus the completion reserve.
 *
 * Net effect versus the 124 000 this replaces is a wash, deliberately. That
 * number hid a reserve for a system prompt it mis-measured; the budget is now
 * 126 000 and `estimateContextChars` spends 8 000 chars (2 000 tokens) of it on
 * the real SYSTEM_PROMPT reserve, leaving ~124 000 tokens for context + history.
 * The derivation is explicit; the boundary did not move.
 */
export const DEFAULT_MAX_PROMPT_TOKENS = maxPromptTokensForWindow(
	AZURE_CONTEXT_WINDOW_TOKENS,
);

// ── Relevance recall constants ────────────────────────────────────────────────
// Bounded semantic recall blended ahead of the static top-N in top facts.
// One bounded D1 search, fail-soft — the kernel hot
// path degrades to today's flat top-N if the vector client is absent or throws.
export const RELEVANCE_RECALL_TOP_K = 6;
export const RELEVANCE_RECALL_MIN_CONFIDENCE = 0.3;
/**
 * How long assembly waits for the in-flight semantic recall before it falls
 * back to the previous completed recall of this conversation (see
 * `kernel/relevance-recall-store.ts`) or the static top-N facts.
 *
 * Default 0: the recall is never in time. Production over 3 h (n=50,
 * 2026-10-11) measured `[MemoryGraph.search] complete` totalMs min 3074 / p50
 * 5436 / p95 12334 (agentMemoryMs p50 4576), while the previous 2 s budget
 * expired on every turn and then fell back to static facts anyway — the wait
 * was ~2 s of the 3.1–3.5 s workStarted→plannerFirstProgress gap for nothing.
 * With 0 an already-settled recall (one microtask) still wins the race; an
 * unsettled one is handed to the next turn through DO storage.
 * `KERNEL_RELEVANCE_RECALL_BUDGET_MS` overrides it per deployment.
 */
export const RELEVANCE_RECALL_BUDGET_MS = 0;

/**
 * Hard bound on the candidate-ranking wave (workflows, tedis, memory). The Jev
 * call itself is bounded at 2 s, but anything feeding or wrapping it that
 * hangs would stall the turn before its route call; past this budget the
 * lexical orders are used and the overrun is logged.
 */
export const CONTEXT_RANKING_BUDGET_MS = 3_000;

/**
 * Default critical-path wait for the ranking wave on a Home route pass: `0`
 * skips the Jev reranks (lexical candidate order). Measured 2026-10-12 (Work
 * 4cd15490): with the reranks the wave cost 1.35-1.65 s per turn (two
 * ~150 ms Jev requests wrapped in rate lookups, billing admission and cost
 * writes); skipping them took server first token from p50 6-7.7 s to 4.7 s
 * with identical answers and routes on the fixed question set. The tedi and
 * workflow inventories are capped and slug-sorted anyway; only the memory
 * tail order changes. A per-request `rankingBudgetMs` still turns it on.
 */
export const HOME_ROUTE_RANKING_BUDGET_MS = 0;

/** Resolve `work` or, after `budgetMs`, `fallback()`; the work keeps running. */
export async function withRankingBudget<T>(
	work: Promise<T>,
	budgetMs: number,
	fallback: () => T,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback()), budgetMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
/**
 * Resolve `candidates` or, once `budgetMs` elapses, `null` — whichever comes
 * first. The underlying recall keeps running and settles on its own; only this
 * turn stops waiting for it. With `budgetMs` 0 the deadline is one macrotask
 * away, so a recall that has already settled still resolves first.
 */
export function boundRelevanceRecall(
	candidates: Promise<AgentMemoryCandidate[]>,
	budgetMs: number,
): Promise<AgentMemoryCandidate[] | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			if (budgetMs > 0) {
				console.warn({
					component: "kernel.context",
					event: "recall_budget_exceeded",
					budgetMs,
				});
			}
			resolve(null);
		}, budgetMs);
	});
	return Promise.race([candidates, deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Pick this turn's relevance candidates: the in-flight recall if it settles
 * inside the budget (`fresh`), else the conversation's last completed recall
 * (`previous`), else none (`static`). A settled-but-empty fresh recall is a
 * real answer and still counts as `fresh`.
 */
export async function resolveRelevanceCandidates(input: {
	inFlight: Promise<AgentMemoryCandidate[]> | null;
	previous: StoredRelevanceRecall | null | undefined;
	budgetMs: number;
	now: () => number;
}): Promise<{
	candidates: AgentMemoryCandidate[];
	outcome: RelevanceRecallOutcome;
}> {
	const startedAt = input.now();
	const fresh = input.inFlight
		? await boundRelevanceRecall(input.inFlight, input.budgetMs)
		: null;
	const waitedMs = Math.max(0, input.now() - startedAt);
	if (fresh) {
		return {
			candidates: fresh,
			outcome: {
				source: "fresh",
				ageMs: 0,
				candidates: fresh.length,
				waitedMs,
			},
		};
	}
	if (input.previous) {
		return {
			candidates: input.previous.candidates,
			outcome: {
				source: "previous",
				ageMs: Math.max(0, input.now() - input.previous.completedAt),
				candidates: input.previous.candidates.length,
				waitedMs,
			},
		};
	}
	return {
		candidates: [],
		outcome: { source: "static", ageMs: null, candidates: 0, waitedMs },
	};
}
