import { describe, expect, it } from "vite-plus/test";
import {
	classifyWorkstationDispatch,
	parseDispatchPolicyLayer,
	resolveEarnedDelegationEnforcement,
	resolveLayeredDispatchPolicy,
} from "./dispatch-policy";

/**
 * Workstation-dispatch policy tests. The approved model is policy-gated:
 * auto-dispatch ONLY when every low-risk condition holds; any unmet/unknown
 * condition degrades to the approval-card flow (never more permissive than the
 * inputs justify).
 */

const LOW_RISK_BASE = {
	explicitHumanDelegation: true,
	hasActingUser: true,
	runtimeRunning: true as boolean | null,
	routeRisk: null as "low" | "medium" | "high" | null,
};

describe("classifyWorkstationDispatch", () => {
	it("auto-dispatches ONLY the fully-low-risk case", () => {
		const d = classifyWorkstationDispatch(LOW_RISK_BASE);
		expect(d).toMatchObject({ risk: "low", autoDispatch: true });
		expect(d.reasons.length).toBeGreaterThan(0); // audit trail always present
	});

	it("requires approval for kernel-initiated dispatch (no explicit human target)", () => {
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			explicitHumanDelegation: false,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("kernel-initiated");
	});

	it("requires approval when there is no authenticated human identity", () => {
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			hasActingUser: false,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("no authenticated human identity");
	});

	it("requires approval when the runtime is not running (spawn/wake needed)", () => {
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			runtimeRunning: false,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("spawn/wake");
	});

	it("requires approval when the running-state is unknown (fail-closed)", () => {
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			runtimeRunning: null,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("unknown");
	});

	it("requires approval when the route planner classified the work as high risk", () => {
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			routeRisk: "high",
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("high risk");
	});

	it("accumulates ALL failed conditions in the audit reasons", () => {
		const d = classifyWorkstationDispatch({
			explicitHumanDelegation: false,
			hasActingUser: false,
			runtimeRunning: false,
			routeRisk: "high",
		});
		expect(d.autoDispatch).toBe(false);
		expect(d.reasons).toHaveLength(4);
	});

	it("medium route risk does not block an otherwise low-risk dispatch", () => {
		// Only "high" blocks; medium falls to the human's explicit choice.
		const d = classifyWorkstationDispatch({
			...LOW_RISK_BASE,
			routeRisk: "medium",
		});
		expect(d).toMatchObject({ risk: "low", autoDispatch: true });
	});

	// "Workstations over bodies": a warm workstation lease is also eligible for
	// the low-risk auto path.
	it("auto-dispatches a warm isolate workstation (lease warm)", () => {
		const d = classifyWorkstationDispatch({
			explicitHumanDelegation: true,
			hasActingUser: true,
			runtimeRunning: null,
			isolateWorkstationWarm: true,
			routeRisk: null,
		});
		expect(d).toMatchObject({ risk: "low", autoDispatch: true });
	});

	it("requires approval when an isolate workstation is not warm (lease cold)", () => {
		const d = classifyWorkstationDispatch({
			explicitHumanDelegation: true,
			hasActingUser: true,
			runtimeRunning: null,
			isolateWorkstationWarm: false,
			routeRisk: null,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("spawn/wake");
	});

	it("requires approval when neither runtime nor workstation warm-state is known (fail-closed)", () => {
		const d = classifyWorkstationDispatch({
			explicitHumanDelegation: true,
			hasActingUser: true,
			runtimeRunning: null,
			isolateWorkstationWarm: null,
			routeRisk: null,
		});
		expect(d).toMatchObject({ risk: "high", autoDispatch: false });
		expect(d.reasons.join(" ")).toContain("unknown");
	});
});

/**
 * Layered dispatch policy precedence (session → tedi → org). DENY short-circuits
 * and fail-closed; an absent layer yields no opinion (defer).
 */
describe("resolveLayeredDispatchPolicy", () => {
	it("defers when no layer expresses an opinion", () => {
		expect(resolveLayeredDispatchPolicy({})).toEqual({
			effect: "defer",
			layer: null,
			reason: "no layered dispatch policy opinion",
		});
		expect(
			resolveLayeredDispatchPolicy({ session: null, tedi: null, org: null })
				.effect,
		).toBe("defer");
	});

	it("a single DENY at any layer wins", () => {
		expect(
			resolveLayeredDispatchPolicy({ org: { effect: "deny" } }),
		).toMatchObject({
			effect: "deny",
			layer: "org",
		});
		expect(
			resolveLayeredDispatchPolicy({ tedi: { effect: "deny" } }),
		).toMatchObject({
			effect: "deny",
			layer: "tedi",
		});
		expect(
			resolveLayeredDispatchPolicy({ session: { effect: "deny" } }),
		).toMatchObject({
			effect: "deny",
			layer: "session",
		});
	});

	it("DENY short-circuits over a higher-precedence ALLOW (fail-closed)", () => {
		const r = resolveLayeredDispatchPolicy({
			session: { effect: "allow" },
			org: { effect: "deny" },
		});
		expect(r.effect).toBe("deny");
		expect(r.layer).toBe("org");
	});

	it("surfaces the highest-precedence deny when multiple layers deny", () => {
		const r = resolveLayeredDispatchPolicy({
			session: { effect: "deny", reason: "thread muted" },
			org: { effect: "deny", reason: "org locked" },
		});
		expect(r.layer).toBe("session");
		expect(r.reason).toBe("thread muted");
	});

	it("the highest-precedence ALLOW governs when no layer denies", () => {
		expect(
			resolveLayeredDispatchPolicy({
				session: { effect: "allow" },
				org: { effect: "allow" },
			}),
		).toMatchObject({ effect: "allow", layer: "session" });
		expect(
			resolveLayeredDispatchPolicy({ org: { effect: "allow" } }),
		).toMatchObject({
			effect: "allow",
			layer: "org",
		});
	});

	it("carries a custom reason through, else a default", () => {
		expect(
			resolveLayeredDispatchPolicy({ org: { effect: "deny" } }).reason,
		).toContain("org policy denies");
		expect(
			resolveLayeredDispatchPolicy({
				session: { effect: "deny", reason: "custom" },
			}).reason,
		).toBe("custom");
	});
});

describe("parseDispatchPolicyLayer", () => {
	it("returns null for non-objects and empty/unrecognized bags (fail-closed → defer)", () => {
		expect(parseDispatchPolicyLayer(null)).toBeNull();
		expect(parseDispatchPolicyLayer(undefined)).toBeNull();
		expect(parseDispatchPolicyLayer("deny")).toBeNull();
		expect(parseDispatchPolicyLayer([])).toBeNull();
		expect(parseDispatchPolicyLayer({})).toBeNull();
		expect(parseDispatchPolicyLayer({ unrelated: true })).toBeNull();
	});

	it("parses explicit dispatch allow/deny", () => {
		expect(parseDispatchPolicyLayer({ dispatch: "allow" })).toEqual({
			effect: "allow",
		});
		expect(parseDispatchPolicyLayer({ dispatch: "deny" })).toEqual({
			effect: "deny",
		});
	});

	it("maps autoDispatch and requiresApproval flags", () => {
		expect(parseDispatchPolicyLayer({ autoDispatch: true })).toEqual({
			effect: "allow",
		});
		expect(parseDispatchPolicyLayer({ autoDispatch: false })).toEqual({
			effect: "deny",
		});
		expect(parseDispatchPolicyLayer({ requiresApproval: true })).toEqual({
			effect: "deny",
		});
		expect(parseDispatchPolicyLayer({ requiresApproval: false })).toEqual({
			effect: "allow",
		});
	});

	it("carries a trimmed reason when present", () => {
		expect(
			parseDispatchPolicyLayer({ dispatch: "deny", reason: "  muted  " }),
		).toEqual({
			effect: "deny",
			reason: "muted",
		});
	});

	it("parses an exact earned-delegation rollout without changing dispatch policy", () => {
		expect(
			parseDispatchPolicyLayer({
				earnedDelegation: {
					mode: "enforce",
					activityIds: [" activity-1 ", "activity-1"],
					tediIds: ["tedi-cmo"],
					environments: ["production"],
				},
			}),
		).toEqual({
			earnedDelegation: {
				mode: "enforce",
				activityIds: ["activity-1"],
				tediIds: ["tedi-cmo"],
				environments: ["production"],
			},
		});
	});

	it("rejects global or malformed enforce rollouts", () => {
		expect(
			parseDispatchPolicyLayer({
				earnedDelegation: { mode: "enforce", activityIds: [] },
			}),
		).toBeNull();
		expect(
			parseDispatchPolicyLayer({
				earnedDelegation: {
					mode: "enforce",
					activityIds: ["activity-1"],
					tediIds: "all",
				},
			}),
		).toBeNull();
	});
});

describe("resolveEarnedDelegationEnforcement", () => {
	const policy = {
		mode: "enforce" as const,
		activityIds: ["activity-1"],
		tediIds: ["tedi-cmo"],
		environments: ["production"],
	};

	it("enrolls a named tedi fail-closed while preserving other tedi and environment boundaries", () => {
		expect(
			resolveEarnedDelegationEnforcement({
				globalMode: "enforce",
				policy,
				activityId: "activity-1",
				tediId: "tedi-cmo",
				environment: "production",
			}),
		).toBe("enforce");
		expect(
			resolveEarnedDelegationEnforcement({
				globalMode: "enforce",
				policy,
				activityId: null,
				tediId: "tedi-cmo",
				environment: "production",
			}),
		).toBe("enforce");
		expect(
			resolveEarnedDelegationEnforcement({
				globalMode: "enforce",
				policy,
				activityId: "other",
				tediId: "tedi-cmo",
				environment: "production",
			}),
		).toBe("enforce");
		for (const input of [
			{ globalMode: "shadow" as const },
			{ tediId: "other" },
			{ environment: "staging" },
			{ policy: null },
		]) {
			expect(
				resolveEarnedDelegationEnforcement({
					globalMode: "enforce",
					policy,
					activityId: "activity-1",
					tediId: "tedi-cmo",
					environment: "production",
					...input,
				}),
			).toBe("shadow");
		}
	});

	it("supports activity-only scoping while still requiring an exact activity", () => {
		const activityOnly = {
			mode: "enforce" as const,
			activityIds: ["activity-1"],
			tediIds: [],
			environments: [],
		};
		for (const [activityId, expected] of [
			["activity-1", "enforce"],
			["other", "shadow"],
			[null, "shadow"],
		] as const) {
			expect(
				resolveEarnedDelegationEnforcement({
					globalMode: "enforce",
					policy: activityOnly,
					activityId,
					tediId: "any-tedi",
					environment: "canary",
				}),
			).toBe(expected);
		}
	});
});

describe("parseDispatchPolicyLayer delegationApprover", () => {
	it("parses a tedi designation on its own (no dispatch effect)", () => {
		expect(
			parseDispatchPolicyLayer({
				delegationApprover: { type: "tedi", id: " tedi-cto " },
			}),
		).toEqual({ delegationApprover: { type: "tedi", id: "tedi-cto" } });
	});

	it("keeps the designation alongside an explicit effect", () => {
		expect(
			parseDispatchPolicyLayer({
				dispatch: "deny",
				delegationApprover: { type: "tedi", id: "tedi-cto" },
			}),
		).toEqual({
			effect: "deny",
			delegationApprover: { type: "tedi", id: "tedi-cto" },
		});
	});

	it.each([
		["a user designation", { type: "user", id: "user-1" }],
		["an empty id", { type: "tedi", id: "  " }],
		["a non-string id", { type: "tedi", id: 7 }],
		["a bare string", "tedi-cto"],
		["an array", [{ type: "tedi", id: "tedi-cto" }]],
	])("ignores %s", (_label, delegationApprover) => {
		expect(parseDispatchPolicyLayer({ delegationApprover })).toBeNull();
	});
});
