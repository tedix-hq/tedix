import type { SelectedKernelModel } from "../../src/rpc/routers/kernel/llm";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vite-plus/test";
import { planKernelRoute } from "../../src/rpc/routers/kernel/route-planner";
import { normalizeRouteDecisionCandidate } from "../../src/rpc/routers/kernel/route-schema";
import { finalizeKernelRouteDecision } from "../../src/rpc/routers/kernel/index";
import { ROUTE_CONTRACT_FIXTURES } from "./route-contract-fixtures";

// A failed generation trips shared provider state; each case starts independently.

function objectModel(object: unknown): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			// Fill additive optional fields using the production normalization seam.
			content: [
				{
					type: "text",
					text: JSON.stringify(normalizeRouteDecisionCandidate(object)),
				},
			],
		}),
	});
}

function throwingModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async () => {
			throw new Error("Simulated upstream failure — fail-soft test");
		},
	});
}

describe("kernel route contract with supplied model output", () => {
	it.each(ROUTE_CONTRACT_FIXTURES)("$name", async (fixture) => {
		const model =
			fixture.modelFailure === "throws"
				? throwingModel()
				: fixture.modelFailure === "absent"
					? null
					: objectModel(fixture.modelOutput);
		// Only the explicit failure fixture expects rejection.
		const pending = planKernelRoute({
			content: fixture.userText,
			context: fixture.context,
			model: model
				? ({
						model,
						pricingIdentity: null,
						attempts: [],
						forOperation() {
							return { ...this, attempts: [] };
						},
					} as SelectedKernelModel)
				: null,
		});
		if (fixture.modelFailure === "throws") {
			await expect(pending).rejects.toThrow("Simulated upstream failure");
			return;
		}
		const result = await pending;
		const { isNull, hasRouterVersion, clarifyingQuestion, ...expected } =
			fixture.expected;
		if (isNull) {
			expect(result).toBeNull();
			return;
		}
		expect(result).not.toBeNull();
		expect(result).toMatchObject(expected);
		if ("clarifyingQuestion" in fixture.expected) {
			expect(result?.clarifyingQuestion != null).toBe(
				clarifyingQuestion != null,
			);
		}
		if (hasRouterVersion)
			expect(result?.routerVersion).toMatch(/^[0-9a-f]{12}$/);
		if (model) expect(model.doGenerateCalls).toHaveLength(1);
	});
});

it("final routing cannot restore a forbidden parked delegation", () => {
	const fixture = ROUTE_CONTRACT_FIXTURES.find(
		(f) => f.name === "acknowledgment-only-overrides-delegate",
	)!;
	const route = finalizeKernelRouteDecision(
		{ ...fixture.modelOutput!, routeKind: "answer_in_home" },
		"Acknowledge only. Prepare a CTO delegation work order; park for approval first.",
		fixture.context.tedis,
	);
	expect(route).toMatchObject({
		routeKind: "answer_in_home",
		answer: "Acknowledged.",
		targetTediId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
	});
});
