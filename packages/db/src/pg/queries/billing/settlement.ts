import { and, eq, or } from "drizzle-orm";
import type { PgQueryClient } from "../../query-client";
import {
	billingAccounts,
	billingCreditEntries,
	billingPlanVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
	stripeMeterOutbox,
} from "../../schema/billing";
import type { settleBillingUsage as sqliteSettle } from "../../../queries/billing/settlement";
import {
	monetaryInferenceConfig,
	observedMonetaryInference,
} from "../../../queries/billing/monetary-inference";

/** Serialize one wallet; the period, debit, receipt and outbox commit together. */
export async function settleBillingUsage(
	db: PgQueryClient,
	input: Parameters<typeof sqliteSettle>[1],
) {
	const totalTokens = input.inputTokens + input.outputTokens;
	if (
		![
			input.inputTokens,
			input.outputTokens,
			totalTokens,
			input.providerCostMicros,
		].every((n) => Number.isSafeInteger(n) && n >= 0)
	)
		throw new Error("Settled usage requires non-negative safe integers");
	if (!input.gatewayLogId && !input.providerUsageId)
		throw new Error(
			"gatewayLogId or providerUsageId is required for settlement",
		);
	if (!input.reservationId)
		throw new Error(
			"billingReservationId is required for customer usage settlement",
		);
	const reservationId = input.reservationId;
	return db.transaction(async (tx) => {
		const [account] = await tx
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.organizationId, input.organizationId))
			.for("update");
		const duplicatePredicate = or(
			eq(billingUsageCharges.id, input.id),
			eq(billingUsageCharges.reservationId, reservationId),
			input.gatewayLogId
				? eq(billingUsageCharges.gatewayLogId, input.gatewayLogId)
				: undefined,
			input.providerUsageId
				? eq(billingUsageCharges.providerUsageId, input.providerUsageId)
				: undefined,
		);
		const findDuplicate = async () => {
			const [row] = await tx
				.select()
				.from(billingUsageCharges)
				.where(duplicatePredicate)
				.limit(1);
			if (
				row &&
				(row.organizationId !== input.organizationId ||
					row.reservationId !== reservationId)
			)
				throw new Error("Usage settlement identity mismatch");
			return row;
		};
		const duplicate = await findDuplicate();
		if (duplicate) return duplicate;
		const [reservation] = await tx
			.select()
			.from(billingUsageReservations)
			.where(
				and(
					eq(billingUsageReservations.id, reservationId),
					eq(billingUsageReservations.organizationId, input.organizationId),
				),
			)
			.for("update");
		if (!reservation)
			throw new Error(`Billing reservation not found: ${reservationId}`);
		if (!["reserved", "expired"].includes(reservation.status))
			throw new Error(
				`Billing reservation ${reservationId} cannot settle from ${reservation.status}`,
			);
		if (!account)
			throw new Error(
				`Billing reservation ${reservationId} is no longer settleable or its billing account is missing`,
			);
		const [plan] = await tx
			.select()
			.from(billingPlanVersions)
			.where(eq(billingPlanVersions.id, reservation.planVersionId))
			.limit(1);
		if (!plan)
			throw new Error(
				`Billing plan version not found: ${reservation.planVersionId}`,
			);
		const quote = observedMonetaryInference(reservation, input);
		if (monetaryInferenceConfig(plan) && !quote)
			throw new Error("Monetary settlement requires a pinned rate snapshot");
		if (quote && input.rateCardVersion !== quote.rateSnapshot.id)
			throw new Error(
				"Settlement receipt differs from reserved monetary price",
			);
		const periodId = `${input.organizationId}:${reservation.periodStart}`;
		await tx
			.insert(billingUsagePeriods)
			.values({
				id: periodId,
				organizationId: input.organizationId,
				planVersionId: plan.id,
				periodStart: reservation.periodStart,
				periodEnd: reservation.periodEnd,
				includedTokens: plan.includedMonthlyTokens,
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoNothing();
		const [period] = await tx
			.select()
			.from(billingUsagePeriods)
			.where(eq(billingUsagePeriods.id, periodId))
			.for("update");
		if (!period) throw new Error("Billing usage period missing");
		const b = BigInt,
			min = (a: bigint, c: bigint) => (a < c ? a : c),
			max = (a: bigint, c: bigint) => (a > c ? a : c);
		const used = b(period.usedInputTokens) + b(period.usedOutputTokens),
			tokens = b(totalTokens),
			included =
				period.includedTokens < 0
					? tokens
					: min(tokens, max(b(period.includedTokens) - used, 0n));
		const before =
				period.includedTokens < 0
					? 0n
					: max(used - b(period.includedTokens), 0n),
			after = before + tokens - included,
			unit = b(Math.max(1, plan.overageUnitTokens)),
			price = b(plan.overageUnitPriceMicros);
		const units = max(
				(after + unit - 1n) / unit - (before + unit - 1n) / unit,
				0n,
			),
			credited =
				price > 0n ? min(units, b(account.creditBalanceMicros) / price) : 0n,
			coverage =
				price > 0n ? (b(period.creditAppliedMicros) / price) * unit : 0n;
		let creditApplied = credited * price,
			metered = max(
				after - coverage - credited * unit - b(period.meteredOverageTokens),
				0n,
			),
			customerCharge = (units - credited) * price,
			includedApplied = included;
		if (plan.allowOverage && price > 0n && !account.overageEnabled) {
			creditApplied = 0n;
			metered = 0n;
			customerCharge = 0n;
		}
		if (quote) {
			const holds = await tx
				.select()
				.from(billingUsageReservations)
				.where(
					and(
						eq(billingUsageReservations.organizationId, input.organizationId),
						eq(billingUsageReservations.status, "reserved"),
					),
				);
			const otherHolds = holds
				.filter((r) => r.id !== reservationId && r.expiresAt > input.now)
				.reduce((sum, r) => sum + b(r.estimatedChargeMicros), 0n);
			creditApplied = min(
				b(quote.customerChargeMicros),
				min(
					b(reservation.estimatedChargeMicros),
					max(b(account.creditBalanceMicros) - otherHolds, 0n),
				),
			);
			metered = 0n;
			customerCharge = 0n;
			includedApplied = 0n;
		}
		const outboxId = crypto.randomUUID();
		const creditEntryId = crypto.randomUUID();
		const number = (value: bigint) => {
			if (
				value > b(Number.MAX_SAFE_INTEGER) ||
				value < b(Number.MIN_SAFE_INTEGER)
			)
				throw new Error("Settlement exceeds safe monetary precision");
			return Number(value);
		};
		const [charge] = await tx
			.insert(billingUsageCharges)
			.values({
				id: input.id,
				organizationId: input.organizationId,
				tediId: input.tediId ?? null,
				reservationId,
				usagePeriodId: periodId,
				gatewayLogId: input.gatewayLogId ?? null,
				providerUsageId: input.providerUsageId ?? null,
				provider: input.provider,
				model: input.model,
				source: input.source,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				includedTokensApplied: number(includedApplied),
				meteredOverageTokens: number(metered),
				providerCostMicros: input.providerCostMicros,
				customerChargeMicros: number(customerCharge),
				creditAppliedMicros: number(creditApplied),
				usageQuality: input.usageQuality,
				providerCostQuality: input.providerCostQuality,
				meteringReady: input.meteringReady,
				rateCardVersion: input.rateCardVersion ?? null,
				occurredAt: input.occurredAt,
				metadata: JSON.parse(
					JSON.stringify({
						...input.metadata,
						...(quote
							? {
									monetaryQuote: quote,
									absorbedChargeMicros:
										quote.customerChargeMicros - number(creditApplied),
								}
							: {}),
					}),
				),
				createdAt: input.now,
			})
			.onConflictDoNothing()
			.returning();
		if (!charge) {
			const duplicate = await findDuplicate();
			if (duplicate) return duplicate;
			throw new Error("Failed to settle billing usage");
		}
		await tx
			.update(billingUsagePeriods)
			.set({
				usedInputTokens: number(
					b(period.usedInputTokens) + b(input.inputTokens),
				),
				usedOutputTokens: number(
					b(period.usedOutputTokens) + b(input.outputTokens),
				),
				meteredOverageTokens: number(b(period.meteredOverageTokens) + metered),
				providerCostMicros: number(
					b(period.providerCostMicros) + b(input.providerCostMicros),
				),
				customerChargeMicros: number(
					b(period.customerChargeMicros) + customerCharge,
				),
				creditAppliedMicros: number(
					b(period.creditAppliedMicros) + creditApplied,
				),
				settlementVersion: period.settlementVersion + 1,
				lastSettlementId: input.id,
				updatedAt: input.now,
			})
			.where(eq(billingUsagePeriods.id, periodId));
		if (creditApplied > 0n)
			await tx.insert(billingCreditEntries).values({
				id: creditEntryId,
				organizationId: input.organizationId,
				kind: "debit",
				amountMicros: -number(creditApplied),
				sourceType: "usage_charge",
				sourceRef: input.id,
				usageChargeId: input.id,
				idempotencyKey: `usage-charge:${input.id}`,
				description: `Credits applied to ${input.model} usage`,
				metadata: {},
				createdAt: input.now,
			});
		await tx
			.update(billingUsageReservations)
			.set({ status: "settled", settledAt: input.now, updatedAt: input.now })
			.where(eq(billingUsageReservations.id, reservationId));
		if (
			input.meteringReady &&
			metered > 0n &&
			account.billingMode === "stripe" &&
			account.stripeEnvironment === (input.stripeEnvironment ?? "live") &&
			account.stripeCustomerId
		)
			await tx.insert(stripeMeterOutbox).values({
				id: outboxId,
				organizationId: input.organizationId,
				usageChargeId: input.id,
				stripeCustomerId: account.stripeCustomerId,
				stripeEnvironment: input.stripeEnvironment ?? "live",
				eventName: "token_usage",
				quantity: number(metered),
				idempotencyKey: `stripe-meter:${input.id}`,
				status: "pending",
				attemptCount: 0,
				nextAttemptAt: input.now,
				createdAt: input.now,
				updatedAt: input.now,
			});
		return charge;
	});
}
