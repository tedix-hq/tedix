/**
 * Workers AI token rates derived from what Cloudflare bills: Neurons.
 *
 * Cloudflare publishes, per model, how many Neurons one million input, cached
 * input and output tokens cost, and bills $0.011 per 1,000 Neurons. That price
 * is exactly 11 USD micros per Neuron, so the governed per-million-token rate
 * is an integer: neurons per million tokens times 11. The daily free
 * allocation (10,000 Neurons) is an account-level discount and is not part of
 * a per-call rate.
 */
import type { ProviderTokenRates, ProviderTokenUsage } from "./model-pricing";

/** $0.011 per 1,000 Neurons = 11 USD micros per Neuron. */
export const WORKERS_AI_MICROUSD_PER_NEURON = 11;

/** One row of Cloudflare's published Neuron table. */
export interface WorkersAiNeuronRate {
	inputNeuronsPerMillion: number;
	/** Null when Cloudflare lists no cached-input price: cached tokens bill as input. */
	cachedInputNeuronsPerMillion: number | null;
	outputNeuronsPerMillion: number;
}

function assertNeuronCount(value: number, label: string) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${label} must be a non-negative integer`);
}

/**
 * Governed token rates for one model. Cloudflare has no cache-write charge:
 * a token written to the prompt cache is billed as an ordinary input token.
 */
export function workersAiTokenRatesFromNeurons(
	rate: WorkersAiNeuronRate,
): ProviderTokenRates {
	assertNeuronCount(rate.inputNeuronsPerMillion, "inputNeuronsPerMillion");
	assertNeuronCount(rate.outputNeuronsPerMillion, "outputNeuronsPerMillion");
	if (rate.cachedInputNeuronsPerMillion !== null)
		assertNeuronCount(
			rate.cachedInputNeuronsPerMillion,
			"cachedInputNeuronsPerMillion",
		);
	const input = rate.inputNeuronsPerMillion * WORKERS_AI_MICROUSD_PER_NEURON;
	return {
		inputMicrousdPerMillion: input,
		outputMicrousdPerMillion:
			rate.outputNeuronsPerMillion * WORKERS_AI_MICROUSD_PER_NEURON,
		cacheReadMicrousdPerMillion:
			(rate.cachedInputNeuronsPerMillion ?? rate.inputNeuronsPerMillion) *
			WORKERS_AI_MICROUSD_PER_NEURON,
		cacheWriteMicrousdPerMillion: input,
	};
}

/**
 * Neurons Cloudflare bills for one usage record. `inputTokens` includes cache
 * reads and writes, as in `ProviderTokenUsage`. Returns null for invalid usage.
 */
export function workersAiNeuronsForUsage(
	rate: WorkersAiNeuronRate,
	usage: ProviderTokenUsage,
): number | null {
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
		usage;
	if (
		[inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(
			(value) =>
				typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
		) ||
		cacheReadTokens! + cacheWriteTokens! > inputTokens!
	)
		return null;
	const cached =
		rate.cachedInputNeuronsPerMillion ?? rate.inputNeuronsPerMillion;
	return (
		((inputTokens! - cacheReadTokens!) * rate.inputNeuronsPerMillion +
			cacheReadTokens! * cached +
			outputTokens! * rate.outputNeuronsPerMillion) /
		1_000_000
	);
}
