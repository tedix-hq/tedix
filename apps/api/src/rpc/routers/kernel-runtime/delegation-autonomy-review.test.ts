import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";

const mocks = vi.hoisted(() => ({ policy: vi.fn() }));
vi.mock("../kernel/tedi-capabilities", () => ({
	readOrgDispatchPolicyLayer: mocks.policy,
	getTediCapabilityCards: async () => [],
}));
vi.mock("../kernel/delegation-dispatch", () => ({
	buildDelegationWorkOrder: () => ({
		executionRequirement: {},
		capabilityPlan: {},
	}),
	decideDelegationDispatch: () => ({
		canAutoDispatch: false,
		mode: "blocked",
		reason: "capability gap",
	}),
}));
vi.mock("./delegation-autonomy-workstation-policy", () => ({
	reviewWorkstationDelegationAutonomy: async () => null,
}));
vi.mock("./turn-delegation", () => ({
	approvalHeldDelegation: () => false,
	kernelDelegationRecommendationFromRun: (run: KernelRuntimeRun) => ({
		metadata: run.metadata,
		delegation: {},
		targetTediId: "worker",
		workOrder: { sourceContent: run.metadata?.sourceContent },
	}),
}));

import { reviewDelegationAutonomy } from "./delegation-autonomy-review";

describe("execution blockers under autonomy", () => {
	beforeEach(() => {
		mocks.policy.mockResolvedValue({
			autonomy: { version: 1, maxRisk: "medium" },
		});
	});
	const context = { db: {}, env: { ENVIRONMENT: "test" } } as BaseContext;
	function run(
		sourceContent: string,
		risk = "medium",
		effortClass: string | null = "single_read",
	) {
		return {
			organizationId: "org",
			metadata: {
				sourceContent,
				kernelRoute: {
					routeKind: "delegate_tedi",
					answer: null,
					rationale: "The requested task belongs to this worker.",
					risk,
					confidence: 1,
					effortClass,
					targetTediId: "worker",
					targetTediLabel: "Worker",
					targetActivityId: null,
					plannedToolIds: [],
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			},
		} as unknown as KernelRuntimeRun;
	}
	it.each(["Draft an internal note", "Draft an email for later review"])(
		"closes the execution blocker for a non-critical task: %s",
		async (content) => {
			expect(
				await reviewDelegationAutonomy(context, run(content)),
			).toMatchObject({
				allowed: false,
				executionBlocked: true,
			});
		},
	);
	it.each([
		"Pay the invoice",
		"Email a customer",
		"Publish the article",
		"Complete OAuth consent",
		"Change member permissions",
		"Delete the records",
		"Update production provider settings",
	])(
		"keeps critical work human-gated despite missing tools: %s",
		async (content) => {
			expect(
				(await reviewDelegationAutonomy(context, run(content)))
					.executionBlocked,
			).toBe(false);
		},
	);
	it("preserves high-risk and human-corrected classes", async () => {
		expect(
			(await reviewDelegationAutonomy(context, run("Read the report", "high")))
				.executionBlocked,
		).toBe(false);
		mocks.policy.mockResolvedValueOnce({
			autonomy: {
				version: 1,
				maxRisk: "medium",
				askForClasses: ["delegation:unknown"],
			},
		});
		expect(
			(
				await reviewDelegationAutonomy(
					context,
					run("Read the report", "medium", null),
				)
			).executionBlocked,
		).toBe(false);
	});
	it("does not close a hold without an active autonomy policy", async () => {
		mocks.policy.mockResolvedValueOnce(null);
		expect(
			(await reviewDelegationAutonomy(context, run("Read the report")))
				.executionBlocked,
		).toBeUndefined();
	});
});
