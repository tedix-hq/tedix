import { describe, expect, it } from "vite-plus/test";
import { computeCostMicros } from "./model-pricing";
import {
	workersAiNeuronsForUsage,
	workersAiTokenRatesFromNeurons,
} from "./workers-ai-neuron-pricing";

// Cloudflare's published row for @cf/moonshotai/kimi-k2.7-code.
const kimi = {
	inputNeuronsPerMillion: 86364,
	cachedInputNeuronsPerMillion: 17273,
	outputNeuronsPerMillion: 363636,
};

describe("Workers AI rates from Neurons", () => {
	it("prices one Neuron at 11 USD micros ($0.011 per 1,000)", () =>
		expect(workersAiTokenRatesFromNeurons(kimi)).toEqual({
			inputMicrousdPerMillion: 950004,
			outputMicrousdPerMillion: 3999996,
			cacheReadMicrousdPerMillion: 190003,
			cacheWriteMicrousdPerMillion: 950004,
		}));

	it("bills cached tokens as input when no cached price is listed", () =>
		expect(
			workersAiTokenRatesFromNeurons({
				inputNeuronsPerMillion: 26668,
				cachedInputNeuronsPerMillion: null,
				outputNeuronsPerMillion: 204805,
			}),
		).toEqual({
			inputMicrousdPerMillion: 293348,
			outputMicrousdPerMillion: 2252855,
			cacheReadMicrousdPerMillion: 293348,
			cacheWriteMicrousdPerMillion: 293348,
		}));

	it("rejects fractional or negative Neuron counts", () => {
		expect(() =>
			workersAiTokenRatesFromNeurons({ ...kimi, inputNeuronsPerMillion: 1.5 }),
		).toThrow(RangeError);
		expect(() =>
			workersAiTokenRatesFromNeurons({
				...kimi,
				cachedInputNeuronsPerMillion: -1,
			}),
		).toThrow(RangeError);
	});

	it("gives the same cost as Neurons times $0.011 per 1,000", () => {
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 10_000,
			cacheReadTokens: 800_000,
			cacheWriteTokens: 0,
		};
		const neurons = workersAiNeuronsForUsage(kimi, usage)!;
		// 200k uncached + 800k cached input + 10k output.
		expect(neurons).toBeCloseTo(0.2 * 86364 + 0.8 * 17273 + 0.01 * 363636, 9);
		expect(
			Number(computeCostMicros(workersAiTokenRatesFromNeurons(kimi), usage)),
		).toBe(Math.ceil(neurons * 11));
	});

	it("rejects usage whose cached tokens exceed input", () =>
		expect(
			workersAiNeuronsForUsage(kimi, {
				inputTokens: 10,
				outputTokens: 0,
				cacheReadTokens: 11,
				cacheWriteTokens: 0,
			}),
		).toBeNull());
});
