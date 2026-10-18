import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
const mocks = vi.hoisted(() => ({
	lexical: vi.fn(),
	graph: vi.fn(),
	temporal: vi.fn(),
	hydrate: vi.fn(),
	fallback: vi.fn(),
	semantic: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/hybrid-recall", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/memory-graph/hybrid-recall")
	>()),
	lexicalRecall: mocks.lexical,
	graphRecall: mocks.graph,
	temporalRecall: mocks.temporal,
	hydrateRecall: mocks.hydrate,
	fallbackRecall: mocks.fallback,
}));
vi.mock("../integrations/cloudflare/agent-memory", () => ({
	recallCanonicalMemoryCandidates: mocks.semantic,
}));
import {
	fuseRecall,
	recallMemoryFacts,
	type RecallEnvironment,
} from "./memory-hybrid-recall";
const db = {} as DbClient;
const fact = (id: string) =>
	({
		id,
		organizationId: "fictional-a",
		content: `knowledge ${id}`,
		confidence: 0.8,
		replacesFactIds: [],
	}) as unknown as MemoryFact;
const scope = {
	orgId: "fictional-a",
	tediId: "tedi-a",
	query: "cobalt yesterday",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.lexical.mockResolvedValue([{ factId: "a", score: 3 }]);
	mocks.graph.mockResolvedValue([]);
	mocks.temporal.mockResolvedValue([]);
	mocks.semantic.mockResolvedValue([]);
	mocks.hydrate.mockResolvedValue([fact("a"), fact("b")]);
	mocks.fallback.mockResolvedValue([fact("a")]);
});
afterEach(() => vi.useRealTimers());
describe("hybrid memory orchestration", () => {
	it("fuses rank rather than incompatible scores and retains each arm's provenance", () => {
		const results = fuseRecall({
			lexical: [
				{ factId: "a", score: 99999 },
				{ factId: "b", score: 2 },
			],
			semantic: [
				{ factId: "b", score: 0.1 },
				{ factId: "b", score: 0.1 },
			],
			graph: [{ factId: "b", score: 0.9 }],
		});
		expect(results.map((x) => x.factId)).toEqual(["b", "a"]);
		expect(results[0]!.provenance.arms.map((x) => x.arm)).toEqual([
			"lexical",
			"semantic",
			"graph",
		]);
	});
	it("starts all arms together and bounds a hung semantic provider", async () => {
		vi.useFakeTimers();
		mocks.semantic.mockImplementation(() => new Promise(() => {}));
		const promise = recallMemoryFacts(db, {
			...scope,
			env: { AGENT_MEMORY: {} } as RecallEnvironment,
		});
		await vi.advanceTimersByTimeAsync(1);
		for (const arm of [
			mocks.lexical,
			mocks.graph,
			mocks.temporal,
			mocks.semantic,
		])
			expect(arm).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(450);
		expect((await promise).map((x) => x.factId)).toEqual(["a"]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("preserves eligible RRF candidates when reranking hangs, fails or returns malformed indices", async () => {
		mocks.graph.mockResolvedValue([{ factId: "b", score: 0.8 }]);
		for (const run of [
			vi.fn().mockRejectedValue(new Error("unavailable")),
			vi.fn().mockResolvedValue({ response: [{ id: 99, score: 1 }] }),
		]) {
			expect(
				(
					await recallMemoryFacts(db, {
						...scope,
						env: { AI: { run } } as unknown as RecallEnvironment,
					})
				).map((x) => x.factId),
			).toEqual(["a", "b"]);
		}
		vi.useFakeTimers();
		const run = vi.fn(() => new Promise(() => {}));
		const result = recallMemoryFacts(db, {
			...scope,
			budgetMs: 50,
			env: { AI: { run } } as unknown as RecallEnvironment,
		});
		await vi.advanceTimersByTimeAsync(50);
		expect((await result).map((x) => x.factId)).toEqual(["a", "b"]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("reranks only the canonical hydrated shortlist and returns the model score separately", async () => {
		mocks.graph.mockResolvedValue([
			{ factId: "b", score: 0.8 },
			{ factId: "foreign", score: 0.7 },
		]);
		const run = vi.fn().mockResolvedValue({
			response: [
				{ id: 1, score: 0.99 },
				{ id: 0, score: 0.1 },
			],
		});
		const results = await recallMemoryFacts(db, {
			...scope,
			env: { AI: { run } } as unknown as RecallEnvironment,
		});
		expect(results.map((x) => x.factId)).toEqual(["b", "a"]);
		expect(results[0]!.provenance.rerankScore).toBe(0.99);
		expect(run.mock.calls[0]![1]).toMatchObject({
			query: scope.query,
			contexts: [{ text: "\nknowledge a" }, { text: "\nknowledge b" }],
		});
	});
	it("uses the old ranker only when the FTS table is absent, including wrapped Drizzle errors", async () => {
		mocks.lexical.mockRejectedValue(
			new Error("query failed", {
				cause: new Error("no such table: memory_fact_fts"),
			}),
		);
		expect((await recallMemoryFacts(db, scope))[0]!.provenance.fallback).toBe(
			true,
		);
		expect(mocks.fallback).toHaveBeenCalledTimes(1);
		mocks.fallback.mockClear();
		mocks.lexical.mockResolvedValue([]);
		expect(await recallMemoryFacts(db, scope)).toEqual([]);
		expect(mocks.fallback).not.toHaveBeenCalled();
	});
	it("retains the eligible tail beyond the 30-document rerank shortlist", async () => {
		const facts = Array.from({ length: 36 }, (_, index) =>
			fact(`f${String(index).padStart(2, "0")}`),
		);
		mocks.lexical.mockResolvedValue([
			{ factId: "foreign", score: 100 },
			...facts.map((fact, index) => ({ factId: fact.id, score: 99 - index })),
		]);
		mocks.hydrate.mockResolvedValue(facts);
		const run = vi.fn().mockResolvedValue({
			response: Array.from({ length: 30 }, (_, id) => ({ id, score: id })),
		});
		const results = await recallMemoryFacts(db, {
			...scope,
			topK: 40,
			env: { AI: { run } } as unknown as RecallEnvironment,
		});
		expect(results).toHaveLength(36);
		expect(new Set(results.map((item) => item.factId)).size).toBe(36);
		expect(results[0]!.factId).toBe("f29");
		expect(results.slice(30).map((item) => item.factId)).toEqual(
			facts.slice(30).map((fact) => fact.id),
		);
		expect(run.mock.calls[0]![1].contexts).toHaveLength(30);
	});
	it("enforces the caller's complete budget even when every arm or hydration stalls", async () => {
		vi.useFakeTimers();
		for (const arm of [mocks.lexical, mocks.graph, mocks.temporal])
			arm.mockImplementation(() => new Promise(() => {}));
		const result = recallMemoryFacts(db, { ...scope, budgetMs: 70 });
		await vi.advanceTimersByTimeAsync(70);
		expect(await result).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
