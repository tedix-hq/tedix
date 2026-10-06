/**
 * Managed non-token service credits.
 *
 * Admission is a plan-period grant plus reservation in one native D1 batch.
 * Settlement is a provider receipt, immutable credit debit, and reservation
 * transition in one batch. D1 rejects BEGIN, so do not replace these batches
 * with Drizzle transactions.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type BillingServiceCreditControl,
	type BillingServiceCreditEntry,
	type BillingServiceCreditReservation,
	type BillingServiceKey,
	type BillingServiceOperationKey,
	type BillingServiceRateCard,
	billingAccounts,
	billingServiceCreditControls,
	billingServiceCreditEntries,
	billingServiceCreditReservations,
	billingServiceRateCards,
} from "../schema/billing";

const ACTIVE_ACCOUNT_STATUSES = ["trial", "active"] as const;

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
	enabled: number;
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
		enabled: row.enabled === 1,
		availableCredits: Math.max(
			row.grantedCredits - row.usedCredits - row.reservedCredits,
			0,
		),
	};
}

export async function getBillingServiceCreditSnapshot(
	db: DbClient,
	organizationId: string,
	serviceKey: BillingServiceKey,
	now: string,
): Promise<BillingServiceCreditSnapshot | null> {
	const rows = (await db.all(sql`
		SELECT
			${serviceKey} AS serviceKey,
			account.status AS status,
			account.plan_version_id AS planVersionId,
			account.period_start AS periodStart,
			account.period_end AS periodEnd,
			allowance.included_credits AS includedCredits,
			COALESCE((
				SELECT SUM(entry.amount_credits)
				FROM billing_service_credit_entries AS entry
				WHERE entry.organization_id = account.organization_id
					AND entry.service_key = ${serviceKey}
					AND entry.amount_credits > 0
					AND (
						entry.expires_at IS NULL
						OR datetime(entry.expires_at) > datetime(${now})
					)
			), 0) + CASE
				WHEN EXISTS (
					SELECT 1
					FROM billing_service_credit_entries AS plan_grant
					WHERE plan_grant.organization_id = account.organization_id
						AND plan_grant.service_key = ${serviceKey}
						AND plan_grant.kind = 'grant'
						AND plan_grant.source_type = 'plan_allowance'
						AND plan_grant.source_ref = account.plan_version_id
						AND plan_grant.expires_at = account.period_end
				) THEN 0
				ELSE allowance.included_credits
			END AS grantedCredits,
			COALESCE((
				SELECT -SUM(entry.amount_credits)
				FROM billing_service_credit_entries AS entry
				WHERE entry.organization_id = account.organization_id
					AND entry.service_key = ${serviceKey}
					AND entry.amount_credits < 0
					AND datetime(entry.created_at) >= datetime(account.period_start)
					AND datetime(entry.created_at) < datetime(account.period_end)
			), 0) AS usedCredits,
			COALESCE((
				SELECT SUM(reservation.credits_reserved)
				FROM billing_service_credit_reservations AS reservation
				WHERE reservation.organization_id = account.organization_id
					AND reservation.service_key = ${serviceKey}
					AND reservation.status = 'reserved'
					AND datetime(reservation.expires_at) > datetime(${now})
					AND reservation.period_start = account.period_start
					AND reservation.period_end = account.period_end
			), 0) AS reservedCredits,
			COALESCE(control.enabled, 1) AS enabled,
			control.monthly_credit_limit AS monthlyCreditLimit,
			COALESCE(
				control.per_tedi_monthly_limit,
				allowance.per_tedi_monthly_limit
			) AS perTediMonthlyLimit,
			COALESCE(
				control.monthly_provider_cost_limit_micros,
				allowance.monthly_provider_cost_limit_micros
			) AS monthlyProviderCostLimitMicros,
			COALESCE((
				SELECT SUM(usage.provider_cost_micros)
				FROM billing_provider_usage AS usage
				WHERE usage.organization_id = account.organization_id
					AND usage.usage_kind = 'seo_data'
					AND json_extract(usage.metadata, '$.credentialMode') = 'managed'
					AND datetime(usage.occurred_at) >= datetime(account.period_start)
					AND datetime(usage.occurred_at) < datetime(account.period_end)
			), 0) AS providerCostMicros,
			COALESCE((
				SELECT SUM(reservation.provider_cost_ceiling_micros)
				FROM billing_service_credit_reservations AS reservation
				WHERE reservation.organization_id = account.organization_id
					AND reservation.service_key = ${serviceKey}
					AND reservation.status = 'reserved'
					AND datetime(reservation.expires_at) > datetime(${now})
					AND reservation.period_start = account.period_start
					AND reservation.period_end = account.period_end
			), 0) AS reservedProviderCostMicros
		FROM billing_accounts AS account
		INNER JOIN billing_plan_service_allowances AS allowance
			ON allowance.plan_version_id = account.plan_version_id
			AND allowance.service_key = ${serviceKey}
		LEFT JOIN billing_service_credit_controls AS control
			ON control.organization_id = account.organization_id
			AND control.service_key = ${serviceKey}
		WHERE account.organization_id = ${organizationId}
		LIMIT 1
	`)) as RawServiceCreditSnapshot[];
	return rows[0] ? normalizeSnapshot(rows[0]) : null;
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
export async function reserveBillingServiceCredits(
	db: DbClient,
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

	const d1 = db.$client as D1Database;
	const grantKey = planGrantIdempotencyKey({
		organizationId: input.organizationId,
		planVersionId: account.planVersionId,
		serviceKey: input.serviceKey,
		periodStart: account.periodStart,
	});
	const grant = d1
		.prepare(`
			INSERT INTO billing_service_credit_entries (
				id, organization_id, service_key, kind, amount_credits,
				source_type, source_ref, reservation_id, idempotency_key,
				expires_at, description, metadata, created_at
			)
			SELECT
				?, account.organization_id, allowance.service_key, 'grant',
				allowance.included_credits, 'plan_allowance',
				account.plan_version_id, NULL, ?, account.period_end,
				'Included plan service credits', ?, ?
			FROM billing_accounts AS account
			INNER JOIN billing_plan_service_allowances AS allowance
				ON allowance.plan_version_id = account.plan_version_id
				AND allowance.service_key = ?
			WHERE account.organization_id = ?
				AND allowance.included_credits > 0
			ON CONFLICT(idempotency_key) DO NOTHING
		`)
		.bind(
			crypto.randomUUID(),
			grantKey,
			JSON.stringify({
				planVersionId: account.planVersionId,
				periodStart: account.periodStart,
				periodEnd: account.periodEnd,
			}),
			input.now,
			input.serviceKey,
			input.organizationId,
		);
	const reserve = d1
		.prepare(`
			WITH snapshot AS (
				SELECT
					account.organization_id,
					account.plan_version_id,
					account.status,
					account.period_start,
					account.period_end,
					rate.id AS rate_card_id,
					rate.credit_cost,
					rate.customer_value_micros,
					rate.provider_cost_ceiling_micros,
					COALESCE(control.enabled, 1) AS enabled,
					control.monthly_credit_limit,
					COALESCE(
						control.per_tedi_monthly_limit,
						allowance.per_tedi_monthly_limit
					) AS per_tedi_monthly_limit,
					COALESCE(
						control.monthly_provider_cost_limit_micros,
						allowance.monthly_provider_cost_limit_micros
					) AS provider_cost_limit_micros,
					COALESCE((
						SELECT SUM(entry.amount_credits)
						FROM billing_service_credit_entries AS entry
						WHERE entry.organization_id = account.organization_id
							AND entry.service_key = ?
							AND (
								entry.expires_at IS NULL
								OR datetime(entry.expires_at) > datetime(?)
							)
					), 0) AS credit_balance,
					COALESCE((
						SELECT SUM(r.credits_reserved)
						FROM billing_service_credit_reservations AS r
						WHERE r.organization_id = account.organization_id
							AND r.service_key = ?
							AND r.status = 'reserved'
							AND datetime(r.expires_at) > datetime(?)
							AND r.period_start = account.period_start
							AND r.period_end = account.period_end
					), 0) AS reserved_credits,
					COALESCE((
						SELECT -SUM(entry.amount_credits)
						FROM billing_service_credit_entries AS entry
						WHERE entry.organization_id = account.organization_id
							AND entry.service_key = ?
							AND entry.amount_credits < 0
							AND datetime(entry.created_at) >= datetime(account.period_start)
							AND datetime(entry.created_at) < datetime(account.period_end)
					), 0) AS used_credits,
					COALESCE((
						SELECT -SUM(entry.amount_credits)
						FROM billing_service_credit_entries AS entry
						INNER JOIN billing_service_credit_reservations AS r
							ON r.id = entry.reservation_id
						WHERE entry.organization_id = account.organization_id
							AND entry.service_key = ?
							AND entry.amount_credits < 0
							AND r.tedi_id = ?
							AND datetime(entry.created_at) >= datetime(account.period_start)
							AND datetime(entry.created_at) < datetime(account.period_end)
					), 0) AS tedi_used_credits,
					COALESCE((
						SELECT SUM(r.credits_reserved)
						FROM billing_service_credit_reservations AS r
						WHERE r.organization_id = account.organization_id
							AND r.service_key = ?
							AND r.tedi_id = ?
							AND r.status = 'reserved'
							AND datetime(r.expires_at) > datetime(?)
							AND r.period_start = account.period_start
							AND r.period_end = account.period_end
					), 0) AS tedi_reserved_credits,
					COALESCE((
						SELECT SUM(usage.provider_cost_micros)
						FROM billing_provider_usage AS usage
						WHERE usage.organization_id = account.organization_id
							AND usage.usage_kind = 'seo_data'
							AND json_extract(usage.metadata, '$.credentialMode') = 'managed'
							AND datetime(usage.occurred_at) >= datetime(account.period_start)
							AND datetime(usage.occurred_at) < datetime(account.period_end)
					), 0) AS provider_cost_micros,
					COALESCE((
						SELECT SUM(r.provider_cost_ceiling_micros)
						FROM billing_service_credit_reservations AS r
						WHERE r.organization_id = account.organization_id
							AND r.service_key = ?
							AND r.status = 'reserved'
							AND datetime(r.expires_at) > datetime(?)
							AND r.period_start = account.period_start
							AND r.period_end = account.period_end
					), 0) AS reserved_provider_cost_micros
				FROM billing_accounts AS account
				INNER JOIN billing_plan_service_allowances AS allowance
					ON allowance.plan_version_id = account.plan_version_id
					AND allowance.service_key = ?
				INNER JOIN billing_service_rate_cards AS rate
					ON rate.id = ?
				LEFT JOIN billing_service_credit_controls AS control
					ON control.organization_id = account.organization_id
					AND control.service_key = ?
				WHERE account.organization_id = ?
			)
			INSERT INTO billing_service_credit_reservations (
				id, organization_id, plan_version_id, rate_card_id, tedi_id,
				service_key, operation_key, status, credits_reserved,
				customer_value_micros, provider_cost_ceiling_micros,
				actual_provider_cost_micros, provider_usage_id,
				period_start, period_end, idempotency_key, rejection_code,
				expires_at, settled_at, released_at, metadata, created_at, updated_at
			)
			SELECT
				?, organization_id, plan_version_id, rate_card_id, ?,
				?, ?, 'reserved', credit_cost,
				customer_value_micros * credit_cost, provider_cost_ceiling_micros,
				NULL, NULL, period_start, period_end, ?, NULL, ?,
				NULL, NULL, ?, ?, ?
			FROM snapshot
			WHERE status IN ('trial', 'active')
				AND datetime(?) >= datetime(period_start)
				AND datetime(?) < datetime(period_end)
				AND enabled = 1
				AND credit_balance - reserved_credits >= credit_cost
				AND (
					monthly_credit_limit IS NULL
					OR used_credits + reserved_credits + credit_cost
						<= monthly_credit_limit
				)
				AND (
					? IS NULL
					OR per_tedi_monthly_limit IS NULL
					OR tedi_used_credits + tedi_reserved_credits + credit_cost
						<= per_tedi_monthly_limit
				)
				AND (
					provider_cost_limit_micros IS NULL
					OR provider_cost_micros + reserved_provider_cost_micros +
						provider_cost_ceiling_micros <= provider_cost_limit_micros
				)
			ON CONFLICT(idempotency_key) DO NOTHING
		`)
		.bind(
			input.serviceKey,
			input.now,
			input.serviceKey,
			input.now,
			input.serviceKey,
			input.serviceKey,
			input.tediId ?? null,
			input.serviceKey,
			input.tediId ?? null,
			input.now,
			input.serviceKey,
			input.now,
			input.serviceKey,
			rateCard.id,
			input.serviceKey,
			input.organizationId,
			input.id,
			input.tediId ?? null,
			input.serviceKey,
			input.operationKey,
			input.idempotencyKey,
			input.expiresAt,
			JSON.stringify(input.metadata ?? {}),
			input.now,
			input.now,
			input.now,
			input.now,
			input.tediId ?? null,
		);
	await d1.batch([grant, reserve]);

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
	now: string;
}

/**
 * Atomically records provider cost and either debits managed credits or
 * releases them when the provider failed.
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

	const d1 = db.$client as D1Database;
	const metadata = JSON.stringify({
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
	});
	const providerUsage = d1
		.prepare(`
			INSERT INTO billing_provider_usage (
				id, organization_id, tedi_id, reservation_id, gateway_log_id,
				provider_usage_id, provider, model, usage_kind, unit, quantity,
				provider_cost_micros, provider_cost_quality,
				customer_metering_ready, occurred_at, metadata, created_at
			) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'seo_data', 'units', 1, ?, ?, ?, ?, ?, ?)
			ON CONFLICT DO NOTHING
		`)
		.bind(
			input.id,
			input.organizationId,
			input.tediId ?? null,
			input.reservationId,
			input.providerUsageId,
			input.provider,
			input.model,
			input.providerCostMicros,
			input.providerCostQuality,
			input.providerSucceeded ? 1 : 0,
			input.occurredAt,
			metadata,
			input.now,
		);
	const statements: D1PreparedStatement[] = [providerUsage];
	if (input.providerSucceeded) {
		statements.push(
			d1
				.prepare(`
					INSERT INTO billing_service_credit_entries (
						id, organization_id, service_key, kind, amount_credits,
						source_type, source_ref, reservation_id, idempotency_key,
						expires_at, description, metadata, created_at
					)
					SELECT ?, ?, ?, 'debit', ?, 'provider_usage', ?, ?, ?, NULL, ?, ?, ?
					WHERE EXISTS (
						SELECT 1
						FROM billing_provider_usage
						WHERE provider_usage_id = ?
							AND reservation_id = ?
					)
					ON CONFLICT(idempotency_key) DO NOTHING
				`)
				.bind(
					crypto.randomUUID(),
					input.organizationId,
					reservation.serviceKey,
					-reservation.creditsReserved,
					input.providerUsageId,
					reservation.id,
					`service-debit:${input.providerUsageId}`,
					`${reservation.operationKey} managed usage`,
					metadata,
					input.now,
					input.providerUsageId,
					reservation.id,
				),
		);
	}
	statements.push(
		d1
			.prepare(`
				UPDATE billing_service_credit_reservations
				SET status = ?,
					actual_provider_cost_micros = ?,
					provider_usage_id = ?,
					rejection_code = ?,
					settled_at = ?,
					released_at = ?,
					updated_at = ?
				WHERE id = ?
					AND organization_id = ?
					AND status = 'reserved'
					AND EXISTS (
						SELECT 1
						FROM billing_provider_usage
						WHERE provider_usage_id = ?
							AND reservation_id = ?
					)
			`)
			.bind(
				input.providerSucceeded ? "settled" : "released",
				input.providerCostMicros,
				input.providerUsageId,
				input.providerSucceeded ? null : "provider_failed",
				input.providerSucceeded ? input.now : null,
				input.providerSucceeded ? null : input.now,
				input.now,
				input.reservationId,
				input.organizationId,
				input.providerUsageId,
				input.reservationId,
			),
	);
	await d1.batch(statements);

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

export async function grantBillingServiceCredits(
	db: DbClient,
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
	return entry;
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
