import { describe, expect, it } from "vite-plus/test";
import type { KernelContext } from "./context-assembly";
import { decideDelegationDispatch } from "./delegation-dispatch";
import {
	embodiedMismatchAnswer,
	rerouteEmbodiedMismatch,
} from "./embodied-reroute";
import type { KernelRouteDecision } from "./route-schema";
import type { TediCapabilityCard } from "./tedi-capabilities";

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
		embodied: false,
		availability: "running",
		hasWarmWorkstationLease: false,
		hasRepository: false,
		repositoryUrl: null,
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
	rationale: "The research tedi owns this topic.",
	risk: "low",
	confidence: 0.8,
	effortClass: "embodied",
	targetTediId: "researcher",
	targetTediLabel: "Researcher",
	targetActivityId: "research-activity",
	plannedToolIds: ["open_computer"],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: "A pull request",
};

const request = "Fix the failing checkout test and open a pull request";

describe("rerouteEmbodiedMismatch", () => {
	it("moves workstation work from a bodiless tedi to one with a workstation", () => {
		const result = rerouteEmbodiedMismatch({
			content: request,
			context: context([
				card("researcher", "Researcher"),
				card("engineer", "Engineer", {
					embodied: true,
					hasRepository: true,
					availability: "standby",
				}),
			]),
			decision: route,
		});
		expect(result).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "engineer",
			targetTediLabel: "Engineer",
			targetActivityId: null,
			plannedToolIds: [],
		});
	});

	it("prefers a warm workstation over a standby body", () => {
		const result = rerouteEmbodiedMismatch({
			content: request,
			context: context([
				card("researcher", "Researcher"),
				card("cold", "Cold Engineer", { embodied: true, hasRepository: true }),
				card("warm", "Warm Engineer", {
					embodied: true,
					hasRepository: true,
					hasWarmWorkstationLease: true,
				}),
			]),
			decision: route,
		});
		expect(result.targetTediId).toBe("warm");
	});

	it("answers in Home instead of moving a tedi the operator named", () => {
		const result = rerouteEmbodiedMismatch({
			content: `Ask Researcher to ${request.toLowerCase()}`,
			context: context([
				card("researcher", "Researcher"),
				card("engineer", "Engineer", { embodied: true, hasRepository: true }),
			]),
			decision: route,
		});
		expect(result.routeKind).toBe("answer_in_home");
		expect(result.targetTediId).toBeNull();
		expect(result.answer).toBe(
			embodiedMismatchAnswer({
				targetName: "Researcher",
				peerName: "Engineer",
			}),
		);
		expect(result.answer).toContain("Engineer has one");
	});

	it("says what to connect when no tedi has a workstation", () => {
		const result = rerouteEmbodiedMismatch({
			content: request,
			context: context([
				card("researcher", "Researcher"),
				card("writer", "Writer"),
			]),
			decision: route,
		});
		expect(result.routeKind).toBe("answer_in_home");
		expect(result.answer).toContain("no other tedi here has one either");
		expect(result.answer).toContain("Connect a repository or workstation");
	});

	it("skips peers that are archived or hold no grants", () => {
		const result = rerouteEmbodiedMismatch({
			content: request,
			context: context([
				card("researcher", "Researcher"),
				card("gone", "Gone", { embodied: true, availability: "archived" }),
				card("bare", "Bare", { embodied: true, scopeGroups: [] }),
			]),
			decision: route,
		});
		expect(result.routeKind).toBe("answer_in_home");
	});

	it("leaves non-workstation work and workstation-capable targets alone", () => {
		const roster = context([
			card("researcher", "Researcher"),
			card("engineer", "Engineer", { embodied: true, hasRepository: true }),
		]);
		const read = rerouteEmbodiedMismatch({
			content: "Summarize last week's billing questions",
			context: roster,
			decision: { ...route, effortClass: "multi_hop_read", plannedToolIds: [] },
		});
		expect(read.targetTediId).toBe("researcher");
		const capable = rerouteEmbodiedMismatch({
			content: request,
			context: roster,
			decision: { ...route, targetTediId: "engineer" },
		});
		expect(capable.targetTediId).toBe("engineer");
	});

	it("never hands the mismatch to a person at the dispatch gate", () => {
		const verdict = decideDelegationDispatch({
			route,
			card: card("researcher", "Researcher"),
			speaker: { approvalAuthority: true },
		});
		expect(verdict.mode).toBe("blocked");
		expect(verdict.reason).toContain("capability gap");
	});
});
