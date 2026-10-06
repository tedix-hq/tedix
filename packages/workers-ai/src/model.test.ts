import { generateText, type LanguageModel } from "ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { workersAiModel } from "./model";
import { type WorkersAiClient } from "./transport";

type LanguageModelV2 = Extract<LanguageModel, { specificationVersion: "v2" }>;
type CallOptions = Parameters<LanguageModelV2["doGenerate"]>[0];

/**
 * Drive the model through the `env.AI` binding (no gateway configured) and
 * return the inputs the binding was called with — the exact request body the
 * model built.
 */
async function bindingInputs(
	options: Partial<CallOptions> & Pick<CallOptions, "prompt">,
	attribution?: Record<string, string>,
): Promise<Record<string, unknown>> {
	const run = vi.fn(async () => ({ response: "ok" }));
	const client: WorkersAiClient = {
		env: {
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			AI: { run } as unknown as Ai,
		},
		authorize: async (input) => ({ attribution: input.attribution }),
	};
	const model = workersAiModel(client, "@cf/openai/gpt-oss-120b", attribution);
	await model.doGenerate(options as CallOptions);
	return run.mock.calls[0]?.[1] as Record<string, unknown>;
}

const HELLO: CallOptions["prompt"] = [
	{ role: "user", content: [{ type: "text", text: "hello" }] },
];

const TOOL: NonNullable<CallOptions["tools"]>[number] = {
	type: "function",
	name: "list_skills",
	description: "list them",
	inputSchema: { type: "object", properties: {} },
};

describe("workersAiModel factory", () => {
	it("refuses to build without a binding OR a configured gateway", () => {
		expect(() =>
			workersAiModel({ env: {}, authorize: async () => ({}) }, "m"),
		).toThrow(/no Workers AI transport available/);
	});

	it("builds on a configured HTTPS gateway with NO AI binding", () => {
		const model = workersAiModel(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "acct-1",
					AI_GATEWAY_LLM_ID: "llm-gw",
					CF_AI_GATEWAY_TOKEN: "aig",
					CF_WORKERS_AI_TOKEN: "byok",
				},
				authorize: async () => ({}),
			},
			"@cf/openai/gpt-oss-120b",
		);
		expect(model.specificationVersion).toBe("v2");
		expect(model.provider).toBe("workers-ai");
		expect(model.modelId).toBe("@cf/openai/gpt-oss-120b");
	});

	it("requires an explicit model id (no shipped default in the factory)", () => {
		const model = workersAiModel(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					AI: {} as unknown as Ai,
				},
				authorize: async () => ({}),
			},
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		);
		expect(model.modelId).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	});
});

describe("JSON mode forwarding", () => {
	it("conveys the exact nested response schema without changing the caller prompt", async () => {
		const schema = {
			type: "object",
			properties: {
				toolName: { type: "string" },
				reasoning: { type: ["string", "null"] },
				args: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
			required: ["toolName", "reasoning", "args"],
		};
		const prompt: CallOptions["prompt"] = [
			{ role: "system", content: "Select one tool." },
			...HELLO,
		];
		const original = structuredClone(prompt);
		const inputs = await bindingInputs({
			prompt,
			responseFormat: { type: "json", schema },
		});
		expect(inputs.response_format).toEqual({ type: "json_object" });
		expect(inputs.messages).toEqual([
			{
				role: "system",
				content: expect.stringContaining(JSON.stringify(schema)),
			},
			{ role: "system", content: "Select one tool." },
			{ role: "user", content: "hello" },
		]);
		expect(prompt).toEqual(original);
	});

	it("forwards response_format when responseFormat.type is json", async () => {
		const inputs = await bindingInputs({
			prompt: HELLO,
			responseFormat: { type: "json" },
		});
		expect(inputs.response_format).toEqual({ type: "json_object" });
	});

	it("forwards nothing for text responseFormat", async () => {
		const inputs = await bindingInputs({
			prompt: HELLO,
			responseFormat: { type: "text" },
		});
		expect(inputs).not.toHaveProperty("response_format");
	});

	it("forwards nothing when responseFormat is absent", async () => {
		expect(await bindingInputs({ prompt: HELLO })).not.toHaveProperty(
			"response_format",
		);
	});
});

describe("tool_choice guard", () => {
	it("drops tool_choice when the turn offers NO tools (AiError 8001)", async () => {
		const inputs = await bindingInputs({
			prompt: HELLO,
			toolChoice: { type: "auto" },
		});
		expect(inputs).not.toHaveProperty("tool_choice");
		expect(inputs).not.toHaveProperty("tools");
	});

	it("sends tool_choice alongside a tools array", async () => {
		const inputs = await bindingInputs({
			prompt: HELLO,
			tools: [TOOL],
			toolChoice: { type: "required" },
		});
		expect(inputs.tool_choice).toBe("required");
		expect(inputs.tools).toEqual([
			{
				type: "function",
				function: {
					name: "list_skills",
					description: "list them",
					parameters: { type: "object", properties: {} },
				},
			},
		]);
	});

	it("maps a named tool choice to the OpenAI function shape", async () => {
		const inputs = await bindingInputs({
			prompt: HELLO,
			tools: [TOOL],
			toolChoice: { type: "tool", toolName: "list_skills" },
		});
		expect(inputs.tool_choice).toEqual({
			type: "function",
			function: { name: "list_skills" },
		});
	});
});

describe("prompt mapping", () => {
	it("keeps assistant tool_calls correlated with tool results", async () => {
		const inputs = await bindingInputs({
			prompt: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: [{ type: "text", text: "go" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "calling" },
						{
							type: "tool-call",
							toolCallId: "call_1",
							toolName: "list_skills",
							input: '{"limit":2}',
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_1",
							toolName: "list_skills",
							output: { type: "json", value: { skills: [] } },
						},
					],
				},
			],
		});
		expect(inputs.messages).toEqual([
			{ role: "system", content: "be brief" },
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: "calling",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "list_skills", arguments: '{"limit":2}' },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				content: '{"skills":[]}',
			},
		]);
	});
});

describe("attribution threading", () => {
	it("hands the pre-normalized record to the transport unchanged", async () => {
		const run = vi.fn(async () => ({ response: "ok" }));
		const model = workersAiModel(
			{
				env: {
					AI: { run } as unknown as Ai,
					AI_GATEWAY_ACCOUNT_ID: "acct-1",
					AI_GATEWAY_LLM_ID: "llm-gw",
				},
				authorize: async (input) => ({ attribution: input.attribution }),
			},
			"@cf/openai/gpt-oss-120b",
			{ surface: "kernel", orgId: "org-1" },
		);
		await model.doGenerate({ prompt: HELLO } as CallOptions);
		expect(run.mock.calls[0]?.[2]).toEqual({
			gateway: {
				id: "llm-gw",
				metadata: { surface: "kernel", orgId: "org-1" },
			},
		});
	});
});

describe("doStream", () => {
	it("replays a buffered generate as ordered stream parts", async () => {
		const run = vi.fn(async () => ({
			response: null,
			tool_calls: [{ name: "list_skills", arguments: { limit: 1 } }],
			usage: { prompt_tokens: 5, completion_tokens: 2 },
		}));
		const model = workersAiModel(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					AI: { run } as unknown as Ai,
				},
				authorize: async () => ({}),
			},
			"@cf/openai/gpt-oss-120b",
		);
		const { stream } = await model.doStream({
			prompt: HELLO,
			tools: [TOOL],
		} as CallOptions);
		const parts: Array<{ type: string }> = [];
		for await (const part of stream) parts.push(part as { type: string });
		expect(parts.map((p) => p.type)).toEqual([
			"stream-start",
			"tool-input-start",
			"tool-input-delta",
			"tool-input-end",
			"tool-call",
			"finish",
		]);
	});
});

describe("lossless large model requests", () => {
	it("preserves a large task and tool schema through the model adapter", async () => {
		const task = "goal:" + "源".repeat(40_000);
		const description = "d".repeat(100_000);
		const sent = await bindingInputs({
			prompt: [{ role: "user", content: [{ type: "text", text: task }] }],
			tools: [{ ...TOOL, description }],
		});
		expect(sent.messages).toEqual([{ role: "user", content: task }]);
		expect(JSON.stringify(sent.tools)).toContain(description);
		expect(
			new TextEncoder().encode(JSON.stringify(sent)).byteLength,
		).toBeGreaterThan(90_000);
	});
});

describe("reasoning results", () => {
	function reasoningModel() {
		return workersAiModel(
			{
				env: {
					AI_GATEWAY_ACCOUNT_ID: "account",
					AI_GATEWAY_LLM_ID: "gateway",
					AI: {
						run: async () => ({
							response: "answer",
							reasoning: "analysis",
							usage: {
								prompt_tokens: 10,
								completion_tokens: 8,
								completion_tokens_details: { reasoning_tokens: 5 },
								prompt_tokens_details: { cached_tokens: 3 },
							},
						}),
					} as unknown as Ai,
				},
				authorize: async () => ({}),
			},
			"@cf/test",
		);
	}

	it("preserves reasoning and detailed usage through the installed AI SDK", async () => {
		const result = await generateText({
			model: reasoningModel(),
			prompt: "hello",
		});
		expect(result.text).toBe("answer");
		expect(result.reasoningText).toBe("analysis");
		expect(result.usage.totalTokens).toBe(18);
		expect(result.usage.outputTokenDetails.reasoningTokens).toBe(5);
		expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(3);
	});

	it("keeps reasoning separate and does not double count reasoning tokens", async () => {
		const result = await reasoningModel().doGenerate({
			prompt: HELLO,
		} as CallOptions);
		expect(result.content).toEqual([
			{ type: "reasoning", text: "analysis" },
			{ type: "text", text: "answer" },
		]);
		expect(result.usage).toEqual({
			inputTokens: 10,
			outputTokens: 8,
			totalTokens: 18,
			reasoningTokens: 5,
			cachedInputTokens: 3,
		});
	});

	it("replays separate reasoning frames before answer frames with complete usage", async () => {
		const { stream } = await reasoningModel().doStream({
			prompt: HELLO,
		} as CallOptions);
		const parts = [];
		for await (const part of stream) parts.push(part);
		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect(parts[2]).toMatchObject({ delta: "analysis" });
		expect(parts[5]).toMatchObject({ delta: "answer" });
		expect(parts[7]).toMatchObject({
			usage: { totalTokens: 18, reasoningTokens: 5, cachedInputTokens: 3 },
		});
	});
});
