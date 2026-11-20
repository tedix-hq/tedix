import { describe, expect, it } from "vite-plus/test";
import { guardKernelRouteDecision } from "./delegation-intent";
import type { KernelRouteDecision } from "./route-schema";

function decision(
	overrides: Partial<KernelRouteDecision> = {},
): KernelRouteDecision {
	return {
		routeKind: "delegate_tedi",
		rationale: "CEO owns work items",
		risk: "low",
		confidence: 0.8,
		effortClass: "single_read",
		answer: null,
		targetTediId: "tedi-ceo",
		targetTediLabel: "CEO",
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

describe("undispatched delegation promises", () => {
	it("clears a Home answer that promises a delegation no route dispatches", () => {
		const result = guardKernelRouteDecision(
			decision({
				routeKind: "answer_in_home",
				answer:
					"I'll ask Research to read the document and answer the questions.",
			}),
		);
		expect(result.routeKind).toBe("answer_in_home");
		expect(result.answer).toBeNull();
	});
	it("leaves every other decision untouched", () => {
		const delegate = decision();
		expect(guardKernelRouteDecision(delegate)).toBe(delegate);
		const answer = decision({
			routeKind: "answer_in_home",
			answer: "Research owns that document.",
		});
		expect(guardKernelRouteDecision(answer)).toBe(answer);
	});
});
