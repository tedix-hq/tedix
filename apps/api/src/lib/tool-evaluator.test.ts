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
