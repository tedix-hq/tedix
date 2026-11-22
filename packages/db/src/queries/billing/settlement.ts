/**
 * AI settlement: the provider row's actual cost becomes the call's credits
 * (converted to EUR at the plan's pinned rate, times two, rounded up) and is
 * drawn from the organization credit pool. Token counts and provider cost
 * stay on the charge and period as cost evidence.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	aiCreditsForProviderCost,
	DYNAMIC_WORKER_PROVIDER,
} from "@tedix/api-contract/utils/credit-pricing";
import { and, eq, exists, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingUsageCharge,
	type BillingUsageSource,
	billingCreditConsumptions,
	billingPlanVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
} from "../../schema/billing";
import { buildCreditConsumptionStatements, parseCreditFx } from "./credit-pool";

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
	const reservationId = input.reservationId;

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
				eq(billingUsageReservations.id, reservationId),
				eq(billingUsageReservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!reservation) {
		throw new Error(`Billing reservation not found: ${reservationId}`);
	}
	if (!["reserved", "expired"].includes(reservation.status)) {
		throw new Error(
			`Billing reservation ${reservationId} cannot settle from ${reservation.status}`,
		);
	}

	const [pricing] = await db
		.select({
			reservationFx: billingPlanVersions.creditFx,
			accountFx:
				sql<unknown>`(SELECT account_plan.credit_fx FROM billing_accounts AS account JOIN billing_plan_versions AS account_plan ON account_plan.id = account.plan_version_id WHERE account.organization_id = ${input.organizationId})`.as(
					"account_fx",
				),
		})
		.from(billingPlanVersions)
		.where(eq(billingPlanVersions.id, reservation.planVersionId))
		.limit(1);
	if (!pricing) {
		throw new Error(
			`Billing plan version not found: ${reservation.planVersionId}`,
		);
	}
	// A reservation admitted before credits keeps its retired plan version; it
	// settles at the account's current pinned rate.
	const fx =
		parseCreditFx(pricing.reservationFx) ?? parseCreditFx(pricing.accountFx);
	if (!fx) throw new Error("Credit settlement requires a pinned FX rate");
	const credits = aiCreditsForProviderCost(
		input.providerCostMicros,
		fx.microUsdPerEur,
	);
	const tediId = input.tediId ?? reservation.tediId;

	const periodId = `${input.organizationId}:${reservation.periodStart}`;
	await db
		.insert(billingUsagePeriods)
		.values({
			id: periodId,
			organizationId: input.organizationId,
			planVersionId: reservation.planVersionId,
			periodStart: reservation.periodStart,
			periodEnd: reservation.periodEnd,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoNothing();

	// The guarded INSERT claims the reservation once. D1 serializes the batch,
	// so every later statement sees exactly this charge or nothing.
	// Raw: an INSERT ... SELECT guarded by the claim, kept on the money path.
	const insertCharge = db.run(sql`
		INSERT INTO billing_usage_charges (
			id, organization_id, tedi_id, reservation_id, usage_period_id,
			gateway_log_id, provider_usage_id, provider, model, source,
			input_tokens, output_tokens, included_tokens_applied, metered_overage_tokens,
			provider_cost_micros, customer_charge_micros, credit_applied_micros, credits,
			usage_quality, provider_cost_quality, metering_ready, rate_card_version,
			occurred_at, metadata, created_at
		)
		SELECT ${input.id}, ${input.organizationId}, ${tediId}, reservation.id, ${periodId},
			${input.gatewayLogId ?? null}, ${input.providerUsageId ?? null},
			${input.provider}, ${input.model}, ${input.source},
			${input.inputTokens}, ${input.outputTokens}, 0, 0,
			${input.providerCostMicros}, 0, 0, ${credits},
			${input.usageQuality}, ${input.providerCostQuality}, ${input.meteringReady ? 1 : 0},
			${input.rateCardVersion ?? null}, ${input.occurredAt},
			${JSON.stringify(input.metadata ?? {})}, ${input.now}
		FROM billing_usage_reservations AS reservation
		WHERE reservation.id = ${reservationId}
			AND reservation.organization_id = ${input.organizationId}
			AND reservation.status IN ('reserved', 'expired')
			AND NOT EXISTS (SELECT 1 FROM billing_usage_charges WHERE reservation_id = reservation.id)
			AND NOT EXISTS (SELECT 1 FROM billing_usage_charges WHERE
				(${input.gatewayLogId ?? null} IS NOT NULL AND gateway_log_id = ${input.gatewayLogId ?? null})
				OR (${input.providerUsageId ?? null} IS NOT NULL AND provider_usage_id = ${input.providerUsageId ?? null}))
		ON CONFLICT DO NOTHING
	`);

	// changes() belongs to the immediately preceding INSERT in this atomic batch.
	// Raw: the row-value SET (...) = (SELECT ...) has no Drizzle builder form.
	const updatePeriod = db.run(sql`
		UPDATE billing_usage_periods
		SET (used_input_tokens, used_output_tokens, provider_cost_micros) = (
			SELECT billing_usage_periods.used_input_tokens + charge.input_tokens,
				billing_usage_periods.used_output_tokens + charge.output_tokens,
				billing_usage_periods.provider_cost_micros + charge.provider_cost_micros
			FROM billing_usage_charges AS charge WHERE charge.id = ${input.id}
		), settlement_version = settlement_version + 1, last_settlement_id = ${input.id}, updated_at = ${input.now}
		WHERE id = ${periodId} AND changes() = 1
	`);

	const settleReservation = db
		.update(billingUsageReservations)
		.set({ status: "settled", settledAt: input.now, updatedAt: input.now })
		.where(
			and(
				eq(billingUsageReservations.id, reservationId),
				eq(billingUsageReservations.organizationId, input.organizationId),
				sql`${billingUsageReservations.status} IN ('reserved', 'expired')`,
				exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageCharges)
						.where(
							and(
								eq(billingUsageCharges.id, input.id),
								eq(
									billingUsageCharges.reservationId,
									billingUsageReservations.id,
								),
							),
						),
				),
			),
		)
		.returning({ id: billingUsageReservations.id });

	// The hold is released above, so the pool now carries the actual credits in
	// place of the estimate. The consumption reads them from the new charge;
	// with no charge the amount is NULL and nothing is recorded.
	const consumptionId = crypto.randomUUID();
	const consume = buildCreditConsumptionStatements(db, {
		id: consumptionId,
		organizationId: input.organizationId,
		kind: input.provider === DYNAMIC_WORKER_PROVIDER ? "code_run" : "ai",
		sourceRef: input.id,
		tediId,
		userId: reservation.userId,
		periodStart: reservation.periodStart,
		periodEnd: reservation.periodEnd,
		credits: db
			.select({ credits: billingUsageCharges.credits })
			.from(billingUsageCharges)
			.where(eq(billingUsageCharges.id, input.id)),
		now: input.now,
		stripeEnvironment: input.stripeEnvironment,
	});
	const recordedConsumption = db
		.select({ micros: billingCreditConsumptions.paygChargeMicros })
		.from(billingCreditConsumptions)
		.where(eq(billingCreditConsumptions.id, consumptionId));
	const chargePayAsYouGo = db
		.update(billingUsageCharges)
		.set({ customerChargeMicros: sql`(${recordedConsumption})` })
		.where(
			and(eq(billingUsageCharges.id, input.id), exists(recordedConsumption)),
		);

	await db.batch([
		insertCharge,
		updatePeriod,
		settleReservation,
		...consume,
		chargePayAsYouGo,
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
		`Billing reservation ${reservationId} is no longer settleable or its billing account is missing`,
	);
}
