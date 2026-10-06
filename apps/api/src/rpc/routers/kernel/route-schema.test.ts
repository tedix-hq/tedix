import { describe, expect, it } from "vite-plus/test";
import {
	HOME_EFFORT_CLASSES,
	HOME_ROUTE_KINDS,
	type KernelRouteDecision,
	KernelRouteDecisionSchema,
	normalizeRouteDecisionCandidate,
} from "./route-schema";

/**
 * Every field is REQUIRED (Azure/OpenAI strict structured output); unused
 * route-specific fields are explicitly `null`. This helper builds a complete
 * decision so fixtures stay readable while matching the strict shape.
 */
function decision(
	overrides: Partial<KernelRouteDecision> &
		Pick<KernelRouteDecision, "routeKind">,
): KernelRouteDecision {
	return {
		rationale: "grounded rationale referencing the assembled context",
		risk: "low",
		confidence: 0.8,
		effortClass: "single_read",
		answer: null,
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

const REPRESENTATIVE_BY_KIND: Record<
	(typeof HOME_ROUTE_KINDS)[number],
	KernelRouteDecision
> = {
	answer_in_home: decision({
		routeKind: "answer_in_home",
		answer: "You have two active work items in progress.",
	}),
	propose_tool_write: decision({
		routeKind: "propose_tool_write",
		risk: "high",
		confidence: 0.6,
		toolIntent: {
			appSlug: "globex",
			capability: "globex.invoices.create",
			connectionStatus: "unknown",
		},
	}),
	delegate_tedi: decision({
		routeKind: "delegate_tedi",
		risk: "medium",
		effortClass: "fan_out",
		targetTediId: "tedi-cpo",
		targetTediLabel: "CPO",
		targetActivityId: "activity-market-research",
		plannedToolIds: ["market_tedix.search"],
	}),
	suggest_handoff: decision({
		routeKind: "suggest_handoff",
		risk: "medium",
		effortClass: "embodied",
		targetTediId: "tedi-cto",
		targetTediLabel: "CTO",
		answer:
			"This looks like a long pairing session — open a direct session with the CTO tedi.",
	}),
	run_workflow: decision({
		routeKind: "run_workflow",
		risk: "medium",
		effortClass: "multi_hop_read",
		workflowHint: "customer-onboarding",
		evidenceExpectation: "provision the tenant and seed the default app",
	}),
	ask_human: decision({
		routeKind: "ask_human",
		confidence: 0.3,
		effortClass: null,
		clarifyingQuestion: "Which app did you mean — gmail or outlook?",
	}),
};

describe("KernelRouteDecisionSchema", () => {
	it("keeps answer directly after routeKind for single-pass streaming latency", () => {
		expect(Object.keys(KernelRouteDecisionSchema.shape).slice(0, 2)).toEqual([
			"routeKind",
			"answer",
		]);
	});

	it("exposes all six route kinds", () => {
		expect([...HOME_ROUTE_KINDS]).toEqual([
			"answer_in_home",
			"propose_tool_write",
			"delegate_tedi",
			"suggest_handoff",
			"run_workflow",
			"ask_human",
		]);
	});

	it("exposes the four effort classes", () => {
		expect([...HOME_EFFORT_CLASSES]).toEqual([
			"single_read",
			"multi_hop_read",
			"fan_out",
			"embodied",
		]);
	});

	for (const routeKind of HOME_ROUTE_KINDS) {
		it(`accepts a representative ${routeKind} decision`, () => {
			const parsed = KernelRouteDecisionSchema.safeParse(
				REPRESENTATIVE_BY_KIND[routeKind],
			);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.routeKind).toBe(routeKind);
			}
		});
	}

	it("rejects an invalid routeKind", () => {
		const parsed = KernelRouteDecisionSchema.safeParse({
			...REPRESENTATIVE_BY_KIND.answer_in_home,
			routeKind: "do_the_thing",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a missing rationale", () => {
		const { rationale: _rationale, ...withoutRationale } =
			REPRESENTATIVE_BY_KIND.answer_in_home;
		const parsed = KernelRouteDecisionSchema.safeParse(withoutRationale);
		expect(parsed.success).toBe(false);
	});

	it("rejects an invalid connectionStatus on toolIntent", () => {
		const parsed = KernelRouteDecisionSchema.safeParse({
			...REPRESENTATIVE_BY_KIND.propose_tool_write,
			toolIntent: {
				appSlug: "gmail",
				capability: "gmail.read",
				connectionStatus: "maybe",
			},
		});
		expect(parsed.success).toBe(false);
	});

	it("requires every field to be present, even when null (Azure strict)", () => {
		// Omitting a nullable field must fail — strict structured output needs
		// every property in `required`.
		const { toolIntent: _toolIntent, ...withoutToolIntent } =
			REPRESENTATIVE_BY_KIND.propose_tool_write;
		const parsed = KernelRouteDecisionSchema.safeParse(withoutToolIntent);
		expect(parsed.success).toBe(false);
	});

	it("requires the delegate activity and exact planned-tool fields in Azure strict output", () => {
		const { targetActivityId: _activity, ...withoutActivity } =
			REPRESENTATIVE_BY_KIND.delegate_tedi;
		const { plannedToolIds: _tools, ...withoutTools } =
			REPRESENTATIVE_BY_KIND.delegate_tedi;
		expect(KernelRouteDecisionSchema.safeParse(withoutActivity).success).toBe(
			false,
		);
		expect(KernelRouteDecisionSchema.safeParse(withoutTools).success).toBe(
			false,
		);
		expect(REPRESENTATIVE_BY_KIND.delegate_tedi.toolIntent).toBeNull();
	});

	for (const effortClass of HOME_EFFORT_CLASSES) {
		it(`accepts effortClass "${effortClass}"`, () => {
			const parsed = KernelRouteDecisionSchema.safeParse(
				decision({ routeKind: "answer_in_home", answer: "ok", effortClass }),
			);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.effortClass).toBe(effortClass);
			}
		});
	}

	it("accepts a null effortClass (genuinely inapplicable, e.g. ask_human)", () => {
		const parsed = KernelRouteDecisionSchema.safeParse(
			REPRESENTATIVE_BY_KIND.ask_human,
		);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.effortClass).toBeNull();
		}
	});

	it("rejects an invalid effortClass", () => {
		const parsed = KernelRouteDecisionSchema.safeParse({
			...REPRESENTATIVE_BY_KIND.answer_in_home,
			effortClass: "heroic",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a missing effortClass (Azure strict — every property required)", () => {
		const { effortClass: _effortClass, ...withoutEffortClass } =
			REPRESENTATIVE_BY_KIND.answer_in_home;
		const parsed = KernelRouteDecisionSchema.safeParse(withoutEffortClass);
		expect(parsed.success).toBe(false);
	});

	describe("normalizeRouteDecisionCandidate (Workers AI json_object mode)", () => {
		it("fills omitted nullable fields with null so the strict schema accepts them", () => {
			// llama-3.1-8b via json_object omits inapplicable fields entirely —
			// the exact shape observed in the dev-battery schema failures.
			const omittedShape = {
				routeKind: "delegate_tedi",
				rationale: "the CTO owns this domain, so delegate to the CTO tedi",
				risk: "low",
				confidence: 0.9,
				effortClass: "single_read",
				answer: null,
				targetTediId: "tedi-cto",
				targetTediLabel: "CTO",
				// toolIntent, workflowHint, clarifyingQuestion, evidenceExpectation omitted
			};
			expect(KernelRouteDecisionSchema.safeParse(omittedShape).success).toBe(
				false,
			);
			const parsed = KernelRouteDecisionSchema.safeParse(
				normalizeRouteDecisionCandidate(omittedShape),
			);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.toolIntent).toBeNull();
				expect(parsed.data.targetActivityId).toBeNull();
				expect(parsed.data.plannedToolIds).toEqual([]);
				expect(parsed.data.workflowHint).toBeNull();
				expect(parsed.data.clarifyingQuestion).toBeNull();
				expect(parsed.data.evidenceExpectation).toBeNull();
			}
		});

		it("fills omitted nullable fields inside a present toolIntent", () => {
			const parsed = KernelRouteDecisionSchema.safeParse(
				normalizeRouteDecisionCandidate({
					routeKind: "propose_tool_write",
					rationale: "one bounded gmail write requires approval",
					risk: "low",
					confidence: 0.8,
					effortClass: "single_read",
					toolIntent: { appSlug: "gmail" },
				}),
			);
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.toolIntent).toEqual({
					appSlug: "gmail",
					capability: null,
					connectionStatus: null,
				});
			}
		});

		it("leaves complete decisions unchanged", () => {
			const complete = REPRESENTATIVE_BY_KIND.delegate_tedi;
			expect(normalizeRouteDecisionCandidate(complete)).toEqual(complete);
		});

		it("passes non-object values through untouched", () => {
			expect(normalizeRouteDecisionCandidate(null)).toBeNull();
			expect(normalizeRouteDecisionCandidate("prose")).toBe("prose");
			expect(normalizeRouteDecisionCandidate([1])).toEqual([1]);
		});

		it("does not mask genuinely invalid decisions", () => {
			const parsed = KernelRouteDecisionSchema.safeParse(
				normalizeRouteDecisionCandidate({ routeKind: "do_the_thing" }),
			);
			expect(parsed.success).toBe(false);
		});
	});

	it("accepts a suggest_handoff decision carrying target tedi + suggestion", () => {
		const parsed = KernelRouteDecisionSchema.safeParse(
			REPRESENTATIVE_BY_KIND.suggest_handoff,
		);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.routeKind).toBe("suggest_handoff");
			expect(parsed.data.targetTediId).toBe("tedi-cto");
			expect(parsed.data.targetTediLabel).toBe("CTO");
			expect(parsed.data.answer).toContain("direct session");
		}
	});
});
