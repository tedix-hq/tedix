import { describe, expect, it } from "vite-plus/test";
import { computeCost } from "./model-pricing";
const rate = {
	inputMicrousdPerMillion: 1000000,
	outputMicrousdPerMillion: 4000000,
	cacheReadMicrousdPerMillion: 100000,
	cacheWriteMicrousdPerMillion: 2000000,
};
describe("governed token arithmetic", () => {
	it("partitions cached input and rounds only the combined estimate", () =>
		expect(
			computeCost(rate, {
				inputTokens: 1000,
				outputTokens: 100,
				cacheReadTokens: 500,
				cacheWriteTokens: 100,
			}),
		).toBe(0.00105));
	it("accepts explicit zero without treating missing usage as free", () => {
		expect(
			computeCost(rate, {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		).toBe(0);
		expect(
			computeCost(rate, {
				inputTokens: null,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		).toBeNull();
	});
	it.each([-1, NaN, Infinity, 0.5])("rejects invalid count %s", (inputTokens) =>
		expect(
			computeCost(rate, {
				inputTokens,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		).toBeNull(),
	);
	it("rejects overlapping cache partitions and overflow", () => {
		expect(
			computeCost(rate, {
				inputTokens: 1,
				outputTokens: 0,
				cacheReadTokens: 2,
				cacheWriteTokens: 0,
			}),
		).toBeNull();
		expect(
			computeCost(
				{ ...rate, inputMicrousdPerMillion: Number.MAX_SAFE_INTEGER },
				{
					inputTokens: Number.MAX_SAFE_INTEGER,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			),
		).toBeNull();
	});
});
