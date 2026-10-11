/**
 * Per-conversation hand-off of the Agent Memory relevance recall between Home
 * turns.
 *
 * The recall is model-backed and multi-second: production over 3 h (n=50,
 * 2026-10-11) measured `[MemoryGraph.search] complete` totalMs min 3074 /
 * p50 5436 / p95 12334 (agentMemoryMs p50 4576), while assembly reached its
 * wait only ~1 s after ingress. A turn therefore never sees its own recall in
 * time. Instead of blocking, the kernel keeps the LAST completed recall of the
 * conversation in the KernelDO's storage and lets the next turn blend it; the
 * in-flight recall is stored when it settles so the turn after it benefits.
 *
 * Pure module: no agents-SDK / `cloudflare:workers` imports, injectable clock.
 */
import type { AgentMemoryCandidate } from "../integrations/cloudflare/agent-memory";

/** Oldest stored recall a later turn may still blend. */
export const RELEVANCE_RECALL_PREVIOUS_MAX_AGE_MS = 30 * 60_000;
/** Size caps on the stored row (DO storage value, read on every turn). */
export const RELEVANCE_RECALL_STORED_CANDIDATE_CAP = 24;
export const RELEVANCE_RECALL_STORED_QUERY_CHARS = 400;

export const RELEVANCE_RECALL_STORAGE_KEY_PREFIX = "relevance-recall:";

export function relevanceRecallStorageKey(conversationId: string): string {
	return `${RELEVANCE_RECALL_STORAGE_KEY_PREFIX}${conversationId}`;
}

/** The most recent completed recall for one conversation. */
export interface StoredRelevanceRecall {
	v: 1;
	conversationId: string;
	/** The operator-turn text the recall was computed for (truncated). */
	query: string;
	/** Epoch ms when the recall settled. */
	completedAt: number;
	candidates: AgentMemoryCandidate[];
}

/** How this turn's blended relevance facts were sourced. */
export type RelevanceRecallSource = "fresh" | "previous" | "static";

export interface RelevanceRecallOutcome {
	source: RelevanceRecallSource;
	/** Age of the recall result at assembly time (`previous` only). */
	ageMs: number | null;
	/** Candidate ids handed to canonical D1 hydration. */
	candidates: number;
	/** Wall-clock ms assembly spent waiting on the in-flight recall. */
	waitedMs: number;
}

/** Build the row to persist once a recall settles. Returns null for an empty
 * result so a failed/empty recall never overwrites a useful earlier one. */
export function toStoredRelevanceRecall(input: {
	conversationId: string;
	query: string;
	candidates: AgentMemoryCandidate[];
	completedAt: number;
}): StoredRelevanceRecall | null {
	if (input.candidates.length === 0) return null;
	return {
		v: 1,
		conversationId: input.conversationId,
		query: input.query.slice(0, RELEVANCE_RECALL_STORED_QUERY_CHARS),
		completedAt: input.completedAt,
		candidates: input.candidates
			.slice(0, RELEVANCE_RECALL_STORED_CANDIDATE_CAP)
			.map(({ factId, score }) => ({ factId, score })),
	};
}

/**
 * The stored recall a turn may blend: the row must be well-formed, belong to
 * the conversation, and be younger than the age cap. Anything else is treated
 * as absent (the static-facts path).
 */
export function usablePreviousRelevanceRecall(
	stored: unknown,
	opts: {
		conversationId: string;
		now: number;
		maxAgeMs?: number;
	},
): StoredRelevanceRecall | null {
	if (!stored || typeof stored !== "object") return null;
	const row = stored as Partial<StoredRelevanceRecall>;
	if (
		row.v !== 1 ||
		row.conversationId !== opts.conversationId ||
		typeof row.completedAt !== "number" ||
		!Array.isArray(row.candidates) ||
		row.candidates.length === 0
	) {
		return null;
	}
	const ageMs = opts.now - row.completedAt;
	if (
		ageMs < 0 ||
		ageMs > (opts.maxAgeMs ?? RELEVANCE_RECALL_PREVIOUS_MAX_AGE_MS)
	) {
		return null;
	}
	return row as StoredRelevanceRecall;
}
