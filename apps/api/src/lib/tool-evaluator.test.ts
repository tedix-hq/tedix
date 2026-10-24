import { expect, it, vi } from "vite-plus/test";
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

it.each([
	"[]",
	'[{"id":"o1"}]',
	"42",
	"0",
	"true",
	"false",
	'"text"',
	'""',
	"null",
	"```json\n[]\n```",
	"Generated input: [1, 2]",
])("falls back to object arguments for model JSON %s", async (response) => {
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
});

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
