import {
	buildProviderExecutionInsertStatement,
	providerExecutionGuardPredicate,
	providerExecutionRetryPredicate,
	type ProviderExecutionAdmissionGuard,
} from "../provider-executions";
import type { NewProviderExecutionAttemptRow } from "../../schema/provider-executions";
/** Canonical billing reservations queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	autoRoutedPricingIdentity,
	readProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingAccountStatus,
	type BillingPlanVersion,
	type BillingUsageReservation,
	type BillingUsageSource,
	billingUsageReservations,
	billingPlanVersions,
	billingAccounts,
} from "../../schema/billing";

import {
	type BillingBalanceSnapshot,
	getBillingBalanceSnapshot,
} from "./credits";
import { effectiveAllowOverageSql } from "./overage";
import { reservationUsedTokensSql } from "./usage-tokens";
import {
	estimateMonetaryInference,
	monetaryInferenceConfig,
	monetaryPeriodSpendSql,
	verifyMonetaryQuoteReceipt,
} from "./monetary-inference";

const ACTIVE_BILLING_STATUSES: BillingAccountStatus[] = ["trial", "active"];

/** Monthly metering is the paid account's capacity authority. */
export function usesMonthlyInferenceCapacity(input: {
	status: string;
	allowOverage: boolean;
	billingMode: string;
	stripeCustomerId: string | null;
	isSponsoredCustomer?: boolean;
}): boolean {
	return (
		input.status === "active" &&
		input.allowOverage &&
		((input.billingMode === "internal" && !input.isSponsoredCustomer) ||
			input.billingMode === "invoice" ||
			(input.billingMode === "stripe" && input.stripeCustomerId !== null))
	);
}

async function aiGatewayLimitExceeded(
	db: DbClient,
	input: {
		organizationId: string;
		tediId?: string | null;
		now: string;
		estimatedTokens: number;
		limits: NonNullable<
			Parameters<typeof reserveBillingUsage>[1]["aiGatewayLimits"]
		>;
		stripeEnvironment: "test" | "live";
		monthlyFirst: boolean;
	},
): Promise<boolean> {
	const [row] = await db.all<{
		organizationDayTokens: number;
		organizationDaySpendMicros: number;
		organizationDayCapacityTokens: number;
		organizationDayCapacitySpendMicros: number;
		tediDayTokens: number;
		tediDaySpendMicros: number;
		estimatedChargeMicros: number;
	}>(sql`
		WITH usage AS (
			SELECT
				account.organization_id,
				plan.included_monthly_tokens,
				plan.overage_unit_tokens,
				plan.overage_unit_price_micros,
				COALESCE(period.used_input_tokens + period.used_output_tokens, 0) AS used_tokens,
				COALESCE((
					SELECT SUM(estimated_input_tokens + estimated_output_tokens)
					FROM billing_usage_reservations
					WHERE organization_id = account.organization_id
						AND status = 'reserved'
						AND datetime(expires_at) > datetime(${input.now})
						AND period_start = account.period_start
						AND period_end = account.period_end
				), 0) AS reserved_tokens,
				COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
						AND substr(reservation.created_at, 1, 10) = substr(${input.now}, 1, 10)
				), 0) AS organization_day_tokens,
				COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations
						WHERE organization_id = account.organization_id
							AND status = 'reserved'
							AND datetime(expires_at) > datetime(${input.now})
							AND substr(created_at, 1, 10) = substr(${input.now}, 1, 10)
						UNION ALL
						SELECT provider_cost_micros AS spend_micros
						FROM billing_usage_charges
						WHERE organization_id = account.organization_id
							AND substr(occurred_at, 1, 10) = substr(${input.now}, 1, 10)
					)
				), 0) AS organization_day_spend_micros,
				COALESCE((
					SELECT SUM(token_amount)
					FROM billing_capacity_allocations
					WHERE organization_id = account.organization_id
						AND budget_day = substr(${input.now}, 1, 10)
						AND stripe_environment = ${input.stripeEnvironment}
						AND datetime(expires_at) > datetime(${input.now})
				), 0) AS organization_day_capacity_tokens,
				COALESCE((
					SELECT SUM(spend_amount_micros)
					FROM billing_capacity_allocations
					WHERE organization_id = account.organization_id
						AND budget_day = substr(${input.now}, 1, 10)
						AND stripe_environment = ${input.stripeEnvironment}
						AND datetime(expires_at) > datetime(${input.now})
				), 0) AS organization_day_capacity_spend_micros,
				COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.tedi_id = ${input.tediId ?? null}
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
						AND substr(reservation.created_at, 1, 10) = substr(${input.now}, 1, 10)
				), 0) AS tedi_day_tokens,
				COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND status = 'reserved'
							AND datetime(expires_at) > datetime(${input.now})
							AND substr(created_at, 1, 10) = substr(${input.now}, 1, 10)
						UNION ALL
						SELECT provider_cost_micros AS spend_micros
						FROM billing_usage_charges
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND substr(occurred_at, 1, 10) = substr(${input.now}, 1, 10)
					)
				), 0) AS tedi_day_spend_micros
			FROM billing_accounts AS account
			INNER JOIN billing_plan_versions AS plan ON plan.id = account.plan_version_id
			LEFT JOIN billing_usage_periods AS period
				ON period.organization_id = account.organization_id
				AND period.period_start = account.period_start
				AND period.period_end = account.period_end
			WHERE account.organization_id = ${input.organizationId}
		)
		SELECT
			organization_day_tokens AS organizationDayTokens,
			organization_day_spend_micros AS organizationDaySpendMicros,
			organization_day_capacity_tokens AS organizationDayCapacityTokens,
			organization_day_capacity_spend_micros AS organizationDayCapacitySpendMicros,
			tedi_day_tokens AS tediDayTokens,
			tedi_day_spend_micros AS tediDaySpendMicros,
			CASE
				WHEN included_monthly_tokens < 0 OR
					used_tokens + reserved_tokens + ${input.estimatedTokens} <= included_monthly_tokens
					THEN 0
				WHEN overage_unit_price_micros <= 0 THEN 0
				ELSE (
					CAST((MAX(used_tokens + reserved_tokens + ${input.estimatedTokens} - included_monthly_tokens, 0) + overage_unit_tokens - 1) / overage_unit_tokens AS INTEGER) -
					CAST((MAX(used_tokens + reserved_tokens - included_monthly_tokens, 0) + overage_unit_tokens - 1) / overage_unit_tokens AS INTEGER)
				) * overage_unit_price_micros
			END AS estimatedChargeMicros
		FROM usage
	`);
	if (!row) return false;
	const limitExceeded = (usage: number, increment: number, limit?: number) =>
		limit !== undefined && usage + increment > limit;
	return (
		(!input.monthlyFirst &&
			limitExceeded(
				Number(row.organizationDayTokens),
				input.estimatedTokens,
				input.limits.organizationDailyTokenLimit === undefined
					? undefined
					: input.limits.organizationDailyTokenLimit +
							Number(row.organizationDayCapacityTokens),
			)) ||
		(!input.monthlyFirst &&
			limitExceeded(
				Number(row.organizationDaySpendMicros),
				Number(row.estimatedChargeMicros),
				input.limits.organizationDailySpendLimitMicros === undefined
					? undefined
					: input.limits.organizationDailySpendLimitMicros +
							Number(row.organizationDayCapacitySpendMicros),
			)) ||
		// Mirrors the INSERT deliberately: org capacity may raise a tedi ceiling,
		// never lower it. Both copies used to apply it signed, so a negative
		// org allocation lowered every tedi limit with it.
		limitExceeded(
			Number(row.tediDayTokens),
			input.estimatedTokens,
			input.limits.tediDailyTokenLimit === undefined
				? undefined
				: input.limits.tediDailyTokenLimit +
						Math.max(0, Number(row.organizationDayCapacityTokens)),
		) ||
		limitExceeded(
			Number(row.tediDaySpendMicros),
			Number(row.estimatedChargeMicros),
			input.limits.tediDailySpendLimitMicros === undefined
				? undefined
				: input.limits.tediDailySpendLimitMicros +
						Math.max(0, Number(row.organizationDayCapacitySpendMicros)),
		)
	);
}

export type BillingReservationDecision =
	| {
			allowed: true;
			reservation: Pick<
				BillingUsageReservation,
				"id" | "planVersionId" | "expiresAt" | "estimatedChargeMicros"
			>;
	  }
	| {
			allowed: false;
			code:
				| "billing_not_configured"
				| "subscription_inactive"
				| "billing_period_inactive"
				| "monthly_allowance_exhausted"
				| "payment_required"
				| "hard_spend_limit"
				| "inference_capacity_exhausted"
				| "pricing_unavailable"
				| "credit_allowance_exhausted";
			// Monetary plans never fall back to token-priced admission.
			snapshot: BillingBalanceSnapshot | null;
	  };

export interface BillingReservationFreshness {
	/** Newest admitted inference reservation in the last 30 days. */
	maxCreatedAt: string | null;
	count30d: number;
}

/**
 * Activity side of the Gateway-metering freshness comparison. Reservations
 * are written before provider inference, so they are the durable proof that
 * the Gateway ledger should subsequently advance. Rejected admission creates
 * no row and therefore cannot produce a false metering-dark signal.
 */
export async function getBillingReservationFreshness(
	db: DbClient,
	nowMs: number,
): Promise<BillingReservationFreshness> {
	const iso30d = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({
			maxCreatedAt: sql<
				string | null
			>`MAX(${billingUsageReservations.createdAt})`,
			count30d: sql<number>`COUNT(*)`,
		})
		.from(billingUsageReservations)
		.where(sql`${billingUsageReservations.createdAt} >= ${iso30d}`);
	return {
		maxCreatedAt: rows[0]?.maxCreatedAt ?? null,
		count30d: Number(rows[0]?.count30d ?? 0),
	};
}

export interface BillingReservationPreflightInput {
	organizationId: string;
	idempotencyKey: string;
	executionGuard?: ProviderExecutionAdmissionGuard;
}

export interface BillingReservationPreflight extends BillingReservationPreflightInput {
	existing: BillingUsageReservation | undefined;
	plan: Pick<BillingPlanVersion, "id" | "currency" | "metadata"> | undefined;
}

/** Compose fresh replay and pricing reads into the caller's admission batch. */
export function buildBillingReservationPreflightStatements(
	db: DbClient,
	input: BillingReservationPreflightInput,
) {
	// Scoped by organization as well as key. `uniq_billing_reservation_idempotency`
	// is global, so today every caller builds a key that already implies one org
	// (`seo:{orgId}:…`, `kernel-inference:{uuid}`) and a collision cannot happen —
	// this is defence in depth, not a live hole. It matters because of the failure
	// mode if that ever stops holding: an unscoped read would hand org A org B's
	// reservation row and return `allowed: true` WITHOUT reserving anything
	// against A's balance — a silent cross-tenant billing bypass. With the org
	// pinned, the same collision instead falls through to the insert and trips the
	// unique index, which fails loudly rather than granting free usage.
	const existingStatement = db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.idempotencyKey, input.idempotencyKey),
				eq(billingUsageReservations.organizationId, input.organizationId),
				input.executionGuard
					? sql`EXISTS (WITH __provider_replay(billing_reservation_id) AS MATERIALIZED
 (SELECT billing_reservation_id FROM provider_execution_attempts WHERE ${providerExecutionRetryPredicate(input.executionGuard)})
 SELECT 1 FROM __provider_replay WHERE billing_reservation_id=billing_usage_reservations.id)`
					: undefined,
			),
		)
		.limit(1);
	const planStatement = db
		.select({
			id: billingPlanVersions.id,
			currency: billingPlanVersions.currency,
			metadata: billingPlanVersions.metadata,
		})
		.from(billingAccounts)
		.innerJoin(
			billingPlanVersions,
			eq(billingAccounts.planVersionId, billingPlanVersions.id),
		)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	return [existingStatement, planStatement] as const;
}

/** Atomically checks current capacity and reserves one provider inference. */
export async function reserveBillingUsage(
	db: DbClient,
	input: {
		execution?: NewProviderExecutionAttemptRow;
		executionGuard?: ProviderExecutionAdmissionGuard;
		preflight?: BillingReservationPreflight;
		stripeEnvironment?: "test" | "live";
		id: string;
		organizationId: string;
		tediId?: string | null;
		source: BillingUsageSource;
		provider: string;
		model: string;
		deploymentScope?: string;
		estimatedInputTokens: number;
		estimatedOutputTokens: number;
		runId?: string | null;
		traceId?: string | null;
		idempotencyKey: string;
		expiresAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
		aiGatewayLimits?: {
			organizationDailyTokenLimit?: number;
			organizationDailySpendLimitMicros?: number;
			tediDailyTokenLimit?: number;
			tediDailySpendLimitMicros?: number;
		};
	},
): Promise<BillingReservationDecision> {
	if (
		input.execution &&
		(input.execution.billingReservationId !== input.id ||
			input.execution.organizationId !== input.organizationId ||
			input.execution.idempotencyKey !== input.idempotencyKey)
	)
		throw new Error("Execution/reservation identity mismatch");
	if (input.executionGuard && !input.execution)
		throw new Error("Guarded reservation requires execution identity");
	const capturedPredicate = input.execution
		? providerExecutionGuardPredicate(input.execution, input.executionGuard)
		: sql`1=1`;
	const eligibility = input.executionGuard
		? sql`__provider_eligibility(eligible) AS MATERIALIZED ${capturedPredicate},`
		: sql``;
	const executionPredicate = input.executionGuard
		? sql`(SELECT eligible FROM __provider_eligibility)`
		: capturedPredicate;
	const estimatedTokens =
		input.estimatedInputTokens + input.estimatedOutputTokens;
	if (
		!Number.isSafeInteger(estimatedTokens) ||
		estimatedTokens <= 0 ||
		input.estimatedInputTokens < 0 ||
		input.estimatedOutputTokens < 0
	) {
		throw new Error("Estimated billing tokens must be positive safe integers");
	}

	const preflight = input.preflight;
	if (
		preflight &&
		(preflight.organizationId !== input.organizationId ||
			preflight.idempotencyKey !== input.idempotencyKey ||
			preflight.executionGuard !== input.executionGuard)
	)
		throw new Error("Reservation preflight scope mismatch");
	// Caller-owned preflight comes from this admission's policy batch, never a cache.
	const [existing, plans] = preflight
		? [[preflight.existing], [preflight.plan]]
		: await db.batch(buildBillingReservationPreflightStatements(db, input));
	const plan = plans[0];
	if (existing[0]) {
		return (existing[0].status === "reserved" &&
			existing[0].expiresAt > input.now) ||
			existing[0].status === "settled"
			? { allowed: true, reservation: existing[0] }
			: {
					allowed: false,
					code: "monthly_allowance_exhausted",
					snapshot: await getBillingBalanceSnapshot(
						db,
						input.organizationId,
						input.now,
					),
				};
	}

	let monetaryQuote: ReturnType<typeof estimateMonetaryInference> | null = null;
	try {
		const config = plan ? monetaryInferenceConfig(plan) : null;
		if (config) {
			if (config.perRunBudgetMicros !== undefined && !input.runId)
				return {
					allowed: false,
					code: "hard_spend_limit",
					snapshot: await getBillingBalanceSnapshot(
						db,
						input.organizationId,
						input.now,
					),
				};
			monetaryQuote = estimateMonetaryInference(config, input);
			const autoRouted = input.execution
				? autoRoutedPricingIdentity(
						readProviderExecutionIdentity(input.execution),
					)
				: null;
			// An Auto Router alias is priced only when its admitted routing can
			// land on the one model whose receipt the wallet bound to it.
			if (
				input.model === "cloudflare/auto" &&
				autoRouted?.modelId !== monetaryQuote.rateSnapshot.model
			)
				throw new Error("Auto routing can reach an unpriced model");
			const deploymentScope =
				autoRouted?.deploymentScope ??
				input.execution?.deploymentScope ??
				input.deploymentScope;
			if (!deploymentScope)
				throw new Error(
					"Monetary inference requires exact execution deployment scope",
				);
			await verifyMonetaryQuoteReceipt(db, monetaryQuote, deploymentScope);
		}
	} catch {
		return {
			allowed: false,
			code: "pricing_unavailable",
			snapshot: await getBillingBalanceSnapshot(
				db,
				input.organizationId,
				input.now,
			),
		};
	}
	const reservationMetadata = {
		...input.metadata,
		...(monetaryQuote ? { monetaryQuote } : {}),
	};
	const reservationStatement = db.all(sql`
		WITH ${eligibility} snapshot AS (
			SELECT
				account.organization_id,
				plan.id AS plan_version_id,
				(json_extract(plan.metadata, '$.monetaryInference.version') = 1) AS is_monetary,
				json_extract(plan.metadata, '$.monetaryInference.perRunBudgetMicros') AS run_budget_micros,
				COALESCE((
					SELECT SUM(charge.credit_applied_micros)
					FROM billing_usage_charges AS charge
					JOIN billing_usage_reservations AS held ON held.id = charge.reservation_id
					WHERE held.organization_id = ${input.organizationId}
						AND held.run_id = ${input.runId ?? null}
						AND json_extract(charge.metadata, '$.monetaryQuote.schemaVersion') = 1
				), 0) AS run_spent_micros,
				COALESCE((
					SELECT SUM(held.estimated_charge_micros)
					FROM billing_usage_reservations AS held
					WHERE held.organization_id = ${input.organizationId}
						AND held.run_id = ${input.runId ?? null}
						AND held.status = 'reserved' AND held.expires_at > ${input.now}
				), 0) AS run_reserved_micros,
				account.status,
				account.billing_mode,
				(json_extract(account.metadata, '$.providerCustomerKey') IS NOT NULL
					OR EXISTS (
						SELECT 1 FROM organizations AS customer_org
						WHERE customer_org.id = account.organization_id
							AND json_extract(customer_org.metadata, '$.providerCustomerKey') IS NOT NULL
					)) AS is_sponsored_customer,
				account.stripe_environment AS account_stripe_environment,
				account.period_start,
				account.period_end,
				account.hard_spend_limit_micros,
				account.credit_balance_micros,
				account.stripe_customer_id,
				account.stripe_environment,
				plan.included_monthly_tokens,
				${sql.raw(effectiveAllowOverageSql("plan", "account"))} AS allow_overage,
				plan.overage_unit_tokens,
				plan.overage_unit_price_micros,
				COALESCE(period.used_input_tokens + period.used_output_tokens, 0)
					AS used_tokens,
				CASE WHEN json_extract(plan.metadata, '$.monetaryInference.version') = 1 THEN ${monetaryPeriodSpendSql()} ELSE COALESCE(period.customer_charge_micros, 0) END AS charged_micros,
				COALESCE((
					SELECT SUM(
						reservation.estimated_input_tokens +
						reservation.estimated_output_tokens
					)
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status = 'reserved'
						AND datetime(reservation.expires_at) > datetime(${input.now})
						AND reservation.period_start = account.period_start
						AND reservation.period_end = account.period_end
				), 0) AS reserved_tokens,
				COALESCE((
					SELECT SUM(reservation.estimated_charge_micros)
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status = 'reserved'
						AND datetime(reservation.expires_at) > datetime(${input.now})
						AND reservation.period_start = account.period_start
						AND reservation.period_end = account.period_end
				), 0) AS reserved_charge_micros
				, COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
						AND substr(reservation.created_at, 1, 10) = substr(${input.now}, 1, 10)
				), 0) AS organization_day_tokens
				, COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT reservation.estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations AS reservation
						WHERE reservation.organization_id = account.organization_id
							AND reservation.status = 'reserved'
							AND datetime(reservation.expires_at) > datetime(${input.now})
							AND substr(reservation.created_at, 1, 10) = substr(${input.now}, 1, 10)
						UNION ALL
						SELECT charge.provider_cost_micros AS spend_micros
						FROM billing_usage_charges AS charge
						WHERE charge.organization_id = account.organization_id
							AND substr(charge.occurred_at, 1, 10) = substr(${input.now}, 1, 10)
					)
				), 0) AS organization_day_spend_micros
				, COALESCE((
					SELECT SUM(allocation_row.token_amount)
					FROM billing_capacity_allocations AS allocation_row
					WHERE allocation_row.organization_id = account.organization_id
						AND allocation_row.budget_day = substr(${input.now}, 1, 10)
						AND allocation_row.stripe_environment = ${input.stripeEnvironment ?? "live"}
						AND datetime(allocation_row.expires_at) > datetime(${input.now})
				), 0) AS organization_day_capacity_tokens
				, COALESCE((
					SELECT SUM(allocation_row.spend_amount_micros)
					FROM billing_capacity_allocations AS allocation_row
					WHERE allocation_row.organization_id = account.organization_id
						AND allocation_row.budget_day = substr(${input.now}, 1, 10)
						AND allocation_row.stripe_environment = ${input.stripeEnvironment ?? "live"}
						AND datetime(allocation_row.expires_at) > datetime(${input.now})
				), 0) AS organization_day_capacity_spend_micros
				, COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.tedi_id = ${input.tediId ?? null}
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
						AND substr(reservation.created_at, 1, 10) = substr(${input.now}, 1, 10)
				), 0) AS tedi_day_tokens
				, COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND status = 'reserved'
							AND datetime(expires_at) > datetime(${input.now})
							AND substr(created_at, 1, 10) = substr(${input.now}, 1, 10)
						UNION ALL
						SELECT provider_cost_micros AS spend_micros
						FROM billing_usage_charges
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND substr(occurred_at, 1, 10) = substr(${input.now}, 1, 10)
					)
				), 0) AS tedi_day_spend_micros
			FROM billing_accounts AS account
			INNER JOIN billing_plan_versions AS plan
				ON plan.id = account.plan_version_id
				AND plan.status IN ('active', 'retired')
			LEFT JOIN billing_usage_periods AS period
				ON period.organization_id = account.organization_id
				AND period.period_start = account.period_start
				AND period.period_end = account.period_end
			WHERE account.organization_id = ${input.organizationId}
		),
		priced AS (
			SELECT
				*,
				CASE
					WHEN included_monthly_tokens < 0 THEN 0
					ELSE MAX(
						used_tokens + reserved_tokens + ${estimatedTokens} -
						included_monthly_tokens,
						0
					) - MAX(
						used_tokens + reserved_tokens - included_monthly_tokens,
						0
					)
				END AS incremental_overage_tokens
			FROM snapshot
		),
		admission AS (
			SELECT
				*,
				CASE
					WHEN is_monetary = 1 THEN ${monetaryQuote?.customerChargeMicros ?? 0}
					WHEN incremental_overage_tokens <= 0 THEN 0
					WHEN overage_unit_price_micros <= 0 THEN 0
					ELSE (
						CAST((
							MAX(
								used_tokens + reserved_tokens + ${estimatedTokens} -
									included_monthly_tokens,
								0
							) + overage_unit_tokens - 1
						) / overage_unit_tokens AS INTEGER) -
						CAST((
							MAX(
								used_tokens + reserved_tokens -
									included_monthly_tokens,
								0
							) + overage_unit_tokens - 1
						) / overage_unit_tokens AS INTEGER)
					) * overage_unit_price_micros
				END AS estimated_charge_micros
			FROM priced
		)
		INSERT INTO billing_usage_reservations (
			id, organization_id, plan_version_id, tedi_id, status, source,
			provider, model,
			estimated_input_tokens, estimated_output_tokens,
			estimated_charge_micros, period_start, period_end, run_id, trace_id,
			idempotency_key, rejection_code, expires_at, metadata, created_at,
			updated_at
		)
		SELECT
			${input.id}, organization_id, plan_version_id,
			${input.tediId ?? null}, 'reserved',
			${input.source}, ${input.provider}, ${input.model},
			${input.estimatedInputTokens}, ${input.estimatedOutputTokens},
			estimated_charge_micros, period_start, period_end,
			${input.runId ?? null}, ${input.traceId ?? null},
			${input.idempotencyKey}, NULL, ${input.expiresAt},
			${JSON.stringify(reservationMetadata)}, ${input.now}, ${input.now}
		FROM admission
		WHERE plan_version_id = ${plan?.id ?? null}
			AND (COALESCE(is_monetary,0) = 0 OR ${monetaryQuote !== null ? 1 : 0} = 1)
			AND (
				COALESCE(is_monetary, 0) = 0 OR run_budget_micros IS NULL
				OR run_spent_micros + run_reserved_micros + estimated_charge_micros <= run_budget_micros
			)
			AND datetime(${input.expiresAt}) > datetime(${input.now})
			AND status IN ('trial', 'active')
			AND (
				billing_mode <> 'stripe'
				OR account_stripe_environment = ${input.stripeEnvironment ?? "live"}
			)
			AND datetime(${input.now}) >= datetime(period_start)
			AND datetime(${input.now}) < datetime(period_end)
			AND (
				(is_monetary = 1 AND credit_balance_micros - reserved_charge_micros >= estimated_charge_micros)
				OR (COALESCE(is_monetary,0) = 0 AND (incremental_overage_tokens <= 0
				OR (
					allow_overage = 1
					AND (
						billing_mode IN ('invoice', 'internal')
						OR (
							billing_mode = 'stripe'
							AND stripe_customer_id IS NOT NULL
							AND stripe_environment = ${input.stripeEnvironment ?? "live"}
						)
						OR credit_balance_micros - reserved_charge_micros
							>= estimated_charge_micros
					)
				)))
			)
			AND (
				hard_spend_limit_micros IS NULL
				OR charged_micros + reserved_charge_micros +
					estimated_charge_micros <= hard_spend_limit_micros
			)
			AND (
				-- Active funded overage accounts are governed by the monthly
				-- allowance/charge and hard spend predicates above. Their old UTC
				-- daily ceiling remains ledger history, not an admission gate.
				(COALESCE(is_monetary,0) = 0 AND status = 'active' AND allow_overage = 1 AND (
					billing_mode = 'invoice' OR
					(billing_mode = 'internal' AND is_sponsored_customer = 0) OR
					(billing_mode = 'stripe' AND stripe_customer_id IS NOT NULL
						AND stripe_environment = ${input.stripeEnvironment ?? "live"})
				)) OR
				is_monetary = 1 OR ${input.aiGatewayLimits?.organizationDailyTokenLimit ?? null} IS NULL
				OR organization_day_tokens + ${estimatedTokens} <=
					${input.aiGatewayLimits?.organizationDailyTokenLimit ?? null} +
					organization_day_capacity_tokens
			)
			AND (
				(COALESCE(is_monetary,0) = 0 AND status = 'active' AND allow_overage = 1 AND (
					billing_mode = 'invoice' OR
					(billing_mode = 'internal' AND is_sponsored_customer = 0) OR
					(billing_mode = 'stripe' AND stripe_customer_id IS NOT NULL
						AND stripe_environment = ${input.stripeEnvironment ?? "live"})
				)) OR
				${input.aiGatewayLimits?.organizationDailySpendLimitMicros ?? null} IS NULL
				OR organization_day_spend_micros + estimated_charge_micros <=
					${input.aiGatewayLimits?.organizationDailySpendLimitMicros ?? null} +
					organization_day_capacity_spend_micros
			)
			-- Organization capacity may RAISE a tedi ceiling but never lower it.
			-- Purchased capacity lifting a tedi that is at its budget is
			-- deliberate. Applying the same number when it is NEGATIVE was not:
			-- a provider sponsoring customers is debited org capacity, and that
			-- negative balance silently took the same amount off every one of its
			-- tedis — headroom they were never granted and are not charged for.
			-- The debit belongs to the organization conditions above, which still
			-- carry it in full.
			AND (
				is_monetary = 1 OR ${input.aiGatewayLimits?.tediDailyTokenLimit ?? null} IS NULL
				OR tedi_day_tokens + ${estimatedTokens} <=
					${input.aiGatewayLimits?.tediDailyTokenLimit ?? null} +
					MAX(organization_day_capacity_tokens, 0)
			)
			AND (
				${input.aiGatewayLimits?.tediDailySpendLimitMicros ?? null} IS NULL
				OR tedi_day_spend_micros + estimated_charge_micros <=
					${input.aiGatewayLimits?.tediDailySpendLimitMicros ?? null} +
					MAX(organization_day_capacity_spend_micros, 0)
			)
			AND ${executionPredicate}
		ON CONFLICT(idempotency_key) DO NOTHING
		RETURNING
			id,
			plan_version_id AS planVersionId,
			expires_at AS expiresAt,
			estimated_charge_micros AS estimatedChargeMicros
	`);
	const inserted = (
		input.execution
			? (
					await db.batch([
						reservationStatement,
						buildProviderExecutionInsertStatement(
							db,
							input.execution,
							input.executionGuard,
						),
					])
				)[0]
			: await reservationStatement
	) as Array<
		Pick<
			BillingUsageReservation,
			"id" | "planVersionId" | "expiresAt" | "estimatedChargeMicros"
		>
	>;
	if (inserted[0]) return { allowed: true, reservation: inserted[0] };

	const snapshot = await getBillingBalanceSnapshot(
		db,
		input.organizationId,
		input.now,
	);
	if (!snapshot) {
		return { allowed: false, code: "billing_not_configured", snapshot: null };
	}
	if (!ACTIVE_BILLING_STATUSES.includes(snapshot.status)) {
		return { allowed: false, code: "subscription_inactive", snapshot };
	}
	if (
		Date.parse(input.now) < Date.parse(snapshot.periodStart) ||
		Date.parse(input.now) >= Date.parse(snapshot.periodEnd)
	) {
		return { allowed: false, code: "billing_period_inactive", snapshot };
	}
	if (monetaryQuote) {
		if (snapshot.availableCreditMicros < monetaryQuote.customerChargeMicros)
			return { allowed: false, code: "credit_allowance_exhausted", snapshot };
		if (
			snapshot.hardSpendLimitMicros !== null &&
			(snapshot.monetarySpentMicros ?? 0) +
				snapshot.reservedChargeMicros +
				monetaryQuote.customerChargeMicros >
				snapshot.hardSpendLimitMicros
		)
			return { allowed: false, code: "hard_spend_limit", snapshot };
		return { allowed: false, code: "inference_capacity_exhausted", snapshot };
	}
	if (
		!snapshot.allowOverage &&
		snapshot.remainingIncludedTokens < estimatedTokens
	) {
		return {
			allowed: false,
			code: "monthly_allowance_exhausted",
			snapshot,
		};
	}
	// Same arithmetic as the INSERT's hard-spend predicate: the request's own
	// incremental charge counts, so a cap hit is named before the ladder falls
	// through to the `payment_required` guess.
	if (
		snapshot.hardSpendLimitMicros !== null &&
		snapshot.customerChargeMicros +
			snapshot.reservedChargeMicros +
			incrementalOverageChargeMicros({
				includedTokens: snapshot.includedTokens,
				usedTokens: snapshot.usedTokens,
				reservedTokens: snapshot.reservedTokens,
				estimatedTokens,
				overageUnitTokens: snapshot.overageUnitTokens,
				overageUnitPriceMicros: snapshot.overageUnitPriceMicros,
			}) >
			snapshot.hardSpendLimitMicros
	) {
		return { allowed: false, code: "hard_spend_limit", snapshot };
	}
	if (
		input.aiGatewayLimits &&
		(await aiGatewayLimitExceeded(db, {
			organizationId: input.organizationId,
			tediId: input.tediId,
			now: input.now,
			estimatedTokens,
			limits: input.aiGatewayLimits,
			stripeEnvironment: input.stripeEnvironment ?? "live",
			monthlyFirst: usesMonthlyInferenceCapacity(snapshot),
		}))
	) {
		return { allowed: false, code: "inference_capacity_exhausted", snapshot };
	}
	// Nothing above matched, so the reservation was refused by a condition the
	// INSERT enforces and this ladder does not model. `payment_required` is the
	// least-wrong code we can return without a contract change, but it is a
	// guess — it tells an operator to fix a payment method that may be fine.
	//
	// So record the shape instead of swallowing it. Identifiers, booleans and
	// counts only — never amounts a customer would consider private beyond what
	// their own billing page already shows them.
	unclassifiedAdmissionRefusal({
		organizationId: input.organizationId,
		tediId: input.tediId ?? null,
		status: snapshot.status,
		billingMode: snapshot.billingMode,
		allowOverage: snapshot.allowOverage,
		remainingIncludedTokens: snapshot.remainingIncludedTokens,
		hasStripeCustomer: snapshot.stripeCustomerId !== null,
		availableCreditMicros: snapshot.availableCreditMicros,
		hardSpendLimitMicros: snapshot.hardSpendLimitMicros,
		hadGatewayLimits: Boolean(input.aiGatewayLimits),
		estimatedTokens,
	});
	return { allowed: false, code: "payment_required", snapshot };
}

/**
 * The reservation was refused and the ladder could not say which rule did it.
 *
 * That is always a defect in this file — the ladder is supposed to mirror the
 * INSERT's WHERE clause — and it reaches a customer as a wrong instruction. The
 * marker names the drift.
 */
function unclassifiedAdmissionRefusal(shape: Record<string, unknown>): void {
	try {
		console.log(
			JSON.stringify({ _tr: "admission_refusal_unclassified", ...shape }),
		);
	} catch {
		/* a diagnostic must never fail an admission decision */
	}
}

/**
 * A modest but realistic turn, for callers asking whether inference could run
 * at all rather than admitting one specific request.
 */
export const NOMINAL_TURN_TOKENS = 20_000;

/** Same started-unit delta used by the atomic reservation for one estimate. */
export function incrementalOverageChargeMicros(input: {
	includedTokens: number;
	usedTokens: number;
	reservedTokens: number;
	estimatedTokens: number;
	overageUnitTokens: number;
	overageUnitPriceMicros: number;
}): number {
	if (input.includedTokens < 0 || input.overageUnitPriceMicros <= 0) return 0;
	const before = Math.max(
		0,
		input.usedTokens + input.reservedTokens - input.includedTokens,
	);
	const after = Math.max(
		0,
		input.usedTokens +
			input.reservedTokens +
			input.estimatedTokens -
			input.includedTokens,
	);
	return (
		(Math.ceil(after / input.overageUnitTokens) -
			Math.ceil(before / input.overageUnitTokens)) *
		input.overageUnitPriceMicros
	);
}

/**
 * Why an organization cannot currently be admitted, or null.
 *
 * The console used to answer this with its own copy of the rules in
 * `billing.getBillingOverview`. That made three implementations of one policy
 * — the reservation INSERT, the denial ladder above, and the console — which
 * could disagree: the console reported `available: true` for an organization
 * the gate was denying on every turn.
 *
 * This is the console's source now. It still re-derives rather than asking
 * the INSERT, so there are two copies instead of three, and the two that a
 * human compares agree by construction.
 */
export function billingBlockingReason(input: {
	status: string;
	now: string;
	periodStart: string;
	periodEnd: string;
	allowOverage: boolean;
	remainingIncludedTokens: number;
	billingMode: string;
	stripeCustomerId: string | null;
	isSponsoredCustomer?: boolean;
	availableCreditMicros: number;
	hardSpendLimitMicros: number | null;
	customerChargeMicros: number;
	reservedChargeMicros: number;
	estimatedChargeMicros: number;
	effectiveDailyTokens: number;
	effectiveDailySpendMicros: number | null;
	usedDailyTokens: number;
	usedDailySpendMicros: number;
	/**
	 * Tokens the pending request would consume. The gate passes its real
	 * estimate; a caller asking the general question "could a turn run right
	 * now?" passes `NOMINAL_TURN_TOKENS`.
	 *
	 * It is not optional-with-a-zero-default on purpose. Ignoring it is what
	 * made the console call an organization available with 7,586 tokens left in
	 * its day — true for a one-token request, false for every real turn.
	 */
	estimatedTokens: number;
}):
	| "subscription_inactive"
	| "billing_period_inactive"
	| "monthly_allowance_exhausted"
	| "payment_required"
	| "hard_spend_limit"
	| "inference_capacity_exhausted"
	| null {
	if (!ACTIVE_BILLING_STATUSES.includes(input.status as BillingAccountStatus))
		return "subscription_inactive";
	if (input.now < input.periodStart || input.now >= input.periodEnd)
		return "billing_period_inactive";
	if (
		!input.allowOverage &&
		input.remainingIncludedTokens >= 0 &&
		input.remainingIncludedTokens < input.estimatedTokens
	)
		return "monthly_allowance_exhausted";
	// In overage, the spend has to be fundable by SOMETHING: an invoiced or
	// internal account, a Stripe customer, or credit on the balance.
	if (
		input.allowOverage &&
		input.estimatedChargeMicros > 0 &&
		input.billingMode === "stripe" &&
		input.stripeCustomerId === null &&
		input.availableCreditMicros < input.estimatedChargeMicros
	)
		return "payment_required";
	if (
		input.hardSpendLimitMicros !== null &&
		input.customerChargeMicros +
			input.reservedChargeMicros +
			input.estimatedChargeMicros >
			input.hardSpendLimitMicros
	)
		return "hard_spend_limit";
	if (
		!usesMonthlyInferenceCapacity(input) &&
		(input.usedDailyTokens + input.estimatedTokens >
			input.effectiveDailyTokens ||
			(input.effectiveDailySpendMicros !== null &&
				input.usedDailySpendMicros + input.estimatedChargeMicros >
					input.effectiveDailySpendMicros))
	)
		return "inference_capacity_exhausted";
	return null;
}

export async function releaseBillingReservation(
	db: DbClient,
	input: {
		reservationId: string;
		organizationId: string;
		reason: string;
		now: string;
	},
): Promise<BillingUsageReservation | null> {
	const [row] = await db
		.update(billingUsageReservations)
		.set({
			status: "released",
			rejectionCode: input.reason,
			releasedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingUsageReservations.id, input.reservationId),
				eq(billingUsageReservations.organizationId, input.organizationId),
				eq(billingUsageReservations.status, "reserved"),
			),
		)
		.returning();
	return row ?? null;
}

export async function expireBillingReservations(
	db: DbClient,
	now: string,
): Promise<number> {
	const rows = await db.all<{ id: string }>(sql`
		UPDATE billing_usage_reservations
		SET status = 'expired', updated_at = ${now}
		WHERE id IN (
			SELECT id FROM billing_usage_reservations
			WHERE status = 'reserved' AND expires_at <= ${now}
			ORDER BY expires_at
			LIMIT 500
		)
		RETURNING id
	`);
	return rows.length;
}
