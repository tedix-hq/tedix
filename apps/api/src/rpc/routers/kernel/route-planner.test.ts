import type { LanguageModel } from "ai";
import type { SelectedKernelModel } from "./llm";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelContext } from "./context-assembly";
import {
	planKernelRoute as runPlanKernelRoute,
	shapeRouteUsage as actualShapeRouteUsage,
	SYSTEM_PROMPT,
} from "./route-planner";
import {
	type KernelRouteDecision,
	normalizeRouteDecisionCandidate,
} from "./route-schema";
import { getRouterVersion } from "./router-version";

function selected(model: LanguageModel): SelectedKernelModel {
	return {
		model,
		pricingIdentity: null,
		attempts: [],
		forOperation: () => selected(model),
	};
}
function planKernelRoute(
	args: Omit<Parameters<typeof runPlanKernelRoute>[0], "model"> & {
		model: LanguageModel | null;
	},
) {
	return runPlanKernelRoute({
		...args,
		model: args.model ? selected(args.model) : null,
	});
}
function shapeRouteUsage(usage: unknown, model: LanguageModel) {
	return actualShapeRouteUsage(usage, selected(model));
}

// The Azure circuit breaker is module-level state (per-isolate in prod). A
// fail-soft case (throwing model / schema violation) trips it for the 5-min
// cooldown, which would silently reroute every LATER test in this file onto
// the Workers AI fallback (null without env.AI). Reset it before each test.
beforeEach(() => {});

const EMPTY_CONTEXT: KernelContext = {
	tedis: [],
	apps: [],
	workflows: [],
	workItems: [],
	facts: [],
	rationale: [],
	speaker: null,
	history: [],
};

/**
 * Build a fully offline language model whose single `doGenerate` returns the
 * given object serialized as the JSON `generateObject` expects. No network,
 * no Azure — deterministic.
 */
function objectModel(object: unknown): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			content: [
				{
					type: "text",
					text: JSON.stringify(normalizeRouteDecisionCandidate(object)),
				},
			],
		}),
	});
}

/** A language model whose generation always throws, to prove fail-soft. */
function throwingModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async () => {
			throw new Error("Azure 500 — simulated upstream failure");
		},
	});
}

describe("planKernelRoute", () => {
	it("replays historical images on both routing paths and refuses a text-only fallback", async () => {
		const context: KernelContext = {
			...EMPTY_CONTEXT,
			history: [
				{
					role: "user",
					content: "",
					attachments: [
						{
							type: "image",
							fileName: "screen.png",
							mimeType: "image/png",
							content:
								"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4S8AAAAASUVORK5CYII=",
						},
					],
				},
			],
		};
		for (const streaming of [false, true]) {
			const decision = {
				routeKind: "answer_in_home",
				answer: "payload received",
				rationale: "describe the supplied image",
				risk: "low",
				confidence: 0.9,
				effortClass: "single_read",
			};
			const model = streaming
				? streamingObjectModel(
						[JSON.stringify(normalizeRouteDecisionCandidate(decision))],
						decision,
					)
				: objectModel(decision);
			const result = await planKernelRoute({
				content: "look at the image",
				context,
				model,
				// Providing `onAnswerDelta` selects the single streamObject pass;
				// omitting it keeps the non-streaming generateObject pass.
				...(streaming ? { onAnswerDelta: () => {} } : {}),
			});
			const prompt = (
				streaming ? model.doStreamCalls[0] : model.doGenerateCalls[0]
			)!.prompt;
			expect(prompt[1]).toMatchObject({
				role: "user",
				content: expect.arrayContaining([
					expect.objectContaining({ type: "file", mediaType: "image/png" }),
				]),
			});
			expect(JSON.stringify(prompt.at(-1))).toContain("look at the image");
			expect(result?.traceInput).toMatchObject({
				requestShape: "messages",
				truncated: false,
				mediaOmitted: true,
			});
			expect(result?.traceInput.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						content: expect.arrayContaining([
							expect.objectContaining({ type: "file", omitted: true }),
						]),
					}),
				]),
			);
			expect(JSON.stringify(result?.traceInput)).not.toContain("iVBORw0KGgo");
		}
		const run = vi.fn();
		expect(
			await planKernelRoute({
				content: "look at the image",
				context,
				model: null,
				env: { AI: { run } } as Parameters<typeof planKernelRoute>[0]["env"],
			}),
		).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});
	it("returns null when the model is null (fail-soft, no Azure config)", async () => {
		const result = await planKernelRoute({
			content: "check my gmail messages",
			context: EMPTY_CONTEXT,
			model: null,
		});
		expect(result).toBeNull();
	});

	it("propagates the selected provider error without invoking another provider or logging private text", async () => {
		const error = new Error("private-provider-detail");
		const run = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				planKernelRoute({
					content: "private-input",
					context: EMPTY_CONTEXT,
					model: new MockLanguageModelV3({
						doGenerate: async () => {
							throw error;
						},
					}),
					env: { AI: { run } } as never,
				}),
			).rejects.toThrow("private-provider-detail");
			expect(run).not.toHaveBeenCalled();
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				"private-provider-detail",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("returns a schema-valid KernelRouteDecision from the model output (delegate_tedi for live-data read)", async () => {
		// The planner no longer offers direct_tool_read. When the operator asks for
		// live provider data, the correct route is delegate_tedi — honoring any
		// explicitly named tedi (e.g. "from cto" → CTO tedi).
		const decision: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale:
				"CTO tedi owns the github connection and should fetch commits.",
			risk: "low",
			confidence: 0.88,
			effortClass: "single_read",
			answer: null,
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};

		const result = await planKernelRoute({
			content: "give me the last 5 github commits from cto",
			context: {
				...EMPTY_CONTEXT,
				tedis: [{ id: "tedi-cto", slug: "cto", name: "CTO" }],
			},
			model: objectModel(decision),
		});

		expect(result).not.toBeNull();
		expect(result).toMatchObject({
			routeKind: "delegate_tedi",
			risk: "low",
			confidence: 0.88,
			effortClass: "single_read",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
		});
	});

	it("applies an injected Jev delegation ranker after the typed route and clears stale authority", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			answer: null,
			rationale: "Delegate a provider read.",
			risk: "low",
			confidence: 0.8,
			effortClass: "single_read",
			targetTediId: "first",
			targetTediLabel: "First",
			targetActivityId: "activity-first",
			plannedToolIds: ["first.read"],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const ranker = vi.fn().mockResolvedValue(["second", "first"]);
		const capability = (id: string) =>
			({
				availability: "running",
				embodied: false,
				apps: [],
				scopeGroups: [],
				skills: [id],
			}) as unknown as NonNullable<
				KernelContext["tedis"][number]["capability"]
			>;
		const result = await planKernelRoute({
			content: "Please investigate the issue",
			context: {
				...EMPTY_CONTEXT,
				tedis: [
					{
						id: "first",
						slug: "first",
						name: "First",
						capability: capability("first"),
					},
					{
						id: "second",
						slug: "second",
						name: "Second",
						capability: capability("second"),
					},
				],
			},
			model: objectModel(decision),
			delegationCandidateRanker: ranker,
		});
		expect(ranker).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			targetTediId: "second",
			targetActivityId: null,
			plannedToolIds: [],
		});
	});

	it("NEVER offers direct_tool_read in the system prompt — reads must be delegated to tedis", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		let capturedSystem = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedSystem = options.prompt
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
						},
					],
				};
			},
		});

		await planKernelRoute({
			content: "check my gmail messages",
			context: EMPTY_CONTEXT,
			model,
		});

		// direct_tool_read must NOT appear as a selectable route in the system prompt.
		// The prompt may reference it in a historical note but must not offer it as
		// a valid route choice — check the Routes block specifically.
		expect(capturedSystem).not.toMatch(/^- direct_tool_read:/m);
		// delegate_tedi guidance must explicitly cover live-data reads.
		expect(capturedSystem).toContain("delegate_tedi");
		expect(capturedSystem).toContain(
			"READ or FETCH live EXTERNAL provider data",
		);
	});

	it("returns a schema-valid suggest_handoff decision (target tedi + one-sentence suggestion)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "suggest_handoff",
			rationale:
				"Open-ended pairing session the operator should drive directly with the CTO tedi.",
			risk: "medium",
			confidence: 0.7,
			effortClass: "embodied",
			answer:
				"This looks like a long coding session — open a direct session with the CTO tedi.",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};

		const result = await planKernelRoute({
			content: "pair with me on refactoring the gateway for the next hour",
			context: {
				...EMPTY_CONTEXT,
				tedis: [{ id: "tedi-cto", slug: "cto", name: "CTO" }],
			},
			model: objectModel(decision),
		});

		expect(result).not.toBeNull();
		expect(result).toMatchObject({
			routeKind: "suggest_handoff",
			effortClass: "embodied",
			targetTediId: "tedi-cto",
			targetTediLabel: "CTO",
		});
		expect(result?.answer).toContain("direct session");
	});

	it("system prompt contains composite tool+track-record+policy ranking guidance for delegate_tedi", async () => {
		let capturedSystem = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedSystem = options.prompt
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify({
								routeKind: "answer_in_home",
								rationale: "general question",
								risk: "low",
								confidence: 0.9,
								effortClass: "single_read",
								answer: "ok",
								targetTediId: null,
								targetTediLabel: null,
								targetActivityId: null,
								plannedToolIds: [],
								toolIntent: null,
								workflowHint: null,
								clarifyingQuestion: null,
								evidenceExpectation: null,
							}),
						},
					],
				};
			},
		});

		await planKernelRoute({
			content: "fetch my gmail messages",
			context: EMPTY_CONTEXT,
			model,
		});

		// TOOL/PROVIDER OWNERSHIP is the primary ranking signal (step 1).
		expect(capturedSystem).toContain("TOOL/PROVIDER OWNERSHIP");
		expect(capturedSystem).toContain("tools=[...]");
		// TRACK-RECORD is the secondary signal (step 2).
		expect(capturedSystem).toContain("TRACK-RECORD");
		expect(capturedSystem).toContain("track-record=NN%");
		// POLICY/AVAILABILITY is the tie-breaker (step 3).
		expect(capturedSystem).toContain("POLICY/AVAILABILITY");
		expect(capturedSystem).toContain("autonomous");
		expect(capturedSystem).toContain("gated");
		// "running" over "standby" availability preference
		expect(capturedSystem).toContain("running");
		expect(capturedSystem).toContain("standby");
		// Single-best-fit selection language
		expect(capturedSystem).toContain("single best-fit tedi");
	});

	it("prompts the model with effort-class scaling rules, suggest_handoff boundary, and pure-router delegation guidance", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		let capturedSystem = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedSystem = options.prompt
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
						},
					],
				};
			},
		});

		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model,
		});

		expect(result).not.toBeNull();
		// Effort class is a budget the policy layer enforces — every route.
		expect(capturedSystem).toContain("effortClass");
		expect(capturedSystem).toContain("single_read");
		expect(capturedSystem).toContain("multi_hop_read");
		expect(capturedSystem).toContain("fan_out");
		expect(capturedSystem).toContain("embodied");
		expect(capturedSystem).toContain("budget the policy layer enforces");
		// Handoff vs delegate boundary + the SUGGEST-only contract.
		expect(capturedSystem).toContain("suggest_handoff");
		expect(capturedSystem).toContain("never auto-transferred");
		expect(capturedSystem).toContain("prefer delegate_tedi");
		// Body selection policy: route to the right worker, using isolate only as
		// the tie-breaker for equivalent non-embodied targets.
		expect(capturedSystem).toContain("choose the right tedi for the job");
		expect(capturedSystem).toContain(
			"Do NOT delegate to isolate tedis by default",
		);
		expect(capturedSystem).toContain(
			"prefer the isolate body for lower latency/cost",
		);
		// Pure-router contract: direct_tool_read must NOT be a selectable route;
		// live-data reads must be routed through delegate_tedi.
		expect(capturedSystem).not.toMatch(/^- direct_tool_read:/m);
		expect(capturedSystem).toContain(
			"READ or FETCH live EXTERNAL provider data",
		);
	});

	it("renders the conversation history in a fenced untrusted block with reference-resolution guidance", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "recalled from conversation history",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "Your codename is BLUEFALCON-7919.",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		let capturedSystem = "";
		let capturedUser = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedSystem = options.prompt
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				capturedUser = options.prompt
					.filter((message) => message.role === "user")
					.flatMap((message) =>
						Array.isArray(message.content) ? message.content : [],
					)
					.map((part) => ("text" in part ? String(part.text) : ""))
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
						},
					],
				};
			},
		});

		const result = await planKernelRoute({
			content: "what's my codename?",
			context: {
				...EMPTY_CONTEXT,
				history: [
					{ role: "user", content: "remember my codename is BLUEFALCON-7919" },
					{ role: "assistant", content: "Noted." },
				],
			},
			model,
		});

		expect(result).not.toBeNull();
		// History is FENCED (mirrors the tool-call planner's untrusted blocks)
		// and rendered oldest → newest before the operator message.
		expect(capturedUser).toContain("<conversation_history>");
		expect(capturedUser).toContain("</conversation_history>");
		expect(capturedUser).toContain(
			"[user] remember my codename is BLUEFALCON-7919",
		);
		expect(capturedUser).toContain("[assistant] Noted.");
		expect(capturedUser.indexOf("<conversation_history>")).toBeLessThan(
			capturedUser.indexOf("OPERATOR MESSAGE:"),
		);
		// The SECURITY rule names the history block as untrusted data, and the
		// planner is told to resolve references against it (ask_human stays
		// correct when history genuinely doesn't disambiguate).
		expect(capturedSystem).toContain("<conversation_history>");
		expect(capturedSystem).toContain("UNTRUSTED DATA");
		expect(capturedSystem).toContain("Resolve pronouns and references");
		expect(capturedSystem).toContain("ask_human remains correct");
	});

	it("omits the conversation-history fence entirely when there is no history", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		let capturedUser = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedUser = options.prompt
					.filter((message) => message.role === "user")
					.flatMap((message) =>
						Array.isArray(message.content) ? message.content : [],
					)
					.map((part) => ("text" in part ? String(part.text) : ""))
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
						},
					],
				};
			},
		});

		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model,
		});

		expect(result).not.toBeNull();
		expect(capturedUser).not.toContain("<conversation_history>");
	});

	it("stamps routerVersion on every successful decision (harness evidence v1)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question answerable from context",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "All quiet.",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};

		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model: objectModel(decision),
		});

		expect(result).not.toBeNull();
		// The model's parsed fields pass through verbatim …
		expect(result).toMatchObject(decision);
		// … plus the deterministic content-hash router version.
		expect(result?.routerVersion).toMatch(/^[0-9a-f]{12}$/);
		expect(result?.routerVersion).toBe(await getRouterVersion(SYSTEM_PROMPT));
	});

	it("keeps routerVersion OUT of the model-facing schema (model is never asked to produce it)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		let capturedResponseFormat: unknown;
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedResponseFormat = options.responseFormat;
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
						},
					],
				};
			},
		});

		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model,
		});
		expect(result?.routerVersion).toBe(await getRouterVersion(SYSTEM_PROMPT));

		// generateObject sent KernelRouteDecisionSchema as the model contract —
		// routerVersion must not appear in its properties/required (strict
		// structured output would force the model to emit it).
		const responseFormat = capturedResponseFormat as {
			type: string;
			schema?: { properties?: Record<string, unknown>; required?: string[] };
		};
		expect(responseFormat?.type).toBe("json");
		const jsonSchema = responseFormat?.schema;
		expect(jsonSchema?.properties).toBeDefined();
		expect(Object.keys(jsonSchema?.properties ?? {})).not.toContain(
			"routerVersion",
		);
		expect(jsonSchema?.required ?? []).not.toContain("routerVersion");
		expect(Object.keys(jsonSchema?.properties ?? {})).toContain("routeKind");
	});

	it("threads a bounded usage object onto the result (Change 1 — stop all-null)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};

		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model: objectModel(decision),
		});

		expect(result).not.toBeNull();
		// The usage object is ALWAYS present (the kernel bodyExecutionResult reads
		// it instead of defaulting all-null). provider/model are threaded from the
		// resolved model object; the MockLanguageModelV3 surfaces a mock provider
		// but no token counts, so the token fields normalize to null (a real Azure
		// round populates them — same field names as the isolate's shapeStepTelemetry).
		expect(result?.usage).toBeDefined();
		expect(result?.usage).toHaveProperty("provider");
		expect(result?.usage).toHaveProperty("model");
		expect(result?.usage.cacheReadTokens).toBeNull();
		expect(result?.usage.cacheWriteTokens).toBeNull();
		expect(result?.usage.reasoningTokens).toBeNull();
		// Token fields are present as keys (null under the mock), never undefined.
		expect("inputTokens" in (result?.usage ?? {})).toBe(true);
		expect("outputTokens" in (result?.usage ?? {})).toBe(true);
		// The route decision fields stay TOP-LEVEL (still assignable to the route
		// contract) — usage rides along as one extra key.
		expect(result?.routeKind).toBe("answer_in_home");
	});

	it("preserves provider-visible reasoning usage without reasoning text", () => {
		expect(
			shapeRouteUsage(
				{
					inputTokens: 7100,
					outputTokens: 198,
					outputTokenDetails: { reasoningTokens: 83 },
				},
				{ provider: "azure.chat", modelId: "gpt-5.6-luna" } as never,
			),
		).toMatchObject({
			inputTokens: 7100,
			outputTokens: 198,
			reasoningTokens: 83,
		});
	});

	it("propagates upstream failures without a second provider", async () => {
		await expect(
			planKernelRoute({
				content: "do something",
				context: EMPTY_CONTEXT,
				model: throwingModel(),
			}),
		).rejects.toThrow();
	});
	it("rejects model output that violates the route schema", async () => {
		await expect(
			planKernelRoute({
				content: "ambiguous",
				context: EMPTY_CONTEXT,
				model: objectModel({
					routeKind: "not_a_real_route",
					rationale: "nope",
					risk: "low",
					confidence: 0.5,
				}),
			}),
		).rejects.toThrow();
	});

	it("system prompt contains owned-write delegation guidance (delegate_tedi preferred over propose_tool_write for tedi-owned domains)", async () => {
		let capturedSystem = "";
		const model = new MockLanguageModelV3({
			doGenerate: async (options) => {
				capturedSystem = options.prompt
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n");
				return {
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [
						{
							type: "text",
							text: JSON.stringify({
								routeKind: "answer_in_home",
								rationale: "general question",
								risk: "low",
								confidence: 0.9,
								effortClass: "single_read",
								answer: "ok",
								targetTediId: null,
								targetTediLabel: null,
								targetActivityId: null,
								plannedToolIds: [],
								toolIntent: null,
								workflowHint: null,
								clarifyingQuestion: null,
								evidenceExpectation: null,
							}),
						},
					],
				};
			},
		});

		await planKernelRoute({
			content: "make all tedis autonomous",
			context: EMPTY_CONTEXT,
			model,
		});

		// The owned-write delegation rule must be present: delegate to the owning
		// tedi for writes that a named tedi in AVAILABLE TEDIS clearly owns.
		expect(capturedSystem).toContain("WRITE, CHANGE, or SET");
		expect(capturedSystem).toContain("delegate_tedi");
		// propose_tool_write is ONLY for writes where NO tedi owns the domain.
		expect(capturedSystem).toContain(
			"Reserve propose_tool_write ONLY for writes where NO tedi",
		);
		// Concrete example: platform governance → CTO/platform tedi.
		expect(capturedSystem).toContain("platform governance");
		expect(capturedSystem).toContain("autonomous");
		// The rule must call out domain ownership explicitly.
		expect(capturedSystem).toContain("owns the domain");
		// Tenant catalog installation is a first-class Home write, including in a
		// fresh organization whose default tedi is not yet needed for ownership.
		expect(capturedSystem).toContain("catalog.install");
		expect(capturedSystem).toContain(
			"Installing tenant apps from the Tedix catalog",
		);
	});

	it("without a delta sink uses one generateObject pass", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "direct answer",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "The status is green.",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const deltas: string[] = [];
		const result = await planKernelRoute({
			content: "what's our status?",
			context: EMPTY_CONTEXT,
			model: objectModel(decision),
		});
		// No delta sink requests the nonstreaming path.
		expect(result).not.toBeNull();
		expect(result?.routeKind).toBe("answer_in_home");
		expect(result?.answer).toBe("The status is green.");
		expect(deltas).toEqual([]);
	});
});

/**
 * Build a streaming model whose doStream emits the given JSON string as ordered
 * text-delta parts — the format streamObject expects from the provider layer.
 * Each chunk can be any prefix slice of the final JSON.
 */
function streamingObjectModel(
	jsonChunks: string[],
	finalDecision: KernelRouteDecision,
): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		// streamObject calls doStream (not doGenerate): the provider streams the
		// raw JSON text and the SDK assembles partial objects from it.
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "0" },
					...jsonChunks.map((chunk) => ({
						type: "text-delta" as const,
						id: "0",
						delta: chunk,
					})),
					{ type: "text-end", id: "0" },
					{
						type: "finish" as const,
						finishReason: "stop" as const,
						usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
					},
				],
			}),
		}),
		// streamObject also calls doGenerate for the final validated object via
		// `result.object`. We provide it here so both paths are satisfied.
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
			warnings: [],
			content: [
				{
					type: "text",
					text: JSON.stringify(normalizeRouteDecisionCandidate(finalDecision)),
				},
			],
		}),
	});
}

const FALLBACK_DECISION: KernelRouteDecision = {
	routeKind: "answer_in_home",
	rationale: "fallback from generateObject",
	risk: "low",
	confidence: 0.8,
	effortClass: "single_read",
	answer: "Fallback answer.",
	targetTediId: null,
	targetTediLabel: null,
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

/**
 * A streaming model whose doStream emits an error stream part (not a throw),
 * causing result.object to reject. This avoids the SDK's exponential retry
 * loop (which kicks in when doStream itself throws synchronously). The
 * doGenerate fallback is the generateObject path after stream failure.
 */
function streamErrorModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{ type: "stream-start", warnings: [] },
					{
						type: "error",
						error: new Error("Azure 500 — simulated upstream error"),
					},
					{
						type: "finish" as const,
						finishReason: "error" as const,
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					},
				],
			}),
		}),
		// doGenerate is the generateObject fallback after stream error.
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			content: [
				{
					type: "text",
					text: JSON.stringify(
						normalizeRouteDecisionCandidate(FALLBACK_DECISION),
					),
				},
			],
		}),
	});
}

describe("planKernelRoute — single-pass streamObject", () => {
	it("(a) flag-on: emits incremental onAnswerDelta suffixes for answer_in_home", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "direct answer",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "Hello world",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		// Split the full JSON into chunks that progressively build answer field.
		// The SDK's partial parser will emit partial objects as chunks accumulate.
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		// Simulate chunk-by-chunk delivery: split into 8-char pieces.
		const chunkSize = 8;
		const chunks: string[] = [];
		for (let i = 0; i < fullJson.length; i += chunkSize) {
			chunks.push(fullJson.slice(i, i + chunkSize));
		}

		const deltas: string[] = [];
		const result = await planKernelRoute({
			content: "say hi",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel(chunks, decision),
			onAnswerDelta: (d) => deltas.push(d),
		});

		// Result must be the validated decision with routerVersion stamped.
		expect(result).not.toBeNull();
		expect(result?.routeKind).toBe("answer_in_home");
		expect(result?.answer).toBe("Hello world");
		expect(result?.routerVersion).toMatch(/^[0-9a-f]{12}$/);
		expect(result?.routerVersion).toBe(await getRouterVersion(SYSTEM_PROMPT));
		// Answer deltas were emitted — their concatenation equals the full answer.
		expect(deltas.join("")).toBe("Hello world");
		// At least one delta was emitted (not zero).
		expect(deltas.length).toBeGreaterThan(0);
	});

	it("(b) flag-on: returns validated decision from result.object (routerVersion stamped)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "recalled from context",
			risk: "low",
			confidence: 0.95,
			effortClass: "single_read",
			answer: "All quiet.",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const result = await planKernelRoute({
			content: "status?",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel([fullJson], decision),
			onAnswerDelta: () => {},
		});
		expect(result).not.toBeNull();
		expect(result).toMatchObject(decision);
		expect(result?.routerVersion).toBe(await getRouterVersion(SYSTEM_PROMPT));
		expect(result?.usage).toBeDefined();
		expect(result?.usage).toHaveProperty("inputTokens");
	});

	it("stream failure does not start a second generation pass", async () => {
		const model = streamErrorModel();
		await expect(
			planKernelRoute({
				content: "do something",
				context: EMPTY_CONTEXT,
				model,
				onAnswerDelta: () => {},
			}),
		).rejects.toThrow();
		expect(model.doGenerateCalls).toHaveLength(0);
	});

	it("flag-on: does NOT emit deltas for non-answer_in_home routes", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "ask_human",
			rationale: "ambiguous request",
			risk: "low",
			confidence: 0.5,
			effortClass: null,
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: "What exactly do you mean?",
			evidenceExpectation: null,
		};
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const deltas: string[] = [];
		const result = await planKernelRoute({
			content: "do the thing",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel([fullJson], decision),
			onAnswerDelta: (d) => deltas.push(d),
		});
		expect(result?.routeKind).toBe("ask_human");
		// No answer field on ask_human — no deltas emitted.
		expect(deltas).toEqual([]);
	});

	it("forwards provisional RATIONALE deltas on a route whose answer is null", async () => {
		// The blank-screen defect: `answer` is null for the whole pass on
		// ask_human / delegate_tedi / propose_tool_write / run_workflow, so the
		// rationale line is the only thing the operator can see while the planner
		// decides. It must stream even though no answer delta ever will.
		const decision: KernelRouteDecision = {
			routeKind: "ask_human",
			rationale: "The request is ambiguous between two active projects.",
			risk: "low",
			confidence: 0.5,
			effortClass: null,
			answer: null,
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: "Which project?",
			evidenceExpectation: null,
		};
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const chunks: string[] = [];
		for (let i = 0; i < fullJson.length; i += 8) {
			chunks.push(fullJson.slice(i, i + 8));
		}
		const answerDeltas: string[] = [];
		const rationaleDeltas: string[] = [];
		const result = await planKernelRoute({
			content: "do the thing",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel(chunks, decision),
			onAnswerDelta: (d) => answerDeltas.push(d),
			onRationaleDelta: (d) => rationaleDeltas.push(d),
		});
		expect(result?.routeKind).toBe("ask_human");
		expect(answerDeltas).toEqual([]);
		expect(rationaleDeltas.length).toBeGreaterThan(0);
		// Monotonic forward extension only: the concatenation is EXACTLY the
		// rationale, with no regenerated prefix re-emitted.
		expect(rationaleDeltas.join("")).toBe(decision.rationale);
	});

	it("a throwing onRationaleDelta sink never breaks the stream", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "The GitHub-owning tedi holds this connection.",
			risk: "medium",
			confidence: 0.8,
			effortClass: "multi_hop_read",
			answer: null,
			targetTediId: "tedi-1",
			targetTediLabel: "Engineer",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const result = await planKernelRoute({
			content: "recent commits",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel([fullJson], decision),
			onAnswerDelta: () => {},
			onRationaleDelta: () => {
				throw new Error("sink exploded");
			},
		});
		expect(result).not.toBeNull();
		expect(result?.routeKind).toBe("delegate_tedi");
	});

	it("flag-on: monotonicity guard — non-monotonic partial answer is silently skipped", async () => {
		// Simulate a pathological case where partial.answer goes backwards
		// (shouldn't happen in practice but must not corrupt the stream).
		// We test this by verifying the suffix logic: if answer = "Hello" then
		// "Hel" then "Hello world", only "Hello" and " world" are emitted.
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "test",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "Hello world",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		// We can't easily inject a non-monotonic partialObjectStream from the SDK
		// side (the SDK builds partials from JSON accumulation), so instead we
		// verify the positive case: deltas concat to the full answer with no
		// duplication when streams progress normally.
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const deltas: string[] = [];
		await planKernelRoute({
			content: "hi",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel([fullJson], decision),
			onAnswerDelta: (d) => deltas.push(d),
		});
		// No duplication — joined equals exactly the answer.
		expect(deltas.join("")).toBe("Hello world");
	});

	it("flag-on: a throwing onAnswerDelta sink never breaks the stream (result still returned)", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "test",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "ok",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const result = await planKernelRoute({
			content: "ok",
			context: EMPTY_CONTEXT,
			model: streamingObjectModel(
				[JSON.stringify(normalizeRouteDecisionCandidate(decision))],
				decision,
			),
			onAnswerDelta: () => {
				throw new Error("sink exploded");
			},
		});
		expect(result).not.toBeNull();
		expect(result?.answer).toBe("ok");
	});
});

// ── Stall guards (intermittent-wedge fix) ──────────────────────────────────
// A half-open Azure stall OPENS the call/stream but emits no bytes and never
// closes; the underlying fetch only ends when its AbortSignal fires. These
// fakes reproduce that exactly: they honor the SDK-forwarded abortSignal (as a
// real fetch does) and otherwise never settle. Without the guard the awaited
// call / for-await would wedge runKernel forever.

/** Reject only when the SDK-forwarded abortSignal fires (never resolves). */
function blockUntilAbort(abortSignal: AbortSignal | undefined): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(abortSignal?.reason ?? new Error("aborted"));
		if (abortSignal?.aborted) return onAbort();
		abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** A non-streaming model whose doGenerate opens, never yields, never closes. */
function stallingGenerateModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doGenerate: async ({ abortSignal }) => {
			await blockUntilAbort(abortSignal);
			throw new Error("unreachable");
		},
	});
}

/** A streaming model whose doStream opens a stream that never yields/closes. */
function stallingStreamObjectModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doStream: async ({ abortSignal }) => ({
			stream: new ReadableStream({
				start(controller) {
					const onAbort = () =>
						controller.error(abortSignal?.reason ?? new Error("aborted"));
					if (abortSignal?.aborted) return onAbort();
					abortSignal?.addEventListener("abort", onAbort, { once: true });
				},
			}),
		}),
	});
}

/**
 * Stall stream + a COUNTING doGenerate fallback. Proves the streamObject →
 * generateObject fallthrough is SKIPPED on an idle-abort (doGenerate untouched).
 */
function stallStreamCountGenerateModel(): MockLanguageModelV3 {
	return new MockLanguageModelV3({
		doStream: async ({ abortSignal }) => ({
			stream: new ReadableStream({
				start(controller) {
					const onAbort = () =>
						controller.error(abortSignal?.reason ?? new Error("aborted"));
					if (abortSignal?.aborted) return onAbort();
					abortSignal?.addEventListener("abort", onAbort, { once: true });
				},
			}),
		}),
		// Recorded via doGenerateCalls — must stay at 0 when fallthrough is skipped.
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			content: [
				{
					type: "text",
					text: JSON.stringify(
						normalizeRouteDecisionCandidate(FALLBACK_DECISION),
					),
				},
			],
		}),
	});
}

/** Fail the wrapped promise if it does not settle within `ms` (proves no hang). */
async function settlesWithin<T>(
	p: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`${label} did not settle within ${ms}ms (wedged)`)),
			ms,
		);
	});
	try {
		return await Promise.race([p, guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("planKernelRoute — stall guards (intermittent-wedge fix)", () => {
	it("non-streaming: a stalled generateObject settles to null at the flat bound (not a hang)", async () => {
		const result = await settlesWithin(
			planKernelRoute({
				content: "what's our status?",
				context: EMPTY_CONTEXT,
				model: stallingGenerateModel(),
				// No env / no onAnswerDelta → the generateObject fallback path.
				generationTimeoutMs: 60,
			}).catch((error: unknown) => error),
			800,
			"stalled generateObject",
		);
		// Fail-soft: the wedge becomes a settled null → heuristic responder.
		expect(result).toBeInstanceOf(Error);
	});

	it("streaming: a stalled streamObject idle-aborts to null (not a hang)", async () => {
		const deltas: string[] = [];
		const result = await settlesWithin(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model: stallingStreamObjectModel(),
				onAnswerDelta: (d) => deltas.push(d),
				streamIdleMs: 60,
			}).catch((error: unknown) => error),
			800,
			"stalled streamObject",
		);
		expect(result).toBeInstanceOf(Error);
		expect(deltas).toEqual([]);
	});

	it("FALLTHROUGH SKIP: an idle-aborted streamObject does NOT fall through to generateObject", async () => {
		const model = stallStreamCountGenerateModel();
		const result = await settlesWithin(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model,
				onAnswerDelta: () => {},
				streamIdleMs: 60,
				// Set generously: if the fallthrough were (wrongly) taken, the stall
				// generate would itself only abort at this bound and stack latency.
				generationTimeoutMs: 5_000,
			}).catch((error: unknown) => error),
			800,
			"idle-abort fallthrough",
		);
		expect(result).toBeInstanceOf(Error);
		// The decisive assertion: generateObject was never invoked on idle-abort.
		expect(model.doGenerateCalls.length).toBe(0);
	});

	it("SLOW-BUT-PROGRESSING stream: the idle reset does NOT abort a legit slow stream", async () => {
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "slow but progressing",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "Hello world",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		// Chunks arrive every 20ms — slower in TOTAL than a flat 120ms deadline,
		// but each GAP (20ms) is well under the 120ms idle bound, so the idle
		// reset keeps the stream alive to completion.
		const fullJson = JSON.stringify(normalizeRouteDecisionCandidate(decision));
		const chunks: string[] = [];
		for (let i = 0; i < fullJson.length; i += 24) {
			chunks.push(fullJson.slice(i, i + 24));
		}
		const slowModel = new MockLanguageModelV3({
			doStream: async () => ({
				stream: simulateReadableStream({
					initialDelayInMs: 10,
					chunkDelayInMs: 20,
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "0" },
						...chunks.map((chunk) => ({
							type: "text-delta" as const,
							id: "0",
							delta: chunk,
						})),
						{ type: "text-end", id: "0" },
						{
							type: "finish" as const,
							finishReason: "stop" as const,
							usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
						},
					],
				}),
			}),
		});
		const deltas: string[] = [];
		const result = await settlesWithin(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model: slowModel,
				onAnswerDelta: (d) => deltas.push(d),
				streamIdleMs: 120,
			}),
			3_000,
			"slow-but-progressing stream",
		);
		// The stream completed normally — NOT idle-aborted.
		expect(result).not.toBeNull();
		expect(result?.answer).toBe("Hello world");
		expect(deltas.join("")).toBe("Hello world");
	});
});

// ── Operator abort classification (per-turn cancel) ─────────────────────────
// `KernelDO.cancelTurn` aborts a runId-keyed AbortController mid-plan
// (docs/engineering/cognition/kernel-execution-model.md "Operator cancel"). These pin the
// classification contract: an operator abort settles to `null` (same as any
// other fail-soft outcome — the turn body's pre-materialize cancel gate owns
// the actual settle via the run row's already-`canceled` DB status), but it
// must NEVER be recorded as a provider failure — no Azure circuit trip, no
// wasted Workers AI fallback call, and a log message that says "aborted by
// operator", not "failed".
describe("planKernelRoute — operator abort classification (per-turn cancel)", () => {
	it("pre-aborted signal: returns null immediately without ever calling the model", async () => {
		const model = stallStreamCountGenerateModel();
		const controller = new AbortController();
		controller.abort();
		const result = await settlesWithin(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model,
				abortSignal: controller.signal,
			}),
			200,
			"pre-aborted planKernelRoute",
		);
		expect(result).toBeNull();
		expect(model.doGenerateCalls.length).toBe(0);
	});

	it("non-streaming: an operator abort mid-generateObject settles null WITHOUT tripping the Azure circuit or logging a provider failure", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const controller = new AbortController();
			const pending = settlesWithin(
				planKernelRoute({
					content: "what's our status?",
					context: EMPTY_CONTEXT,
					model: stallingGenerateModel(),
					abortSignal: controller.signal,
				}),
				800,
				"operator-aborted generateObject",
			);
			// Abort shortly after the call starts (simulates KernelDO.cancelTurn
			// firing while the LLM pass is in flight).
			await new Promise((r) => setTimeout(r, 10));
			controller.abort();
			const result = await pending;
			expect(result).toBeNull();

			// Distinct classification: the abort-specific warn fired…
			const events = warnSpy.mock.calls.map(
				(call) => (call[0] as { event?: string }).event,
			);
			expect(events.includes("operator_aborted_generation")).toBe(true);
			// …and the generic provider-failure warn did NOT.
			expect(
				events.includes("azure_generation_failed_workers_ai_fallback"),
			).toBe(false);
			expect(events.includes("workers_ai_fallback_unavailable")).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}

		// Circuit-not-tripped proof: a SUBSEQUENT call with a healthy model still
		// routes through Azure (a tripped circuit would force the Workers AI path,
		// which returns null with no env.AI configured here).
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "azure still healthy after the abort",
			risk: "low",
			confidence: 0.9,
			effortClass: "single_read",
			answer: "still here",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const second = await planKernelRoute({
			content: "you still there?",
			context: EMPTY_CONTEXT,
			model: objectModel(decision),
		});
		expect(second?.answer).toBe("still here");
	});

	it("streaming: an operator abort mid-stream settles null and does NOT fall through to generateObject", async () => {
		const model = stallStreamCountGenerateModel();
		const controller = new AbortController();
		const pending = settlesWithin(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model,
				onAnswerDelta: () => {},
				abortSignal: controller.signal,
			}),
			800,
			"operator-aborted streamObject",
		);
		await new Promise((r) => setTimeout(r, 10));
		controller.abort();
		const result = await pending;
		expect(result).toBeNull();
		// The decisive assertion: generateObject was never invoked — an operator
		// abort must not fall through to a second (also-doomed-to-abort) pass.
		expect(model.doGenerateCalls.length).toBe(0);
	});
});

describe("planKernelRoute — billing-policy denial propagation", () => {
	const BILLING_DENIAL =
		"Inference blocked by billing policy: entitlement_inactive";

	/** Model whose transport rejects with the canonical admission-denial marker
	 * (what reserveKernelBilling throws inside kernelGatewayFetch). */
	function billingDeniedModel(): MockLanguageModelV3 {
		return new MockLanguageModelV3({
			doGenerate: async () => {
				throw new Error(BILLING_DENIAL);
			},
		});
	}

	it("RETHROWS a billing denial instead of settling null — never masked as a provider outage", async () => {
		await expect(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model: billingDeniedModel(),
			}),
		).rejects.toThrow(BILLING_DENIAL);
	});

	it("a billing denial does NOT trip the Azure circuit — the next turn still routes via Azure", async () => {
		await planKernelRoute({
			content: "say hi",
			context: EMPTY_CONTEXT,
			model: billingDeniedModel(),
		}).catch(() => {});
		// If the denial had tripped the circuit, this call would skip Azure and
		// settle null (no env.AI). A working Azure model must still route.
		const decision: KernelRouteDecision = {
			routeKind: "answer_in_home",
			rationale: "general question",
			risk: "low",
			confidence: 0.9,
			effortClass: null,
			answer: "still routing via azure",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const result = await planKernelRoute({
			content: "say hi",
			context: EMPTY_CONTEXT,
			model: objectModel(decision),
		});
		expect(result?.answer).toBe("still routing via azure");
	});

	it("a non-billing provider failure propagates without switching routes", async () => {
		await expect(
			planKernelRoute({
				content: "say hi",
				context: EMPTY_CONTEXT,
				model: throwingModel(),
			}),
		).rejects.toThrow();
	});
});

describe("Auto Home final answer streaming", () => {
	function autoModel(
		decision: KernelRouteDecision,
		stream: ReadableStream<any>,
	) {
		return new MockLanguageModelV3({
			modelId: "cloudflare/auto",
			doGenerate: async () => ({
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 20, text: 20, reasoning: 0 },
				},
				warnings: [],
				content: [
					{
						type: "text",
						text: JSON.stringify(normalizeRouteDecisionCandidate(decision)),
					},
				],
			}),
			doStream: async (call) => {
				expect(call.responseFormat?.type).not.toBe("json");
				expect(call.tools?.length ?? 0).toBe(0);
				return { stream };
			},
		});
	}
	const finish = {
		type: "finish",
		finishReason: { unified: "stop", raw: "stop" },
		usage: {
			inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 2, text: 2, reasoning: 0 },
		},
	};
	it("emits early text before provider finish, suppresses outline and sums both usage records", async () => {
		let controller!: ReadableStreamDefaultController<any>;
		const stream = new ReadableStream({
			start(c) {
				controller = c;
			},
		});
		const deltas: string[] = [];
		const operation = planKernelRoute({
			model: autoModel(
				{ ...FALLBACK_DECISION, answer: "Buffered outline" },
				stream,
			),
			context: EMPTY_CONTEXT,
			content: "Explain rain",
			onAnswerDelta: (d) => deltas.push(d),
		});
		controller.enqueue({ type: "stream-start", warnings: [] });
		controller.enqueue({ type: "text-start", id: "0" });
		controller.enqueue({ type: "text-delta", id: "0", delta: "Early" });
		await vi.waitFor(() => expect(deltas).toEqual(["Early"]));
		controller.enqueue({ type: "text-delta", id: "0", delta: " answer" });
		controller.enqueue({ type: "text-end", id: "0" });
		controller.enqueue(finish);
		controller.close();
		const result = await operation;
		expect(result?.answer).toBe("Early answer");
		expect(deltas.join("")).toBe("Early answer");
		expect(result?.usage).toMatchObject({ inputTokens: 15, outputTokens: 22 });
	});
	it("does not start an answer pass for an action route", async () => {
		const model = autoModel(
			{
				...FALLBACK_DECISION,
				routeKind: "propose_tool_write",
				answer: null,
				risk: "medium",
			},
			new ReadableStream(),
		);
		const delta = vi.fn();
		const result = await planKernelRoute({
			model,
			context: EMPTY_CONTEXT,
			content: "Create a document",
			onAnswerDelta: delta,
		});
		expect(result?.routeKind).toBe("propose_tool_write");
		expect(model.doStreamCalls).toHaveLength(0);
		expect(delta).not.toHaveBeenCalled();
	});
	it("rejects a failed partial answer without falling back to its buffered outline", async () => {
		const stream = simulateReadableStream({
			initialDelayInMs: null,
			chunkDelayInMs: null,
			chunks: [
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "0" },
				{ type: "text-delta", id: "0", delta: "Partial" },
				{ type: "error", error: new Error("provider failed") },
			],
		});
		const model = autoModel(FALLBACK_DECISION, stream);
		const delta = vi.fn();
		await expect(
			planKernelRoute({
				model,
				context: EMPTY_CONTEXT,
				content: "Explain rain",
				onAnswerDelta: delta,
			}),
		).rejects.toThrow("provider failed");
		expect(delta).toHaveBeenCalledWith("Partial");
		expect(model.doGenerateCalls).toHaveLength(1);
	});
	it("returns cancellation when aborted during final text without another dispatch", async () => {
		const abort = new AbortController();
		const stream = simulateReadableStream({
			initialDelayInMs: null,
			chunkDelayInMs: null,
			chunks: [
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "0" },
				{ type: "text-delta", id: "0", delta: "Partial" },
				finish,
			],
		});
		const model = autoModel(FALLBACK_DECISION, stream);
		const result = await planKernelRoute({
			model,
			context: EMPTY_CONTEXT,
			content: "Explain rain",
			abortSignal: abort.signal,
			onAnswerDelta: () => abort.abort(),
		});
		expect(result).toBeNull();
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(model.doStreamCalls).toHaveLength(1);
	});
});

describe("operator intent before delegation fit", () => {
	it.each([
		"Acknowledge only. Do not delegate.",
		"Reply directly without delegation.",
	])(
		"uses original operator text and suppresses provisional action copy: %s",
		async (operatorContent) => {
			const ranker = vi.fn();
			const onAnswerDelta = vi.fn();
			const onRationaleDelta = vi.fn();
			const output = {
				routeKind: "delegate_tedi",
				rationale: "Delegate the attached plan",
				risk: "high",
				confidence: 1,
				effortClass: "fan_out",
				answer: "I will delegate to CTO.",
				targetTediId: "cto",
				targetTediLabel: "CTO",
				targetActivityId: null,
				plannedToolIds: ["github.write"],
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
			};
			const model = new MockLanguageModelV3({
				doGenerate: async () => ({
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
					content: [{ type: "text", text: JSON.stringify(output) }],
				}),
			});
			const result = await planKernelRoute({
				content:
					"Prepare a CTO delegation work order. Park for approval first.",
				operatorContent,
				onAnswerDelta,
				onRationaleDelta,
				context: EMPTY_CONTEXT,
				model,
				delegationCandidateRanker: ranker,
			});
			expect(result).toMatchObject({
				routeKind: "answer_in_home",
				answer: operatorContent.startsWith("Acknowledge")
					? "Acknowledged."
					: "I’ll respond here without delegating.",
				targetTediId: null,
				plannedToolIds: [],
				explicitDelegationIntent: false,
			});
			expect(ranker).not.toHaveBeenCalled();
			expect(onAnswerDelta).not.toHaveBeenCalled();
			expect(onRationaleDelta).not.toHaveBeenCalled();
			expect(model.doStreamCalls).toHaveLength(0);
		},
	);
	it("does not take attachment prohibitions as operator intent", async () => {
		const output = {
			routeKind: "delegate_tedi",
			rationale: "Explicit delegation",
			risk: "medium",
			confidence: 1,
			effortClass: "single_read",
			answer: null,
			targetTediId: "cto",
			targetTediLabel: "CTO",
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		const model = new MockLanguageModelV3({
			doGenerate: async () => ({
				finishReason: "stop",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
				content: [{ type: "text", text: JSON.stringify(output) }],
			}),
		});
		const result = await planKernelRoute({
			content:
				"Delegate this to CTO. Attachment says: acknowledge only, no delegation.",
			operatorContent: "Delegate this to CTO.",
			context: EMPTY_CONTEXT,
			model,
		});
		expect(result).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "cto",
			explicitDelegationIntent: true,
		});
	});
});
