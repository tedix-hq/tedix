import { describe, expect, it } from "vite-plus/test";
import { RunEvalInputSchema } from "./mcp-eval";
describe("MCP evaluation model selection", () => {
	it("defaults generative evaluation to Auto Router", () => {
		expect(RunEvalInputSchema.parse({ appSlug: "tedix" }).model).toBe(
			"cloudflare/auto",
		);
	});
	it("preserves custom refs for supported evaluation transports before registry admission", () => {
		for (const model of ["azure-openai/sample-eval", "workers-ai/sample-eval"])
			expect(RunEvalInputSchema.parse({ appSlug: "tedix", model }).model).toBe(
				model,
			);
	});
	it("rejects malformed refs and providers unsupported by evaluation transport", () => {
		for (const model of [
			"sample-eval",
			"workers-ai/",
			"unknown/sample-eval",
			"openai/sample-eval",
		])
			expect(
				RunEvalInputSchema.safeParse({ appSlug: "tedix", model }).success,
			).toBe(false);
	});
});
