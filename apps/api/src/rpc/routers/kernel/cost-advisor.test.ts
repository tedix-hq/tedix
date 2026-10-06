/**
 * Tests for the kernel per-turn cost advisor (cost-advisor.ts).
 *
 * Verifies:
 *   - tier derivation from effortClass + confidence
 *   - advise mode records a verdict without altering the model
 *   - off mode produces no verdict
 *   - fail-open: null route → no verdict
 *   - readCostAdvisorMode reads the env flag correctly
 */

import { describe, expect, it } from "vite-plus/test";
import {
	adviseTurnCost,
	type CostAdvisorVerdict,
	readCostAdvisorMode,
} from "./cost-advisor";
import type { KernelRouteDecision } from "./route-schema";

// Minimal route stub — only the fields the advisor reads.
function route(
	effortClass: KernelRouteDecision["effortClass"],
	confidence: number,
): Pick<KernelRouteDecision, "effortClass" | "confidence"> {
	return { effortClass, confidence };
}

describe("readCostAdvisorMode", () => {
	it("returns off for absent env key", () => {
		expect(readCostAdvisorMode({})).toBe("off");
	});

	it("returns off for unrecognised value", () => {
		expect(readCostAdvisorMode({ KERNEL_COST_ADVISOR_MODE: "unknown" })).toBe(
			"off",
		);
	});

	it("returns advise when set to advise", () => {
		expect(readCostAdvisorMode({ KERNEL_COST_ADVISOR_MODE: "advise" })).toBe(
			"advise",
		);
	});

	it("returns optimize when set to optimize", () => {
		expect(readCostAdvisorMode({ KERNEL_COST_ADVISOR_MODE: "optimize" })).toBe(
			"optimize",
		);
	});
});

describe("adviseTurnCost — off mode", () => {
	it("returns null when mode is off, even with a valid route", () => {
		const verdict = adviseTurnCost({
			mode: "off",
			route: route("single_read", 0.9),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict).toBeNull();
	});
});

describe("adviseTurnCost — null route", () => {
	it("returns null when route is null (planner fell back)", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: null,
			currentModelDeployment: "gpt-5",
		});
		expect(verdict).toBeNull();
	});
});

describe("adviseTurnCost — null effortClass", () => {
	it("returns null for ask_human routes where effortClass is null", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route(null, 0.7),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict).toBeNull();
	});
});

describe("adviseTurnCost — tier derivation", () => {
	it("maps single_read → cheap", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.95),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("cheap");
	});

	it("maps multi_hop_read with high confidence → medium", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("multi_hop_read", 0.8),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("medium");
	});

	it("maps multi_hop_read at confidence boundary 0.45 → medium", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("multi_hop_read", 0.45),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("medium");
	});

	it("maps multi_hop_read with low confidence (< 0.45) → expensive", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("multi_hop_read", 0.44),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("expensive");
	});

	it("maps fan_out → expensive", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("fan_out", 0.9),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("expensive");
	});

	it("maps embodied → expensive", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("embodied", 0.85),
			currentModelDeployment: "gpt-5",
		});
		expect(verdict?.tier).toBe("expensive");
	});
});

describe("adviseTurnCost — advise mode invariants", () => {
	it("never sets applied=true in advise mode", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.9),
			currentModelDeployment: "gpt-5",
		}) as CostAdvisorVerdict;
		expect(verdict.applied).toBe(false);
	});

	it("records the effortClass and confidence on the verdict", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("multi_hop_read", 0.72),
			currentModelDeployment: "gpt-5",
		}) as CostAdvisorVerdict;
		expect(verdict.effortClass).toBe("multi_hop_read");
		expect(verdict.confidence).toBeCloseTo(0.72);
	});

	it("records the mode on the verdict", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.9),
			currentModelDeployment: "gpt-5",
		}) as CostAdvisorVerdict;
		expect(verdict.mode).toBe("advise");
	});

	it("records the currentModelDeployment as suggestedModel", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.9),
			currentModelDeployment: "gpt-5-deployment",
		}) as CostAdvisorVerdict;
		expect(verdict.suggestedModel).toBe("gpt-5-deployment");
	});

	it("records suggestedModel as null when no deployment is configured", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.9),
			currentModelDeployment: null,
		}) as CostAdvisorVerdict;
		expect(verdict.suggestedModel).toBeNull();
	});

	it("does not alter the model in any way (returns a verdict, not a model swap)", () => {
		// The verdict describes what WOULD have happened; the model selection is
		// unchanged. We verify the verdict is pure metadata — no side effects on
		// the route or model object.
		const inputRoute = route("fan_out", 0.88);
		const originalEffortClass = inputRoute.effortClass;
		adviseTurnCost({
			mode: "advise",
			route: inputRoute,
			currentModelDeployment: "gpt-5",
		});
		// Route object must be untouched.
		expect(inputRoute.effortClass).toBe(originalEffortClass);
	});
});

describe("adviseTurnCost — optimize mode behaves like advise (applied=false)", () => {
	it("records a verdict in optimize mode but applied is still false", () => {
		const verdict = adviseTurnCost({
			mode: "optimize",
			route: route("single_read", 0.9),
			currentModelDeployment: "gpt-5",
		}) as CostAdvisorVerdict;
		// TODO: when optimize mode is implemented, this will need updating.
		expect(verdict.applied).toBe(false);
		expect(verdict.mode).toBe("optimize");
	});
});

describe("adviseTurnCost — rationale field", () => {
	it("includes a non-empty rationale string", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("single_read", 0.9),
			currentModelDeployment: null,
		}) as CostAdvisorVerdict;
		expect(typeof verdict.rationale).toBe("string");
		expect(verdict.rationale.length).toBeGreaterThan(0);
	});

	it("mentions the confidence bump in the rationale when it applies", () => {
		const verdict = adviseTurnCost({
			mode: "advise",
			route: route("multi_hop_read", 0.1),
			currentModelDeployment: null,
		}) as CostAdvisorVerdict;
		expect(verdict.rationale).toContain("low confidence");
	});
});
