/** Managed non-token service credits with transactional account-scoped admission. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, exists, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgQueryClient } from "../query-client";
import {
	type BillingServiceCreditControl,
	type BillingServiceCreditEntry,
	type BillingServiceCreditReservation,
	type BillingServiceKey,
	type BillingServiceOperationKey,
	type BillingServiceRateCard,
	billingAccounts,
	billingPlanServiceAllowances,
	billingProviderUsage,
	billingServiceCreditControls,
	billingServiceCreditEntries,
	billingServiceCreditReservations,
	billingServiceRateCards,
} from "../schema/billing";

const ACTIVE_ACCOUNT_STATUSES = ["trial", "active"] as const;

const serviceAccount = alias(billingAccounts, "account");
const serviceAllowance = alias(billingPlanServiceAllowances, "allowance");
const serviceControl = alias(billingServiceCreditControls, "control");
const entry = billingServiceCreditEntries;
const held = billingServiceCreditReservations;

/** Debited credits in the account's current period, as a positive number. */
function usedCreditsInPeriod(
	db: PgQueryClient,
	serviceKey: BillingServiceKey,
	tediId?: string | null,
) {
	const debits = db
		.select({ used: sql`-SUM(${entry.amountCredits})::float8` })
		.from(entry);
	const scoped =
		tediId === undefined
			? debits
			: debits.innerJoin(held, eq(held.id, entry.reservationId));
	return sql<number>`COALESCE(${scoped.where(
		and(
			eq(entry.organizationId, serviceAccount.organizationId),
			eq(entry.serviceKey, serviceKey),
			sql`${entry.amountCredits} < 0`,
			tediId === undefined ? undefined : sql`${held.tediId} = ${tediId}`,
			sql`(${entry.createdAt})::timestamptz >= (${serviceAccount.periodStart})::timestamptz`,
			sql`(${entry.createdAt})::timestamptz < (${serviceAccount.periodEnd})::timestamptz`,
		),
	)}, 0)`;
}

/** Live reservations of the account's current period, summed over `amount`. */
function reservedInPeriod(
	db: PgQueryClient,
	serviceKey: BillingServiceKey,
	now: string,
	amount: SQL,
	tediId?: string | null,
) {
	return sql<number>`COALESCE(${db
		.select({ reserved: sql`SUM(${amount})::float8` })
		.from(held)
		.where(
			and(
				eq(held.organizationId, serviceAccount.organizationId),
				eq(held.serviceKey, serviceKey),
				tediId === undefined ? undefined : sql`${held.tediId} = ${tediId}`,
				sql`${held.status} = 'reserved'`,
				sql`(${held.expiresAt})::timestamptz > (${now})::timestamptz`,
				eq(held.periodStart, serviceAccount.periodStart),
				eq(held.periodEnd, serviceAccount.periodEnd),
			),
		)}, 0)`;
}

/** Managed provider cost recorded in the account's current period. */
function managedProviderCostInPeriod(db: PgQueryClient) {
	return sql<number>`COALESCE(${db
		.select({
			cost: sql`SUM(${billingProviderUsage.providerCostMicros})::float8`,
		})
		.from(billingProviderUsage)
		.where(
			and(
				eq(billingProviderUsage.organizationId, serviceAccount.organizationId),
				sql`${billingProviderUsage.usageKind} = 'seo_data'`,
				sql`(${billingProviderUsage.metadata}->>'credentialMode') = 'managed'`,
				sql`(${billingProviderUsage.occurredAt})::timestamptz >= (${serviceAccount.periodStart})::timestamptz`,
				sql`(${billingProviderUsage.occurredAt})::timestamptz < (${serviceAccount.periodEnd})::timestamptz`,
			),
		)}, 0)`;
}

function serviceAllowanceJoin(serviceKey: BillingServiceKey) {
	return and(
		eq(serviceAllowance.planVersionId, serviceAccount.planVersionId),
		eq(serviceAllowance.serviceKey, serviceKey),
	);
}

function serviceControlJoin(serviceKey: BillingServiceKey) {
	return and(
		eq(serviceControl.organizationId, serviceAccount.organizationId),
		eq(serviceControl.serviceKey, serviceKey),
	);
}

export interface BillingServiceCreditSnapshot {
	serviceKey: BillingServiceKey;
	status: "trial" | "active" | "past_due" | "cancelled" | "suspended";
	planVersionId: string;
	periodStart: string;
	periodEnd: string;
	includedCredits: number;
	grantedCredits: number;
	usedCredits: number;
	reservedCredits: number;
	availableCredits: number;
	enabled: boolean;
	monthlyCreditLimit: number | null;
	perTediMonthlyLimit: number | null;
	monthlyProviderCostLimitMicros: number | null;
	providerCostMicros: number;
	reservedProviderCostMicros: number;
}

export type BillingServiceCreditReservationDecision =
	| {
			allowed: true;
			replayed: boolean;
			reservation: BillingServiceCreditReservation;
			rateCard: BillingServiceRateCard;
			snapshot: BillingServiceCreditSnapshot;
	  }
	| {
			allowed: false;
			code:
				| "billing_not_configured"
				| "subscription_inactive"
				| "billing_period_inactive"
				| "service_disabled"
				| "rate_card_unavailable"
				| "request_already_reserved"
				| "request_already_settled"
				| "credit_allowance_exhausted"
				| "monthly_credit_limit"
				| "tedi_credit_limit"
				| "provider_cost_limit";
			snapshot: BillingServiceCreditSnapshot | null;
	  };

interface RawServiceCreditSnapshot {
	serviceKey: BillingServiceKey;
	status: BillingServiceCreditSnapshot["status"];
	planVersionId: string;
	periodStart: string;
	periodEnd: string;
	includedCredits: number;
	grantedCredits: number;
	usedCredits: number;
	reservedCredits: number;
	enabled: boolean;
	monthlyCreditLimit: number | null;
	perTediMonthlyLimit: number | null;
	monthlyProviderCostLimitMicros: number | null;
	providerCostMicros: number;
	reservedProviderCostMicros: number;
}

function normalizeSnapshot(
	row: RawServiceCreditSnapshot,
): BillingServiceCreditSnapshot {
	return {
		...row,
		enabled: row.enabled,
		availableCredits: Math.max(
			row.grantedCredits - row.usedCredits - row.reservedCredits,
			0,
		),
	};
}

export async function getBillingServiceCreditSnapshot(
	db: PgQueryClient,
	organizationId: string,
	serviceKey: BillingServiceKey,
	now: string,
): Promise<BillingServiceCreditSnapshot | null> {
	const planGrant = alias(billingServiceCreditEntries, "plan_grant");
	const rows = (await db
		.select({
			serviceKey: sql<BillingServiceKey>`${serviceKey}`,
			status: serviceAccount.status,
			planVersionId: serviceAccount.planVersionId,
			periodStart: serviceAccount.periodStart,
			periodEnd: serviceAccount.periodEnd,
			includedCredits: serviceAllowance.includedCredits,
			grantedCredits: sql<number>`COALESCE(${db
				.select({ granted: sql`SUM(${entry.amountCredits})::float8` })
				.from(entry)
				.where(
					and(
						eq(entry.organizationId, serviceAccount.organizationId),
						eq(entry.serviceKey, serviceKey),
						sql`${entry.amountCredits} > 0`,
						sql`(${entry.expiresAt} IS NULL OR (${entry.expiresAt})::timestamptz > (${now})::timestamptz)`,
					),
				)}, 0) + CASE
				WHEN ${exists(
					db
						.select({ one: sql`1` })
						.from(planGrant)
						.where(
							and(
								eq(planGrant.organizationId, serviceAccount.organizationId),
								eq(planGrant.serviceKey, serviceKey),
								sql`${planGrant.kind} = 'grant'`,
								sql`${planGrant.sourceType} = 'plan_allowance'`,
								eq(planGrant.sourceRef, serviceAccount.planVersionId),
								eq(planGrant.expiresAt, serviceAccount.periodEnd),
							),
						),
				)} THEN 0
				ELSE ${serviceAllowance.includedCredits}
			END`,
			usedCredits: usedCreditsInPeriod(db, serviceKey),
			reservedCredits: reservedInPeriod(
				db,
				serviceKey,
				now,
				sql`${held.creditsReserved}`,
			),
			enabled: sql<boolean>`COALESCE(${serviceControl.enabled}, true)`,
			monthlyCreditLimit: serviceControl.monthlyCreditLimit,
			perTediMonthlyLimit: sql<
				number | null
			>`COALESCE(${serviceControl.perTediMonthlyLimit}, ${serviceAllowance.perTediMonthlyLimit})`.mapWith(
				Number,
			),
			monthlyProviderCostLimitMicros: sql<
				number | null
			>`COALESCE(${serviceControl.monthlyProviderCostLimitMicros}, ${serviceAllowance.monthlyProviderCostLimitMicros})`.mapWith(
				Number,
			),
			providerCostMicros: managedProviderCostInPeriod(db),
			reservedProviderCostMicros: reservedInPeriod(
				db,
				serviceKey,
				now,
				sql`${held.providerCostCeilingMicros}`,
			),
		})
		.from(serviceAccount)
		.innerJoin(serviceAllowance, serviceAllowanceJoin(serviceKey))
		.leftJoin(serviceControl, serviceControlJoin(serviceKey))
		.where(eq(serviceAccount.organizationId, organizationId))
		.limit(1)) as RawServiceCreditSnapshot[];
	return rows[0] ? normalizeSnapshot(rows[0]) : null;
}

async function getActiveRateCard(
	db: PgQueryClient,
	serviceKey: BillingServiceKey,
	operationKey: BillingServiceOperationKey,
	now: string,
): Promise<BillingServiceRateCard | null> {
	const [row] = await db
		.select()
		.from(billingServiceRateCards)
		.where(
			and(
				eq(billingServiceRateCards.serviceKey, serviceKey),
				eq(billingServiceRateCards.operationKey, operationKey),
				eq(billingServiceRateCards.status, "active"),
				sql`(${billingServiceRateCards.effectiveAt})::timestamptz <= (${now})::timestamptz`,
			),
		)
		.orderBy(desc(billingServiceRateCards.version))
		.limit(1);
	return row ?? null;
}

function planGrantIdempotencyKey(input: {
	organizationId: string;
	planVersionId: string;
	serviceKey: BillingServiceKey;
	periodStart: string;
}): string {
	return [
		"service-plan-grant",
		input.organizationId,
		input.planVersionId,
		input.serviceKey,
		input.periodStart,
	].join(":");
}

/**
 * Atomically grants the plan-period allowance (once) and reserves credits.
 */
async function reserveBillingServiceCreditsInTransaction(
	db: PgQueryClient,
	input: {
		id: string;
		organizationId: string;
		tediId?: string | null;
		serviceKey: BillingServiceKey;
		operationKey: BillingServiceOperationKey;
		idempotencyKey: string;
		expiresAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingServiceCreditReservationDecision> {
	const [existing] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(
			eq(billingServiceCreditReservations.idempotencyKey, input.idempotencyKey),
		)
		.limit(1);
	if (existing) {
		if (
			existing.organizationId !== input.organizationId ||
			existing.serviceKey !== input.serviceKey ||
			existing.operationKey !== input.operationKey
		) {
			throw new Error(
				"Service credit reservation idempotency key scope mismatch",
			);
		}
		const rateCard = await getActiveRateCard(
			db,
			existing.serviceKey,
			existing.operationKey,
			existing.createdAt,
		);
		const snapshot = await getBillingServiceCreditSnapshot(
			db,
			input.organizationId,
			input.serviceKey,
			input.now,
		);
		if (rateCard && snapshot && existing.status === "reserved") {
			return {
				allowed: true,
				replayed: true,
				reservation: existing,
				rateCard,
				snapshot,
			};
		}
		if (rateCard && snapshot) {
			return {
				allowed: false,
				code: "request_already_settled",
				snapshot,
			};
		}
		return { allowed: false, code: "credit_allowance_exhausted", snapshot };
	}

	const rateCard = await getActiveRateCard(
		db,
		input.serviceKey,
		input.operationKey,
		input.now,
	);
	if (!rateCard) {
		return { allowed: false, code: "rate_card_unavailable", snapshot: null };
	}

	const [account] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	if (!account) {
		return { allowed: false, code: "billing_not_configured", snapshot: null };
	}
	const snapshotBefore = await getBillingServiceCreditSnapshot(
		db,
		input.organizationId,
		input.serviceKey,
		input.now,
	);
	if (!snapshotBefore) {
		return { allowed: false, code: "billing_not_configured", snapshot: null };
	}
	if (
		!(ACTIVE_ACCOUNT_STATUSES as readonly string[]).includes(account.status)
	) {
		return {
			allowed: false,
			code: "subscription_inactive",
			snapshot: snapshotBefore,
		};
	}
	if (
		Date.parse(input.now) < Date.parse(account.periodStart) ||
		Date.parse(input.now) >= Date.parse(account.periodEnd)
	) {
		return {
			allowed: false,
			code: "billing_period_inactive",
			snapshot: snapshotBefore,
		};
	}

	const grantKey = planGrantIdempotencyKey({
		organizationId: input.organizationId,
		planVersionId: account.planVersionId,
		serviceKey: input.serviceKey,
		periodStart: account.periodStart,
	});
	const grant = db
		.insert(billingServiceCreditEntries)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					organizationId: serviceAccount.organizationId,
					serviceKey: serviceAllowance.serviceKey,
					kind: sql<"grant">`'grant'`.as("kind"),
					amountCredits: serviceAllowance.includedCredits,
					sourceType: sql<string>`'plan_allowance'`.as("source_type"),
					sourceRef: serviceAccount.planVersionId,
					reservationId: sql<null>`NULL`.as("reservation_id"),
					idempotencyKey: sql<string>`${grantKey}`.as("idempotency_key"),
					expiresAt: serviceAccount.periodEnd,
					description: sql<string>`'Included plan service credits'`.as(
						"description",
					),
					metadata: sql<string>`${JSON.stringify({
						planVersionId: account.planVersionId,
						periodStart: account.periodStart,
						periodEnd: account.periodEnd,
					})}::jsonb`.as("metadata"),
					createdAt: sql<string>`${input.now}`.as("created_at"),
				})
				.from(serviceAccount)
				.innerJoin(serviceAllowance, serviceAllowanceJoin(input.serviceKey))
				.where(
					and(
						eq(serviceAccount.organizationId, input.organizationId),
						sql`${serviceAllowance.includedCredits} > 0`,
					),
				),
		)
		.onConflictDoNothing({
			target: billingServiceCreditEntries.idempotencyKey,
		});
	const tediId = input.tediId ?? null;
	const rate = alias(billingServiceRateCards, "rate");
	const admission = db.$with("snapshot").as(
		db
			.select({
				organizationId: serviceAccount.organizationId,
				planVersionId: serviceAccount.planVersionId,
				status: serviceAccount.status,
				periodStart: serviceAccount.periodStart,
				periodEnd: serviceAccount.periodEnd,
				rateCardId: sql<string>`${rate.id}`.as("rate_card_id"),
				creditCost: rate.creditCost,
				customerValueMicros: rate.customerValueMicros,
				providerCostCeilingMicros: rate.providerCostCeilingMicros,
				enabled: sql<boolean>`COALESCE(${serviceControl.enabled}, true)`.as(
					"enabled",
				),
				monthlyCreditLimit: serviceControl.monthlyCreditLimit,
				perTediMonthlyLimit: sql<
					number | null
				>`COALESCE(${serviceControl.perTediMonthlyLimit}, ${serviceAllowance.perTediMonthlyLimit})`.as(
					"per_tedi_monthly_limit",
				),
				providerCostLimitMicros: sql<
					number | null
				>`COALESCE(${serviceControl.monthlyProviderCostLimitMicros}, ${serviceAllowance.monthlyProviderCostLimitMicros})`.as(
					"provider_cost_limit_micros",
				),
				creditBalance: sql<number>`COALESCE(${db
					.select({ balance: sql`SUM(${entry.amountCredits})::float8` })
					.from(entry)
					.where(
						and(
							eq(entry.organizationId, serviceAccount.organizationId),
							eq(entry.serviceKey, input.serviceKey),
							sql`(${entry.expiresAt} IS NULL OR (${entry.expiresAt})::timestamptz > (${input.now})::timestamptz)`,
						),
					)}, 0)`.as("credit_balance"),
				reservedCredits: reservedInPeriod(
					db,
					input.serviceKey,
					input.now,
					sql`${held.creditsReserved}`,
				).as("reserved_credits"),
				usedCredits: usedCreditsInPeriod(db, input.serviceKey).as(
					"used_credits",
				),
				tediUsedCredits: usedCreditsInPeriod(db, input.serviceKey, tediId).as(
					"tedi_used_credits",
				),
				tediReservedCredits: reservedInPeriod(
					db,
					input.serviceKey,
					input.now,
					sql`${held.creditsReserved}`,
					tediId,
				).as("tedi_reserved_credits"),
				providerCostMicros: managedProviderCostInPeriod(db).as(
					"provider_cost_micros",
				),
				reservedProviderCostMicros: reservedInPeriod(
					db,
					input.serviceKey,
					input.now,
					sql`${held.providerCostCeilingMicros}`,
				).as("reserved_provider_cost_micros"),
			})
			.from(serviceAccount)
			.innerJoin(serviceAllowance, serviceAllowanceJoin(input.serviceKey))
			.innerJoin(rate, eq(rate.id, rateCard.id))
			.leftJoin(serviceControl, serviceControlJoin(input.serviceKey))
			.where(eq(serviceAccount.organizationId, input.organizationId)),
	);
	const reserve = db
		.with(admission)
		.insert(billingServiceCreditReservations)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: admission.organizationId,
					planVersionId: admission.planVersionId,
					rateCardId: admission.rateCardId,
					tediId: sql<string | null>`${tediId}`.as("tedi_id"),
					serviceKey: sql<BillingServiceKey>`${input.serviceKey}`.as(
						"service_key",
					),
					operationKey:
						sql<BillingServiceOperationKey>`${input.operationKey}`.as(
							"operation_key",
						),
					status: sql<"reserved">`'reserved'`.as("status"),
					creditsReserved: admission.creditCost,
					customerValueMicros:
						sql<number>`${admission.customerValueMicros} * ${admission.creditCost}`.as(
							"customer_value_micros",
						),
					providerCostCeilingMicros: admission.providerCostCeilingMicros,
					actualProviderCostMicros: sql<null>`NULL`.as(
						"actual_provider_cost_micros",
					),
					providerUsageId: sql<null>`NULL`.as("provider_usage_id"),
					periodStart: admission.periodStart,
					periodEnd: admission.periodEnd,
					idempotencyKey: sql<string>`${input.idempotencyKey}`.as(
						"idempotency_key",
					),
					rejectionCode: sql<null>`NULL`.as("rejection_code"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					settledAt: sql<null>`NULL`.as("settled_at"),
					releasedAt: sql<null>`NULL`.as("released_at"),
					metadata:
						sql<string>`${JSON.stringify(input.metadata ?? {})}::jsonb`.as(
							"metadata",
						),
					createdAt: sql<string>`${input.now}`.as("created_at"),
					updatedAt: sql<string>`${input.now}`.as("updated_at"),
				})
				.from(admission)
				.where(
					and(
						sql`${admission.status} IN ('trial', 'active')`,
						sql`(${input.now})::timestamptz >= (${admission.periodStart})::timestamptz`,
						sql`(${input.now})::timestamptz < (${admission.periodEnd})::timestamptz`,
						sql`${admission.enabled} = true`,
						sql`${admission.creditBalance} - ${admission.reservedCredits} >= ${admission.creditCost}`,
						sql`(${admission.monthlyCreditLimit} IS NULL OR ${admission.usedCredits} + ${admission.reservedCredits} + ${admission.creditCost} <= ${admission.monthlyCreditLimit})`,
						sql`(${tediId}::text IS NULL OR ${admission.perTediMonthlyLimit} IS NULL OR ${admission.tediUsedCredits} + ${admission.tediReservedCredits} + ${admission.creditCost} <= ${admission.perTediMonthlyLimit})`,
						sql`(${admission.providerCostLimitMicros} IS NULL OR ${admission.providerCostMicros} + ${admission.reservedProviderCostMicros} + ${admission.providerCostCeilingMicros} <= ${admission.providerCostLimitMicros})`,
					),
				),
		)
		.onConflictDoNothing({
			target: billingServiceCreditReservations.idempotencyKey,
		});
	await grant;
	await reserve;

	const [reservation] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(
			eq(billingServiceCreditReservations.idempotencyKey, input.idempotencyKey),
		)
		.limit(1);
	const snapshot = await getBillingServiceCreditSnapshot(
		db,
		input.organizationId,
		input.serviceKey,
		input.now,
	);
	if (reservation && snapshot) {
		return { allowed: true, replayed: false, reservation, rateCard, snapshot };
	}
	if (!snapshot) {
		return { allowed: false, code: "billing_not_configured", snapshot: null };
	}
	if (!snapshot.enabled) {
		return { allowed: false, code: "service_disabled", snapshot };
	}
	if (snapshot.availableCredits < rateCard.creditCost) {
		return { allowed: false, code: "credit_allowance_exhausted", snapshot };
	}
	if (
		snapshot.monthlyCreditLimit !== null &&
		snapshot.usedCredits + snapshot.reservedCredits + rateCard.creditCost >
			snapshot.monthlyCreditLimit
	) {
		return { allowed: false, code: "monthly_credit_limit", snapshot };
	}
	if (
		snapshot.monthlyProviderCostLimitMicros !== null &&
		snapshot.providerCostMicros +
			snapshot.reservedProviderCostMicros +
			rateCard.providerCostCeilingMicros >
			snapshot.monthlyProviderCostLimitMicros
	) {
		return { allowed: false, code: "provider_cost_limit", snapshot };
	}
	return { allowed: false, code: "tedi_credit_limit", snapshot };
}

async function releaseBillingServiceCreditReservationInTransaction(
	db: PgQueryClient,
	input: {
		reservationId: string;
		organizationId: string;
		reason: string;
		now: string;
	},
): Promise<BillingServiceCreditReservation | null> {
	const [row] = await db
		.update(billingServiceCreditReservations)
		.set({
			status: "released",
			rejectionCode: input.reason,
			releasedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingServiceCreditReservations.id, input.reservationId),
				eq(
					billingServiceCreditReservations.organizationId,
					input.organizationId,
				),
				eq(billingServiceCreditReservations.status, "reserved"),
			),
		)
		.returning();
	return row ?? null;
}

export interface SettleBillingServiceCreditUsageInput {
	id: string;
	reservationId: string;
	organizationId: string;
	tediId?: string | null;
	providerUsageId: string;
	provider: string;
	model: string;
	providerCostMicros: number;
	providerCostQuality:
		| "estimated"
		| "gateway_reported"
		| "provider_reported"
		| "provider_reconciled";
	providerSucceeded: boolean;
	occurredAt: string;
	metadata?: Record<string, JsonValue>;
	now: string;
}

/**
 * Atomically records provider cost and either debits managed credits or
 * releases them when the provider failed.
 */
async function settleBillingServiceCreditUsageInTransaction(
	db: PgQueryClient,
	input: SettleBillingServiceCreditUsageInput,
): Promise<BillingServiceCreditReservation> {
	if (
		!Number.isSafeInteger(input.providerCostMicros) ||
		input.providerCostMicros < 0
	) {
		throw new Error("Provider cost must be a non-negative safe integer");
	}
	const [reservation] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(
			and(
				eq(billingServiceCreditReservations.id, input.reservationId),
				eq(
					billingServiceCreditReservations.organizationId,
					input.organizationId,
				),
			),
		)
		.limit(1);
	if (!reservation) {
		throw new Error(
			`Service credit reservation not found: ${input.reservationId}`,
		);
	}
	if (reservation.providerUsageId === input.providerUsageId) return reservation;
	if (reservation.status !== "reserved") {
		throw new Error(
			`Service credit reservation is not settleable: ${reservation.status}`,
		);
	}

	const metadata = {
		...input.metadata,
		credentialMode: "managed",
		serviceKey: reservation.serviceKey,
		operationKey: reservation.operationKey,
		rateCardId: reservation.rateCardId,
		creditsDebited: input.providerSucceeded ? reservation.creditsReserved : 0,
		customerValueMicros: input.providerSucceeded
			? reservation.customerValueMicros
			: 0,
		providerSucceeded: input.providerSucceeded,
	};
	const providerUsage = db
		.insert(billingProviderUsage)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			tediId: input.tediId ?? null,
			reservationId: input.reservationId,
			gatewayLogId: null,
			providerUsageId: input.providerUsageId,
			provider: input.provider,
			model: input.model,
			usageKind: "seo_data",
			unit: "units",
			quantity: 1,
			providerCostMicros: input.providerCostMicros,
			providerCostQuality: input.providerCostQuality,
			customerMeteringReady: input.providerSucceeded,
			occurredAt: input.occurredAt,
			metadata,
			createdAt: input.now,
		})
		.onConflictDoNothing();
	// The receipt exists only once its provider usage row landed in this transaction.
	const recorded = and(
		eq(billingProviderUsage.providerUsageId, input.providerUsageId),
		eq(billingProviderUsage.reservationId, reservation.id),
	);
	const settle = db
		.update(billingServiceCreditReservations)
		.set({
			status: input.providerSucceeded ? "settled" : "released",
			actualProviderCostMicros: input.providerCostMicros,
			providerUsageId: input.providerUsageId,
			rejectionCode: input.providerSucceeded ? null : "provider_failed",
			settledAt: input.providerSucceeded ? input.now : null,
			releasedAt: input.providerSucceeded ? null : input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingServiceCreditReservations.id, input.reservationId),
				eq(
					billingServiceCreditReservations.organizationId,
					input.organizationId,
				),
				sql`${billingServiceCreditReservations.status} = 'reserved'`,
				exists(
					db
						.select({ one: sql`1` })
						.from(billingProviderUsage)
						.where(
							and(
								eq(billingProviderUsage.providerUsageId, input.providerUsageId),
								eq(billingProviderUsage.reservationId, input.reservationId),
							),
						),
				),
			),
		);
	if (input.providerSucceeded) {
		// provider_usage_id is unique, so this selects at most the one receipt row.
		const debit = db
			.insert(billingServiceCreditEntries)
			.select(
				db
					.select({
						id: sql<string>`${crypto.randomUUID()}`.as("id"),
						organizationId: sql<string>`${input.organizationId}`.as(
							"organization_id",
						),
						serviceKey: sql<BillingServiceKey>`${reservation.serviceKey}`.as(
							"service_key",
						),
						kind: sql<"debit">`'debit'`.as("kind"),
						amountCredits: sql<number>`${-reservation.creditsReserved}`.as(
							"amount_credits",
						),
						sourceType: sql<string>`'provider_usage'`.as("source_type"),
						sourceRef: sql<string>`${input.providerUsageId}`.as("source_ref"),
						reservationId: sql<string>`${reservation.id}`.as("reservation_id"),
						idempotencyKey:
							sql<string>`${`service-debit:${input.providerUsageId}`}`.as(
								"idempotency_key",
							),
						expiresAt: sql<null>`NULL`.as("expires_at"),
						description:
							sql<string>`${`${reservation.operationKey} managed usage`}`.as(
								"description",
							),
						metadata: sql<string>`${JSON.stringify(metadata)}::jsonb`.as(
							"metadata",
						),
						createdAt: sql<string>`${input.now}`.as("created_at"),
					})
					.from(billingProviderUsage)
					.where(recorded)
					.limit(1),
			)
			.onConflictDoNothing({
				target: billingServiceCreditEntries.idempotencyKey,
			});
		await providerUsage;
		await debit;
		const [journaledDebit] = await db
			.select()
			.from(billingServiceCreditEntries)
			.where(
				eq(
					billingServiceCreditEntries.idempotencyKey,
					`service-debit:${input.providerUsageId}`,
				),
			)
			.limit(1);
		if (
			!journaledDebit ||
			journaledDebit.organizationId !== input.organizationId ||
			journaledDebit.serviceKey !== reservation.serviceKey ||
			journaledDebit.reservationId !== reservation.id ||
			journaledDebit.kind !== "debit" ||
			journaledDebit.amountCredits !== -reservation.creditsReserved
		) {
			throw new Error("Failed to journal managed service credit debit");
		}
		await settle;
	} else {
		await providerUsage;
		await settle;
	}

	const [settled] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(eq(billingServiceCreditReservations.id, input.reservationId))
		.limit(1);
	if (!settled || settled.providerUsageId !== input.providerUsageId) {
		throw new Error("Failed to settle managed service credits");
	}
	return settled;
}

async function grantBillingServiceCreditsInTransaction(
	db: PgQueryClient,
	input: {
		id: string;
		organizationId: string;
		serviceKey: BillingServiceKey;
		amountCredits: number;
		sourceType: string;
		sourceRef?: string | null;
		idempotencyKey: string;
		expiresAt?: string | null;
		description?: string | null;
		metadata?: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<BillingServiceCreditEntry> {
	if (!Number.isSafeInteger(input.amountCredits) || input.amountCredits <= 0) {
		throw new Error("Service credit grants require positive integer credits");
	}
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
		.insert(billingServiceCreditEntries)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			serviceKey: input.serviceKey,
			kind: "grant",
			amountCredits: input.amountCredits,
			sourceType: input.sourceType,
			sourceRef: input.sourceRef ?? null,
			idempotencyKey: input.idempotencyKey,
			expiresAt: input.expiresAt ?? null,
			description: input.description ?? null,
			metadata: input.metadata ?? {},
			createdAt: input.createdAt,
		})
		.onConflictDoNothing({
			target: billingServiceCreditEntries.idempotencyKey,
		});
	const [entry] = await db
		.select()
		.from(billingServiceCreditEntries)
		.where(eq(billingServiceCreditEntries.idempotencyKey, input.idempotencyKey))
		.limit(1);
	if (!entry) throw new Error("Failed to journal service credit grant");
	if (
		entry.organizationId !== input.organizationId ||
		entry.serviceKey !== input.serviceKey
	) {
		throw new Error("Service credit grant idempotency key scope mismatch");
	}
	return entry;
}

async function setBillingServiceCreditControlsInTransaction(
	db: PgQueryClient,
	input: {
		organizationId: string;
		serviceKey: BillingServiceKey;
		enabled: boolean;
		monthlyCreditLimit?: number | null;
		perTediMonthlyLimit?: number | null;
		monthlyProviderCostLimitMicros?: number | null;
		updatedBy: string;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingServiceCreditControl> {
	for (const value of [
		input.monthlyCreditLimit,
		input.perTediMonthlyLimit,
		input.monthlyProviderCostLimitMicros,
	]) {
		if (value !== undefined && value !== null) {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error("Service credit limits must be non-negative integers");
			}
		}
	}
	const [row] = await db
		.insert(billingServiceCreditControls)
		.values({
			organizationId: input.organizationId,
			serviceKey: input.serviceKey,
			enabled: input.enabled,
			monthlyCreditLimit: input.monthlyCreditLimit ?? null,
			perTediMonthlyLimit: input.perTediMonthlyLimit ?? null,
			monthlyProviderCostLimitMicros:
				input.monthlyProviderCostLimitMicros ?? null,
			updatedBy: input.updatedBy,
			metadata: input.metadata ?? {},
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: [
				billingServiceCreditControls.organizationId,
				billingServiceCreditControls.serviceKey,
			],
			set: {
				enabled: input.enabled,
				monthlyCreditLimit: input.monthlyCreditLimit ?? null,
				perTediMonthlyLimit: input.perTediMonthlyLimit ?? null,
				monthlyProviderCostLimitMicros:
					input.monthlyProviderCostLimitMicros ?? null,
				updatedBy: input.updatedBy,
				metadata: input.metadata ?? {},
				updatedAt: input.now,
			},
		})
		.returning();
	if (!row) throw new Error("Failed to set service credit controls");
	return row;
}

/** All service-credit mutations use the same account lock as monetary billing.
 * READ COMMITTED makes statements after the lock see the previous owner's writes.
 */
async function withBillingAccountLock<T>(
	db: PgQueryClient,
	organizationId: string,
	run: (tx: PgQueryClient) => Promise<T>,
): Promise<T> {
	return db.transaction(
		async (tx) => {
			await tx
				.select({ organizationId: billingAccounts.organizationId })
				.from(billingAccounts)
				.where(eq(billingAccounts.organizationId, organizationId))
				.for("update");
			return run(tx);
		},
		{ isolationLevel: "read committed" },
	);
}

export async function reserveBillingServiceCredits(
	db: PgQueryClient,
	input: Parameters<typeof reserveBillingServiceCreditsInTransaction>[1],
): ReturnType<typeof reserveBillingServiceCreditsInTransaction> {
	return withBillingAccountLock(db, input.organizationId, (tx) =>
		reserveBillingServiceCreditsInTransaction(tx, input),
	);
}

export async function releaseBillingServiceCreditReservation(
	db: PgQueryClient,
	input: Parameters<
		typeof releaseBillingServiceCreditReservationInTransaction
	>[1],
): ReturnType<typeof releaseBillingServiceCreditReservationInTransaction> {
	return withBillingAccountLock(db, input.organizationId, (tx) =>
		releaseBillingServiceCreditReservationInTransaction(tx, input),
	);
}

export async function settleBillingServiceCreditUsage(
	db: PgQueryClient,
	input: Parameters<typeof settleBillingServiceCreditUsageInTransaction>[1],
): ReturnType<typeof settleBillingServiceCreditUsageInTransaction> {
	return withBillingAccountLock(db, input.organizationId, (tx) =>
		settleBillingServiceCreditUsageInTransaction(tx, input),
	);
}

export async function grantBillingServiceCredits(
	db: PgQueryClient,
	input: Parameters<typeof grantBillingServiceCreditsInTransaction>[1],
): ReturnType<typeof grantBillingServiceCreditsInTransaction> {
	return withBillingAccountLock(db, input.organizationId, (tx) =>
		grantBillingServiceCreditsInTransaction(tx, input),
	);
}

export async function setBillingServiceCreditControls(
	db: PgQueryClient,
	input: Parameters<typeof setBillingServiceCreditControlsInTransaction>[1],
): ReturnType<typeof setBillingServiceCreditControlsInTransaction> {
	return withBillingAccountLock(db, input.organizationId, (tx) =>
		setBillingServiceCreditControlsInTransaction(tx, input),
	);
}
