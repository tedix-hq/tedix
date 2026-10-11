import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { billingCreditEntries } from "../../schema/billing";
export function includedCreditPeriodKey(
	organizationId: string,
	periodStart: string,
	periodEnd: string,
) {
	return `included-credit:${organizationId}:${periodStart}:${periodEnd}`;
}

/** The SELECT fences the journal insert on the canonical account, including CAS activation. */
export function buildIncludedCreditPeriodGrant(
	db: DbClient,
	input: {
		organizationId: string;
		planVersionId: string;
		periodStart: string;
		periodEnd: string;
		amountMicros: number;
		now: string;
		metadata?: Record<string, unknown>;
		expectedEntitlementVersion?: number;
	},
) {
	const key = includedCreditPeriodKey(
		input.organizationId,
		input.periodStart,
		input.periodEnd,
	);
	const metadata = JSON.stringify({
		...input.metadata,
		planVersionId: input.planVersionId,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		includedCreditCarryForward: true,
	});
	return db
		.insert(billingCreditEntries)
		.select(sql`SELECT
  ${key}, organization_id, 'grant', ${input.amountMicros}, 'plan_period', ${input.periodStart},
  NULL, ${key}, NULL, 'Included monthly credits (carry forward)', ${metadata}, ${input.now}
  FROM billing_accounts WHERE organization_id = ${input.organizationId}
  AND plan_version_id = ${input.planVersionId} AND period_start = ${input.periodStart}
  AND period_end = ${input.periodEnd} AND status = 'active'
 AND (${input.expectedEntitlementVersion ?? null} IS NULL OR entitlement_version = ${input.expectedEntitlementVersion ?? null})`)
		.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey });
}
