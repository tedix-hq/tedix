import { describe, expect, it } from "vite-plus/test";
import { RunEvalInputSchema } from "./mcp-eval";
describe("MCP evaluation model selection", () => {
	it("defaults generative evaluation to Auto Router", () => {
		expect(RunEvalInputSchema.parse({ appSlug: "tedix" }).model).toBe(
			"cloudflare/auto",
		);
	});
	it("preserves canonical explicit fixed selections and rejects legacy or invalid refs", () => {
		for (const model of [
			"azure-openai/gpt-5.6-terra",
			"workers-ai/@cf/openai/gpt-oss-120b",
		])
			expect(RunEvalInputSchema.parse({ appSlug: "tedix", model }).model).toBe(
				model,
			);
		for (const model of [
			"gpt-5.6-terra",
			"workers-ai/not-real",
			"openai/not-real",
		])
			expect(
				RunEvalInputSchema.safeParse({ appSlug: "tedix", model }).success,
			).toBe(false);
	});
});
