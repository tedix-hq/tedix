import {
	usesMonthlyInferenceCapacity,
	incrementalOverageChargeMicros,
	type BillingReservationDecision,
} from "../../queries/billing/reservations";
import {
	estimateMonetaryInference,
	monetaryInferenceConfig,
} from "../../queries/billing/monetary-inference";
import type { ProviderExecutionAdmissionGuard } from "../../queries/provider-executions";
import type { NewProviderExecutionAttemptRow } from "../../schema/provider-executions";

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	lte,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgQueryClient } from "../query-client";
import {
	type BillingAccountStatus,
	type BillingPlanVersion,
	type BillingUsageReservation,
	type BillingUsageSource,
	billingUsageReservations,
	billingPlanVersions,
	billingAccounts,
	billingCapacityAllocations,
	billingUsageCharges,
	billingUsagePeriods,
} from "../schema/billing";

import { getBillingBalanceSnapshot } from "./billing/credits";
import { effectiveAllowOverageSql } from "./billing/overage";
import { reservationUsedTokensSql } from "../../queries/billing/usage-tokens";
import { liveAtSql, sameUtcDaySql } from "./billing/usage-window";
import {
	monetaryPeriodSpendSql,
	verifyMonetaryQuoteReceipt,
} from "./billing/monetary-inference";

const ACTIVE_BILLING_STATUSES: BillingAccountStatus[] = ["trial", "active"];

export async function listBillingUsageReservations(
	db: PgQueryClient,
	params: {
		organizationId: string;
		status?: (typeof billingUsageReservations.$inferSelect)["status"];
		monetaryCurrency?: string;
		limit?: number;
	},
) {
	return db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.organizationId, params.organizationId),
				params.status
					? eq(billingUsageReservations.status, params.status)
					: undefined,
				params.monetaryCurrency
					? sql`${billingUsageReservations.metadata} #>> '{monetaryQuote,rateSnapshot,customerCurrency}' = ${params.monetaryCurrency}`
					: undefined,
			),
		)
		.orderBy(desc(billingUsageReservations.createdAt))
		.limit(params.limit ?? 100);
}

async function aiGatewayLimitExceeded(
	db: PgQueryClient,
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
	const account = alias(billingAccounts, "account");
	const plan = alias(billingPlanVersions, "plan");
	const period = alias(billingUsagePeriods, "period");
	const reservation = alias(billingUsageReservations, "reservation");
	const tediId = input.tediId ?? null;
	/** Sum of one scalar subquery, or 0 when it matches no rows. */
	const total = (subquery: SQLWrapper) => sql<number>`COALESCE(${subquery}, 0)`;
	const dayTokens = (tediFilter?: SQL) =>
		db
			.select({ tokens: sql`SUM(${reservationUsedTokensSql("reservation")})` })
			.from(reservation)
			.where(
				and(
					eq(reservation.organizationId, account.organizationId),
					tediFilter,
					sameUtcDaySql("reservation.created_at", input.now),
					sql`${reservation.status} IN ('reserved', 'settled')`,
					sql`(${reservation.status} = 'settled' OR ${liveAtSql("reservation.expires_at", input.now)})`,
				),
			);
	const daySpend = (alias: string, tediFilter: boolean) => {
		const spend = db
			.select({
				spendMicros:
					sql<number>`${billingUsageReservations.estimatedChargeMicros}`.as(
						"spend_micros",
					),
			})
			.from(billingUsageReservations)
			.where(
				and(
					eq(billingUsageReservations.organizationId, account.organizationId),
					tediFilter
						? sql`${billingUsageReservations.tediId} = ${tediId}`
						: undefined,
					sameUtcDaySql("created_at", input.now),
					sql`${billingUsageReservations.status} = 'reserved'`,
					liveAtSql("expires_at", input.now),
				),
			)
			.unionAll(
				db
					.select({
						spendMicros:
							sql<number>`${billingUsageCharges.providerCostMicros}`.as(
								"spend_micros",
							),
					})
					.from(billingUsageCharges)
					.where(
						and(
							eq(billingUsageCharges.organizationId, account.organizationId),
							tediFilter
								? sql`${billingUsageCharges.tediId} = ${tediId}`
								: undefined,
							sameUtcDaySql("occurred_at", input.now),
						),
					),
			)
			.as(alias);
		return db.select({ total: sql`SUM(${spend.spendMicros})` }).from(spend);
	};
	const dayCapacity = (amount: SQL) =>
		db
			.select({ total: sql`SUM(${amount})` })
			.from(billingCapacityAllocations)
			.where(
				and(
					eq(billingCapacityAllocations.organizationId, account.organizationId),
					sql`${billingCapacityAllocations.budgetDay} = substr(${input.now}, 1, 10)`,
					eq(
						billingCapacityAllocations.stripeEnvironment,
						input.stripeEnvironment,
					),
					liveAtSql("expires_at", input.now),
				),
			);
	const usage = db.$with("usage").as(
		db
			.select({
				organizationId: account.organizationId,
				includedMonthlyTokens: plan.includedMonthlyTokens,
				overageUnitTokens: plan.overageUnitTokens,
				overageUnitPriceMicros: plan.overageUnitPriceMicros,
				usedTokens:
					sql<number>`COALESCE(${period.usedInputTokens} + ${period.usedOutputTokens}, 0)`.as(
						"used_tokens",
					),
				reservedTokens: total(
					db
						.select({
							tokens: sql`SUM(${billingUsageReservations.estimatedInputTokens} + ${billingUsageReservations.estimatedOutputTokens})`,
						})
						.from(billingUsageReservations)
						.where(
							and(
								eq(
									billingUsageReservations.organizationId,
									account.organizationId,
								),
								sql`${billingUsageReservations.status} = 'reserved'`,
								liveAtSql("expires_at", input.now),
								eq(billingUsageReservations.periodStart, account.periodStart),
								eq(billingUsageReservations.periodEnd, account.periodEnd),
							),
						),
				).as("reserved_tokens"),
				organizationDayTokens: total(dayTokens()).as("organization_day_tokens"),
				organizationDaySpendMicros: total(
					daySpend("organization_spend", false),
				).as("organization_day_spend_micros"),
				organizationDayCapacityTokens: total(
					dayCapacity(sql`${billingCapacityAllocations.tokenAmount}`),
				).as("organization_day_capacity_tokens"),
				organizationDayCapacitySpendMicros: total(
					dayCapacity(sql`${billingCapacityAllocations.spendAmountMicros}`),
				).as("organization_day_capacity_spend_micros"),
				tediDayTokens: total(
					dayTokens(sql`${reservation.tediId} = ${tediId}`),
				).as("tedi_day_tokens"),
				tediDaySpendMicros: total(daySpend("tedi_spend", true)).as(
					"tedi_day_spend_micros",
				),
			})
			.from(account)
			.innerJoin(plan, eq(plan.id, account.planVersionId))
			.leftJoin(
				period,
				and(
					eq(period.organizationId, account.organizationId),
					eq(period.periodStart, account.periodStart),
					eq(period.periodEnd, account.periodEnd),
				),
			)
			.where(eq(account.organizationId, input.organizationId)),
	);
	const projected = sql`${usage.usedTokens} + ${usage.reservedTokens} + ${input.estimatedTokens}`;
	const [row] = await db
		.with(usage)
		.select({
			organizationDayTokens: usage.organizationDayTokens,
			organizationDaySpendMicros: usage.organizationDaySpendMicros,
			organizationDayCapacityTokens: usage.organizationDayCapacityTokens,
			organizationDayCapacitySpendMicros:
				usage.organizationDayCapacitySpendMicros,
			tediDayTokens: usage.tediDayTokens,
			tediDaySpendMicros: usage.tediDaySpendMicros,
			estimatedChargeMicros: sql<number>`CASE
				WHEN ${usage.includedMonthlyTokens} < 0 OR
					${projected} <= ${usage.includedMonthlyTokens}
					THEN 0
				WHEN ${usage.overageUnitPriceMicros} <= 0 THEN 0
				ELSE (
					CAST(FLOOR((GREATEST(${projected} - ${usage.includedMonthlyTokens}, 0) + ${usage.overageUnitTokens} - 1) / ${usage.overageUnitTokens}) AS BIGINT) -
					CAST(FLOOR((GREATEST(${usage.usedTokens} + ${usage.reservedTokens} - ${usage.includedMonthlyTokens}, 0) + ${usage.overageUnitTokens} - 1) / ${usage.overageUnitTokens}) AS BIGINT)
				) * ${usage.overageUnitPriceMicros}
			END`,
		})
		.from(usage);
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
	db: PgQueryClient,
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
	db: PgQueryClient,
	input: BillingReservationPreflightInput,
) {
	// Keep replay keys tenant-scoped even though their unique index is global.
	const existingStatement = db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.idempotencyKey, input.idempotencyKey),
				eq(billingUsageReservations.organizationId, input.organizationId),
				input.executionGuard ? sql`false` : undefined,
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
async function reserveBillingUsageInTransaction(
	db: PgQueryClient,
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
	if (input.execution || input.executionGuard)
		throw new Error("Postgres provider execution admission is not ported");
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
	// The caller's reads may predate the account lock and a competing admission.
	const [existing, plans] = await Promise.all(
		buildBillingReservationPreflightStatements(db, input),
	);
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
			if (input.model === "cloudflare/auto")
				throw new Error("Auto routing can reach an unpriced model");
			const deploymentScope = input.deploymentScope;
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
	// Account locking serializes the admission snapshot against other wallet writes.
	const [inserted] = await db.execute<{
		id: string;
		planVersionId: string;
		expiresAt: string;
		estimatedChargeMicros: number | string;
	}>(
		sql`
		WITH snapshot AS (
			SELECT
				account.organization_id,
				plan.id AS plan_version_id,
				coalesce((plan.metadata #> '{monetaryInference,version}' IN ('1'::jsonb, 'true'::jsonb))::integer,0) AS is_monetary,
				(plan.metadata #>> '{monetaryInference,perRunBudgetMicros}')::bigint AS run_budget_micros,
				COALESCE((
					SELECT SUM(charge.credit_applied_micros)
					FROM billing_usage_charges AS charge
					JOIN billing_usage_reservations AS held ON held.id = charge.reservation_id
					WHERE held.organization_id = ${input.organizationId}
						AND held.run_id = ${input.runId ?? null}
						AND charge.metadata #> '{monetaryQuote,schemaVersion}' IN ('1'::jsonb, 'true'::jsonb)
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
				((account.metadata #>> '{providerCustomerKey}') IS NOT NULL
					OR EXISTS (
						SELECT 1 FROM organizations AS customer_org
						WHERE customer_org.id = account.organization_id
							AND (customer_org.metadata #>> '{providerCustomerKey}') IS NOT NULL
					))::integer AS is_sponsored_customer,
				account.stripe_environment AS account_stripe_environment,
				account.period_start,
				account.period_end,
				account.hard_spend_limit_micros,
				account.credit_balance_micros,
				account.stripe_customer_id,
				account.stripe_environment,
				plan.included_monthly_tokens,
				(${effectiveAllowOverageSql("plan", "account")})::integer AS allow_overage,
				plan.overage_unit_tokens,
				plan.overage_unit_price_micros,
				COALESCE(period.used_input_tokens + period.used_output_tokens, 0)
					AS used_tokens,
				CASE WHEN plan.metadata #> '{monetaryInference,version}' IN ('1'::jsonb, 'true'::jsonb) THEN ${monetaryPeriodSpendSql()} ELSE COALESCE(period.customer_charge_micros, 0) END AS charged_micros,
				COALESCE((
					SELECT SUM(
						reservation.estimated_input_tokens +
						reservation.estimated_output_tokens
					)
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status = 'reserved'
						AND ${liveAtSql("reservation.expires_at", input.now)}
						AND reservation.period_start = account.period_start
						AND reservation.period_end = account.period_end
				), 0) AS reserved_tokens,
				COALESCE((
					SELECT SUM(reservation.estimated_charge_micros)
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status = 'reserved'
						AND ${liveAtSql("reservation.expires_at", input.now)}
						AND reservation.period_start = account.period_start
						AND reservation.period_end = account.period_end
				), 0) AS reserved_charge_micros
				, COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND ${sameUtcDaySql("reservation.created_at", input.now)}
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR ${liveAtSql("reservation.expires_at", input.now)})
				), 0) AS organization_day_tokens
				, COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT reservation.estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations AS reservation
						WHERE reservation.organization_id = account.organization_id
							AND ${sameUtcDaySql("reservation.created_at", input.now)}
							AND reservation.status = 'reserved'
							AND ${liveAtSql("reservation.expires_at", input.now)}
						UNION ALL
						SELECT charge.provider_cost_micros AS spend_micros
						FROM billing_usage_charges AS charge
						WHERE charge.organization_id = account.organization_id
							AND ${sameUtcDaySql("charge.occurred_at", input.now)}
					)
				), 0) AS organization_day_spend_micros
				, COALESCE((
					SELECT SUM(allocation_row.token_amount)
					FROM billing_capacity_allocations AS allocation_row
					WHERE allocation_row.organization_id = account.organization_id
						AND allocation_row.budget_day = substr(${input.now}, 1, 10)
						AND allocation_row.stripe_environment = ${input.stripeEnvironment ?? "live"}
						AND ${liveAtSql("allocation_row.expires_at", input.now)}
				), 0) AS organization_day_capacity_tokens
				, COALESCE((
					SELECT SUM(allocation_row.spend_amount_micros)
					FROM billing_capacity_allocations AS allocation_row
					WHERE allocation_row.organization_id = account.organization_id
						AND allocation_row.budget_day = substr(${input.now}, 1, 10)
						AND allocation_row.stripe_environment = ${input.stripeEnvironment ?? "live"}
						AND ${liveAtSql("allocation_row.expires_at", input.now)}
				), 0) AS organization_day_capacity_spend_micros
				, COALESCE((
					SELECT SUM(${reservationUsedTokensSql("reservation")})
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.tedi_id = ${input.tediId ?? null}
						AND ${sameUtcDaySql("reservation.created_at", input.now)}
						AND reservation.status IN ('reserved', 'settled')
						AND (reservation.status = 'settled' OR ${liveAtSql("reservation.expires_at", input.now)})
				), 0) AS tedi_day_tokens
				, COALESCE((
					SELECT SUM(spend_micros)
					FROM (
						SELECT estimated_charge_micros AS spend_micros
						FROM billing_usage_reservations
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND ${sameUtcDaySql("created_at", input.now)}
							AND status = 'reserved'
							AND ${liveAtSql("expires_at", input.now)}
						UNION ALL
						SELECT provider_cost_micros AS spend_micros
						FROM billing_usage_charges
						WHERE organization_id = account.organization_id
							AND tedi_id = ${input.tediId ?? null}
							AND ${sameUtcDaySql("occurred_at", input.now)}
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
					ELSE GREATEST(
						used_tokens + reserved_tokens + ${estimatedTokens} -
						included_monthly_tokens,
						0
					) - GREATEST(
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
						CAST(FLOOR((
							GREATEST(
								used_tokens + reserved_tokens + ${estimatedTokens} -
									included_monthly_tokens,
								0
							) + overage_unit_tokens - 1
						) / overage_unit_tokens) AS BIGINT) -
						CAST(FLOOR((
							GREATEST(
								used_tokens + reserved_tokens -
									included_monthly_tokens,
								0
							) + overage_unit_tokens - 1
						) / overage_unit_tokens) AS BIGINT)
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
			AND date_trunc('second', (${input.expiresAt})::timestamptz) > date_trunc('second', (${input.now})::timestamptz)
			AND status IN ('trial', 'active')
			AND (
				billing_mode <> 'stripe'
				OR account_stripe_environment = ${input.stripeEnvironment ?? "live"}
			)
			AND date_trunc('second', (${input.now})::timestamptz) >= date_trunc('second', (period_start)::timestamptz)
			AND date_trunc('second', (${input.now})::timestamptz) < date_trunc('second', (period_end)::timestamptz)
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
				is_monetary = 1 OR ${input.aiGatewayLimits?.organizationDailyTokenLimit ?? null}::bigint IS NULL
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
				${input.aiGatewayLimits?.organizationDailySpendLimitMicros ?? null}::bigint IS NULL
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
				is_monetary = 1 OR ${input.aiGatewayLimits?.tediDailyTokenLimit ?? null}::bigint IS NULL
				OR tedi_day_tokens + ${estimatedTokens} <=
					${input.aiGatewayLimits?.tediDailyTokenLimit ?? null} +
					GREATEST(organization_day_capacity_tokens, 0)
			)
			AND (
				${input.aiGatewayLimits?.tediDailySpendLimitMicros ?? null}::bigint IS NULL
				OR tedi_day_spend_micros + estimated_charge_micros <=
					${input.aiGatewayLimits?.tediDailySpendLimitMicros ?? null} +
					GREATEST(organization_day_capacity_spend_micros, 0)
			)
		ON CONFLICT(idempotency_key) DO NOTHING
		RETURNING
			id,
			plan_version_id AS "planVersionId",
			expires_at AS "expiresAt",
			estimated_charge_micros AS "estimatedChargeMicros"
	`,
		"objects",
	);
	if (inserted)
		return {
			allowed: true,
			reservation: {
				...inserted,
				estimatedChargeMicros: Number(inserted.estimatedChargeMicros),
			},
		};

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

/** Record a refusal whose explanation diverged from the INSERT predicate. */
function unclassifiedAdmissionRefusal(shape: Record<string, unknown>): void {
	try {
		console.log(
			JSON.stringify({ _tr: "admission_refusal_unclassified", ...shape }),
		);
	} catch {
		/* a diagnostic must never fail an admission decision */
	}
}

export async function releaseBillingReservation(
	db: PgQueryClient,
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
	db: PgQueryClient,
	now: string,
): Promise<number> {
	const rows = await db
		.update(billingUsageReservations)
		.set({ status: "expired", updatedAt: now })
		.where(
			and(
				eq(billingUsageReservations.status, "reserved"),
				// bound-params: a subquery, not a bound list.
				inArray(
					billingUsageReservations.id,
					db
						.select({ id: billingUsageReservations.id })
						.from(billingUsageReservations)
						.where(
							and(
								eq(billingUsageReservations.status, "reserved"),
								lte(billingUsageReservations.expiresAt, now),
							),
						)
						.orderBy(asc(billingUsageReservations.expiresAt))
						.limit(500),
				),
			),
		)
		.returning({ id: billingUsageReservations.id });
	return rows.length;
}

export async function reserveBillingUsage(
	db: PgQueryClient,
	input: Parameters<typeof reserveBillingUsageInTransaction>[1],
): Promise<BillingReservationDecision> {
	return db.transaction(async (tx) => {
		await tx
			.select({ organizationId: billingAccounts.organizationId })
			.from(billingAccounts)
			.where(eq(billingAccounts.organizationId, input.organizationId))
			.for("update");
		return reserveBillingUsageInTransaction(tx, input);
	});
}
