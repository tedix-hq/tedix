/** Canonical billing settlement queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, or } from "drizzle-orm";
import {
	monetaryInferenceConfig,
	observedMonetaryInference,
} from "./monetary-inference";
import type { D1Executor, DbClient } from "../../client";
import {
	type BillingUsageCharge,
	type BillingUsageSource,
	billingPlanVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
} from "../../schema/billing";

const STRIPE_TOKEN_METER_EVENT = "token_usage";

function usageDuplicatePredicate(input: {
	id: string;
	reservationId?: string | null;
	gatewayLogId?: string | null;
	providerUsageId?: string | null;
}) {
	const predicates = [eq(billingUsageCharges.id, input.id)];
	if (input.reservationId)
		predicates.push(eq(billingUsageCharges.reservationId, input.reservationId));
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
		id: string;
		reservationId?: string | null;
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
	if (duplicate) {
		if (
			duplicate.organizationId !== input.organizationId ||
			duplicate.reservationId !== input.reservationId
		)
			throw new Error("Usage settlement identity mismatch");
		return duplicate;
	}

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
		const settled = await findExistingBillingUsageCharge(db, input);
		if (settled) {
			if (
				settled.organizationId !== input.organizationId ||
				settled.reservationId !== input.reservationId
			)
				throw new Error("Usage settlement identity mismatch");
			return settled;
		}
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

	const monetaryQuote = observedMonetaryInference(reservation, input);
	if (monetaryInferenceConfig(plan) && !monetaryQuote)
		throw new Error("Monetary settlement requires a pinned rate snapshot");
	if (monetaryQuote && input.rateCardVersion !== monetaryQuote.rateSnapshot.id)
		throw new Error("Settlement receipt differs from reserved monetary price");
	const duplicateSql = `(
		(? IS NOT NULL AND gateway_log_id = ?)
		OR (? IS NOT NULL AND provider_usage_id = ?)
	)`;
	// Narrower than D1Database on purpose: this only needs prepare + batch, which
	// a D1DatabaseSession also provides, so these writes work unchanged when the
	// caller passes a session-backed client (see createDbSession).
	const d1 = db.$client as D1Executor;

	const outboxId = crypto.randomUUID();
	const creditEntryId = crypto.randomUUID();
	const metadata = JSON.stringify({
		...input.metadata,
		...(monetaryQuote ? { monetaryQuote } : {}),
	});

	// The INSERT claims one reservation and prices it against the current wallet
	// and allowance. D1 serializes the whole batch, so no external CAS snapshot
	// or retry budget is needed when other reservations settle in the same period.
	const insertCharge = d1
		.prepare(`
		WITH basis AS (
			SELECT period.used_input_tokens + period.used_output_tokens AS used_before,
				period.included_tokens, period.credit_applied_micros AS credited_before,
				period.metered_overage_tokens AS metered_before,
				account.credit_balance_micros AS balance,
				? AS total_tokens, MAX(1, ?) AS unit_tokens, ? AS unit_price,
				? AND account.overage_enabled = 0 AS absorb_overage,
				? AS monetary, ? AS quoted_charge,
				reservation.estimated_charge_micros AS hold_ceiling,
				CASE WHEN ? THEN COALESCE((
					SELECT SUM(held.estimated_charge_micros)
					FROM billing_usage_reservations AS held
					WHERE held.organization_id = account.organization_id
						AND held.id <> reservation.id AND held.status = 'reserved'
						AND held.expires_at > ?
				), 0) ELSE 0 END AS other_holds
			FROM billing_usage_periods AS period
			JOIN billing_accounts AS account ON account.organization_id = period.organization_id
			JOIN billing_usage_reservations AS reservation ON reservation.id = ?
			WHERE period.id = ? AND period.organization_id = ?
				AND reservation.organization_id = period.organization_id
				AND reservation.status IN ('reserved', 'expired')
				AND NOT EXISTS (SELECT 1 FROM billing_usage_charges WHERE reservation_id = reservation.id)
		), allowance AS (
			SELECT basis.*,
				MIN(total_tokens, CASE WHEN included_tokens < 0 THEN total_tokens
					ELSE MAX(included_tokens - used_before, 0) END) AS included,
				CASE WHEN included_tokens < 0 THEN 0 ELSE MAX(used_before - included_tokens, 0) END AS overage_before
			FROM basis
		), overage AS (
			SELECT allowance.*, overage_before + total_tokens - included AS overage_after
			FROM allowance
		), units AS (
			SELECT overage.*,
				MAX(CAST((overage_after + unit_tokens - 1) / unit_tokens AS INTEGER)
					- CAST((overage_before + unit_tokens - 1) / unit_tokens AS INTEGER), 0) AS incremental_units
			FROM overage
		), credit AS (
			SELECT units.*,
				CASE WHEN unit_price > 0 THEN MIN(incremental_units, CAST(balance / unit_price AS INTEGER)) ELSE 0 END AS credited_units,
				CASE WHEN unit_price > 0 THEN CAST(credited_before / unit_price AS INTEGER) * unit_tokens ELSE 0 END AS credited_coverage
			FROM units
		), amounts AS (
			SELECT
				CASE WHEN monetary THEN 0 ELSE included END AS included_applied,
				CASE WHEN monetary OR absorb_overage THEN 0
					ELSE MAX(overage_after - credited_coverage - credited_units * unit_tokens - metered_before, 0) END AS metered,
				CASE WHEN monetary OR absorb_overage THEN 0
					ELSE (incremental_units - credited_units) * unit_price END AS customer_charge,
				CASE WHEN monetary THEN MIN(quoted_charge, hold_ceiling, MAX(balance - other_holds, 0))
					WHEN absorb_overage THEN 0 ELSE credited_units * unit_price END AS credit_applied
			FROM credit
		)
		INSERT INTO billing_usage_charges (
			id, organization_id, tedi_id, reservation_id, usage_period_id,
			gateway_log_id, provider_usage_id, provider, model, source,
			input_tokens, output_tokens, included_tokens_applied, metered_overage_tokens,
			provider_cost_micros, customer_charge_micros, credit_applied_micros,
			usage_quality, provider_cost_quality, metering_ready, rate_card_version,
			occurred_at, metadata, created_at
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, included_applied, metered,
			?, customer_charge, credit_applied, ?, ?, ?, ?, ?,
			CASE WHEN ? THEN json_set(?, '$.absorbedChargeMicros', ? - credit_applied) ELSE ? END, ?
		FROM amounts
		WHERE NOT EXISTS (SELECT 1 FROM billing_usage_charges WHERE ${duplicateSql})
		ON CONFLICT DO NOTHING
		RETURNING id
	`)
		.bind(
			totalTokens,
			plan.overageUnitTokens,
			plan.overageUnitPriceMicros,
			plan.allowOverage && plan.overageUnitPriceMicros > 0 ? 1 : 0,
			monetaryQuote ? 1 : 0,
			monetaryQuote?.customerChargeMicros ?? 0,
			monetaryQuote ? 1 : 0,
			input.now,
			input.reservationId,
			periodId,
			input.organizationId,
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
			input.providerCostMicros,
			input.usageQuality,
			input.providerCostQuality,
			input.meteringReady ? 1 : 0,
			input.rateCardVersion ?? null,
			input.occurredAt,
			monetaryQuote ? 1 : 0,
			metadata,
			monetaryQuote?.customerChargeMicros ?? 0,
			metadata,
			input.now,
			input.gatewayLogId ?? null,
			input.gatewayLogId ?? null,
			input.providerUsageId ?? null,
			input.providerUsageId ?? null,
		);

	// changes() belongs to the immediately preceding INSERT in this atomic batch.
	// A duplicate claim changes zero rows, including retries with the same charge id.
	const updatePeriod = d1
		.prepare(`
		UPDATE billing_usage_periods
		SET (used_input_tokens, used_output_tokens, metered_overage_tokens,
			provider_cost_micros, customer_charge_micros, credit_applied_micros) = (
			SELECT billing_usage_periods.used_input_tokens + charge.input_tokens, billing_usage_periods.used_output_tokens + charge.output_tokens,
				billing_usage_periods.metered_overage_tokens + charge.metered_overage_tokens,
				billing_usage_periods.provider_cost_micros + charge.provider_cost_micros,
				billing_usage_periods.customer_charge_micros + charge.customer_charge_micros,
				billing_usage_periods.credit_applied_micros + charge.credit_applied_micros
			FROM billing_usage_charges AS charge WHERE charge.id = ?
		), settlement_version = settlement_version + 1, last_settlement_id = ?, updated_at = ?
		WHERE id = ? AND changes() = 1
	`)
		.bind(input.id, input.id, input.now, periodId);

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
			       AND reservation_id = billing_usage_reservations.id
			       AND organization_id = billing_usage_reservations.organization_id
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

	await d1.batch([
		insertCharge,
		updatePeriod,
		insertCredit,
		settleReservation,
		insertOutbox,
	]);
	const existing = await findExistingBillingUsageCharge(db, input);
	if (existing) {
		if (
			existing.organizationId !== input.organizationId ||
			existing.reservationId !== input.reservationId
		)
			throw new Error("Usage settlement identity mismatch");
		return existing;
	}
	throw new Error(
		`Billing reservation ${input.reservationId} is no longer settleable or its billing account is missing`,
	);
}
