import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import {
	JevSettingsSchema,
	parseJevSettings,
} from "@tedix/api-contract/schemas/jev";
import type { JevAnswer } from "@tedix/workers-ai/jev";
import type { DbClient } from "@tedix/db/client";
import type { KernelContext } from "./context-assembly";
import type { KernelEnv, SelectedKernelModel } from "./llm";
import { HOME_ROUTE_KINDS } from "./route-schema";
import {
	choiceProbability,
	resolveRouteChoice,
	decideHomeRoute,
	type RouteDecisionObservation,
	type RouteChoice,
} from "./route-decision";
import { routeDetailsSchema } from "./route-decision-writer";
import { planKernelRoute } from "./route-planner";
import { executeJevJudgment } from "../../../services/jev-judgment";
vi.mock("../../../services/jev-judgment", () => ({
	executeJevJudgment: vi.fn(),
}));
const context: KernelContext = {
	tedis: [
		{ id: "tedi-orion", slug: "orion", name: "Orion", role: "engineering" },
	],
	apps: [{ slug: "github", name: "GitHub" }],
	workflows: [{ slug: "weekly-brief", title: "Weekly brief" }],
	facts: [],
	workItems: [],
	rationale: [],
	speaker: null,
	history: [],
};
const policy = JevSettingsSchema.parse({}).purposes.homeRoute;
const choice: RouteChoice = {
	routeKind: "answer_in_home",
	targetTediId: null,
	targetTediLabel: null,
	confidence: 0.94,
};
function distribution(
	selected: string,
	options: readonly string[],
	p = 0.94,
): JevAnswer {
	return {
		type: "choice",
		choice: selected,
		confidence: p,
		probabilities: Object.fromEntries(
			options.map((key) => [
				key,
				key === selected ? p : (1 - p) / (options.length - 1),
			]),
		),
	};
}
function observation(
	overrides: Partial<RouteDecisionObservation> = {},
): RouteDecisionObservation {
	return {
		version: 1,
		mode: "shadow",
		model: policy.model,
		threshold: 0.85,
		shadowTurns: 100,
		latencyMs: 12,
		status: "selected",
		choice,
		probabilities: {},
		targetProbabilities: {},
		executionIds: [],
		applied: false,
		routeAgreement: null,
		targetAgreement: null,
		...overrides,
	};
}
function selected(model: MockLanguageModelV3): SelectedKernelModel {
	return {
		model,
		pricingIdentity: null,
		attempts: [],
		forOperation: () => selected(model),
	};
}
function writer(value: unknown) {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			warnings: [],
			content: [{ type: "text", text: JSON.stringify(value) }],
		}),
	});
}
beforeEach(() => vi.clearAllMocks());
describe("route choice probabilities and policy", () => {
	it("defaults to shadow and requires explicit enforcement", () => {
		expect(policy).toMatchObject({
			mode: "shadow",
			minConfidence: 0.85,
			shadowTurns: 100,
		});
		expect(
			parseJevSettings({
				jev: {
					purposes: { homeRoute: { mode: "enforce", minConfidence: 0.9 } },
				},
			}).purposes.homeRoute.mode,
		).toBe("enforce");
		expect(
			parseJevSettings({
				jev: { purposes: { homeRoute: { minConfidence: 1.1 } } },
			}).enabled,
		).toBe(false);
	});
	it.each([
		{
			type: "choice",
			choice: "answer_in_home",
			confidence: 1,
			probabilities: { answer_in_home: 1 },
		},
		{ type: "choice", choice: "unknown", confidence: 1, probabilities: {} },
		{ ...distribution("answer_in_home", HOME_ROUTE_KINDS), confidence: NaN },
		{
			...distribution("answer_in_home", HOME_ROUTE_KINDS),
			probabilities: Object.fromEntries(HOME_ROUTE_KINDS.map((k) => [k, 0.9])),
		},
	])("rejects malformed distributions %#", (answer) => {
		expect(
			choiceProbability(answer as JevAnswer, [...HOME_ROUTE_KINDS]),
		).toBeNull();
	});
	it("requires probabilities for the current live target set", () => {
		const answers = {
			route: distribution("delegate_tedi", HOME_ROUTE_KINDS),
			target: distribution("t0", ["NONE", "t0"], 0.7),
		};
		expect(resolveRouteChoice(answers, context)).toMatchObject({
			targetTediId: "tedi-orion",
			confidence: 0.7,
		});
		expect(resolveRouteChoice(answers, { ...context, tedis: [] })).toBeNull();
		expect(
			resolveRouteChoice(answers, { ...context, delegationAvailable: false }),
		).toBeNull();
	});
	it("bounds the governed wrapper while holding accounting alive", async () => {
		let finish!: (value: null) => void;
		vi.mocked(executeJevJudgment).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const held: Promise<void>[] = [];
		const result = await decideHomeRoute({
			db: {} as DbClient,
			env: { AI: {} } as KernelEnv,
			gatewayContext: { organizationId: "org-fiction" },
			content: "Hello",
			context,
			policy: { ...policy, timeoutMs: 10 },
			hold: (work) => held.push(work),
		});
		expect(result.status).toBe("timeout");
		expect(held).toHaveLength(1);
		expect(
			vi.mocked(executeJevJudgment).mock.calls[0]![0].signal?.aborted,
		).toBe(true);
		finish(null);
		await held[0];
	});
	it("skips images without a text-only judgment", async () => {
		const result = await decideHomeRoute({
			db: {} as DbClient,
			env: { AI: {} } as KernelEnv,
			gatewayContext: { organizationId: "org-fiction" },
			content: "See image",
			context,
			policy,
			ineligible: true,
		});
		expect(result.status).toBe("ineligible");
		expect(executeJevJudgment).not.toHaveBeenCalled();
	});
});
describe("two-step route integration", () => {
	it("shadows without changing the old router's verdict", async () => {
		const result = await planKernelRoute({
			content: "Which one?",
			context,
			model: selected(
				writer({
					routeKind: "ask_human",
					answer: null,
					confidence: 0.7,
					details: {
						rationale: "Ambiguous",
						risk: "low",
						effortClass: null,
						clarifyingQuestion: "Which report?",
					},
				}),
			),
			decisionMode: "shadow",
			decisionModel: async () => observation(),
		});
		expect(result?.routeKind).toBe("ask_human");
		expect(result?.routeDecision).toMatchObject({
			applied: false,
			routeAgreement: false,
			latencyMs: 12,
		});
	});
	it("keeps the old router below threshold", async () => {
		const result = await planKernelRoute({
			content: "Hello",
			context,
			model: selected(
				writer({
					routeKind: "answer_in_home",
					answer: "Hello",
					confidence: 0.6,
					details: null,
				}),
			),
			decisionMode: "enforce",
			decisionModel: async () =>
				observation({
					status: "uncertain",
					choice: { ...choice, confidence: 0.8 },
				}),
		});
		expect(result?.confidence).toBe(0.6);
		expect(result?.routeDecision?.applied).toBe(false);
	});
	it("streams an answer without generated route fields", async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						{ type: "text-start", id: "a" },
						{ type: "text-delta", id: "a", delta: '{"answer":"Hello Orion."}' },
						{ type: "text-end", id: "a" },
						{
							type: "finish",
							finishReason: "stop",
							usage: { inputTokens: 10, outputTokens: 5 },
						},
					],
				}),
				warnings: [],
			}),
		});
		const deltas: string[] = [];
		const result = await planKernelRoute({
			content: "Hello",
			context,
			model: selected(model),
			onAnswerDelta: (d) => deltas.push(d),
			decisionMode: "enforce",
			decisionModel: async () => observation(),
		});
		expect(result?.answer).toBe("Hello Orion.");
		expect(result?.confidence).toBe(0.94);
		expect(deltas.join("")).toBe("Hello Orion.");
		expect(result?.routeDecision?.applied).toBe(true);
	});
	it("locks the chosen target against writer overrides", async () => {
		const chosen = {
			...choice,
			routeKind: "delegate_tedi" as const,
			targetTediId: "tedi-orion",
			targetTediLabel: "Orion",
		};
		const result = await planKernelRoute({
			content: "Ask Orion to read GitHub commits",
			context,
			model: selected(
				writer({
					routeKind: "answer_in_home",
					targetTediId: "tedi-other",
					rationale: "Read commits",
					risk: "medium",
					effortClass: "single_read",
					evidenceExpectation: "Citations",
					targetActivityId: null,
					plannedToolIds: [],
				}),
			),
			decisionMode: "enforce",
			decisionModel: async () => observation({ choice: chosen }),
		});
		expect(result).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "tedi-orion",
			confidence: 0.94,
		});
	});
	it("fails closed on invalid action details without the routing-trouble notice", async () => {
		const chosen = {
			...choice,
			routeKind: "delegate_tedi" as const,
			targetTediId: "tedi-orion",
			targetTediLabel: "Orion",
		};
		const result = await planKernelRoute({
			content: "Ask Orion to read GitHub commits",
			context,
			model: selected(writer({ garbage: true })),
			decisionMode: "enforce",
			decisionModel: async () => observation({ choice: chosen }),
		});
		expect(result).toMatchObject({
			routeKind: "ask_human",
			confidence: 0.94,
			targetTediId: null,
			plannedToolIds: [],
			recovery: "invalid_route_details",
		});
		expect(result?.routeDecision?.writerFailed).toBe(true);
		expect(result?.answer ?? "").not.toContain("Routing had trouble");
	});
	it("preserves provider failures", async () => {
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				throw new Error("provider offline");
			},
		});
		await expect(
			planKernelRoute({
				content: "Hello",
				context,
				model: selected(model),
				decisionMode: "enforce",
				decisionModel: async () => observation(),
			}),
		).rejects.toThrow("provider offline");
	});
});
// First two cases preserve the approval-stage Work creation shape of recorded
// failed turns; names, projects and requested work are fictional. Remaining
// cases extend coverage. Supplied judgments do not measure semantic accuracy.
const replay = [
	{
		text: "Stage one work_items.create for approval. Project: 11111111-1111-4111-8111-111111111111. Title: Improve Acme launch summaries. Description: Every summary should state the decision and consequence. Done when: most summaries can be understood without opening the source.",
		routeKind: "propose_tool_write",
		details: {
			rationale: "Stage requested Work creation for approval",
			risk: "medium",
			effortClass: "single_read",
			evidenceExpectation: "One Work creation proposal",
			toolIntent: {
				appSlug: "tedix",
				capability: "work_items.create",
				connectionStatus: "connected",
			},
		},
	},
	{
		text: "Stage one work_items.create for approval. Project: 22222222-2222-4222-8222-222222222222. Title: Show Acme research suggestions in the main feed. Description: Existing research suggestions are visible only in the workspace app. Done when: pending suggestions appear in the main feed and workspace review still works.",
		routeKind: "propose_tool_write",
		details: {
			rationale: "Stage requested Work creation for approval",
			risk: "medium",
			effortClass: "single_read",
			evidenceExpectation: "One Work creation proposal",
			toolIntent: {
				appSlug: "tedix",
				capability: "work_items.create",
				connectionStatus: "connected",
			},
		},
	},
	{
		text: "How many accepted work items does Acme have?",
		routeKind: "answer_in_home",
		details: { answer: "No accepted items in this snapshot." },
	},
	{
		text: "Ask Orion to read Acme's latest repository commits",
		routeKind: "delegate_tedi",
		details: {
			rationale: "Orion owns GitHub",
			risk: "medium",
			effortClass: "single_read",
			evidenceExpectation: "Cited commits",
			targetActivityId: null,
			plannedToolIds: [],
		},
	},
	{
		text: "Create an Acme launch draft",
		routeKind: "propose_tool_write",
		details: {
			rationale: "Create requested draft",
			risk: "medium",
			effortClass: "single_read",
			evidenceExpectation: "Draft document",
			toolIntent: {
				appSlug: "documents",
				capability: "documents.create",
				connectionStatus: "connected",
			},
		},
	},
	{
		text: "Run weekly-brief",
		routeKind: "run_workflow",
		details: {
			rationale: "Exact listed workflow",
			risk: "medium",
			effortClass: "multi_hop_read",
			evidenceExpectation: "Weekly brief",
			workflowHint: "weekly-brief",
		},
	},
	{
		text: "Fix that",
		routeKind: "ask_human",
		details: {
			rationale: "Missing referent",
			risk: "low",
			effortClass: null,
			evidenceExpectation: null,
			clarifyingQuestion: "Which draft?",
		},
	},
	{
		text: "Open an extended specialist session with Orion",
		routeKind: "suggest_handoff",
		details: {
			rationale: "Human-driven session",
			risk: "low",
			effortClass: "multi_hop_read",
			evidenceExpectation: null,
			answer: "Continue with Orion for the review.",
		},
	},
] as const;
it.each(replay)("fictional Home replay: $routeKind", async (entry) => {
	const chosen: RouteChoice = {
		...choice,
		routeKind: entry.routeKind,
		...(["delegate_tedi", "suggest_handoff"].includes(entry.routeKind)
			? { targetTediId: "tedi-orion", targetTediLabel: "Orion" }
			: {}),
	};
	const result = await planKernelRoute({
		content: entry.text,
		context,
		model: selected(writer(entry.details)),
		decisionMode: "enforce",
		decisionModel: async () => observation({ choice: chosen }),
	});
	expect(result?.routeKind).toBe(entry.routeKind);
	expect(result?.confidence).toBe(0.94);
	const schema = routeDetailsSchema(chosen).jsonSchema as {
		properties: Record<string, unknown>;
	};
	expect(schema.properties).not.toHaveProperty("routeKind");
	expect(schema.properties).not.toHaveProperty("confidence");
	expect(schema.properties).not.toHaveProperty("targetTediId");
});
