/**
 * Managed service operations (SEO) draw from the organization credit pool.
 *
 * Each operation keeps the fixed credit cost of its rate card. Admission is
 * one guarded reservation INSERT against the shared pool plus the optional
 * per-service controls (kill switch, lower monthly limits, provider-spend
 * safety limit). Settlement records the provider receipt and, when the
 * provider succeeded, draws the reserved credits from the pool in the same
 * D1 batch. D1 rejects BEGIN, so do not replace these batches with Drizzle
 * transactions.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type AnyColumn,
	and,
	desc,
	eq,
	exists,
	gt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import {
	type BillingServiceCreditControl,
	type BillingServiceCreditReservation,
	type BillingServiceKey,
	type BillingServiceOperationKey,
	type BillingServiceRateCard,
	billingProviderUsage,
	billingServiceCreditControls,
	billingServiceCreditReservations,
	billingServiceRateCards,
} from "../schema/billing";
import {
	type CreditRefusalCode,
	buildCreditConsumptionStatements,
	type CreditPoolCte,
	creditAdmissionPredicate,
	creditCapacityCte,
	creditPoolCte,
	creditRefusalReason,
	getCreditPoolSnapshot,
} from "./billing/credit-pool";

export interface BillingServiceCreditSnapshot {
	serviceKey: BillingServiceKey;
	status: "trial" | "active" | "past_due" | "cancelled" | "suspended";
	planVersionId: string;
	periodStart: string;
	periodEnd: string;
	/** Credits this service used this period. */
	usedCredits: number;
	reservedCredits: number;
	/** Credits left in the shared organization pool. */
	availableCredits: number;
	enabled: boolean;
	monthlyCreditLimit: number | null;
	perTediMonthlyLimit: number | null;
	monthlyProviderCostLimitMicros: number | null;
	providerCostMicros: number;
	reservedProviderCostMicros: number;
}

export type BillingServiceCreditDenialCode =
	| CreditRefusalCode
	| "service_disabled"
	| "rate_card_unavailable"
	| "request_already_reserved"
	| "request_already_settled"
	| "service_monthly_credit_limit"
	| "service_tedi_credit_limit"
	| "provider_cost_limit";

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
			code: BillingServiceCreditDenialCode;
			snapshot: BillingServiceCreditSnapshot | null;
	  };

const serviceHeld = alias(billingServiceCreditReservations, "service_held");
const serviceUsage = alias(billingProviderUsage, "service_usage");
const serviceControl = alias(billingServiceCreditControls, "service_control");

/**
 * Over `pool`: this service's use, holds and controls in the pool's period.
 * `tediId` scopes the per-tedi figure.
 */
function serviceCte(
	db: DbClient,
	pool: CreditPoolCte,
	input: { serviceKey: BillingServiceKey; now: string; tediId: string | null },
) {
	const live = and(
		eq(serviceHeld.status, "reserved"),
		gt(serviceHeld.expiresAt, input.now),
	);
	const held = (amount: SQL | AnyColumn, filter: SQL | undefined) =>
		sql<number>`COALESCE((${db
			.select({ total: sql`SUM(${amount})` })
			.from(serviceHeld)
			.where(
				and(
					sql`${serviceHeld.organizationId} = ${pool.organizationId}`,
					eq(serviceHeld.serviceKey, input.serviceKey),
					sql`${serviceHeld.periodStart} = ${pool.periodStart}`,
					filter,
				),
			)}), 0)`;
	const providerCost = db
		.select({ total: sql`SUM(${serviceUsage.providerCostMicros})` })
		.from(serviceUsage)
		.where(
			and(
				sql`${serviceUsage.organizationId} = ${pool.organizationId}`,
				eq(serviceUsage.usageKind, "seo_data"),
				sql`json_extract(${serviceUsage.metadata}, '$.credentialMode') = 'managed'`,
				sql`${serviceUsage.occurredAt} >= ${pool.periodStart}`,
				sql`${serviceUsage.occurredAt} < ${pool.periodEnd}`,
			),
		);
	return db.$with("service").as(
		db
			.select({
				enabled: sql<number>`COALESCE(${serviceControl.enabled}, 1)`.as(
					"enabled",
				),
				monthlyCreditLimit: sql<
					number | null
				>`${serviceControl.monthlyCreditLimit}`.as("monthly_credit_limit"),
				perTediMonthlyLimit: sql<
					number | null
				>`${serviceControl.perTediMonthlyLimit}`.as("per_tedi_monthly_limit"),
				providerCostLimitMicros: sql<
					number | null
				>`${serviceControl.monthlyProviderCostLimitMicros}`.as(
					"provider_cost_limit_micros",
				),
				serviceUsed: held(
					serviceHeld.creditsReserved,
					eq(serviceHeld.status, "settled"),
				).as("service_used"),
				serviceReserved: held(serviceHeld.creditsReserved, live).as(
					"service_reserved",
				),
				serviceTediUsed: held(
					serviceHeld.creditsReserved,
					and(
						sql`${serviceHeld.tediId} = ${input.tediId}`,
						or(eq(serviceHeld.status, "settled"), live),
					),
				).as("service_tedi_used"),
				providerCostMicros: sql<number>`COALESCE((${providerCost}), 0)`.as(
					"provider_cost_micros",
				),
				reservedProviderCostMicros: held(
					serviceHeld.providerCostCeilingMicros,
					live,
				).as("reserved_provider_cost_micros"),
			})
			.from(pool)
			.leftJoin(
				serviceControl,
				and(
					sql`${serviceControl.organizationId} = ${pool.organizationId}`,
					eq(serviceControl.serviceKey, input.serviceKey),
				),
			),
	);
}

export async function getBillingServiceCreditSnapshot(
	db: DbClient,
	organizationId: string,
	serviceKey: BillingServiceKey,
	now: string,
	tediId: string | null = null,
): Promise<BillingServiceCreditSnapshot | null> {
	const pool = creditPoolCte(db, { organizationId, now });
	const capacity = creditCapacityCte(db, pool, { now });
	const service = serviceCte(db, pool, { serviceKey, now, tediId });
	const [row] = await db
		.with(pool, capacity, service)
		.select({
			status: capacity.status,
			planVersionId: capacity.planVersionId,
			periodStart: capacity.periodStart,
			periodEnd: capacity.periodEnd,
			availableCredits: capacity.availableCredits,
			enabled: service.enabled,
			monthlyCreditLimit: service.monthlyCreditLimit,
			perTediMonthlyLimit: service.perTediMonthlyLimit,
			providerCostLimitMicros: service.providerCostLimitMicros,
			serviceUsed: service.serviceUsed,
			serviceReserved: service.serviceReserved,
			providerCostMicros: service.providerCostMicros,
			reservedProviderCostMicros: service.reservedProviderCostMicros,
		})
		.from(capacity)
		.innerJoin(service, sql`1 = 1`)
		.limit(1);
	if (!row) return null;
	const nullable = (value: unknown) =>
		value === null || value === undefined ? null : Number(value);
	return {
		serviceKey,
		status: row.status,
		planVersionId: String(row.planVersionId),
		periodStart: String(row.periodStart),
		periodEnd: String(row.periodEnd),
		usedCredits: Number(row.serviceUsed ?? 0),
		reservedCredits: Number(row.serviceReserved ?? 0),
		availableCredits: Math.max(Number(row.availableCredits ?? 0), 0),
		enabled: Number(row.enabled) === 1,
		monthlyCreditLimit: nullable(row.monthlyCreditLimit),
		perTediMonthlyLimit: nullable(row.perTediMonthlyLimit),
		monthlyProviderCostLimitMicros: nullable(row.providerCostLimitMicros),
		providerCostMicros: Number(row.providerCostMicros ?? 0),
		reservedProviderCostMicros: Number(row.reservedProviderCostMicros ?? 0),
	};
}

async function getActiveRateCard(
	db: DbClient,
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
				sql`datetime(${billingServiceRateCards.effectiveAt}) <= datetime(${now})`,
			),
		)
		.orderBy(desc(billingServiceRateCards.version))
		.limit(1);
	return row ?? null;
}

/** Atomically checks the shared pool and service controls, then reserves credits. */
export async function reserveBillingServiceCredits(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		tediId?: string | null;
		userId?: string | null;
		serviceKey: BillingServiceKey;
		operationKey: BillingServiceOperationKey;
		idempotencyKey: string;
		expiresAt: string;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingServiceCreditReservationDecision> {
	const tediId = input.tediId ?? null;
	const snapshot = () =>
		getBillingServiceCreditSnapshot(
			db,
			input.organizationId,
			input.serviceKey,
			input.now,
			tediId,
		);
	const [existing] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(
			and(
				eq(
					billingServiceCreditReservations.idempotencyKey,
					input.idempotencyKey,
				),
				eq(
					billingServiceCreditReservations.organizationId,
					input.organizationId,
				),
			),
		)
		.limit(1);
	if (existing) {
		const rateCard = await getActiveRateCard(
			db,
			existing.serviceKey,
			existing.operationKey,
			existing.createdAt,
		);
		const current = await snapshot();
		if (rateCard && current && existing.status === "reserved")
			return {
				allowed: true,
				replayed: true,
				reservation: existing,
				rateCard,
				snapshot: current,
			};
		return {
			allowed: false,
			code:
				existing.status === "settled"
					? "request_already_settled"
					: "request_already_reserved",
			snapshot: current,
		};
	}

	const rateCard = await getActiveRateCard(
		db,
		input.serviceKey,
		input.operationKey,
		input.now,
	);
	if (!rateCard)
		return { allowed: false, code: "rate_card_unavailable", snapshot: null };

	const subject = { tediId, userId: input.userId };
	const credits = rateCard.creditCost;
	const pool = creditPoolCte(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	const capacity = creditCapacityCte(db, pool, { now: input.now, subject });
	const service = serviceCte(db, pool, {
		serviceKey: input.serviceKey,
		now: input.now,
		tediId,
	});
	await db
		.with(pool, capacity, service)
		.insert(billingServiceCreditReservations)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: capacity.organizationId,
					planVersionId: capacity.planVersionId,
					rateCardId: sql<string>`${rateCard.id}`.as("rate_card_id"),
					tediId: sql<string | null>`${tediId}`.as("tedi_id"),
					userId: sql<string | null>`${input.userId ?? null}`.as("user_id"),
					serviceKey: sql<BillingServiceKey>`${input.serviceKey}`.as(
						"service_key",
					),
					operationKey:
						sql<BillingServiceOperationKey>`${input.operationKey}`.as(
							"operation_key",
						),
					status: sql<"reserved">`'reserved'`.as("status"),
					creditsReserved: sql<number>`${credits}`.as("credits_reserved"),
					customerValueMicros:
						sql<number>`${rateCard.customerValueMicros * credits}`.as(
							"customer_value_micros",
						),
					providerCostCeilingMicros:
						sql<number>`${rateCard.providerCostCeilingMicros}`.as(
							"provider_cost_ceiling_micros",
						),
					actualProviderCostMicros: sql<null>`NULL`.as(
						"actual_provider_cost_micros",
					),
					providerUsageId: sql<null>`NULL`.as("provider_usage_id"),
					periodStart: capacity.periodStart,
					periodEnd: capacity.periodEnd,
					idempotencyKey: sql<string>`${input.idempotencyKey}`.as(
						"idempotency_key",
					),
					rejectionCode: sql<null>`NULL`.as("rejection_code"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					settledAt: sql<null>`NULL`.as("settled_at"),
					releasedAt: sql<null>`NULL`.as("released_at"),
					metadata: sql<string>`${JSON.stringify(input.metadata ?? {})}`.as(
						"metadata",
					),
					createdAt: sql<string>`${input.now}`.as("created_at"),
					updatedAt: sql<string>`${input.now}`.as("updated_at"),
				})
				.from(capacity)
				.innerJoin(service, sql`1 = 1`)
				.where(
					and(
						creditAdmissionPredicate(capacity, { now: input.now, credits }),
						sql`${service.enabled} = 1`,
						sql`(${service.monthlyCreditLimit} IS NULL
							OR ${service.serviceUsed} + ${service.serviceReserved} + ${credits} <= ${service.monthlyCreditLimit})`,
						sql`(${tediId} IS NULL OR ${service.perTediMonthlyLimit} IS NULL
							OR ${service.serviceTediUsed} + ${credits} <= ${service.perTediMonthlyLimit})`,
						sql`(${service.providerCostLimitMicros} IS NULL
							OR ${service.providerCostMicros} + ${service.reservedProviderCostMicros} + ${rateCard.providerCostCeilingMicros} <= ${service.providerCostLimitMicros})`,
					),
				),
		)
		.onConflictDoNothing({
			target: billingServiceCreditReservations.idempotencyKey,
		});

	const [reservation] = await db
		.select()
		.from(billingServiceCreditReservations)
		.where(eq(billingServiceCreditReservations.id, input.id))
		.limit(1);
	const current = await snapshot();
	if (reservation && current)
		return {
			allowed: true,
			replayed: false,
			reservation,
			rateCard,
			snapshot: current,
		};
	const poolSnapshot = await getCreditPoolSnapshot(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	const poolRefusal = creditRefusalReason(poolSnapshot, {
		now: input.now,
		credits,
	});
	if (poolRefusal)
		return { allowed: false, code: poolRefusal, snapshot: current };
	if (!current)
		return { allowed: false, code: "billing_not_configured", snapshot: null };
	if (!current.enabled)
		return { allowed: false, code: "service_disabled", snapshot: current };
	if (
		current.monthlyCreditLimit !== null &&
		current.usedCredits + current.reservedCredits + credits >
			current.monthlyCreditLimit
	)
		return {
			allowed: false,
			code: "service_monthly_credit_limit",
			snapshot: current,
		};
	if (
		current.monthlyProviderCostLimitMicros !== null &&
		current.providerCostMicros +
			current.reservedProviderCostMicros +
			rateCard.providerCostCeilingMicros >
			current.monthlyProviderCostLimitMicros
	)
		return { allowed: false, code: "provider_cost_limit", snapshot: current };
	return {
		allowed: false,
		code: "service_tedi_credit_limit",
		snapshot: current,
	};
}

export async function releaseBillingServiceCreditReservation(
	db: DbClient,
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
	stripeEnvironment?: "test" | "live";
	now: string;
}

/**
 * Atomically records provider cost and either draws the reserved credits from
 * the pool or releases them when the provider failed.
 */
export async function settleBillingServiceCreditUsage(
	db: DbClient,
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
		// The credits are drawn only when this batch settled the reservation.
		const consume = buildCreditConsumptionStatements(db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			kind: "service",
			sourceRef: reservation.id,
			tediId: reservation.tediId,
			userId: reservation.userId,
			periodStart: reservation.periodStart,
			periodEnd: reservation.periodEnd,
			credits: db
				.select({ credits: billingServiceCreditReservations.creditsReserved })
				.from(billingServiceCreditReservations)
				.where(
					and(
						eq(billingServiceCreditReservations.id, reservation.id),
						eq(billingServiceCreditReservations.status, "settled"),
						eq(
							billingServiceCreditReservations.providerUsageId,
							input.providerUsageId,
						),
					),
				),
			now: input.now,
			stripeEnvironment: input.stripeEnvironment,
		});
		await db.batch([providerUsage, settle, ...consume]);
	} else {
		await db.batch([providerUsage, settle]);
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

export async function setBillingServiceCreditControls(
	db: DbClient,
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
