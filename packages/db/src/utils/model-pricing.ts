/** Pure governed-rate arithmetic. This module has no model inventory or fallback. */
export interface ProviderTokenRates {
	inputMicrousdPerMillion: number;
	outputMicrousdPerMillion: number;
	cacheReadMicrousdPerMillion: number;
	cacheWriteMicrousdPerMillion: number;
}
export interface ProviderTokenUsage {
	/** Includes cache reads/writes; each token is priced in exactly one partition. */
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
}
export function computeCostMicros(
	rate: ProviderTokenRates,
	usage: ProviderTokenUsage,
): bigint | null {
	const counts = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
	];
	const prices = [
		rate.inputMicrousdPerMillion,
		rate.outputMicrousdPerMillion,
		rate.cacheReadMicrousdPerMillion,
		rate.cacheWriteMicrousdPerMillion,
	];
	if (
		[...counts, ...prices].some(
			(value) =>
				typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
		)
	)
		return null;
	const [input, output, read, write] = counts as number[];
	if (read! + write! > input!) return null;
	const numerator =
		BigInt(input! - read! - write!) * BigInt(prices[0]!) +
		BigInt(output!) * BigInt(prices[1]!) +
		BigInt(read!) * BigInt(prices[2]!) +
		BigInt(write!) * BigInt(prices[3]!);
	const micros = (numerator + 999999n) / 1000000n;
	return micros > BigInt(Number.MAX_SAFE_INTEGER) ? null : micros;
}

export function computeCost(
	rate: ProviderTokenRates,
	usage: ProviderTokenUsage,
): number | null {
	const micros = computeCostMicros(rate, usage);
	return micros === null ? null : Number(micros) / 1_000_000;
}
