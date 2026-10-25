import type { assembleHomeContext, KernelContext } from "./context-assembly";
import type { ConversationHistoryRead } from "./context-history";
import { rerankContextCandidates } from "./jev-context-ranking";
import {
	RENDER_TEDIS_CAP,
	RENDER_FACTS_CAP,
	RENDER_RATIONALE_CAP,
	renderHomeContextPrompt,
} from "./context-render";
import {
	assessStepPressure,
	compactKernelHistory,
	getHistoryTokenLimits,
	historyReplayChars,
	shouldCompactHistory,
} from "./context-compaction";

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
 * this module). Measured at 8 917 chars; pinned from the planner side by a
 * test, so growing the system prompt past it fails loudly instead of silently
 * eating the margin.
 */
export const SYSTEM_PROMPT_RESERVE_CHARS = 9_000;

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

// Org workflow catalog: bounded slug list for run_workflow grounding (rendered).
const WORKFLOW_CATALOG_LIMIT = 24;

export async function rankHomeContextCandidates(
	workflowCatalog: KernelContext["workflows"],
	tedis: KernelContext["tedis"],
	blendedFacts: { id: string; text: string; confidence?: number }[],
	rationale: KernelContext["rationale"],
	operatorMessage: string | undefined,
	opts: Parameters<typeof assembleHomeContext>[2],
) {
	// Query-scoped slot filling: when an inventory outgrows its fixed render
	// slots, rank candidates by relevance to this turn's operator message and
	// let the top-K fill the same bounded slots. Ties preserve the source order,
	// so a message with no lexical signal degrades to today's exact behavior.
	const lexicalWorkflows = rankByQueryRelevance(
		workflowCatalog,
		operatorMessage,
		(workflow) => `${workflow.slug} ${workflow.title}`,
	);
	const lexicalTedis =
		tedis.length > RENDER_TEDIS_CAP
			? rankByQueryRelevance(
					tedis,
					operatorMessage,
					(tedi) =>
						`${tedi.slug} ${tedi.name} ${tedi.role ?? ""} ${tedi.capability ? `${tedi.capability.apps.join(" ")} ${tedi.capability.skills.join(" ")} ${tedi.capability.scopeGroups.join(" ")}` : ""}`,
				)
			: tedis;
	// One paid judgment covers both oversubscribed memory sections. Keep the
	// canonical D1/Agent Memory ordering unless finite prompt slots would drop
	// candidates; the model can only permute facts that passed D1 hydration and
	// rationale from this organization's read. A failed/denied judgment keeps
	// those exact source orders. The recall budget is already resolved above
	// and is never extended by this independent, concurrent ranking pass.
	const memoryCandidates = [
		...(blendedFacts.length > RENDER_FACTS_CAP
			? blendedFacts.map((fact) => ({
					kind: "fact" as const,
					id: `fact:${fact.id}`,
					description: `Fact: ${fact.text}`,
					fact,
				}))
			: []),
		...(rationale.length > RENDER_RATIONALE_CAP
			? rationale.map((record, index) => ({
					kind: "outcome" as const,
					id: `outcome:${index}`,
					description: `Prior action: ${record.action}; outcome: ${record.outcome ?? "unknown"}; category: ${record.category ?? "unknown"}`,
					record,
				}))
			: []),
	];

	// Ranking is an enrichment, never a dependency: the whole wave gets a hard
	// bound and falls back to the lexical orders. One stalled turn waited 56 s
	// here before its route call (Work f9861b56).
	const rankingStartedAtMs = Date.now();
	let rankingTimedOut = false;
	const rankingBudgetMs = opts?.rankingBudgetMs ?? HOME_ROUTE_RANKING_BUDGET_MS;
	const rankingSkipped = rankingBudgetMs <= 0;
	const [workflowOrder, rankedTedis, rankedMemory] = rankingSkipped
		? [lexicalWorkflows, lexicalTedis, memoryCandidates]
		: await withRankingBudget(
				Promise.all([
					lexicalWorkflows.length > WORKFLOW_CATALOG_LIMIT
						? rerankContextCandidates(
								lexicalWorkflows,
								operatorMessage,
								"workflow",
								(workflow) => ({
									id: workflow.slug,
									description: `${workflow.slug} ${workflow.title}`,
								}),
								opts?.candidateRanker,
							)
						: Promise.resolve(lexicalWorkflows),
					tedis.length > RENDER_TEDIS_CAP
						? rerankContextCandidates(
								lexicalTedis,
								operatorMessage,
								"tedi",
								(tedi) => ({
									id: tedi.id,
									description: `${tedi.slug} ${tedi.name} ${tedi.role ?? ""} ${tedi.capability?.skills.join(" ") ?? ""}`,
								}),
								opts?.candidateRanker,
							)
						: Promise.resolve(lexicalTedis),
					memoryCandidates.length > 1
						? rerankContextCandidates(
								memoryCandidates,
								operatorMessage,
								"memory",
								(candidate) => ({
									id: candidate.id,
									description: candidate.description,
								}),
								opts?.candidateRanker,
							)
						: Promise.resolve(memoryCandidates),
				]),
				rankingBudgetMs,
				() => {
					rankingTimedOut = true;
					console.warn({
						component: "kernel.context",
						event: "ranking_budget_exceeded",
						budgetMs: CONTEXT_RANKING_BUDGET_MS,
					});
					return [lexicalWorkflows, lexicalTedis, memoryCandidates] as const;
				},
			);
	const rankingMs = Date.now() - rankingStartedAtMs;
	const rankedWorkflows = workflowOrder.slice(0, WORKFLOW_CATALOG_LIMIT);
	const rankedFacts =
		blendedFacts.length > RENDER_FACTS_CAP
			? rankedMemory.flatMap((candidate) =>
					candidate.kind === "fact" ? [candidate.fact] : [],
				)
			: blendedFacts;
	const rankedRationale =
		rationale.length > RENDER_RATIONALE_CAP
			? rankedMemory.flatMap((candidate) =>
					candidate.kind === "outcome" ? [candidate.record] : [],
				)
			: rationale;
	return {
		rankedWorkflows,
		rankedTedis,
		rankedFacts,
		rankedRationale,
		rankingMs,
		rankingTimedOut,
		rankingSkipped,
	};
}

export async function applyHomeContextBudget(
	draftCtx: KernelContext,
	maxPromptTokens: number,
	extraPromptChars: number,
	operatorMessage: string | undefined,
	historyRead: ConversationHistoryRead,
	relevanceRecall: RelevanceRecallOutcome,
	opts: Parameters<typeof assembleHomeContext>[2],
): Promise<KernelContext> {
	// ── Token-budget guard ────────────────────────────────────────────────────
	// Assemble a draft context, render it, then check whether we are over the
	// token budget.  If so, first compact the transcript (oldest turns fold into
	// a checkpoint; the canonical ledger is untouched), then trim the
	// lowest-priority sections (history → facts → rationale) and re-render until
	// we are under budget.  Each trimming step
	// emits a structured warning so the caller / telemetry pipeline can see what
	// was dropped.  Under-budget assemblies are returned unchanged.
	//
	// Priority order (highest → lowest):
	//   speaker, tedis, apps, workItems  — static org knowledge; never trimmed
	//   rationale                         — medium priority
	//   facts                             — medium priority
	//   history                           — lowest priority (trimmed first)
	// Measured pressure, not a proxy: account for everything the planner actually
	// sends, so the compaction trigger fires against the real prompt.
	//   - the SYSTEM_PROMPT reserve, which this module cannot import without a
	//     cycle but which is unconditionally part of every planner call,
	//   - the rendered context block,
	//   - the history the planner fences into <conversation_history>,
	//   - this turn's operator message.
	// Only the SYSTEM_PROMPT term is a reserve; the rest are exact lengths.
	function historyChars(ctx: KernelContext): number {
		return historyReplayChars(ctx.history);
	}
	function estimateContextChars(ctx: KernelContext): number {
		return (
			SYSTEM_PROMPT_RESERVE_CHARS +
			renderHomeContextPrompt(ctx).length +
			historyChars(ctx) +
			(operatorMessage?.length ?? 0) +
			extraPromptChars
		);
	}

	const totalChars = estimateContextChars(draftCtx);
	const estimatedTokens = Math.ceil(totalChars / 4);

	// ── Step 0: compaction ────────────────────────────────────────────────────
	// Before anything is discarded, fold the oldest turns into a checkpoint. This
	// fires at COMPACTION_TRIGGER_RATIO of the budget — ahead of the hard
	// boundary, so the turn is compacted rather than cornered. `history` here is
	// the replay projection; the canonical D1 ledger is untouched and the UI still
	// pages back through every turn.
	// Non-history chars = everything measured except the transcript: the
	// SYSTEM_PROMPT reserve, the rendered context block, and the operator message.
	const { inputBudgetChars, historyBudgetChars, retainTargetChars } =
		getHistoryTokenLimits(maxPromptTokens, totalChars - historyChars(draftCtx));

	// Per-step pressure. The estimator above is char/4 over the rows this pass
	// read; it does not know what the provider actually charged for the last
	// persisted step. Project the next request from that measured number plus the
	// chars appended since, and let the same trigger decide. The projection is a
	// max, so this arm can only make compaction fire earlier — never later.
	const measuredPromptTokens =
		opts?.measuredPromptTokens !== undefined
			? opts.measuredPromptTokens
			: historyRead.lastStepPromptTokens;
	const stepPressure = assessStepPressure({
		measuredPromptTokens,
		// Everything this pass adds on top of the measured step: the assistant
		// answer that step produced and every row persisted after it are already
		// in `history`, so the honest increment is the chars the caller told us it
		// will append (hydrated attachment bodies) plus this turn's operator
		// message. Under-counting here is safe — the estimator term is the floor.
		appendedChars: extraPromptChars + (operatorMessage?.length ?? 0),
		estimatedTotalChars: totalChars,
		inputBudgetChars,
	});

	// Re-check after every fold, not once. A single fold can leave the prompt
	// still over the trigger (a huge retained tail, or a context block that grew
	// since the last pass); folding again is strictly better than the truncation
	// ladder below, whose first rung erases the transcript outright.
	let workingCtx = draftCtx;
	let workingChars = totalChars;
	// The measured projection buys exactly one fold; every further fold must be
	// justified by this pass's own re-measurement of the folded prompt.
	let measuredFoldPending = stepPressure.action === "compact";
	let forcedFoldPending = opts?.forceCompaction ?? false;
	for (let fold = 0; fold < MAX_COMPACTION_FOLDS; fold += 1) {
		const mustCompact =
			forcedFoldPending ||
			measuredFoldPending ||
			shouldCompactHistory(workingChars, inputBudgetChars);
		if (!mustCompact || workingCtx.history.length <= 1) break;

		const compacted = await compactKernelHistory(workingCtx.history, {
			historyBudgetChars,
			retainTargetChars,
			...(opts?.summarizeHistory ? { summarize: opts.summarizeHistory } : {}),
		});
		if (!compacted) break;

		workingCtx = {
			...workingCtx,
			history: compacted.replay,
			historyCheckpoint: compacted.checkpoint,
		};
		workingChars = estimateContextChars(workingCtx);
		console.warn({
			component: "kernel.context",
			event: "history_compacted",
			compactedMessages: compacted.checkpoint.compactedMessages,
			retainedTurns: compacted.replay.length - 1,
			estimatedTokens,
			budget: maxPromptTokens,
			boundaryIndex: compacted.checkpoint.boundaryIndex,
			source: compacted.checkpoint.source,
			fold: fold + 1,
			measuredPromptTokens: stepPressure.measuredPromptTokens,
			stepPressure: stepPressure.reason,
		});
		measuredFoldPending = false;
		forcedFoldPending = false;
	}

	// Publish what this pass measured so the caller can re-check after it appends
	// to the prompt (hydrated attachments) without re-reading the ledger.
	function published(ctx: KernelContext): KernelContext {
		return {
			...ctx,
			lastStepPromptTokens: measuredPromptTokens,
			promptCharsEstimate: estimateContextChars(ctx),
			stepPressure,
			relevanceRecall,
		};
	}

	if (Math.ceil(workingChars / 4) <= maxPromptTokens) {
		return published(workingCtx);
	}

	// Over budget even after compaction — truncate lowest-priority sections first.
	const trimmedCtx = { ...workingCtx };
	const charBudget = maxPromptTokens * 4;

	// Step 1: Drop history entirely. Last resort: reached only when the compacted
	// history (or a history too short to compact) still does not fit.
	if (trimmedCtx.history.length > 0) {
		const droppedCount = trimmedCtx.history.length;
		trimmedCtx.history = [];
		delete trimmedCtx.historyCheckpoint;
		const newChars = estimateContextChars(trimmedCtx);
		console.warn({
			component: "kernel.context",
			event: "history_dropped",
			droppedCount,
			savedChars: workingChars - newChars,
			estimatedTokens,
			budget: maxPromptTokens,
		});
		if (newChars <= charBudget) {
			return published(trimmedCtx);
		}
	}

	// Step 2: Halve facts until under budget or exhausted.
	while (trimmedCtx.facts.length > 0) {
		const before = estimateContextChars(trimmedCtx);
		if (before <= charBudget) break;
		const prevCount = trimmedCtx.facts.length;
		trimmedCtx.facts = trimmedCtx.facts.slice(
			0,
			Math.max(0, Math.floor(prevCount / 2)),
		);
		const after = estimateContextChars(trimmedCtx);
		console.warn({
			component: "kernel.context",
			event: "facts_trimmed",
			previousCount: prevCount,
			remainingCount: trimmedCtx.facts.length,
			savedChars: before - after,
			budget: maxPromptTokens,
		});
		if (trimmedCtx.facts.length === 0) break;
	}

	// Step 3: Halve rationale until under budget or exhausted.
	while (trimmedCtx.rationale.length > 0) {
		const before = estimateContextChars(trimmedCtx);
		if (before <= charBudget) break;
		const prevCount = trimmedCtx.rationale.length;
		trimmedCtx.rationale = trimmedCtx.rationale.slice(
			0,
			Math.max(0, Math.floor(prevCount / 2)),
		);
		const after = estimateContextChars(trimmedCtx);
		console.warn({
			component: "kernel.context",
			event: "rationale_trimmed",
			previousCount: prevCount,
			remainingCount: trimmedCtx.rationale.length,
			savedChars: before - after,
			budget: maxPromptTokens,
		});
		if (trimmedCtx.rationale.length === 0) break;
	}

	// If still over budget (extremely unusual — e.g. tedis/apps alone exceed the
	// window), log but return the best-effort context rather than throwing.
	const finalChars = estimateContextChars(trimmedCtx);
	if (finalChars > charBudget) {
		console.warn({
			component: "kernel.context",
			event: "budget_exceeded_after_trim",
			finalTokens: Math.ceil(finalChars / 4),
			budget: maxPromptTokens,
		});
	}

	return published(trimmedCtx);
}
