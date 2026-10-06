import { WorkSchedulerReadyQueueSchema } from "@tedix/api-contract/schemas/work-scheduler";
import type { ReadyWorkCandidate } from "@tedix/db/queries/work-items/scheduler";
import { describe, expect, it } from "vite-plus/test";
import { mapReadyCandidate } from "./work-scheduler";

function candidate(index: number): ReadyWorkCandidate {
	return {
		workItem: {
			id: `00000000-0000-4000-8000-00000000${String(index).padStart(4, "0")}`,
			title: `Complete example account authentication ${index}`,
			workKind: "operations",
			priority: "medium",
			riskLevel: "medium",
			projectId: null,
			parentWorkItemId: null,
			dueDate: "immediately",
			deadline: "2026-05-31T20:44:00Z",
			requiredAuthorities: [],
		} as unknown as ReadyWorkCandidate["workItem"],
		score: 52.93,
		factors: {
			priority: 40,
			urgency: 5.64,
			aging: 12.29,
			downstream: 0,
			criticalPath: 0,
			risk: -5,
			cost: 0,
			verifierBackpressure: 0,
		},
		readiness: { state: "ready", reasons: [] },
		graphTruncated: false,
		resourceClaims: [],
	};
}

function receipt(verbosity: "compact" | "full", count: number) {
	return WorkSchedulerReadyQueueSchema.parse({
		policyRevision: "work-scheduler/v1",
		verbosity,
		observedAt: "2026-08-25T12:00:00.000Z",
		evaluatedCandidates: 500,
		ineligibleByReason: Object.fromEntries(
			[
				"not_accepted",
				"already_running",
				"already_admitted",
				"purpose_blocked",
				"dependencies_blocked",
				"capability_blocked",
				"approval_blocked",
				"budget_blocked",
				"resource_blocked",
				"evaluation_required",
				"coordination_parent",
				"cost_blocked",
			].map((reason) => [reason, 0]),
		),
		items: Array.from({ length: count }, (_, i) =>
			mapReadyCandidate(candidate(i), verbosity),
		),
		nextCursor: null,
		boundedCandidateLimit: 500,
		graphTruncated: false,
		factsTruncated: false,
		truncatedFacts: [],
	});
}

describe("Work scheduler receipt projection", () => {
	it("defaults to a compact receipt that still exposes every factor value", () => {
		const item = mapReadyCandidate(candidate(0), "compact");
		expect(item.factors).toHaveLength(8);
		expect(item.factors.map((factor) => factor.factor)).toEqual([
			"priority",
			"urgency",
			"aging_fairness",
			"downstream_impact",
			"critical_path",
			"risk",
			"estimated_cost",
			"verification_backpressure",
		]);
		for (const factor of item.factors) {
			expect(typeof factor.value).toBe("number");
			expect(typeof factor.contribution).toBe("number");
			expect(factor).not.toHaveProperty("explanation");
		}
		// The composition still reconstructs the emitted (rounded) score.
		expect(
			Math.round(item.factors.reduce((sum, factor) => sum + factor.value, 0)),
		).toBe(item.score);
		expect(item.eligibility).toEqual({ state: "ready" });
		expect(item.taskGuidance).not.toHaveProperty("explanation");
	});

	it("restores prose under verbosity=full", () => {
		const item = mapReadyCandidate(candidate(0), "full");
		for (const factor of item.factors) expect(factor.explanation).toBeTruthy();
		expect(item.eligibility.explanation).toBeTruthy();
		expect(item.taskGuidance.explanation).toBeTruthy();
	});

	it("preserves the documented truncation semantics in both modes", () => {
		for (const verbosity of ["compact", "full"] as const) {
			const parsed = receipt(verbosity, 1);
			expect(parsed.factsTruncated).toBe(false);
			expect(parsed.truncatedFacts).toEqual([]);
			expect(parsed.graphTruncated).toBe(false);
			expect(parsed.verbosity).toBe(verbosity);
		}
	});

	it("fits a bounded receipt size that the gateway can return whole", () => {
		// The gateway truncates around 8.7k tokens; ~4 chars/token gives a ~34KB
		// working budget. `limit: 12` previously failed outright.
		const compact = JSON.stringify(receipt("compact", 20));
		const full = JSON.stringify(receipt("full", 20));
		expect(compact.length).toBeLessThan(20_000);
		expect(compact.length).toBeLessThan(full.length * 0.7);
	});
});
