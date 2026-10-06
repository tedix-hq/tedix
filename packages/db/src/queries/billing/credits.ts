/** Canonical billing credits queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingAccount,
	type BillingAccountStatus,
	type BillingCreditEntry,
	type BillingPlanVersion,
	billingAccounts,
	billingCreditEntries,
} from "../../schema/billing";

export async function expireBillingCredits(
	db: DbClient,
	now: string,
): Promise<number> {
	const grants = await db
		.select()
		.from(billingCreditEntries)
		.where(
			and(
				inArray(billingCreditEntries.kind, ["grant", "refund"]),
				lte(billingCreditEntries.expiresAt, now),
				sql`NOT EXISTS (
					SELECT 1 FROM billing_credit_entries AS expiry
					WHERE expiry.idempotency_key =
						('credit-expiry:' || ${billingCreditEntries.id})
				)`,
			),
		)
		.orderBy(asc(billingCreditEntries.expiresAt))
		.limit(500);
	let expired = 0;
	for (const grant of grants) {
		// One atomic INSERT ... SELECT (the reserveUsage admission pattern): the
		// compensating amount is computed from the live balance inside the same
		// statement, and the unique idempotency index absorbs races. D1 has no
		// interactive transactions — an explicit BEGIN/COMMIT (Drizzle
		// `db.transaction`) is rejected by the binding.
		const inserted = await db.all<{ id: string }>(sql`
			INSERT INTO billing_credit_entries (
				id, organization_id, kind, amount_micros, source_type, source_ref,
				idempotency_key, description, metadata, created_at
			)
			SELECT
				${crypto.randomUUID()},
				account.organization_id,
				'adjustment',
				-MIN(account.credit_balance_micros, ${grant.amountMicros}),
				'credit_expiry',
				${grant.id},
				${`credit-expiry:${grant.id}`},
				${`Expired credit grant ${grant.id}`},
				'{}',
				${now}
			FROM billing_accounts AS account
			WHERE account.organization_id = ${grant.organizationId}
				AND account.credit_balance_micros > 0
			ON CONFLICT (idempotency_key) DO NOTHING
			RETURNING id
		`);
		expired += inserted.length;
	}
	return expired;
}

export interface BillingBalanceSnapshot {
	organizationId: string;
	status: BillingAccountStatus;
	billingMode: BillingAccount["billingMode"];
	stripeEnvironment: "test" | "live";
	planKey: BillingPlanVersion["planKey"];
	planVersion: number;
	periodStart: string;
	periodEnd: string;
	includedTokens: number;
	usedTokens: number;
	reservedTokens: number;
	remainingIncludedTokens: number;
	/** Customer token allowance semantics; does not bypass admission limits. */
	unlimitedTokenUsage: boolean;
	creditBalanceMicros: number;
	reservedChargeMicros: number;
	availableCreditMicros: number;
	customerChargeMicros: number;
	hardSpendLimitMicros: number | null;
	allowOverage: boolean;
	stripeCustomerId: string | null;
	isSponsoredCustomer: boolean;
}

export async function getBillingBalanceSnapshot(
	db: DbClient,
	organizationId: string,
	now: string,
): Promise<BillingBalanceSnapshot | null> {
	const rows = (await db.all(sql`
		SELECT
			account.organization_id AS organizationId,
			account.status AS status,
			account.billing_mode AS billingMode,
			account.stripe_environment AS stripeEnvironment,
			plan.plan_key AS planKey,
			plan.version AS planVersion,
			account.period_start AS periodStart,
			account.period_end AS periodEnd,
			plan.included_monthly_tokens AS includedTokens,
   (plan.included_monthly_tokens < 0 OR (
    plan.included_monthly_tokens = 0 AND plan.allow_overage = 1
    AND plan.overage_unit_price_micros = 0
   )) AS unlimitedTokenUsage,
			COALESCE(period.used_input_tokens + period.used_output_tokens, 0) AS usedTokens,
			COALESCE((
				SELECT SUM(
					reservation.estimated_input_tokens +
					reservation.estimated_output_tokens
				)
				FROM billing_usage_reservations AS reservation
				WHERE reservation.organization_id = account.organization_id
					AND reservation.status = 'reserved'
					AND datetime(reservation.expires_at) > datetime(${now})
					AND reservation.period_start = account.period_start
					AND reservation.period_end = account.period_end
			), 0) AS reservedTokens,
			CASE
				WHEN plan.included_monthly_tokens < 0 THEN -1
				ELSE MAX(
					plan.included_monthly_tokens -
					COALESCE(period.used_input_tokens + period.used_output_tokens, 0) -
					COALESCE((
						SELECT SUM(
							reservation.estimated_input_tokens +
							reservation.estimated_output_tokens
						)
						FROM billing_usage_reservations AS reservation
						WHERE reservation.organization_id = account.organization_id
							AND reservation.status = 'reserved'
							AND datetime(reservation.expires_at) > datetime(${now})
							AND reservation.period_start = account.period_start
							AND reservation.period_end = account.period_end
					), 0),
					0
				)
			END AS remainingIncludedTokens,
			account.credit_balance_micros AS creditBalanceMicros,
			COALESCE((
				SELECT SUM(reservation.estimated_charge_micros)
				FROM billing_usage_reservations AS reservation
				WHERE reservation.organization_id = account.organization_id
					AND reservation.status = 'reserved'
					AND datetime(reservation.expires_at) > datetime(${now})
					AND reservation.period_start = account.period_start
					AND reservation.period_end = account.period_end
			), 0) AS reservedChargeMicros,
			MAX(
				account.credit_balance_micros -
				COALESCE((
					SELECT SUM(reservation.estimated_charge_micros)
					FROM billing_usage_reservations AS reservation
					WHERE reservation.organization_id = account.organization_id
						AND reservation.status = 'reserved'
						AND datetime(reservation.expires_at) > datetime(${now})
						AND reservation.period_start = account.period_start
						AND reservation.period_end = account.period_end
				), 0),
				0
			) AS availableCreditMicros,
			COALESCE(period.customer_charge_micros, 0) AS customerChargeMicros,
			account.hard_spend_limit_micros AS hardSpendLimitMicros,
			plan.allow_overage AS allowOverage,
			account.stripe_customer_id AS stripeCustomerId,
			(json_extract(account.metadata, '$.providerCustomerKey') IS NOT NULL
				OR EXISTS (
					SELECT 1 FROM organizations AS customer_org
					WHERE customer_org.id = account.organization_id
						AND json_extract(customer_org.metadata, '$.providerCustomerKey') IS NOT NULL
				)) AS isSponsoredCustomer
		FROM billing_accounts AS account
		INNER JOIN billing_plan_versions AS plan
			ON plan.id = account.plan_version_id
		LEFT JOIN billing_usage_periods AS period
			ON period.organization_id = account.organization_id
			AND period.period_start = account.period_start
			AND period.period_end = account.period_end
		WHERE account.organization_id = ${organizationId}
		LIMIT 1
	`)) as Array<Record<string, unknown>>;
	const row = rows[0];
	if (!row) return null;
	return {
		organizationId: String(row.organizationId),
		status: row.status as BillingAccountStatus,
		billingMode: row.billingMode as BillingAccount["billingMode"],
		stripeEnvironment: row.stripeEnvironment as "test" | "live",
		planKey: row.planKey as BillingPlanVersion["planKey"],
		planVersion: Number(row.planVersion),
		periodStart: String(row.periodStart),
		periodEnd: String(row.periodEnd),
		includedTokens: Number(row.includedTokens),
		usedTokens: Number(row.usedTokens),
		reservedTokens: Number(row.reservedTokens),
		remainingIncludedTokens: Number(row.remainingIncludedTokens),
		unlimitedTokenUsage: Boolean(row.unlimitedTokenUsage),
		creditBalanceMicros: Number(row.creditBalanceMicros),
		reservedChargeMicros: Number(row.reservedChargeMicros),
		availableCreditMicros: Number(row.availableCreditMicros),
		customerChargeMicros: Number(row.customerChargeMicros),
		hardSpendLimitMicros:
			row.hardSpendLimitMicros === null
				? null
				: Number(row.hardSpendLimitMicros),
		allowOverage: Boolean(row.allowOverage),
		stripeCustomerId:
			row.stripeCustomerId === null ? null : String(row.stripeCustomerId),
		isSponsoredCustomer: Boolean(row.isSponsoredCustomer),
	};
}

export async function grantBillingCredit(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		amountMicros: number;
		sourceType: string;
		sourceRef?: string | null;
		idempotencyKey: string;
		expiresAt?: string | null;
		description?: string | null;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<BillingCreditEntry> {
	if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) {
		throw new Error(
			"Billing credit grants require positive integer USD micros",
		);
	}
	// D1 has no interactive transactions (Drizzle `db.transaction` issues a
	// literal BEGIN the binding rejects). The unique idempotency index is the
	// real dedupe: insert with ON CONFLICT DO NOTHING, then read the surviving
	// journal row — either ours or the earlier winner's.
	const [account] = await db
		.select({ organizationId: billingAccounts.organizationId })
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	if (!account) {
		throw new Error(
			`Billing account not found for organization ${input.organizationId}`,
		);
	}
	await db
		.insert(billingCreditEntries)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			kind: "grant",
			amountMicros: input.amountMicros,
			sourceType: input.sourceType,
			sourceRef: input.sourceRef ?? null,
			idempotencyKey: input.idempotencyKey,
			expiresAt: input.expiresAt ?? null,
			description: input.description ?? null,
			metadata: input.metadata ?? {},
			createdAt: input.createdAt,
		})
		.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey });
	const [entry] = await db
		.select()
		.from(billingCreditEntries)
		.where(eq(billingCreditEntries.idempotencyKey, input.idempotencyKey))
		.limit(1);
	if (!entry) throw new Error("Failed to journal billing credit grant");
	return entry;
}
