/** Canonical billing settlement queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, or } from "drizzle-orm";
import type { D1Executor, DbClient } from "../../client";
import {
	type BillingPlanVersion,
	type BillingUsageCharge,
	type BillingUsagePeriod,
	type BillingUsageSource,
	billingAccounts,
	billingPlanVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
} from "../../schema/billing";

const STRIPE_TOKEN_METER_EVENT = "token_usage";

function ceilUnits(tokens: number, unitTokens: number): number {
	if (tokens <= 0) return 0;
	return Math.ceil(tokens / Math.max(1, unitTokens));
}

function usageDuplicatePredicate(input: {
	gatewayLogId?: string | null;
	providerUsageId?: string | null;
}) {
	const predicates = [];
	if (input.gatewayLogId) {
		predicates.push(eq(billingUsageCharges.gatewayLogId, input.gatewayLogId));
	}
	if (input.providerUsageId) {
		predicates.push(
			eq(billingUsageCharges.providerUsageId, input.providerUsageId),
		);
	}
	return or(...predicates);
}

async function findExistingBillingUsageCharge(
	db: DbClient,
	input: {
		gatewayLogId?: string | null;
		providerUsageId?: string | null;
	},
): Promise<BillingUsageCharge | null> {
	const [existing] = await db
		.select()
		.from(billingUsageCharges)
		.where(usageDuplicatePredicate(input))
		.limit(1);
	return existing ?? null;
}

interface SettlementAmounts {
	includedTokensApplied: number;
	stripeMeteredTokens: number;
	customerChargeMicros: number;
	creditAppliedMicros: number;
}

function calculateSettlementAmounts(input: {
	totalTokens: number;
	period: BillingUsagePeriod;
	plan: BillingPlanVersion;
	creditBalanceMicros: number;
}): SettlementAmounts {
	const { totalTokens, period, plan } = input;
	const usedBefore = period.usedInputTokens + period.usedOutputTokens;
	const remainingIncluded =
		period.includedTokens < 0
			? totalTokens
			: Math.max(period.includedTokens - usedBefore, 0);
	const includedTokensApplied = Math.min(totalTokens, remainingIncluded);
	const overageTokens = Math.max(totalTokens - includedTokensApplied, 0);
	const overageBefore =
		period.includedTokens < 0
			? 0
			: Math.max(usedBefore - period.includedTokens, 0);
	const overageAfter = overageBefore + overageTokens;
	const overageUnitsBefore = ceilUnits(overageBefore, plan.overageUnitTokens);
	const overageUnitsAfter = ceilUnits(overageAfter, plan.overageUnitTokens);
	const incrementalOverageUnits = Math.max(
		overageUnitsAfter - overageUnitsBefore,
		0,
	);
	const grossChargeMicros =
		incrementalOverageUnits * plan.overageUnitPriceMicros;
	const affordableCreditUnits =
		plan.overageUnitPriceMicros > 0
			? Math.floor(input.creditBalanceMicros / plan.overageUnitPriceMicros)
			: 0;
	const creditedUnits = Math.min(
		incrementalOverageUnits,
		affordableCreditUnits,
	);
	const creditAppliedMicros = creditedUnits * plan.overageUnitPriceMicros;
	const creditedCoverageBefore =
		plan.overageUnitPriceMicros > 0
			? Math.floor(period.creditAppliedMicros / plan.overageUnitPriceMicros) *
				plan.overageUnitTokens
			: 0;
	const creditedCoverageAfter =
		creditedCoverageBefore + creditedUnits * plan.overageUnitTokens;
	const stripeMeteredTotalAfter = Math.max(
		overageAfter - creditedCoverageAfter,
		0,
	);
	const stripeMeteredTokens = Math.max(
		stripeMeteredTotalAfter - period.meteredOverageTokens,
		0,
	);
	return {
		includedTokensApplied,
		stripeMeteredTokens,
		customerChargeMicros: grossChargeMicros - creditAppliedMicros,
		creditAppliedMicros,
	};
}

export async function settleBillingUsage(
	db: DbClient,
	input: {
		stripeEnvironment?: "test" | "live";
		id: string;
		organizationId: string;
		tediId?: string | null;
		reservationId?: string | null;
		gatewayLogId?: string | null;
		providerUsageId?: string | null;
		provider: string;
		model: string;
		source: BillingUsageSource;
		inputTokens: number;
		outputTokens: number;
		providerCostMicros: number;
		usageQuality: BillingUsageCharge["usageQuality"];
		providerCostQuality: BillingUsageCharge["providerCostQuality"];
		meteringReady: boolean;
		rateCardVersion?: string | null;
		occurredAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingUsageCharge> {
	const totalTokens = input.inputTokens + input.outputTokens;
	if (
		!Number.isSafeInteger(input.inputTokens) ||
		input.inputTokens < 0 ||
		!Number.isSafeInteger(input.outputTokens) ||
		input.outputTokens < 0 ||
		!Number.isSafeInteger(totalTokens) ||
		totalTokens < 0 ||
		!Number.isSafeInteger(input.providerCostMicros) ||
		input.providerCostMicros < 0
	) {
		throw new Error("Settled usage requires non-negative safe integers");
	}
	if (!input.gatewayLogId && !input.providerUsageId) {
		throw new Error(
			"gatewayLogId or providerUsageId is required for settlement",
		);
	}
	if (!input.reservationId) {
		throw new Error(
			"billingReservationId is required for customer usage settlement",
		);
	}

	const duplicate = await findExistingBillingUsageCharge(db, input);
	if (duplicate) return duplicate;

	const [reservation] = await db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.id, input.reservationId),
				eq(billingUsageReservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!reservation) {
		throw new Error(`Billing reservation not found: ${input.reservationId}`);
	}
	if (!["reserved", "expired"].includes(reservation.status)) {
		throw new Error(
			`Billing reservation ${input.reservationId} cannot settle from ${reservation.status}`,
		);
	}

	const [plan] = await db
		.select()
		.from(billingPlanVersions)
		.where(eq(billingPlanVersions.id, reservation.planVersionId))
		.limit(1);
	if (!plan) {
		throw new Error(
			`Billing plan version not found: ${reservation.planVersionId}`,
		);
	}

	const periodId = `${input.organizationId}:${reservation.periodStart}`;
	await db
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

	const metadata = JSON.stringify(input.metadata ?? {});
	const duplicateSql = `(
		(? IS NOT NULL AND gateway_log_id = ?)
		OR (? IS NOT NULL AND provider_usage_id = ?)
	)`;
	// Narrower than D1Database on purpose: this only needs prepare + batch, which
	// a D1DatabaseSession also provides, so these writes work unchanged when the
	// caller passes a session-backed client (see createDbSession).
	const d1 = db.$client as D1Executor;

	for (let attempt = 0; attempt < 5; attempt++) {
		const existing = await findExistingBillingUsageCharge(db, input);
		if (existing) return existing;

		const [[period], [account]] = await Promise.all([
			db
				.select()
				.from(billingUsagePeriods)
				.where(eq(billingUsagePeriods.id, periodId))
				.limit(1),
			db
				.select({
					creditBalanceMicros: billingAccounts.creditBalanceMicros,
				})
				.from(billingAccounts)
				.where(eq(billingAccounts.organizationId, input.organizationId))
				.limit(1),
		]);
		if (!period) throw new Error("Failed to load billing usage period");
		if (!account) {
			throw new Error(
				`Billing account not found for organization ${input.organizationId}`,
			);
		}

		const amounts = calculateSettlementAmounts({
			totalTokens,
			period,
			plan,
			creditBalanceMicros: account.creditBalanceMicros,
		});
		const nextSettlementVersion = period.settlementVersion + 1;
		const outboxId = crypto.randomUUID();
		const creditEntryId = crypto.randomUUID();

		const updatePeriod = d1
			.prepare(
				`UPDATE billing_usage_periods
				 SET used_input_tokens = used_input_tokens + ?,
				     used_output_tokens = used_output_tokens + ?,
				     metered_overage_tokens = metered_overage_tokens + ?,
				     provider_cost_micros = provider_cost_micros + ?,
				     customer_charge_micros = customer_charge_micros + ?,
				     credit_applied_micros = credit_applied_micros + ?,
				     settlement_version = settlement_version + 1,
				     last_settlement_id = ?,
				     updated_at = ?
				 WHERE id = ?
				   AND settlement_version = ?
				   AND EXISTS (
				     SELECT 1 FROM billing_accounts
				     WHERE organization_id = ?
				       AND credit_balance_micros = ?
				   )
				   AND NOT EXISTS (
				     SELECT 1 FROM billing_usage_charges
				     WHERE ${duplicateSql}
				   )
				 RETURNING settlement_version`,
			)
			.bind(
				input.inputTokens,
				input.outputTokens,
				amounts.stripeMeteredTokens,
				input.providerCostMicros,
				amounts.customerChargeMicros,
				amounts.creditAppliedMicros,
				input.id,
				input.now,
				periodId,
				period.settlementVersion,
				input.organizationId,
				account.creditBalanceMicros,
				input.gatewayLogId ?? null,
				input.gatewayLogId ?? null,
				input.providerUsageId ?? null,
				input.providerUsageId ?? null,
			);

		const insertCharge = d1
			.prepare(
				`INSERT INTO billing_usage_charges (
				   id, organization_id, tedi_id, reservation_id, usage_period_id,
				   gateway_log_id, provider_usage_id, provider, model, source,
				   input_tokens, output_tokens, included_tokens_applied,
				   metered_overage_tokens, provider_cost_micros,
				   customer_charge_micros, credit_applied_micros, usage_quality,
				   provider_cost_quality, metering_ready, rate_card_version,
				   occurred_at, metadata, created_at
				 )
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				        ?, ?, ?, ?, ?, ?
				 FROM billing_usage_periods
				 WHERE id = ? AND settlement_version = ?
				   AND last_settlement_id = ?
				   AND NOT EXISTS (
				     SELECT 1 FROM billing_usage_charges
				     WHERE ${duplicateSql}
				   )
				 ON CONFLICT DO NOTHING
				 RETURNING *`,
			)
			.bind(
				input.id,
				input.organizationId,
				input.tediId ?? null,
				input.reservationId,
				periodId,
				input.gatewayLogId ?? null,
				input.providerUsageId ?? null,
				input.provider,
				input.model,
				input.source,
				input.inputTokens,
				input.outputTokens,
				amounts.includedTokensApplied,
				amounts.stripeMeteredTokens,
				input.providerCostMicros,
				amounts.customerChargeMicros,
				amounts.creditAppliedMicros,
				input.usageQuality,
				input.providerCostQuality,
				input.meteringReady ? 1 : 0,
				input.rateCardVersion ?? null,
				input.occurredAt,
				metadata,
				input.now,
				periodId,
				nextSettlementVersion,
				input.id,
				input.gatewayLogId ?? null,
				input.gatewayLogId ?? null,
				input.providerUsageId ?? null,
				input.providerUsageId ?? null,
			);

		const insertCredit = d1
			.prepare(
				`INSERT INTO billing_credit_entries (
				   id, organization_id, kind, amount_micros, source_type,
				   source_ref, usage_charge_id, idempotency_key, description,
				   metadata, created_at
				 )
				 SELECT ?, organization_id, 'debit', -credit_applied_micros,
				        'usage_charge', id, id, ?, ?, '{}', ?
				 FROM billing_usage_charges
				 WHERE id = ? AND credit_applied_micros > 0
				 ON CONFLICT(idempotency_key) DO NOTHING
				 RETURNING id`,
			)
			.bind(
				creditEntryId,
				`usage-charge:${input.id}`,
				`Credits applied to ${input.model} usage`,
				input.now,
				input.id,
			);

		const settleReservation = d1
			.prepare(
				`UPDATE billing_usage_reservations
				 SET status = 'settled', settled_at = ?, updated_at = ?
				 WHERE id = ? AND organization_id = ?
				   AND status IN ('reserved', 'expired')
				   AND EXISTS (
				     SELECT 1 FROM billing_usage_charges WHERE id = ?
				   )
				 RETURNING id`,
			)
			.bind(
				input.now,
				input.now,
				input.reservationId,
				input.organizationId,
				input.id,
			);

		const insertOutbox = d1
			.prepare(
				`INSERT INTO stripe_meter_outbox (
				   id, organization_id, usage_charge_id, stripe_customer_id,
				   stripe_environment,
				   event_name, quantity, idempotency_key, status,
				   attempt_count, next_attempt_at, created_at, updated_at
				 )
				 SELECT ?, charge.organization_id, charge.id,
				        account.stripe_customer_id, ?, ?,
				        charge.metered_overage_tokens, ?, 'pending', 0, ?, ?, ?
				 FROM billing_usage_charges AS charge
				 JOIN billing_accounts AS account
				   ON account.organization_id = charge.organization_id
				 WHERE charge.id = ?
				   AND charge.metering_ready = 1
				   AND charge.metered_overage_tokens > 0
				   AND account.billing_mode = 'stripe'
				   AND account.stripe_environment = ?
				   AND account.stripe_customer_id IS NOT NULL
				 ON CONFLICT DO NOTHING
				 RETURNING id`,
			)
			.bind(
				outboxId,
				input.stripeEnvironment ?? "live",
				STRIPE_TOKEN_METER_EVENT,
				`stripe-meter:${input.id}`,
				input.now,
				input.now,
				input.now,
				input.id,
				input.stripeEnvironment ?? "live",
			);

		const results = await d1.batch([
			updatePeriod,
			insertCharge,
			insertCredit,
			settleReservation,
			insertOutbox,
		]);
		const inserted = results[1]?.results?.[0];
		if (inserted) {
			const [charge] = await db
				.select()
				.from(billingUsageCharges)
				.where(eq(billingUsageCharges.id, input.id))
				.limit(1);
			if (charge) return charge;
		}
	}

	const existing = await findExistingBillingUsageCharge(db, input);
	if (existing) return existing;
	throw new Error("Billing settlement concurrency retry exhausted");
}
