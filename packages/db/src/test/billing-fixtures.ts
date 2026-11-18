// Inputs shared by the existing SQLite billing regressions and Postgres parity.
export const monetaryNow = "2026-10-11T12:00:00.000Z";
export const monetaryRate = {
	schemaVersion: 1,
	id: "fictional-price-1",
	version: 1,
	provider: "fictional",
	model: "fictional-model",
	deploymentScope: "fictional-scope",
	currency: "USD",
	customerCurrency: "EUR",
	// Keep the original fixture amounts readable at a 1:1 exchange rate.
	fx: {
		microUsdPerEur: 1_000_000,
		source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
		asOf: "2026-10-09",
	},
	funding: "managed",
	effectiveFrom: "2026-10-01T00:00:00.000Z",
	effectiveUntil: null,
	sourceReceipt: "fictional-receipt",
	creditValueMicros: 10_000,
	inputConvention: "inclusive",
	providerRates: {
		uncachedInput: 1_000_000,
		cacheRead: 100_000,
		cacheWrite: 2_000_000,
		output: 5_000_000,
	},
	customerRates: {
		uncachedInput: 1_000_000,
		cacheRead: 100_000,
		cacheWrite: 2_000_000,
		output: 5_000_000,
	},
};
export function monetaryReservation(id: string) {
	return {
		id,
		organizationId: "org",
		source: "kernel" as const,
		provider: "fictional",
		model: "fictional-model",
		deploymentScope: "fictional-scope",
		estimatedInputTokens: 1_000,
		estimatedOutputTokens: 100,
		idempotencyKey: `key:${id}`,
		expiresAt: "2026-10-11T12:10:00.000Z",
		now: monetaryNow,
		runId: "fictional-run",
		aiGatewayLimits: { organizationDailyTokenLimit: 1, tediDailyTokenLimit: 1 },
	};
}
export function monetaryUsage(reservationId: string, id = "charge") {
	return {
		id,
		reservationId,
		organizationId: "org",
		gatewayLogId: `gateway:${id}`,
		provider: "fictional",
		model: "fictional-model",
		source: "kernel" as const,
		inputTokens: 1_000,
		outputTokens: 50,
		providerCostMicros: 1_170,
		usageQuality: "provider_reported" as const,
		providerCostQuality: "estimated" as const,
		meteringReady: true,
		rateCardVersion: "fictional-price-1",
		occurredAt: monetaryNow,
		now: monetaryNow,
		metadata: { cacheReadTokens: 200, cacheWriteTokens: 100 },
	};
}

export const settlementNow = "2026-10-22T12:00:00.000Z";
export function settlementUsage(i: number, settler: number) {
	return {
		id: `charge:${i}:${settler}`,
		organizationId: "org",
		reservationId: `reservation:${i}`,
		gatewayLogId: `gateway:${i}`,
		provider: "fictional",
		model: "fictional",
		source: "kernel" as const,
		inputTokens: 1000,
		outputTokens: 100,
		providerCostMicros: 7,
		usageQuality: "provider_reported" as const,
		providerCostQuality: "estimated" as const,
		meteringReady: true,
		occurredAt: settlementNow,
		now: settlementNow,
	};
}
