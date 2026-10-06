import { describe, expect, it } from "vite-plus/test";
import {
	WorkExecutionClusterPlanSchema,
	WorkSchedulerReadyQueueSchema,
} from "../schemas/work-scheduler";
import { workSchedulerContract } from "./work-scheduler";

describe("Work scheduler contract", () => {
	it("exposes ready-queue and execution-cluster projections", () => {
		expect(Object.keys(workSchedulerContract)).toEqual([
			"listReady",
			"planClusters",
		]);
	});

	it("keeps execution clusters bounded and explicitly advisory", () => {
		const input = workSchedulerContract.planClusters["~orpc"].inputSchemas[0]!;
		expect(input.safeParse({ maxParallelism: 50 }).success).toBe(true);
		expect(input.safeParse({ maxParallelism: 51 }).success).toBe(false);
		expect(() =>
			WorkExecutionClusterPlanSchema.parse({
				policyRevision: "work-clusters/v1",
				advisory: false,
			}),
		).toThrow();
	});

	it("requires the complete inspectable ranking receipt", () => {
		expect(() =>
			WorkSchedulerReadyQueueSchema.parse({
				policyRevision: "work-scheduler/v1",
			}),
		).toThrow();
	});

	it("bounds ready-queue cursors", () => {
		const input = workSchedulerContract.listReady["~orpc"].inputSchemas[0]!;
		expect(input.safeParse({ cursor: "x".repeat(500) }).success).toBe(true);
		expect(input.safeParse({ cursor: "x".repeat(501) }).success).toBe(false);
	});

	it("requires typed hard-fact truncation categories", () => {
		const receipt = {
			policyRevision: "work-scheduler/v1" as const,
			verbosity: "compact" as const,
			observedAt: "2026-08-21T12:00:00.000Z",
			evaluatedCandidates: 1,
			ineligibleByReason: {
				not_accepted: 0,
				already_running: 0,
				already_admitted: 0,
				purpose_blocked: 0,
				dependencies_blocked: 0,
				capability_blocked: 0,
				approval_blocked: 0,
				budget_blocked: 0,
				resource_blocked: 0,
				evaluation_required: 1,
				coordination_parent: 0,
				cost_blocked: 0,
			},
			items: [],
			nextCursor: null,
			boundedCandidateLimit: 200,
			graphTruncated: false,
			factsTruncated: true,
			truncatedFacts: [
				"dependencies",
				"capabilities",
				"approvals",
				"cases",
			] as const,
		};
		expect(WorkSchedulerReadyQueueSchema.parse(receipt).truncatedFacts).toEqual(
			["dependencies", "capabilities", "approvals", "cases"],
		);
		expect(
			WorkSchedulerReadyQueueSchema.safeParse({
				...receipt,
				truncatedFacts: ["authorities"],
			}).success,
		).toBe(false);
	});
});
