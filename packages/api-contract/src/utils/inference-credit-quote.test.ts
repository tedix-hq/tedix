import { describe, expect, it } from "vite-plus/test";
import {
	quoteInferenceCredits,
	CREDIT_VALUE_MICROS,
	type InferenceRateSnapshot,
} from "./inference-credit-quote";

const zero = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
function fixture() {
	const rate: InferenceRateSnapshot = {
		schemaVersion: 1,
		id: "fictional-rate-v1",
		version: 1,
		provider: "fictional-provider",
		model: "fictional-model",
		currency: "USD",
		funding: "managed",
		effectiveFrom: "2026-10-01T00:00:00Z",
		effectiveUntil: "2026-11-01T00:00:00Z",
		sourceReceipt: "fictional-published-rate-receipt",
		providerRates: {
			uncachedInput: 1_000_000,
			cacheRead: 100_000,
			cacheWrite: 2_000_000,
			output: 5_000_000,
		},
		customerRates: {
			uncachedInput: 2_000_000,
			cacheRead: 200_000,
			cacheWrite: 3_000_000,
			output: 8_000_000,
		},
		creditValueMicros: CREDIT_VALUE_MICROS,
	};
	return {
		rate,
		tokens: {
			uncachedInput: 1_000,
			cacheRead: 2_000,
			cacheWrite: 100,
			output: 50,
		},
		occurredAt: "2026-10-11T00:00:00Z",
		funding: "managed" as const,
		usageKind: "observed" as const,
	};
}

describe("versioned monetary inference quote", () => {
	it("weights disjoint cache/input/output and keeps provider cost separate from the customer price", () => {
		expect(quoteInferenceCredits(fixture())).toMatchObject({
			providerEstimatedCostMicros: 1_650,
			tedixProviderEstimatedCostMicros: 1_650,
			customerChargeMicros: 3_100,
			credits: 0.31,
		});
	});
	it("rounds sub-micro buckets once for the event, without a whole-credit minimum", () => {
		const input = fixture();
		input.rate.customerRates = {
			uncachedInput: 100_000,
			cacheRead: 100_000,
			cacheWrite: 100_000,
			output: 100_000,
		};
		input.tokens = { uncachedInput: 1, cacheRead: 1, cacheWrite: 1, output: 1 };
		expect(quoteInferenceCredits(input)).toMatchObject({
			customerChargeMicros: 1,
			credits: 0.0001,
		});
	});
	it("BYOK does not record customer provider spend as Tedix liability or assume platform use is free", () => {
		const input = fixture();
		input.rate.funding = "byok";
		expect(quoteInferenceCredits({ ...input, funding: "byok" })).toMatchObject({
			providerEstimatedCostMicros: 1_650,
			tedixProviderEstimatedCostMicros: 0,
			customerChargeMicros: 3_100,
		});
	});
	it("pins a frozen independent rate receipt against later caller mutations", () => {
		const input = fixture();
		const quote = quoteInferenceCredits(input);
		input.rate.customerRates.output = 100;
		input.tokens.output = 0;
		expect(quote.rateSnapshot.customerRates.output).toBe(8_000_000);
		expect(quote.tokens.output).toBe(50);
		expect(Object.isFrozen(quote.rateSnapshot.customerRates)).toBe(true);
		expect(Object.isFrozen(quote)).toBe(true);
	});
	it("known zero pricing is valid; missing cache pricing fails closed", () => {
		const input = fixture();
		input.rate.customerRates = { ...zero };
		expect(quoteInferenceCredits(input).customerChargeMicros).toBe(0);
		Reflect.deleteProperty(input.rate.customerRates, "cacheRead");
		expect(() => quoteInferenceCredits(input)).toThrow(
			"customer rates.cacheRead",
		);
	});
	it("missing usage and provider pricing cannot be silently treated as zero", () => {
		const input = fixture();
		Reflect.deleteProperty(input.tokens, "cacheWrite");
		expect(() => quoteInferenceCredits(input)).toThrow("tokens.cacheWrite");
		const next = fixture();
		Reflect.deleteProperty(next.rate.providerRates, "cacheRead");
		expect(() => quoteInferenceCredits(next)).toThrow(
			"provider rates.cacheRead",
		);
	});
	it("BYOK can declare zero platform fees without hiding external provider cost", () => {
		const input = fixture();
		input.rate.funding = "byok";
		input.rate.customerRates = { ...zero };
		expect(quoteInferenceCredits({ ...input, funding: "byok" })).toMatchObject({
			customerChargeMicros: 0,
			credits: 0,
			providerEstimatedCostMicros: 1_650,
			tedixProviderEstimatedCostMicros: 0,
		});
	});
	it("cannot reuse managed inference prices for BYOK", () => {
		expect(() =>
			quoteInferenceCredits({ ...fixture(), funding: "byok" }),
		).toThrow("funding mode");
		const input = fixture();
		input.rate.funding = "byok";
		expect(() => quoteInferenceCredits(input)).toThrow("funding mode");
	});
	it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid usage %s",
		(value) => {
			const input = fixture();
			input.tokens.cacheRead = value;
			expect(() => quoteInferenceCredits(input)).toThrow("tokens.cacheRead");
		},
	);
	it("uses a half-open price validity interval and requires an explicit timezone", () => {
		const input = fixture();
		expect(() =>
			quoteInferenceCredits({ ...input, occurredAt: input.rate.effectiveFrom }),
		).not.toThrow();
		expect(() =>
			quoteInferenceCredits({
				...input,
				occurredAt: input.rate.effectiveUntil!,
			}),
		).toThrow("does not apply");
		expect(() =>
			quoteInferenceCredits({ ...input, occurredAt: "2026-10-11T00:00:00" }),
		).toThrow("timezone");
	});
	it("requires rate identity, positive credit denomination and an independent customer rate", () => {
		const input = fixture();
		expect(() =>
			quoteInferenceCredits({
				...input,
				rate: { ...input.rate, sourceReceipt: "" },
			}),
		).toThrow("sourceReceipt");
		expect(() =>
			quoteInferenceCredits({
				...input,
				rate: { ...input.rate, creditValueMicros: 0 },
			}),
		).toThrow("credit value");
	});
	it("uses exact arithmetic for large products and refuses amounts beyond safe journal precision", () => {
		const input = fixture();
		input.tokens = { ...zero, uncachedInput: Number.MAX_SAFE_INTEGER };
		input.rate.providerRates = { ...zero, uncachedInput: 1 };
		input.rate.customerRates = { ...zero, uncachedInput: 1 };
		expect(quoteInferenceCredits(input).customerChargeMicros).toBe(
			9_007_199_255,
		);
		input.rate.customerRates.uncachedInput = Number.MAX_SAFE_INTEGER;
		expect(() => quoteInferenceCredits(input)).toThrow(
			"safe monetary precision",
		);
	});
});
