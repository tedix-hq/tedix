import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { billingAccounts, billingCreditEntries } from "../../schema/billing";
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
		.select(
			db
				.select({
					id: sql<string>`${key}`.as("id"),
					organizationId: billingAccounts.organizationId,
					kind: sql<"grant">`'grant'`.as("kind"),
					amountMicros: sql<number>`${input.amountMicros}`.as("amount_micros"),
					sourceType: sql<string>`'plan_period'`.as("source_type"),
					sourceRef: sql<string>`${input.periodStart}`.as("source_ref"),
					usageChargeId: sql<null>`NULL`.as("usage_charge_id"),
					idempotencyKey: sql<string>`${key}`.as("idempotency_key"),
					expiresAt: sql<null>`NULL`.as("expires_at"),
					description:
						sql<string>`'Included monthly credits (carry forward)'`.as(
							"description",
						),
					metadata: sql<string>`${metadata}`.as("metadata"),
					createdAt: sql<string>`${input.now}`.as("created_at"),
				})
				.from(billingAccounts)
				.where(
					and(
						eq(billingAccounts.organizationId, input.organizationId),
						eq(billingAccounts.planVersionId, input.planVersionId),
						eq(billingAccounts.periodStart, input.periodStart),
						eq(billingAccounts.periodEnd, input.periodEnd),
						eq(billingAccounts.status, "active"),
						input.expectedEntitlementVersion == null
							? undefined
							: eq(
									billingAccounts.entitlementVersion,
									input.expectedEntitlementVersion,
								),
					),
				),
		)
		.onConflictDoNothing({ target: billingCreditEntries.idempotencyKey });
}
