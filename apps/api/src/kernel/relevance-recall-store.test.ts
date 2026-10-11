import { describe, expect, it } from "vite-plus/test";
import {
	RELEVANCE_RECALL_PREVIOUS_MAX_AGE_MS,
	RELEVANCE_RECALL_STORED_CANDIDATE_CAP,
	RELEVANCE_RECALL_STORED_QUERY_CHARS,
	toStoredRelevanceRecall,
	usablePreviousRelevanceRecall,
} from "./relevance-recall-store";

const row = {
	v: 1 as const,
	conversationId: "home:main",
	query: "q",
	completedAt: 10_000,
	candidates: [{ factId: "f1", score: 0.5 }],
};

describe("toStoredRelevanceRecall", () => {
	it("drops empty results so a failed recall never overwrites a useful one", () => {
		expect(
			toStoredRelevanceRecall({ ...row, candidates: [], completedAt: 1 }),
		).toBeNull();
	});

	it("caps candidates and query text", () => {
		const stored = toStoredRelevanceRecall({
			conversationId: "home:main",
			query: "x".repeat(RELEVANCE_RECALL_STORED_QUERY_CHARS + 50),
			completedAt: 5,
			candidates: Array.from(
				{ length: RELEVANCE_RECALL_STORED_CANDIDATE_CAP + 10 },
				(_, i) => ({ factId: `f${i}`, score: 1 - i / 100, extra: true }),
			),
		});
		expect(stored?.query).toHaveLength(RELEVANCE_RECALL_STORED_QUERY_CHARS);
		expect(stored?.candidates).toHaveLength(
			RELEVANCE_RECALL_STORED_CANDIDATE_CAP,
		);
		expect(stored?.candidates[0]).toEqual({ factId: "f0", score: 1 });
	});
});

describe("usablePreviousRelevanceRecall", () => {
	it("returns a fresh, matching row", () => {
		expect(
			usablePreviousRelevanceRecall(row, {
				conversationId: "home:main",
				now: 10_000 + RELEVANCE_RECALL_PREVIOUS_MAX_AGE_MS,
			}),
		).toBe(row);
	});

	it("rejects expired, foreign, malformed and future-dated rows", () => {
		const base = { conversationId: "home:main", now: 20_000 };
		expect(
			usablePreviousRelevanceRecall(row, {
				...base,
				now: 10_001 + RELEVANCE_RECALL_PREVIOUS_MAX_AGE_MS,
			}),
		).toBeNull();
		expect(
			usablePreviousRelevanceRecall(row, {
				...base,
				conversationId: "home:other",
			}),
		).toBeNull();
		expect(usablePreviousRelevanceRecall({ ...row, v: 2 }, base)).toBeNull();
		expect(
			usablePreviousRelevanceRecall({ ...row, candidates: [] }, base),
		).toBeNull();
		expect(usablePreviousRelevanceRecall(undefined, base)).toBeNull();
		expect(
			usablePreviousRelevanceRecall(row, { ...base, now: 9_999 }),
		).toBeNull();
	});
});
