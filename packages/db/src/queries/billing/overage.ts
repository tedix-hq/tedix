/**
 * Admin overage opt-in.
 *
 * `billing_plan_versions.allow_overage` says whether a plan may run past its
 * included allowance. Priced overage is additionally off per organization
 * until an admin enables it with a monthly cap; zero-priced overage (internal
 * metering) needs no opt-in because nothing is sold.
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingAccount,
	type BillingPlanVersion,
	billingAccounts,
} from "../../schema/billing";

/** Ceiling for one monthly overage cap: 1,000,000 currency units. */
export const BILLING_OVERAGE_MONTHLY_CAP_MAX_MICROS = 1_000_000_000_000;

/**
 * SQL for the effective overage permission. `plan` and `account` are the
 * aliases of `billing_plan_versions` and `billing_accounts` in the enclosing
 * FROM clause. Keep this in step with `effectiveAllowOverage`.
 */
export function effectiveAllowOverageSql(
	planAlias: string,
	accountAlias: string,
): string {
	return `(${planAlias}.allow_overage = 1 AND (${planAlias}.overage_unit_price_micros = 0 OR ${accountAlias}.overage_enabled = 1))`;
}

export function effectiveAllowOverage(
	plan: Pick<BillingPlanVersion, "allowOverage" | "overageUnitPriceMicros">,
	account: Pick<BillingAccount, "overageEnabled">,
): boolean {
	return (
		plan.allowOverage &&
		(plan.overageUnitPriceMicros === 0 || account.overageEnabled)
	);
}

export async function setBillingOverageSettings(
	db: DbClient,
	input: {
		organizationId: string;
		enabled: boolean;
		monthlyCapMicros: number | null;
		now: string;
	},
): Promise<boolean> {
	const rows = await db
		.update(billingAccounts)
		.set({
			overageEnabled: input.enabled,
			hardSpendLimitMicros: input.monthlyCapMicros,
			updatedAt: input.now,
		})
		.where(and(eq(billingAccounts.organizationId, input.organizationId)))
		.returning({ organizationId: billingAccounts.organizationId });
	return rows.length > 0;
}
