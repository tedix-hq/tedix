import { describe, expect, it } from "vite-plus/test";
import {
	memoryGraphContract,
	MemoryGraphHealthOutputSchema,
	MemoryGraphReviewInputSchema,
	MemoryGraphSearchInputSchema,
	MemoryGraphSyncDrainOutputSchema,
} from "./memory-graph";

describe("memoryGraphContract.assemble", () => {
	it("requires the tedi whose memory context is assembled", () => {
		const input = memoryGraphContract.assemble["~orpc"].inputSchemas[0]!;
		expect(input.safeParse({ query: "customer context" }).success).toBe(false);
		expect(
			input.safeParse({ query: "customer context", tediId: "tedi-1" }).success,
		).toBe(true);
	});
});

describe("MemoryGraphSearchInputSchema", () => {
	it("accepts exact topic-key lookup without a semantic query", () => {
		const parsed = MemoryGraphSearchInputSchema.parse({
			topicKey: "acme.brain-quality.baseline.current",
		});

		expect(parsed.topicKey).toBe("acme.brain-quality.baseline.current");
		expect(parsed.query).toBeUndefined();
	});

	it("still accepts normal semantic search", () => {
		const parsed = MemoryGraphSearchInputSchema.parse({
			query: "Acme brain quality baseline",
			topK: 5,
		});

		expect(parsed.query).toBe("Acme brain quality baseline");
		expect(parsed.topK).toBe(5);
	});

	it("requires either query or topicKey", () => {
		expect(() => MemoryGraphSearchInputSchema.parse({})).toThrow(
			"Provide query or topicKey",
		);
	});
});

describe("MemoryGraphReviewInputSchema", () => {
	it("accepts a lifecycle rejection with archive intent", () => {
		const parsed = MemoryGraphReviewInputSchema.parse({
			factId: "5eed0034-0000-4000-8000-000000000034",
			reviewStatus: "rejected",
			archived: true,
			reason: "Low-quality session-derived fact.",
		});

		expect(parsed.reviewStatus).toBe("rejected");
		expect(parsed.archived).toBe(true);
	});

	it("requires at least one lifecycle field beyond factId", () => {
		expect(() =>
			MemoryGraphReviewInputSchema.parse({ factId: "fact-1" }),
		).toThrow("Provide at least one lifecycle field");
	});
});

describe("MemoryGraphSyncDrainOutputSchema", () => {
	it("requires and preserves the post-repair query-budget signal", () => {
		const output = {
			batches: 1,
			processed: 32,
			blocked: null,
			budgetExhausted: true,
		};

		expect(MemoryGraphSyncDrainOutputSchema.parse(output)).toEqual(output);
		expect(() =>
			MemoryGraphSyncDrainOutputSchema.parse({
				batches: 1,
				processed: 32,
				blocked: null,
			}),
		).toThrow();
	});
});

describe("MemoryGraphHealthOutputSchema", () => {
	it("requires an explicit D1-authoritative projection gate", () => {
		const parsed = MemoryGraphHealthOutputSchema.parse({
			healthy: true,
			configured: true,
			passesGate: false,
			checkedAt: "2026-07-18T12:00:00.000Z",
			projection: {
				authority: "d1",
				gateStatus: "failing",
				passesGate: false,
				checkedAt: "2026-07-18T12:00:00.000Z",
				sampleLimit: 25,
				sampleSize: 2,
				projectedCount: 1,
				missingCount: 1,
				staleCount: 0,
				overdueCount: 1,
				sampleCoverageRatio: 0.5,
				newestCanonicalAt: "2026-07-18T11:00:00.000Z",
				newestProjectedAt: "2026-07-18T10:00:00.000Z",
				maxObservedLagMs: 0,
				thresholds: {
					minSampleCoverageRatio: 0.95,
					maxProjectionLagMs: 300_000,
				},
				facts: [
					{
						factId: "fact-1",
						canonicalUpdatedAt: "2026-07-18T11:00:00.000Z",
						projectedUpdatedAt: null,
						lagMs: null,
						status: "missing_overdue",
					},
				],
			},
			edges: {
				authority: "d1",
				passesGate: false,
				sampleSize: 0,
				projectedCount: 0,
				missingCount: 0,
				mismatchCount: 0,
				sampleCoverageRatio: null,
				edges: [],
			},
			lifecycle: {
				authority: "d1",
				passesGate: true,
				sampleSize: 0,
				projectedCount: 0,
				missingCount: 0,
				mismatchCount: 0,
				facts: [],
			},
			managedCounts: {
				authority: "d1",
				passesGate: false,
				canonical: { facts: 2 },
				projected: { facts: 1 },
				mismatches: [
					{
						kind: "facts",
						canonicalCount: 2,
						projectedCount: 1,
						delta: -1,
					},
				],
			},
			schema: {
				version: "graph-projection-schema-v1",
				constraints: [],
				complete: false,
			},
			readiness: null,
			backlog: {
				cursor: 0,
				highWaterSequence: 1,
				pendingCount: 1,
				retryCount: 0,
				poisonedCount: 0,
				oldestPendingAt: "2026-07-18T11:00:00.000Z",
			},
		});

		expect(parsed.projection.authority).toBe("d1");
		expect(parsed.projection.passesGate).toBe(false);
	});
});
