import { describe, expect, it } from "vite-plus/test";
import type { KernelContext } from "./context-assembly";
import { decideDelegationDispatch } from "./delegation-dispatch";
import { delegationCapacity, spreadDelegationLoad } from "./delegation-load";
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

function context(cards: TediCapabilityCard[]): KernelContext {
	return {
		tedis: cards.map((capability) => ({
			id: capability.tediId,
			slug: capability.slug,
			name: capability.name,
			capability,
		})) as unknown as KernelContext["tedis"],
		apps: [{ slug: "github", name: "GitHub" }] as KernelContext["apps"],
		workflows: [],
		workItems: [],
		facts: [],
		rationale: [],
		speaker: null,
		history: [],
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

const request = "Fix the failing checkout test in the storefront repository";

describe("spreadDelegationLoad", () => {
	const roster = context([
		card("lead-engineer", "Lead Engineer", { availability: "running" }),
		card("platform-engineer", "Platform Engineer"),
		card("web-engineer", "Web Engineer"),
	]);

	it("moves coding work off a loaded running tedi to an idle standby peer", () => {
		const result = spreadDelegationLoad({
			content: request,
			context: roster,
			decision: route,
			load: new Map([
				["lead-engineer", 2],
				["platform-engineer", 1],
			]),
		});
		expect(result).toMatchObject({
			targetTediId: "web-engineer",
			targetTediLabel: "Web Engineer",
			targetActivityId: null,
			plannedToolIds: [],
		});
	});

	it("spreads six concurrent requests across the pool instead of stacking them", () => {
		const load = new Map<string, number>();
		for (let i = 0; i < 6; i++) {
			const result = spreadDelegationLoad({
				content: request,
				context: roster,
				decision: route,
				load,
			});
			const target = result.targetTediId!;
			load.set(target, (load.get(target) ?? 0) + 1);
		}
		expect(Object.fromEntries(load)).toEqual({
			"lead-engineer": 2,
			"platform-engineer": 2,
			"web-engineer": 2,
		});
	});

	it("keeps the planner's target when it is no busier than its peers", () => {
		const result = spreadDelegationLoad({
			content: request,
			context: roster,
			decision: route,
			load: new Map([
				["lead-engineer", 1],
				["platform-engineer", 1],
				["web-engineer", 1],
			]),
		});
		expect(result).toBe(route);
	});

	it("never moves an explicitly named tedi", () => {
		const result = spreadDelegationLoad({
			content: `Ask the Lead Engineer to ${request.toLowerCase()}`,
			context: roster,
			decision: route,
			load: new Map([["lead-engineer", 2]]),
		});
		expect(result).toBe(route);
	});

	it("only considers peers on the same repository with no extra gate", () => {
		const result = spreadDelegationLoad({
			content: request,
			context: context([
				card("lead-engineer", "Lead Engineer"),
				card("docs-writer", "Docs Writer", {
					repositoryUrl: "https://git.example.test/globex/handbook",
				}),
				card("gated-engineer", "Gated Engineer", { requiresApproval: true }),
				card("retired-engineer", "Retired Engineer", {
					availability: "archived",
				}),
			]),
			decision: route,
			load: new Map([["lead-engineer", 2]]),
		});
		expect(result).toBe(route);
	});

	it("leaves the target in place when every eligible tedi is full", () => {
		const result = spreadDelegationLoad({
			content: request,
			context: roster,
			decision: route,
			load: new Map([
				["lead-engineer", 2],
				["platform-engineer", 2],
				["web-engineer", 2],
			]),
		});
		expect(result).toBe(route);
	});
});

describe("delegation capacity", () => {
	it("reads the per-tedi limit from the policy pack's workItemConcurrency", () => {
		expect(parseDelegationConcurrency(null)).toBe(2);
		expect(parseDelegationConcurrency({ workItemConcurrency: 3 })).toBe(3);
		expect(parseDelegationConcurrency({ workItemConcurrency: 50 })).toBe(8);
		expect(parseDelegationConcurrency({ workItemConcurrency: 0 })).toBe(2);
	});

	it("holds an otherwise auto dispatch to a tedi at its limit", () => {
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
		const held = decideDelegationDispatch({
			...base,
			targetCapacity: delegationCapacity(
				target,
				new Map([["lead-engineer", 2]]),
			),
		});
		expect(held).toMatchObject({
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
		});
		expect(held.reason).toContain("2 of its 2 concurrent delegated runs");
	});
});
