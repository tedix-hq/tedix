/** Monetary inference quotes: this module grants no entitlement and writes no ledger. */
export const PROPOSED_USD_CREDIT_VALUE_MICROS = 10_000;

/** Normalized, disjoint buckets. Provider-inclusive input must be split upstream. */
export interface InferenceTokenBuckets {
	uncachedInput: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

export interface InferenceRateSnapshot {
	schemaVersion: 1;
	id: string;
	version: number;
	provider: string;
	model: string;
	currency: "USD";
	/** Managed rates cannot be reused for externally funded inference. */
	funding: "managed" | "byok";
	effectiveFrom: string;
	effectiveUntil: string | null;
	sourceReceipt: string;
	/** Independent prices, in USD micros per million tokens; zero is known/free.
	 * BYOK customer rates cover platform/service fees only, not external inference.
	 */
	providerRates: InferenceTokenBuckets;
	customerRates: InferenceTokenBuckets;
	creditValueMicros: number;
}

export interface InferenceCreditQuote {
	schemaVersion: 1;
	usageKind: "estimate" | "observed";
	occurredAt: string;
	funding: "managed" | "byok";
	rateSnapshot: Readonly<InferenceRateSnapshot>;
	tokens: Readonly<InferenceTokenBuckets>;
	/** Estimated economic cost, never evidence of a provider invoice. */
	providerEstimatedCostMicros: number;
	/** BYOK provider spend belongs to the customer's provider account. */
	tedixProviderEstimatedCostMicros: number;
	customerChargeMicros: number;
	/** Fractional display quantity; the monetary journal remains authoritative. */
	credits: number;
}

const BUCKETS = ["uncachedInput", "cacheRead", "cacheWrite", "output"] as const;

function integer(value: number, name: string, minimum = 0): void {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`Invalid ${name}: expected a safe integer >= ${minimum}`);
	}
}

function buckets(value: InferenceTokenBuckets, name: string): void {
	if (!value) throw new Error(`Missing ${name}`);
	for (const bucket of BUCKETS) integer(value[bucket], `${name}.${bucket}`);
}

function timestamp(value: string, name: string): number {
	// Require an explicit zone so execution-host timezone cannot change a quote.
	if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
		throw new Error(`Invalid ${name}: expected a timestamp with timezone`);
	}
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}`);
	return parsed;
}

function pricedMicros(
	tokens: InferenceTokenBuckets,
	rates: InferenceTokenBuckets,
) {
	// BigInt preserves exact products beyond Number.MAX_SAFE_INTEGER. Round
	// only once for the complete event, never per bucket or to whole credits.
	const numerator = BUCKETS.reduce(
		(sum, bucket) => sum + BigInt(tokens[bucket]) * BigInt(rates[bucket]),
		0n,
	);
	const micros = (numerator + 999_999n) / 1_000_000n;
	if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("Quoted amount exceeds safe monetary precision");
	}
	return Number(micros);
}

export function quoteInferenceCredits(input: {
	tokens: InferenceTokenBuckets;
	rate: InferenceRateSnapshot;
	occurredAt: string;
	usageKind: "estimate" | "observed";
	funding: "managed" | "byok";
}): Readonly<InferenceCreditQuote> {
	const { rate, tokens } = input;
	if (!rate || rate.schemaVersion !== 1 || rate.currency !== "USD") {
		throw new Error("A supported USD rate snapshot is required");
	}
	for (const key of ["id", "provider", "model", "sourceReceipt"] as const) {
		if (typeof rate[key] !== "string" || !rate[key].trim()) {
			throw new Error(`Missing rate ${key}`);
		}
	}
	integer(rate.version, "rate version", 1);
	integer(rate.creditValueMicros, "credit value", 1);
	buckets(tokens, "tokens");
	buckets(rate.providerRates, "provider rates");
	buckets(rate.customerRates, "customer rates");
	const at = timestamp(input.occurredAt, "occurredAt");
	const from = timestamp(rate.effectiveFrom, "effectiveFrom");
	const until =
		rate.effectiveUntil === null
			? null
			: timestamp(rate.effectiveUntil, "effectiveUntil");
	if (at < from || (until !== null && (until <= from || at >= until))) {
		throw new Error("Rate snapshot does not apply at occurredAt");
	}
	if (!["managed", "byok"].includes(input.funding))
		throw new Error("Invalid funding");
	if (rate.funding !== input.funding)
		throw new Error("Rate snapshot does not apply to funding mode");
	if (!["estimate", "observed"].includes(input.usageKind))
		throw new Error("Invalid usage kind");
	const providerEstimatedCostMicros = pricedMicros(tokens, rate.providerRates);
	const customerChargeMicros = pricedMicros(tokens, rate.customerRates);
	return Object.freeze({
		schemaVersion: 1,
		usageKind: input.usageKind,
		occurredAt: input.occurredAt,
		funding: input.funding,
		rateSnapshot: Object.freeze({
			...rate,
			providerRates: Object.freeze({ ...rate.providerRates }),
			customerRates: Object.freeze({ ...rate.customerRates }),
		}),
		tokens: Object.freeze({ ...tokens }),
		providerEstimatedCostMicros,
		tedixProviderEstimatedCostMicros:
			input.funding === "byok" ? 0 : providerEstimatedCostMicros,
		customerChargeMicros,
		credits: customerChargeMicros / rate.creditValueMicros,
	});
}
