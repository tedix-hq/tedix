/** Canonical billing plans queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { batchNonEmpty } from "../../utils/batch";
import {
	type BillingAccount,
	type BillingAccountStatus,
	type BillingPlanVersion,
	billingAccounts as schemaBillingAccounts,
	billingPlanVersions as schemaBillingPlanVersions,
	billingUsageReservations as schemaBillingUsageReservations,
} from "../../schema/billing";

export interface BillingEntitlement {
	account: BillingAccount;
	plan: BillingPlanVersion;
}

export async function getActiveBillingPlanByKey(
	db: DbClient,
	planKey: BillingPlanVersion["planKey"],
	now: string,
): Promise<BillingPlanVersion | null> {
	const billingPlanVersions = coreTable(db, schemaBillingPlanVersions);
	const [plan] = await db
		.select()
		.from(billingPlanVersions)
		.where(
			and(
				eq(billingPlanVersions.planKey, planKey),
				eq(billingPlanVersions.status, "active"),
				lte(billingPlanVersions.effectiveAt, now),
			),
		)
		.orderBy(desc(billingPlanVersions.version))
		.limit(1);
	return plan ?? null;
}

export async function getBillingEntitlement(
	db: DbClient,
	organizationId: string,
): Promise<BillingEntitlement | null> {
	const row = await db.query.billingAccounts.findFirst({
		where: { organizationId },
		with: { planVersion: true },
	});
	if (!row?.planVersion) return null;

	const { planVersion, ...account } = row;
	return { account, plan: planVersion };
}

export async function getBillingEntitlementByStripeCustomerId(
	db: DbClient,
	stripeCustomerId: string,
	stripeEnvironment: "test" | "live",
): Promise<BillingEntitlement | null> {
	const row = await db.query.billingAccounts.findFirst({
		where: { stripeCustomerId, stripeEnvironment },
		with: { planVersion: true },
	});
	if (!row?.planVersion) return null;

	const { planVersion, ...account } = row;
	return { account, plan: planVersion };
}

/**
 * Persist the customer created by a one-time Stripe Checkout without changing
 * subscription mode or plan. A concurrent or cross-environment provider
 * identity wins; this helper never overwrites it.
 */
export async function linkBillingAccountStripeCustomerIfUnbound(
	db: DbClient,
	input: {
		organizationId: string;
		stripeCustomerId: string;
		stripeEnvironment: "test" | "live";
		now: string;
	},
): Promise<boolean> {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const [account] = await db
		.update(billingAccounts)
		.set({
			stripeCustomerId: input.stripeCustomerId,
			stripeEnvironment: input.stripeEnvironment,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingAccounts.organizationId, input.organizationId),
				or(
					isNull(billingAccounts.stripeEnvironment),
					eq(billingAccounts.stripeEnvironment, input.stripeEnvironment),
				),
				or(
					isNull(billingAccounts.stripeCustomerId),
					eq(billingAccounts.stripeCustomerId, input.stripeCustomerId),
				),
			),
		)
		.returning({ organizationId: billingAccounts.organizationId });
	return Boolean(account);
}

type ProvisionBillingAccountValues = {
	organizationId: string;
	planVersionId: string;
	status: BillingAccountStatus;
	billingMode: BillingAccount["billingMode"];
	stripeEnvironment?: "test" | "live" | null;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	stripeCancelAtPeriodEnd?: boolean | null;
	periodStart: string;
	periodEnd: string;
	now: string;
	metadata?: Record<string, JsonValue>;
};

function billingAccountUpdateValues(
	billingAccounts: typeof schemaBillingAccounts,
	input: ProvisionBillingAccountValues,
) {
	return {
		planVersionId: input.planVersionId,
		status: input.status,
		billingMode: input.billingMode,
		stripeEnvironment: input.stripeEnvironment ?? null,
		...(input.stripeCustomerId !== undefined && {
			stripeCustomerId: input.stripeCustomerId,
		}),
		...(input.stripeSubscriptionId !== undefined && {
			stripeSubscriptionId: input.stripeSubscriptionId,
		}),
		...(input.stripeCancelAtPeriodEnd !== undefined && {
			stripeCancelAtPeriodEnd: input.stripeCancelAtPeriodEnd,
		}),
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		entitlementVersion: sql`${billingAccounts.entitlementVersion} + 1`,
		metadata: input.metadata ?? {},
		updatedAt: input.now,
	};
}

/**
 * Build the billing-account upsert as an unexecuted statement.
 *
 * D1 rejects `BEGIN TRANSACTION`/`SAVEPOINT` outright (Cloudflare error 7500),
 * so `db.transaction()` — which Drizzle's D1 driver implements by emitting a
 * literal `begin` — throws against a real database even though it passes under
 * Miniflare's in-memory SQLite. `db.batch()` is the only atomic multi-write
 * primitive on D1, and it needs statements it can execute itself. Callers that
 * must write a billing account atomically alongside other rows compose this
 * builder into their batch; `provisionBillingAccount` executes it standalone.
 */
export function buildProvisionBillingAccountStatement(
	db: DbClient,
	input: ProvisionBillingAccountValues,
) {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	return db
		.insert(billingAccounts)
		.values({
			organizationId: input.organizationId,
			planVersionId: input.planVersionId,
			status: input.status,
			billingMode: input.billingMode,
			stripeEnvironment: input.stripeEnvironment ?? null,
			stripeCustomerId: input.stripeCustomerId ?? null,
			stripeSubscriptionId: input.stripeSubscriptionId ?? null,
			stripeCancelAtPeriodEnd: input.stripeCancelAtPeriodEnd ?? null,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			metadata: input.metadata ?? {},
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: billingAccounts.organizationId,
			set: billingAccountUpdateValues(billingAccounts, input),
		})
		.returning();
}

export function buildUpdateStripeBillingAccountStatement(
	db: DbClient,
	input: ProvisionBillingAccountValues & {
		stripeWebhookCustomerKey: string;
		stripeWebhookEventCreatedAt: number;
	},
	guard: SQL,
) {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	return db
		.update(billingAccounts)
		.set({
			...billingAccountUpdateValues(billingAccounts, input),
			stripeWebhookCustomerKey: input.stripeWebhookCustomerKey,
			stripeWebhookEventCreatedAt: input.stripeWebhookEventCreatedAt,
		})
		.where(
			and(eq(billingAccounts.organizationId, input.organizationId), guard),
		);
}

/** Resolve the active plan for `planKey` or throw with the key that missed. */
export async function requireActiveBillingPlan(
	db: DbClient,
	planKey: BillingPlanVersion["planKey"],
	now: string,
): Promise<BillingPlanVersion> {
	const plan = await getActiveBillingPlanByKey(db, planKey, now);
	if (!plan) {
		throw new Error(`Active billing plan not found: ${planKey}`);
	}
	return plan;
}

export async function provisionBillingAccount(
	db: DbClient,
	input: {
		organizationId: string;
		planKey: BillingPlanVersion["planKey"];
		status: BillingAccountStatus;
		billingMode: BillingAccount["billingMode"];
		stripeEnvironment?: "test" | "live" | null;
		stripeCustomerId?: string | null;
		stripeSubscriptionId?: string | null;
		stripeCancelAtPeriodEnd?: boolean | null;
		periodStart: string;
		periodEnd: string;
		now: string;
		metadata?: Record<string, JsonValue>;
	},
): Promise<BillingAccount> {
	const plan = await requireActiveBillingPlan(db, input.planKey, input.now);
	const [account] = await buildProvisionBillingAccountStatement(db, {
		...input,
		planVersionId: plan.id,
	});
	if (!account) throw new Error("Failed to provision billing account");
	return account;
}

/**
 * Put a billing account back on a correct period window.
 *
 * `rollBillingPeriods` is already monthly — it advances `periodEnd` by one
 * `setUTCMonth` whenever a window has closed. What it cannot do is reach an
 * account whose window is WRONG rather than expired: an account provisioned
 * with a year-long window has one monthly allowance covering a year, and the
 * roll would not touch it until that window closes. Nothing in the product
 * could correct that, which is why an operator's only options were a credit
 * grant or waiting out the window.
 *
 * Deliberately narrow: it moves the window and nothing else. It does not
 * change the plan, the status, the mode, or any balance. Concurrency is fenced
 * on `entitlementVersion` like every other entitlement write, and the version
 * bump makes downstream caches re-read.
 *
 * IT RESETS ALLOWANCE ACCOUNTING, DELIBERATELY. Reservations are matched on the
 * PAIR (`period_start`, `period_end`), so moving either end detaches the usage
 * already metered against the old window and the included allowance reads as
 * untouched again. That is the intended effect — the reason to correct a window
 * is usually that an allowance was stretched across the wrong span, and
 * re-homing the usage would leave the account over allowance and still blocked.
 * It is recorded rather than implied: the orphaned totals go into
 * `lastPeriodCorrection` so the reset is reconstructable afterwards.
 *
 * `periodStart` may still not move EARLIER than the current one. Re-opening a
 * span that has already closed would pull in usage from periods before it.
 */
export async function correctBillingAccountPeriod(
	db: DbClient,
	input: {
		organizationId: string;
		periodStart: string;
		periodEnd: string;
		now: string;
		/** Why, for the audit trail. Required: a silent period rewrite is a bug. */
		reason: string;
	},
): Promise<BillingAccount> {
	if (!input.reason.trim())
		throw new Error("A billing period correction must record a reason");
	if (Date.parse(input.periodEnd) <= Date.parse(input.periodStart))
		throw new Error("Billing period must end after it starts");
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const billingUsageReservations = coreTable(
		db,
		schemaBillingUsageReservations,
	);
	const [account] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	if (!account) throw new Error("No billing account for organization");
	// What the reset is about to detach, captured before it is detached.
	const [orphaned] = await db
		.select({
			tokens: sql<number>`COALESCE(SUM(${billingUsageReservations.estimatedInputTokens} + ${billingUsageReservations.estimatedOutputTokens}), 0)`,
			chargeMicros: sql<number>`COALESCE(SUM(${billingUsageReservations.estimatedChargeMicros}), 0)`,
		})
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.organizationId, input.organizationId),
				inArray(billingUsageReservations.status, ["reserved", "settled"]),
				eq(billingUsageReservations.periodStart, account.periodStart),
				eq(billingUsageReservations.periodEnd, account.periodEnd),
			),
		);
	if (Date.parse(input.periodStart) < Date.parse(account.periodStart))
		throw new Error(
			"A correction may not move periodStart earlier: usage already metered against this window would lose its period",
		);
	const [updated] = await db
		.update(billingAccounts)
		.set({
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			entitlementVersion: account.entitlementVersion + 1,
			metadata: {
				...account.metadata,
				lastPeriodCorrection: {
					at: input.now,
					reason: input.reason,
					from: { start: account.periodStart, end: account.periodEnd },
					to: { start: input.periodStart, end: input.periodEnd },
					// The allowance usage this correction detached. Charges are
					// untouched — only the allowance window moved.
					allowanceReset: {
						orphanedTokens: Number(orphaned?.tokens ?? 0),
						orphanedChargeMicros: Number(orphaned?.chargeMicros ?? 0),
					},
				},
			},
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingAccounts.organizationId, input.organizationId),
				eq(billingAccounts.entitlementVersion, account.entitlementVersion),
			),
		)
		.returning();
	if (!updated)
		throw new Error("Billing account changed while correcting its period");
	return updated;
}

export async function rollBillingPeriods(
	db: DbClient,
	now: string,
): Promise<{ renewed: number; suspendedTrials: number }> {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const expired = await db
		.select()
		.from(billingAccounts)
		.where(
			and(
				inArray(billingAccounts.status, ["trial", "active"]),
				lte(billingAccounts.periodEnd, now),
			),
		)
		.limit(500);
	let renewed = 0;
	let suspendedTrials = 0;
	const statements: BatchItem<"sqlite">[] = [];
	for (const account of expired) {
		if (account.status === "trial") {
			statements.push(
				db
					.update(billingAccounts)
					.set({
						status: "suspended",
						entitlementVersion: account.entitlementVersion + 1,
						updatedAt: now,
					})
					.where(
						and(
							eq(billingAccounts.organizationId, account.organizationId),
							eq(
								billingAccounts.entitlementVersion,
								account.entitlementVersion,
							),
						),
					),
			);
			suspendedTrials++;
			continue;
		}
		const nextStart = account.periodEnd;
		const nextEndDate = new Date(nextStart);
		nextEndDate.setUTCMonth(nextEndDate.getUTCMonth() + 1);
		// Included credits belong to their period: advancing the window starts
		// a fresh allowance. Top-up credits keep their own expiry.
		statements.push(
			db
				.update(billingAccounts)
				.set({
					periodStart: nextStart,
					periodEnd: nextEndDate.toISOString(),
					entitlementVersion: account.entitlementVersion + 1,
					updatedAt: now,
				})
				.where(
					and(
						eq(billingAccounts.organizationId, account.organizationId),
						eq(billingAccounts.entitlementVersion, account.entitlementVersion),
					),
				),
		);

		renewed++;
	}
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return { renewed, suspendedTrials };
}

/** Upgrade only the unmodified starter trial created by automatic onboarding. */
export async function activateProviderCustomerBilling(
	db: DbClient,
	input: {
		organizationId: string;
		entitlementVersion: number;
		planVersionId: string;
		metadata: Record<string, JsonValue>;
		now: string;
	},
): Promise<void> {
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	await db
		.update(billingAccounts)
		.set({
			planVersionId: input.planVersionId,
			status: "active",
			billingMode: "internal",
			entitlementVersion: input.entitlementVersion + 1,
			metadata: input.metadata,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingAccounts.organizationId, input.organizationId),
				eq(billingAccounts.entitlementVersion, input.entitlementVersion),
				eq(billingAccounts.status, "trial"),
				eq(billingAccounts.billingMode, "trial"),
				isNull(billingAccounts.stripeSubscriptionId),
			),
		);
}
