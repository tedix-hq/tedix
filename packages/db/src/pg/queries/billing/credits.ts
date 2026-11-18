import { monetaryPeriodSpendSql } from "./monetary-inference";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgQueryClient } from "../../query-client";
import {
	billingAccounts,
	billingCreditEntries,
	billingPlanVersions,
	billingUsagePeriods,
} from "../../schema/billing";
import type { BillingBalanceSnapshot } from "../../../queries/billing/credits";
import type { grantBillingCredit as grantSqliteCredit } from "../../../queries/billing/credits";
import { effectiveAllowOverage } from "../../../queries/billing/overage";

export async function grantBillingCredit(
	db: PgQueryClient,
	input: Parameters<typeof grantSqliteCredit>[1],
) {
	if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0)
		throw new Error(
			"Billing credit grants require positive integer USD micros",
		);
	return db.transaction(async (tx) => {
		const [account] = await tx
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.organizationId, input.organizationId))
			.for("update");
		if (!account)
			throw new Error(
				`Billing account not found for organization ${input.organizationId}`,
			);
		await tx
			.insert(billingCreditEntries)
			.values({
				...input,
				kind: "grant",
				sourceRef: input.sourceRef ?? null,
				expiresAt: input.expiresAt ?? null,
				description: input.description ?? null,
				metadata: input.metadata ?? {},
			})
			.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey });
		const [entry] = await tx
			.select()
			.from(billingCreditEntries)
			.where(eq(billingCreditEntries.idempotencyKey, input.idempotencyKey))
			.limit(1);
		if (!entry) throw new Error("Failed to journal billing credit grant");
		return entry;
	});
}

export async function expireBillingCredits(
	db: PgQueryClient,
	now: string,
): Promise<number> {
	const grants = await db
		.select()
		.from(billingCreditEntries)
		.where(
			and(
				inArray(billingCreditEntries.kind, ["grant", "refund"]),
				lte(billingCreditEntries.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM billing_credit_entries expiry WHERE expiry.idempotency_key = 'credit-expiry:' || ${billingCreditEntries.id})`,
			),
		)
		.orderBy(asc(billingCreditEntries.expiresAt))
		.limit(500);
	let expired = 0;
	for (const grant of grants)
		expired += await db.transaction(async (tx) => {
			const [account] = await tx
				.select()
				.from(billingAccounts)
				.where(
					and(
						eq(billingAccounts.organizationId, grant.organizationId),
						gt(billingAccounts.creditBalanceMicros, 0),
					),
				)
				.for("update");
			if (!account) return 0;
			const rows = await tx
				.insert(billingCreditEntries)
				.values({
					id: crypto.randomUUID(),
					organizationId: grant.organizationId,
					kind: "adjustment",
					amountMicros: -Math.min(
						account.creditBalanceMicros,
						grant.amountMicros,
					),
					sourceType: "credit_expiry",
					sourceRef: grant.id,
					idempotencyKey: `credit-expiry:${grant.id}`,
					description: `Expired credit grant ${grant.id}`,
					metadata: {},
					createdAt: now,
				})
				.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey })
				.returning({ id: billingCreditEntries.id });
			return rows.length;
		});
	return expired;
}

/** All sums use one Postgres statement snapshot, including concurrent reservations. */
export async function getBillingBalanceSnapshot(
	db: PgQueryClient,
	organizationId: string,
	now: string,
): Promise<BillingBalanceSnapshot | null> {
	const account = alias(billingAccounts, "account");
	const [row] = await db
		.select({
			account,
			plan: billingPlanVersions,
			usedTokens:
				sql<number>`coalesce(${billingUsagePeriods.usedInputTokens}+${billingUsagePeriods.usedOutputTokens},0)`.mapWith(
					Number,
				),
			customerChargeMicros:
				sql<number>`coalesce(${billingUsagePeriods.customerChargeMicros},0)`.mapWith(
					Number,
				),
			reservedTokens:
				sql<number>`coalesce((select sum(estimated_input_tokens + estimated_output_tokens) from billing_usage_reservations r where r.organization_id=${account.organizationId} and r.status='reserved' and r.expires_at::timestamptz >= date_trunc('second',${now}::timestamptz)+interval '1 second' and r.period_start=${account.periodStart} and r.period_end=${account.periodEnd}),0)`.mapWith(
					Number,
				),
			reservedChargeMicros:
				sql<number>`coalesce((select sum(estimated_charge_micros) from billing_usage_reservations r where r.organization_id=${account.organizationId} and r.status='reserved' and r.expires_at::timestamptz >= date_trunc('second',${now}::timestamptz)+interval '1 second' and r.period_start=${account.periodStart} and r.period_end=${account.periodEnd}),0)`.mapWith(
					Number,
				),
			monetarySpentMicros: sql<number>`${monetaryPeriodSpendSql()}`.mapWith(
				Number,
			),
			isSponsoredCustomer: sql<boolean>`(${account.metadata}->>'providerCustomerKey' is not null or exists (select 1 from organizations o where o.id=${account.organizationId} and o.metadata->>'providerCustomerKey' is not null))`,
		})
		.from(account)
		.innerJoin(
			billingPlanVersions,
			eq(billingPlanVersions.id, account.planVersionId),
		)
		.leftJoin(
			billingUsagePeriods,
			and(
				eq(billingUsagePeriods.organizationId, account.organizationId),
				eq(billingUsagePeriods.periodStart, account.periodStart),
				eq(billingUsagePeriods.periodEnd, account.periodEnd),
			),
		)
		.where(eq(account.organizationId, organizationId))
		.limit(1);
	if (!row) return null;
	const { account: a, plan: p } = row;
	return {
		organizationId,
		status: a.status,
		billingMode: a.billingMode,
		stripeEnvironment: a.stripeEnvironment as "test" | "live",
		planKey: p.planKey,
		planVersion: p.version,
		periodStart: a.periodStart,
		periodEnd: a.periodEnd,
		includedTokens: p.includedMonthlyTokens,
		overageUnitTokens: p.overageUnitTokens,
		overageUnitPriceMicros: p.overageUnitPriceMicros,
		usedTokens: row.usedTokens,
		reservedTokens: row.reservedTokens,
		remainingIncludedTokens:
			p.includedMonthlyTokens < 0
				? -1
				: Math.max(
						p.includedMonthlyTokens - row.usedTokens - row.reservedTokens,
						0,
					),
		unlimitedTokenUsage:
			p.includedMonthlyTokens < 0 ||
			(p.includedMonthlyTokens === 0 &&
				p.allowOverage &&
				p.overageUnitPriceMicros === 0),
		creditBalanceMicros: a.creditBalanceMicros,
		reservedChargeMicros: row.reservedChargeMicros,
		availableCreditMicros: Math.max(
			a.creditBalanceMicros - row.reservedChargeMicros,
			0,
		),
		customerChargeMicros: row.customerChargeMicros,
		monetarySpentMicros: row.monetarySpentMicros,
		hardSpendLimitMicros: a.hardSpendLimitMicros,
		allowOverage: effectiveAllowOverage(p, a),
		overageEnabled: a.overageEnabled,
		stripeCustomerId: a.stripeCustomerId,
		isSponsoredCustomer: row.isSponsoredCustomer,
	};
}
