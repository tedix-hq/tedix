import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { generateSmartTestInput } from "./tool-evaluator";
it("keeps generative test input construction and uses provider-reported tokens", async () => {
	const ai = {
		run: vi.fn(async (_model: string) => ({
			response: '{"id":"o1"}',
			usage: { prompt_tokens: 81, completion_tokens: 7 },
		})),
	};
	const result = await generateSmartTestInput(ai, { name: "get_order" });
	expect(result.input).toEqual({ id: "o1" });
	expect(result.tokensUsed).toBe(88);
	expect(ai.run.mock.calls[0]?.[0]).toBe(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	);
});

it.each(["[]", "42", "null", "```json\n[]\n```", "Generated input: [1, 2]"])(
	"falls back to object arguments for model JSON %s",
	async (response) => {
		const result = await generateSmartTestInput(
			{
				run: async () => ({ response, usage: { total_tokens: 19 } }),
			},
			{
				name: "get_order",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string", default: "fallback-id" } },
					required: ["id"],
				},
			},
		);
		expect(result.input).toEqual({ id: "fallback-id" });
		expect(result.tokensUsed).toBe(19);
	},
);

it.each([
	'{"id":"o1"}',
	'```json\n{"id":"o1"}\n```',
	'Generated input: {"id":"o1"}',
])("keeps object arguments extracted from %s", async (response) => {
	const result = await generateSmartTestInput(
		{ run: async () => ({ response }) },
		{ name: "get_order" },
	);
	expect(result.input).toEqual({ id: "o1" });
});

describe("tool evaluator logging", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fingerprints prompts and provider errors without logging their bodies", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const secret = "prompt-secret-sk_live_123";
		const ai = {
			run: vi.fn(async () => {
				const providerError = new Error(
					`provider echoed ${secret}`,
				) as Error & {
					body: unknown;
				};
				providerError.body = {
					request: { messages: [{ content: secret }] },
					authorization: `Bearer ${secret}`,
				};
				throw providerError;
			}),
		};

		await generateSmartTestInput(ai, {
			name: "secret_tool",
			description: secret,
		});

		expect(errorLog).toHaveBeenCalledTimes(1);
		const serializedLog = JSON.stringify(errorLog.mock.calls);
		expect(serializedLog).not.toContain(secret);
		expect(serializedLog).not.toContain("authorization");
		expect(serializedLog).toContain("prompt");
		expect(serializedLog).toContain("sha256");
		expect(serializedLog).toContain("messageCount");
	});
});
