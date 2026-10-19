import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vite-plus/test";
import { tracedAi } from "../../../lib/traced-ai";
import { kernelRouteGenerationSchema } from "./route-generation";

async function generate(value: unknown) {
	return (
		await tracedAi.generateObject({
			model: new MockLanguageModelV3({
				doGenerate: async () => ({
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [{ type: "text", text: JSON.stringify(value) }],
				}),
			}),
			schema: kernelRouteGenerationSchema,
			prompt: "Route the request.",
			maxRetries: 0,
		})
	).object;
}

const details = {
	rationale: "The clerk owns the requested provider read.",
	risk: "medium",
	effortClass: "single_read",
	targetTediId: "11111111-1111-4111-8111-111111111111",
	targetTediLabel: "Archive clerk",
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: "A cited provider read.",
};

describe("compact route generation", () => {
	it("expands a direct answer without inventing action parameters", async () => {
		const decision = await generate({
			routeKind: "answer_in_home",
			answer: "102",
			confidence: 0.9,
			details: null,
		});
		expect(decision).toMatchObject({
			routeKind: "answer_in_home",
			answer: "102",
			confidence: 0.9,
			risk: "low",
			effortClass: "single_read",
			plannedToolIds: [],
			targetTediId: null,
			toolIntent: null,
			workflowHint: null,
		});
	});

	it.each([false, true])(
		"accepts omitted nullable action fields (compact=%s)",
		async (compact) => {
			const action = {
				rationale: "The operator requested a bounded work item proposal.",
				risk: "medium",
				toolIntent: {
					capability: "work_items.create",
					appSlug: "fictional-work",
				},
			};
			const route = { routeKind: "propose_tool_write", confidence: 0.9 };
			const decision = await generate(
				compact ? { ...route, details: action } : { ...route, ...action },
			);
			expect(decision).toMatchObject({
				...route,
				answer: null,
				targetTediId: null,
				plannedToolIds: [],
				toolIntent: { ...action.toolIntent, connectionStatus: null },
			});
		},
	);

	it("preserves all supplied delegation parameters", async () => {
		const decision = await generate({
			routeKind: "delegate_tedi",
			answer: null,
			confidence: 0.85,
			details,
		});
		expect(decision).toEqual({
			routeKind: "delegate_tedi",
			answer: null,
			confidence: 0.85,
			...details,
		});
	});

	it.each([
		"delegate_tedi",
		"propose_tool_write",
		"run_workflow",
		"suggest_handoff",
		"ask_human",
	])("refuses missing details for %s", async (routeKind) => {
		await expect(
			generate({ routeKind, answer: null, confidence: 0.9, details: null }),
		).rejects.toThrow();
	});

	it("does not let nested fields change the streamed route", async () => {
		const decision = await generate({
			routeKind: "delegate_tedi",
			answer: null,
			confidence: 0.85,
			details: { ...details, routeKind: "answer_in_home" },
		});
		expect(decision.routeKind).toBe("delegate_tedi");
	});

	it("rejects malformed action metadata", async () => {
		await expect(
			generate({
				routeKind: "delegate_tedi",
				answer: null,
				confidence: 0.85,
				details: { ...details, plannedToolIds: "all" },
			}),
		).rejects.toThrow();
	});
});
