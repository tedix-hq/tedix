import { describe, expect, it } from "vite-plus/test";
import { kernelModel, kernelServesWorkersAiLane, type KernelEnv } from "./llm";
const env = {
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_LLM_ID: "gateway",
	CF_AI_GATEWAY_TOKEN: "token",
	AI: { run: async () => ({ response: "{}" }) },
} as unknown as KernelEnv;
describe("selected kernel provider lane", () => {
	it("does not assign Auto Router the legacy small Workers AI window", () => {
		expect(kernelServesWorkersAiLane(kernelModel(env))).toBe(false);
	});
	it("sizes an explicitly selected Workers AI model in its own lane", () => {
		expect(
			kernelServesWorkersAiLane(
				kernelModel(env, {
					modelRef: "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast",
				}),
			),
		).toBe(true);
	});
});
