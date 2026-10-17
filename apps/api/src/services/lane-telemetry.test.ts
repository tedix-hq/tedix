import { describe, expect, it } from "vite-plus/test";
import { estimateLaneUsage } from "./lane-telemetry";
import type { LaneTelemetryInputSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import type * as z from "zod";

const rates = [
	{
		id: "short",
		modelId: "fictional-model",
		inputTokenMin: 0,
		inputTokenMax: 100,
		inputMicrousdPerMillion: 2_000_000,
		cacheReadMicrousdPerMillion: 100_000,
		cacheWriteMicrousdPerMillion: 2_500_000,
		outputMicrousdPerMillion: 10_000_000,
	},
	{
		id: "long",
		modelId: "fictional-model",
		inputTokenMin: 100,
		inputTokenMax: null,
		inputMicrousdPerMillion: 4_000_000,
		cacheReadMicrousdPerMillion: 200_000,
		cacheWriteMicrousdPerMillion: 5_000_000,
		outputMicrousdPerMillion: 15_000_000,
	},
] as Parameters<typeof estimateLaneUsage>[1];
const sample = {
	model: "fictional-model",
	input: 90,
	cached: 80,
	output: 10,
	reasoning: 5,
	cacheWrite: 0,
};
const input = {
	usage: { input: 180, cached: 160, output: 20, reasoning: 10 },
	usageSamples: [sample, sample],
} as z.output<typeof LaneTelemetryInputSchema>;
describe("lane list-price estimates", () => {
	it("tiers each request and counts cached/reasoning subsets exactly once", () => {
		expect(estimateLaneUsage(input, rates)).toEqual({
			costUsd: 0.000256,
			rateVersionId: "short",
			rateVersionIds: ["short"],
		});
	});
	it("selects long context only for requests across the boundary", () => {
		const usage = { input: 100, cached: 80, output: 10, reasoning: 5 };
		expect(
			estimateLaneUsage(
				{ ...input, usage, usageSamples: [{ ...sample, ...usage }] },
				rates,
			),
		).toEqual({
			costUsd: 0.000246,
			rateVersionId: "long",
			rateVersionIds: ["long"],
		});
	});
	it("leaves incomplete samples, unknown models, overlapping rates and invalid partitions unpriced", () => {
		for (const observed of [
			{ ...input, usageSamples: [sample] },
			{ ...input, usageSamples: [sample, { ...sample, model: "unknown" }] },
			{
				...input,
				usage: { input: 180, cached: 190, output: 20, reasoning: 10 },
				usageSamples: [
					{ ...sample, cached: 95 },
					{ ...sample, cached: 95 },
				],
			},
		])
			expect(estimateLaneUsage(observed, rates).costUsd).toBeNull();
		expect(estimateLaneUsage(input, [...rates, rates[0]!]).costUsd).toBeNull();
	});
});
