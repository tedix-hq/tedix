/** Canonical billing stripe-webhooks queries. */

import { and, eq, exists, gt, lte, or, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import {
	type BillingAccount,
	billingAccounts as schemaBillingAccounts,
	type StripeWebhookEvent,
	stripeWebhookEvents as schemaStripeWebhookEvents,
} from "../../schema/billing";
import { buildApplyOrganizationPlanFeaturesStatement } from "../organizations";
import {
	buildUpdateStripeBillingAccountStatement,
	requireActiveBillingPlan,
} from "./plans";

export async function claimStripeWebhookEvent(
	db: DbClient,
	input: {
		eventId: string;
		eventType: string;
		entityKey: string;
		eventCreatedAt: number;
		now: string;
		leaseExpiresAt: string;
	},
): Promise<{ claimed: boolean; event: StripeWebhookEvent }> {
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	const [claimed] = await db
		.insert(stripeWebhookEvents)
		.values({
			eventId: input.eventId,
			eventType: input.eventType,
			entityKey: input.entityKey,
			eventCreatedAt: input.eventCreatedAt,
			status: "processing",
			attemptCount: 1,
			leaseExpiresAt: input.leaseExpiresAt,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: stripeWebhookEvents.eventId,
			set: {
				status: "processing",
				attemptCount: sql`${stripeWebhookEvents.attemptCount} + 1`,
				leaseExpiresAt: input.leaseExpiresAt,
				lastError: null,
				updatedAt: input.now,
			},
			setWhere: or(
				eq(stripeWebhookEvents.status, "failed"),
				and(
					eq(stripeWebhookEvents.status, "processing"),
					lte(stripeWebhookEvents.leaseExpiresAt, input.now),
				),
			),
		})
		.returning();
	if (claimed) return { claimed: true, event: claimed };
	const [existing] = await db
		.select()
		.from(stripeWebhookEvents)
		.where(eq(stripeWebhookEvents.eventId, input.eventId))
		.limit(1);
	if (!existing) throw new Error("Failed to load Stripe webhook receipt");
	return { claimed: false, event: existing };
}

export async function hasNewerProcessedStripeWebhookEvent(
	db: DbClient,
	input: {
		entityKey: string;
		eventCreatedAt: number;
		eventId: string;
	},
): Promise<boolean> {
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	const [newer] = await db
		.select({ eventId: stripeWebhookEvents.eventId })
		.from(stripeWebhookEvents)
		.where(
			and(
				eq(stripeWebhookEvents.entityKey, input.entityKey),
				eq(stripeWebhookEvents.status, "processed"),
				gt(stripeWebhookEvents.eventCreatedAt, input.eventCreatedAt),
				sql`${stripeWebhookEvents.eventId} <> ${input.eventId}`,
			),
		)
		.limit(1);
	return Boolean(newer);
}

type StripeWebhookLease = Pick<StripeWebhookEvent, "eventId" | "attemptCount">;
export type StripeBillingWebhookOutcome = "applied" | "skipped_stale";

function ownsStripeWebhookLease(
	db: DbClient,
	stripeWebhookEvents: typeof schemaStripeWebhookEvents,
	lease: StripeWebhookLease,
) {
	return and(
		eq(stripeWebhookEvents.eventId, lease.eventId),
		eq(stripeWebhookEvents.status, "processing"),
		eq(stripeWebhookEvents.attemptCount, lease.attemptCount),
		gt(
			coreStore(db) === "postgres"
				? sql`${stripeWebhookEvents.leaseExpiresAt}::timestamptz`
				: sql`${stripeWebhookEvents.leaseExpiresAt}`,
			coreStore(db) === "postgres"
				? sql`now()`
				: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
		),
	);
}

function buildMarkStripeWebhookEventProcessedStatement(
	db: DbClient,
	input: StripeWebhookLease & {
		outcome: string | SQL;
		now: string;
	},
	guard?: SQL,
) {
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	return db
		.update(stripeWebhookEvents)
		.set({
			status: "processed",
			outcome: input.outcome,
			leaseExpiresAt: null,
			lastError: null,
			processedAt: input.now,
			updatedAt: input.now,
		})
		.where(and(ownsStripeWebhookLease(db, stripeWebhookEvents, input), guard));
}

export async function markStripeWebhookEventProcessed(
	db: DbClient,
	input: StripeWebhookLease & { outcome: string; now: string },
): Promise<boolean> {
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	const [processed] = await buildMarkStripeWebhookEventProcessedStatement(
		db,
		input,
	).returning({ eventId: stripeWebhookEvents.eventId });
	return Boolean(processed);
}

type StripeBillingWebhookProjection = Omit<
	Parameters<typeof buildUpdateStripeBillingAccountStatement>[1],
	| "organizationId"
	| "planVersionId"
	| "billingMode"
	| "stripeWebhookCustomerKey"
	| "stripeWebhookEventCreatedAt"
> & {
	account: Pick<
		BillingAccount,
		| "organizationId"
		| "entitlementVersion"
		| "stripeCustomerId"
		| "stripeEnvironment"
	>;
	planKey: Parameters<typeof requireActiveBillingPlan>[1];
	stripeEnvironment: "live" | "test";
	stripeCustomerId: string;
	applyPlanFeatures: boolean;
};

export async function applyStripeBillingWebhook(
	db: DbClient,
	receipt: StripeWebhookLease & Pick<StripeWebhookEvent, "eventCreatedAt">,
	input: StripeBillingWebhookProjection,
): Promise<StripeBillingWebhookOutcome> {
	const { organizationId } = input.account;
	const customerKey = `${input.stripeEnvironment}:${input.stripeCustomerId}`;
	const billingAccounts = coreTable(db, schemaBillingAccounts);
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	const plan = await requireActiveBillingPlan(db, input.planKey, input.now);
	const account = () =>
		db
			.select({ organizationId: billingAccounts.organizationId })
			.from(billingAccounts);
	const stale = exists(
		account().where(
			and(
				eq(billingAccounts.organizationId, organizationId),
				eq(billingAccounts.stripeWebhookCustomerKey, customerKey),
				gt(billingAccounts.stripeWebhookEventCreatedAt, receipt.eventCreatedAt),
			),
		),
	);
	const snapshotMatches = exists(
		account().where(
			and(
				eq(billingAccounts.organizationId, organizationId),
				eq(
					billingAccounts.entitlementVersion,
					input.account.entitlementVersion,
				),
				sql`${billingAccounts.stripeCustomerId} ${coreStore(db) === "postgres" ? sql`IS NOT DISTINCT FROM` : sql`IS`} ${input.account.stripeCustomerId}`,
				sql`${billingAccounts.stripeEnvironment} ${coreStore(db) === "postgres" ? sql`IS NOT DISTINCT FROM` : sql`IS`} ${input.account.stripeEnvironment}`,
			),
		),
	);
	// Only this transaction can see "applying". The first statement checks the
	// live lease; the remaining statements use that decision for every write.
	const applying = and(
		eq(stripeWebhookEvents.eventId, receipt.eventId),
		eq(stripeWebhookEvents.attemptCount, receipt.attemptCount),
		eq(stripeWebhookEvents.status, "processed"),
		eq(stripeWebhookEvents.outcome, "applying"),
	);
	const admitted = exists(
		db
			.select({ eventId: stripeWebhookEvents.eventId })
			.from(stripeWebhookEvents)
			.where(applying),
	);
	const begin = buildMarkStripeWebhookEventProcessedStatement(
		db,
		{
			...receipt,
			now: input.now,
			outcome: sql`CASE WHEN ${stale} THEN 'skipped_stale' ELSE 'applying' END`,
		},
		or(stale, snapshotMatches),
	).returning({ outcome: stripeWebhookEvents.outcome });
	const updateAccount = buildUpdateStripeBillingAccountStatement(
		db,
		{
			...input,
			organizationId,
			planVersionId: plan.id,
			billingMode: "stripe",
			stripeWebhookCustomerKey: customerKey,
			stripeWebhookEventCreatedAt: receipt.eventCreatedAt,
		},
		admitted,
	);
	const finish = db
		.update(stripeWebhookEvents)
		.set({ outcome: "applied" })
		.where(applying);
	const [processed] = await (input.applyPlanFeatures
		? db.batch([
				begin,
				buildApplyOrganizationPlanFeaturesStatement(
					db,
					organizationId,
					input.planKey,
					input.now,
					admitted,
				),
				updateAccount,
				finish,
			])
		: db.batch([begin, updateAccount, finish]));
	if (!processed[0])
		throw new Error("Stripe webhook lease or billing account changed");
	return processed[0].outcome === "skipped_stale" ? "skipped_stale" : "applied";
}

export async function markStripeWebhookEventFailed(
	db: DbClient,
	input: StripeWebhookLease & {
		error: string;
		now: string;
	},
): Promise<void> {
	const stripeWebhookEvents = coreTable(db, schemaStripeWebhookEvents);
	await db
		.update(stripeWebhookEvents)
		.set({
			status: "failed",
			leaseExpiresAt: null,
			lastError: input.error.slice(0, 2_000),
			updatedAt: input.now,
		})
		.where(ownsStripeWebhookLease(db, stripeWebhookEvents, input));
}
