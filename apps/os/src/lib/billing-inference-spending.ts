import type { BillingInferenceSpending } from "@tedix/api-contract/schemas/billing-spending";

export function groupSettledCreditCharges(
	rows: BillingInferenceSpending["rows"],
) {
	const seen = new Set<string>();
	const groups = new Map<string | null, BillingInferenceSpending["rows"]>();
	for (const row of rows) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		const calls = groups.get(row.runId) ?? [];
		calls.push(row);
		groups.set(row.runId, calls);
	}
	return [...groups].map(([runId, calls]) => {
		const total = calls.reduce(
			(sum, row) =>
				sum +
				BigInt(row.creditAppliedMicros) +
				BigInt(row.customerChargeMicros),
			0n,
		);
		const denomination = calls[0]?.creditValueMicros ?? null;
		return {
			runId,
			calls,
			chargeMicros:
				total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null,
			creditValueMicros:
				denomination !== null &&
				calls.every((row) => row.creditValueMicros === denomination)
					? denomination
					: null,
			pricesPinned: calls.every((row) => row.rateVersionId !== null),
		};
	});
}

/** A conditional pace estimate, never a promise of future runtime capacity. */
export function settledCreditCoverage(input: {
	spentMicros: number;
	availableMicros: number;
	reservedMicros: number;
	monthlyCapMicros: number | null;
	periodStart: string;
	periodEnd: string;
	nowMs: number;
}): number | null {
	const elapsedDays =
		(input.nowMs - Date.parse(input.periodStart)) / 86_400_000;
	const remainingDays =
		(Date.parse(input.periodEnd) - input.nowMs) / 86_400_000;
	if (
		!Number.isFinite(elapsedDays) ||
		!Number.isFinite(remainingDays) ||
		elapsedDays < 1 ||
		remainingDays <= 0 ||
		input.spentMicros <= 0
	)
		return null;
	const spendable = Math.max(
		0,
		Math.min(
			input.availableMicros,
			input.monthlyCapMicros === null
				? input.availableMicros
				: input.monthlyCapMicros - input.spentMicros - input.reservedMicros,
		),
	);
	const days = (spendable / input.spentMicros) * elapsedDays;
	return Number.isFinite(days)
		? Math.floor(Math.min(days, remainingDays) * 10) / 10
		: null;
}
