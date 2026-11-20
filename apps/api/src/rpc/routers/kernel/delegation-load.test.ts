import { describe, expect, it } from "vite-plus/test";
import { decideDelegationDispatch } from "./delegation-dispatch";
import { delegationCapacity } from "./delegation-load";
import type { KernelRouteDecision } from "./route-schema";
import {
	parseDelegationConcurrency,
	type TediCapabilityCard,
} from "./tedi-capabilities";

const REPO = "https://git.example.test/globex/storefront";

function card(
	tediId: string,
	name: string,
	overrides: Partial<TediCapabilityCard> = {},
): TediCapabilityCard {
	return {
		tediId,
		slug: tediId,
		name,
		apps: ["github"],
		scopeGroups: ["repository:write"],
		skills: [],
		runtimeKind: "agent",
		embodied: true,
		availability: "standby",
		hasWarmWorkstationLease: false,
		hasRepository: true,
		repositoryUrl: REPO,
		delegationConcurrency: 2,
		depsReady: false,
		environmentReady: false,
		requiresApproval: false,
		delegationEntrustments: [],
		dispatchPolicy: null,
		mcpCapabilityProfile: null,
		...overrides,
	};
}

const route: KernelRouteDecision = {
	routeKind: "delegate_tedi",
	answer: null,
	rationale: "Engineering owns the storefront repository.",
	risk: "low",
	confidence: 0.8,
	effortClass: "embodied",
	targetTediId: "lead-engineer",
	targetTediLabel: "Lead Engineer",
	targetActivityId: "lead-activity",
	plannedToolIds: ["open_computer"],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: "Passing tests",
};

describe("delegation capacity", () => {
	it("reads the per-tedi limit from the policy pack's workItemConcurrency", () => {
		expect(parseDelegationConcurrency(null)).toBe(2);
		expect(parseDelegationConcurrency({ workItemConcurrency: 3 })).toBe(3);
		expect(parseDelegationConcurrency({ workItemConcurrency: 50 })).toBe(8);
		expect(parseDelegationConcurrency({ workItemConcurrency: 0 })).toBe(2);
	});

	it("defers an otherwise auto dispatch to a tedi at its limit, with no approval", () => {
		const target = card("lead-engineer", "Lead Engineer", {
			hasWarmWorkstationLease: true,
			environmentReady: true,
			depsReady: true,
			availability: "running",
		});
		const base = {
			route: { ...route, effortClass: "single_read" as const },
			card: target,
			speaker: { approvalAuthority: true },
		};
		expect(decideDelegationDispatch(base).mode).toBe("auto");
		expect(
			decideDelegationDispatch({
				...base,
				targetCapacity: delegationCapacity(
					target,
					new Map([["lead-engineer", 1]]),
				),
			}).mode,
		).toBe("auto");
		const deferred = decideDelegationDispatch({
			...base,
			targetCapacity: delegationCapacity(
				target,
				new Map([["lead-engineer", 2]]),
			),
		});
		expect(deferred).toMatchObject({
			canAutoDispatch: false,
			mode: "deferred",
		});
		expect(deferred.approvalRoute).toBeUndefined();
		expect(deferred.reason).toMatch(/^capacity: /);
		expect(deferred.reason).toContain("2 of its 2 concurrent delegated runs");
	});
});
