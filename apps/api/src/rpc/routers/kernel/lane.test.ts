import {
	modelCatalogEntry,
	modelCatalogConfig,
} from "@tedix/api-contract/test/model-catalog";
import { describe, expect, it } from "vite-plus/test";
import {
	kernelModel as selectKernelModel,
	kernelServesWorkersAiLane,
	type KernelEnv,
} from "./llm";
const catalog = modelCatalogConfig(
	["cloudflare/auto", "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast"].map(
		(ref) => modelCatalogEntry(ref),
	),
);
const kernelModel = (...args: Parameters<typeof selectKernelModel>) =>
	selectKernelModel(args[0], args[1], args[2], catalog);
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
