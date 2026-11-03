import { describe, expect, it } from "vite-plus/test";
import {
	assertVertexBudgetAllowed,
	assertVertexRequestSize,
	evaluateVertexDailyBudget,
	VERTEX_DAILY_BUDGET_USD,
	VERTEX_DAILY_REQUEST_CAP,
	VERTEX_MAX_REQUEST_BYTES,
	utcDayStartIso,
	VertexGovernanceError,
	vertexBudgetExceededSignal,
	vertexModelFromPath,
	vertexUsageTokens,
} from "./vertex-governance";

const totals = (
	over: Partial<Parameters<typeof evaluateVertexDailyBudget>[0]>,
) => ({
	callCount: 0,
	totalTokens: 0,
	knownCostUsd: 0,
	quarantinedCalls: 0,
	...over,
});

describe("evaluateVertexDailyBudget", () => {
	it("allows an empty window", () => {
		expect(evaluateVertexDailyBudget(totals({}))).toEqual({ allowed: true });
	});

	it("refuses once the priced daily budget is recorded", () => {
		const verdict = evaluateVertexDailyBudget(
			totals({ knownCostUsd: VERTEX_DAILY_BUDGET_USD, callCount: 3 }),
		);
		expect(verdict.allowed).toBe(false);
		expect(assertVertexBudgetAllowed.bind(null, verdict)).toThrow(
			/daily budget recorded/,
		);
	});

	it("refuses once the daily request cap is reached, even unpriced", () => {
		const verdict = evaluateVertexDailyBudget(
			totals({ callCount: VERTEX_DAILY_REQUEST_CAP }),
		);
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toBe("daily_request_cap");
	});

	it("keeps the budget check first when both limits trip", () => {
		const verdict = evaluateVertexDailyBudget(
			totals({
				knownCostUsd: VERTEX_DAILY_BUDGET_USD + 1,
				callCount: VERTEX_DAILY_REQUEST_CAP + 1,
			}),
		);
		if (!verdict.allowed) expect(verdict.reason).toBe("daily_budget_usd");
	});
});

describe("assertVertexRequestSize", () => {
	it("accepts a body at the cap and rejects above it", () => {
		expect(() =>
			assertVertexRequestSize(VERTEX_MAX_REQUEST_BYTES),
		).not.toThrow();
		expect(() =>
			assertVertexRequestSize(VERTEX_MAX_REQUEST_BYTES + 1),
		).toThrowError(VertexGovernanceError);
	});

	it("rejects an unmeasurable body", () => {
		expect(() => assertVertexRequestSize(Number.NaN)).toThrow(
			/VERTEX_REQUEST_UNMEASURABLE/,
		);
	});
});

describe("signal and helpers", () => {
	it("emits a structured budget-exceeded signal", () => {
		const verdict = evaluateVertexDailyBudget(
			totals({ callCount: VERTEX_DAILY_REQUEST_CAP }),
		);
		const parsed = JSON.parse(vertexBudgetExceededSignal("test", verdict));
		expect(parsed.signal).toBe("vertex.budget.exceeded");
		expect(parsed.reason).toBe("daily_request_cap");
	});

	it("anchors the budget window at UTC midnight", () => {
		expect(utcDayStartIso(new Date("2026-11-03T19:20:00Z"))).toBe(
			"2026-11-03T00:00:00.000Z",
		);
	});

	it("reads Gemini usageMetadata defensively", () => {
		expect(
			vertexUsageTokens({
				promptTokenCount: 12,
				candidatesTokenCount: 1290,
				totalTokenCount: 1302,
			}),
		).toEqual({ inputTokens: 12, outputTokens: 1290, totalTokens: 1302 });
		expect(vertexUsageTokens("nope")).toEqual({
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
		});
	});

	it("extracts the model segment from Vertex paths only", () => {
		expect(
			vertexModelFromPath(
				"/v1/projects/p/locations/l/publishers/google/models/veo-3.1-generate-preview",
			),
		).toBe("veo-3.1-generate-preview");
		expect(
			vertexModelFromPath(
				"/v1/publishers/google/models/gemini-2.5-pro:generateContent",
			),
		).toBe("gemini-2.5-pro");
		expect(vertexModelFromPath("/v1/x")).toBeNull();
	});
});
