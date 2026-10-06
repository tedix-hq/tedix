/** Canonical append-only capacity-allocation journal. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, gt, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingCapacityAllocation,
	billingAccounts,
	billingCapacityAllocations,
} from "../../schema/billing";
import { reservationUsedTokensSql } from "./usage-tokens";

export interface RecordCapacityAllocationParams {
	id: string;
	organizationId: string;
	packVersionId?: string | null;
	budgetDay: string;
	tokenAmount: number;
	spendAmountMicros: number;
	sourceType: string;
	sourceRef?: string | null;
	idempotencyKey: string;
	stripeEnvironment: "test" | "live";
	expiresAt: string;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
}

function requireSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${name} must be a safe integer`);
	}
}

export async function recordCapacityAllocation(
	db: DbClient,
	input: RecordCapacityAllocationParams,
): Promise<BillingCapacityAllocation> {
	requireSafeInteger(input.tokenAmount, "tokenAmount");
	requireSafeInteger(input.spendAmountMicros, "spendAmountMicros");
	if (input.tokenAmount === 0 && input.spendAmountMicros === 0) {
		throw new Error("Capacity allocation must provide token or spend capacity");
	}
	if (
		(input.tokenAmount < 0 && input.spendAmountMicros > 0) ||
		(input.tokenAmount > 0 && input.spendAmountMicros < 0)
	) {
		throw new Error("Capacity allocation amounts must have the same direction");
	}
	if (
		input.sourceType === "stripe_checkout" &&
		(input.tokenAmount < 0 || input.spendAmountMicros < 0)
	) {
		throw new Error("Stripe checkout capacity must be positive");
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.budgetDay)) {
		throw new Error("budgetDay must be a UTC date in YYYY-MM-DD format");
	}
	const budgetDayStartMs = Date.parse(`${input.budgetDay}T00:00:00.000Z`);
	if (!Number.isFinite(budgetDayStartMs)) {
		throw new Error("budgetDay must be a valid UTC date");
	}
	const expectedExpiry = new Date(
		budgetDayStartMs + 24 * 60 * 60 * 1_000,
	).toISOString();
	if (input.expiresAt !== expectedExpiry) {
		throw new Error("expiresAt must equal the next UTC midnight");
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
		.insert(billingCapacityAllocations)
		.values({
			...input,
			packVersionId: input.packVersionId ?? null,
			sourceRef: input.sourceRef ?? null,
			metadata: input.metadata ?? {},
		})
		.onConflictDoNothing({
			target: billingCapacityAllocations.idempotencyKey,
		});
	const [allocation] = await db
		.select()
		.from(billingCapacityAllocations)
		.where(
			and(
				eq(billingCapacityAllocations.idempotencyKey, input.idempotencyKey),
				eq(billingCapacityAllocations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!allocation) throw new Error("Failed to journal capacity allocation");
	return allocation;
}

export async function findCapacityAllocationByPaymentIntent(
	db: DbClient,
	input: { paymentIntentId: string; stripeEnvironment: "test" | "live" },
): Promise<BillingCapacityAllocation | null> {
	const [allocation] = await db.all<BillingCapacityAllocation>(sql`
		SELECT id, organization_id AS organizationId,
			pack_version_id AS packVersionId, budget_day AS budgetDay,
			token_amount AS tokenAmount, spend_amount_micros AS spendAmountMicros,
			source_type AS sourceType, source_ref AS sourceRef,
			idempotency_key AS idempotencyKey,
			stripe_environment AS stripeEnvironment, expires_at AS expiresAt,
			metadata, created_at AS createdAt
		FROM billing_capacity_allocations
		WHERE stripe_environment = ${input.stripeEnvironment}
			AND source_type = 'stripe_checkout'
			AND json_extract(metadata, '$.paymentIntentId') = ${input.paymentIntentId}
		ORDER BY created_at DESC
		LIMIT 1
	`);
	return allocation ?? null;
}

export async function reconcileCapacityRefund(
	db: DbClient,
	input: {
		organizationId: string;
		allocation: BillingCapacityAllocation;
		chargeId: string;
		paymentIntentId: string;
		amount: number;
		amountRefunded: number;
		eventId: string;
		createdAt: string;
	},
): Promise<BillingCapacityAllocation | null> {
	if (
		!Number.isSafeInteger(input.amount) ||
		input.amount <= 0 ||
		!Number.isSafeInteger(input.amountRefunded) ||
		input.amountRefunded < 0 ||
		input.amountRefunded > input.amount
	)
		throw new Error("Stripe refund amounts are invalid");
	const [current] = await db.all<{
		tokenAmount: number;
		spendAmountMicros: number;
	}>(sql`
		SELECT COALESCE(SUM(token_amount), 0) AS tokenAmount,
			COALESCE(SUM(spend_amount_micros), 0) AS spendAmountMicros
		FROM billing_capacity_allocations
		WHERE organization_id = ${input.organizationId}
			AND json_extract(metadata, '$.originalAllocationId') = ${input.allocation.id}
	`);
	const { tokenDelta, spendDelta } = capacityRefundDelta({
		tokenAmount: input.allocation.tokenAmount,
		spendAmountMicros: input.allocation.spendAmountMicros,
		amount: input.amount,
		amountRefunded: input.amountRefunded,
		currentTokenAdjustment: Number(current?.tokenAmount ?? 0),
		currentSpendAdjustmentMicros: Number(current?.spendAmountMicros ?? 0),
	});
	if (tokenDelta === 0 && spendDelta === 0) return null;
	if (tokenDelta > 0 || spendDelta > 0) {
		throw new Error("Capacity refund reconciliation cannot restore capacity");
	}
	return recordCapacityAllocation(db, {
		id: crypto.randomUUID(),
		organizationId: input.organizationId,
		packVersionId: input.allocation.packVersionId,
		budgetDay: input.allocation.budgetDay,
		tokenAmount: tokenDelta,
		spendAmountMicros: spendDelta,
		sourceType: "stripe_refund",
		sourceRef: input.chargeId,
		idempotencyKey: `stripe-inference-capacity-refund:${input.allocation.stripeEnvironment}:${input.eventId}`,
		stripeEnvironment: input.allocation.stripeEnvironment,
		expiresAt: input.allocation.expiresAt,
		metadata: {
			originalAllocationId: input.allocation.id,
			chargeId: input.chargeId,
			paymentIntentId: input.paymentIntentId,
			amount: input.amount,
			amountRefunded: input.amountRefunded,
		},
		createdAt: input.createdAt,
	});
}

export function capacityRefundDelta(input: {
	tokenAmount: number;
	spendAmountMicros: number;
	amount: number;
	amountRefunded: number;
	currentTokenAdjustment: number;
	currentSpendAdjustmentMicros: number;
}): { tokenDelta: number; spendDelta: number } {
	const targetTokens = -Math.round(
		(input.tokenAmount * input.amountRefunded) / input.amount,
	);
	const targetSpend = -Math.round(
		(input.spendAmountMicros * input.amountRefunded) / input.amount,
	);
	return {
		tokenDelta: targetTokens - input.currentTokenAdjustment,
		spendDelta: targetSpend - input.currentSpendAdjustmentMicros,
	};
}

export interface InferenceCapacityLedger {
	allocations: Array<{
		id: string;
		packVersionId: string | null;
		packKey: string | null;
		packVersion: number | null;
		packName: string | null;
		budgetDay: string;
		tokenAmount: number;
		spendAmountMicros: number;
		sourceType: string;
		sourceRef: string | null;
		checkoutSessionId: string | null;
		paymentIntentId: string | null;
		stripeEnvironment: "test" | "live";
		expiresAt: string;
		createdAt: string;
		state: "active" | "expired" | "compensating";
	}>;
	tediOverflow: Array<{
		tediId: string;
		displayName: string;
		usedTokens: number;
		usedSpendMicros: number;
		baseTokenLimit: number | null;
		baseSpendLimitMicros: number | null;
		overflowTokens: number;
		overflowSpendMicros: number;
	}>;
}

export async function getInferenceCapacityLedger(
	db: DbClient,
	input: {
		organizationId: string;
		stripeEnvironment: "test" | "live";
		now: string;
		baseDailyTokenLimit: number;
		baseDailySpendLimitMicros: number | null;
	},
): Promise<InferenceCapacityLedger> {
	const budgetDay = input.now.slice(0, 10);
	const allocationRows = await db.all<{
		id: string;
		packVersionId: string | null;
		packKey: string | null;
		packVersion: number | null;
		packName: string | null;
		budgetDay: string;
		tokenAmount: number;
		spendAmountMicros: number;
		sourceType: string;
		sourceRef: string | null;
		checkoutSessionId: string | null;
		paymentIntentId: string | null;
		stripeEnvironment: "test" | "live";
		expiresAt: string;
		createdAt: string;
	}>(sql`
		SELECT allocation.id, allocation.pack_version_id AS packVersionId,
			pack.pack_key AS packKey, pack.version AS packVersion,
			pack.name AS packName, allocation.budget_day AS budgetDay,
			allocation.token_amount AS tokenAmount,
			allocation.spend_amount_micros AS spendAmountMicros,
			allocation.source_type AS sourceType, allocation.source_ref AS sourceRef,
			json_extract(allocation.metadata, '$.checkoutSessionId') AS checkoutSessionId,
			json_extract(allocation.metadata, '$.paymentIntentId') AS paymentIntentId,
			allocation.stripe_environment AS stripeEnvironment,
			allocation.expires_at AS expiresAt, allocation.created_at AS createdAt
		FROM billing_capacity_allocations AS allocation
		LEFT JOIN billing_inference_capacity_pack_versions AS pack
			ON pack.id = allocation.pack_version_id
		WHERE allocation.organization_id = ${input.organizationId}
			AND allocation.stripe_environment = ${input.stripeEnvironment}
		ORDER BY allocation.created_at DESC
		LIMIT 50
	`);
	const tediRows = await db.all<{
		tediId: string;
		displayName: string;
		usedTokens: number;
		usedSpendMicros: number;
		baseTokenLimit: number | null;
		baseSpendLimitMicros: number | null;
	}>(sql`
		SELECT reservation.tedi_id AS tediId,
			COALESCE(tedi.display_name, tedi.slug, reservation.tedi_id) AS displayName,
			SUM(${reservationUsedTokensSql("reservation")}) AS usedTokens,
			SUM(CASE WHEN reservation.status = 'reserved'
				THEN reservation.estimated_charge_micros
				ELSE COALESCE((SELECT SUM(charge.provider_cost_micros)
					FROM billing_usage_charges AS charge
					WHERE charge.reservation_id = reservation.id), reservation.estimated_charge_micros)
			END) AS usedSpendMicros,
			COALESCE(policy.daily_token_limit, ${input.baseDailyTokenLimit}) AS baseTokenLimit,
			COALESCE(policy.daily_spend_limit_micros, ${input.baseDailySpendLimitMicros}) AS baseSpendLimitMicros
		FROM billing_usage_reservations AS reservation
		LEFT JOIN tedis AS tedi ON tedi.id = reservation.tedi_id
		LEFT JOIN billing_inference_policies AS policy
			ON policy.organization_id = reservation.organization_id
			AND policy.scope = 'tedi' AND policy.tedi_id = reservation.tedi_id
		WHERE reservation.organization_id = ${input.organizationId}
			AND reservation.tedi_id IS NOT NULL
			AND reservation.status IN ('reserved', 'settled')
			AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
			AND substr(reservation.created_at, 1, 10) = ${budgetDay}
		GROUP BY reservation.tedi_id, tedi.display_name, tedi.slug,
			policy.daily_token_limit, policy.daily_spend_limit_micros
		ORDER BY usedTokens DESC
	`);
	return {
		allocations: allocationRows.map((row) => ({
			...row,
			tokenAmount: Number(row.tokenAmount),
			spendAmountMicros: Number(row.spendAmountMicros),
			state:
				row.tokenAmount < 0 || row.spendAmountMicros < 0
					? "compensating"
					: row.expiresAt > input.now
						? "active"
						: "expired",
		})),
		tediOverflow: tediRows.map((row) => ({
			...row,
			usedTokens: Number(row.usedTokens),
			usedSpendMicros: Number(row.usedSpendMicros),
			baseTokenLimit:
				row.baseTokenLimit == null ? null : Number(row.baseTokenLimit),
			baseSpendLimitMicros:
				row.baseSpendLimitMicros == null
					? null
					: Number(row.baseSpendLimitMicros),
			overflowTokens:
				row.baseTokenLimit == null
					? 0
					: Math.max(0, Number(row.usedTokens) - Number(row.baseTokenLimit)),
			overflowSpendMicros:
				row.baseSpendLimitMicros == null
					? 0
					: Math.max(
							0,
							Number(row.usedSpendMicros) - Number(row.baseSpendLimitMicros),
						),
		})),
	};
}

export async function getActiveCapacityAllocationTotals(
	db: DbClient,
	input: {
		organizationId: string;
		budgetDay: string;
		stripeEnvironment: "test" | "live";
		now: string;
	},
): Promise<{
	tokenAmount: number;
	spendAmountMicros: number;
	/**
	 * The part of the totals that is capacity this organization SPONSORED to
	 * its embedded customers, which arrives as a negative allocation against
	 * its own day.
	 *
	 * Broken out because the net number alone is unreadable: a provider saw
	 * `allocatedTokens: -3,000,000` against a 5,000,000 base with nothing in
	 * the product explaining that onboarding five customers is what spent it.
	 * Then its own tedis stopped, and the refusal could not name a cause.
	 * Negative here, in the same sign as the total it is part of.
	 */
	sponsoredTokenAmount: number;
	sponsoredSpendAmountMicros: number;
}> {
	const [row] = await db
		.select({
			tokenAmount: sql<number>`COALESCE(SUM(${billingCapacityAllocations.tokenAmount}), 0)`,
			spendAmountMicros: sql<number>`COALESCE(SUM(${billingCapacityAllocations.spendAmountMicros}), 0)`,
			sponsoredTokenAmount: sql<number>`COALESCE(SUM(CASE WHEN ${billingCapacityAllocations.sourceType} = 'provider_sponsored_transfer' THEN ${billingCapacityAllocations.tokenAmount} ELSE 0 END), 0)`,
			sponsoredSpendAmountMicros: sql<number>`COALESCE(SUM(CASE WHEN ${billingCapacityAllocations.sourceType} = 'provider_sponsored_transfer' THEN ${billingCapacityAllocations.spendAmountMicros} ELSE 0 END), 0)`,
		})
		.from(billingCapacityAllocations)
		.where(
			and(
				eq(billingCapacityAllocations.organizationId, input.organizationId),
				eq(billingCapacityAllocations.budgetDay, input.budgetDay),
				eq(
					billingCapacityAllocations.stripeEnvironment,
					input.stripeEnvironment,
				),
				gt(billingCapacityAllocations.expiresAt, input.now),
			),
		);
	return {
		tokenAmount: Number(row?.tokenAmount ?? 0),
		spendAmountMicros: Number(row?.spendAmountMicros ?? 0),
		sponsoredTokenAmount: Number(row?.sponsoredTokenAmount ?? 0),
		sponsoredSpendAmountMicros: Number(row?.sponsoredSpendAmountMicros ?? 0),
	};
}

export interface SponsoredCapacityTransfer {
	transferId: string;
	sponsorAllocation: BillingCapacityAllocation;
	customerAllocation: BillingCapacityAllocation;
}

export async function countSponsoredCapacityTransfers(
	db: DbClient,
	input: {
		customerOrganizationId: string;
		providerInstallationId: string;
		budgetRevision: number;
		budgetDay: string;
		stripeEnvironment: "test" | "live";
	},
): Promise<number> {
	const [row] = await db.all<{ count: number }>(sql`
		SELECT COUNT(*) AS count
		FROM billing_capacity_allocations
		WHERE organization_id = ${input.customerOrganizationId}
			AND budget_day = ${input.budgetDay}
			AND stripe_environment = ${input.stripeEnvironment}
			AND source_type = 'provider_sponsored_transfer'
			AND token_amount >= 0 AND spend_amount_micros >= 0
			AND json_extract(metadata, '$.providerInstallationId') = ${input.providerInstallationId}
			AND json_extract(metadata, '$.budgetRevision') = ${input.budgetRevision}
	`);
	return Number(row?.count ?? 0);
}

/**
 * Move same-day inference capacity between billing accounts as one D1 batch.
 *
 * The sponsor debit is admitted only while its recurring daily policy plus
 * active top-ups, minus its own usage and prior sponsorship debits, can cover
 * both requested dimensions. The customer credit selects from that exact
 * debit, so D1 can never commit only one side of the transfer. Stable per-side
 * idempotency keys make a retried embedded-session exchange return the original
 * pair.
 */
export async function transferSponsoredCapacity(
	db: DbClient,
	input: {
		transferId: string;
		sponsorOrganizationId: string;
		customerOrganizationId: string;
		providerInstallationId: string;
		budgetRevision: number;
		budgetDay: string;
		tokenAmount: number;
		spendAmountMicros: number;
		customerLowWatermarkTokens: number;
		customerLowWatermarkSpendMicros: number;
		sponsorDailyTokenLimit: number | null;
		sponsorDailySpendLimitMicros: number | null;
		stripeEnvironment: "test" | "live";
		expiresAt: string;
		createdAt: string;
	},
): Promise<SponsoredCapacityTransfer> {
	requireSafeInteger(input.tokenAmount, "tokenAmount");
	requireSafeInteger(input.spendAmountMicros, "spendAmountMicros");
	requireSafeInteger(
		input.customerLowWatermarkTokens,
		"customerLowWatermarkTokens",
	);
	requireSafeInteger(
		input.customerLowWatermarkSpendMicros,
		"customerLowWatermarkSpendMicros",
	);
	if (input.sponsorDailyTokenLimit !== null)
		requireSafeInteger(input.sponsorDailyTokenLimit, "sponsorDailyTokenLimit");
	if (input.sponsorDailySpendLimitMicros !== null)
		requireSafeInteger(
			input.sponsorDailySpendLimitMicros,
			"sponsorDailySpendLimitMicros",
		);
	if (input.tokenAmount < 0 || input.spendAmountMicros < 0)
		throw new Error("Sponsored capacity transfer amounts cannot be negative");
	if (input.tokenAmount === 0 && input.spendAmountMicros === 0)
		throw new Error("Sponsored capacity transfer must move capacity");
	if (input.sponsorOrganizationId === input.customerOrganizationId)
		throw new Error("Sponsored capacity transfer requires distinct accounts");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.budgetDay))
		throw new Error("budgetDay must be a UTC date in YYYY-MM-DD format");
	const expectedExpiry = new Date(
		Date.parse(`${input.budgetDay}T00:00:00.000Z`) + 86_400_000,
	).toISOString();
	if (input.expiresAt !== expectedExpiry)
		throw new Error("expiresAt must equal the next UTC midnight");

	const debitKey = `provider-sponsored-capacity:${input.transferId}:debit`;
	const creditKey = `provider-sponsored-capacity:${input.transferId}:credit`;
	const debitId = crypto.randomUUID();
	const creditId = crypto.randomUUID();
	const metadata = {
		transferId: input.transferId,
		providerInstallationId: input.providerInstallationId,
		budgetRevision: input.budgetRevision,
		sponsorOrganizationId: input.sponsorOrganizationId,
		customerOrganizationId: input.customerOrganizationId,
	};

	const sponsorDebit = db
		.insert(billingCapacityAllocations)
		.select(
			db
				.select({
					id: sql<string>`${debitId}`.as("id"),
					organizationId: billingAccounts.organizationId,
					packVersionId: sql<string | null>`NULL`.as("pack_version_id"),
					budgetDay: sql<string>`${input.budgetDay}`.as("budget_day"),
					tokenAmount: sql<number>`${-input.tokenAmount}`.as("token_amount"),
					spendAmountMicros: sql<number>`${-input.spendAmountMicros}`.as(
						"spend_amount_micros",
					),
					sourceType: sql<string>`'provider_sponsored_transfer'`.as(
						"source_type",
					),
					sourceRef: sql<string>`${input.transferId}`.as("source_ref"),
					idempotencyKey: sql<string>`${debitKey}`.as("idempotency_key"),
					stripeEnvironment: sql<
						"test" | "live"
					>`${input.stripeEnvironment}`.as("stripe_environment"),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					metadata: sql<
						Record<string, JsonValue>
					>`json(${JSON.stringify(metadata)})`.as("metadata"),
					createdAt: sql<string>`${input.createdAt}`.as("created_at"),
				})
				.from(billingAccounts)
				.where(
					and(
						eq(billingAccounts.organizationId, input.sponsorOrganizationId),
						eq(billingAccounts.status, "active"),
						sql`EXISTS (SELECT 1 FROM billing_accounts customer WHERE customer.organization_id = ${input.customerOrganizationId})`,
						sql`(COALESCE((SELECT SUM(token_amount) FROM billing_capacity_allocations WHERE organization_id = ${input.customerOrganizationId} AND budget_day = ${input.budgetDay} AND stripe_environment = ${input.stripeEnvironment} AND expires_at > ${input.createdAt}), 0) - COALESCE((SELECT SUM(${reservationUsedTokensSql("reservation")}) FROM billing_usage_reservations AS reservation WHERE reservation.organization_id = ${input.customerOrganizationId} AND reservation.status IN ('reserved', 'settled') AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.createdAt})) AND substr(reservation.created_at, 1, 10) = ${input.budgetDay}), 0) < ${input.customerLowWatermarkTokens} OR COALESCE((SELECT SUM(spend_amount_micros) FROM billing_capacity_allocations WHERE organization_id = ${input.customerOrganizationId} AND budget_day = ${input.budgetDay} AND stripe_environment = ${input.stripeEnvironment} AND expires_at > ${input.createdAt}), 0) - COALESCE((SELECT SUM(spend_micros) FROM (SELECT estimated_charge_micros AS spend_micros FROM billing_usage_reservations WHERE organization_id = ${input.customerOrganizationId} AND status = 'reserved' AND datetime(expires_at) > datetime(${input.createdAt}) AND substr(created_at, 1, 10) = ${input.budgetDay} UNION ALL SELECT provider_cost_micros AS spend_micros FROM billing_usage_charges WHERE organization_id = ${input.customerOrganizationId} AND substr(occurred_at, 1, 10) = ${input.budgetDay})), 0) < ${input.customerLowWatermarkSpendMicros})`,
						input.sponsorDailyTokenLimit === null
							? sql`TRUE`
							: sql`${input.sponsorDailyTokenLimit} + COALESCE((SELECT SUM(token_amount) FROM billing_capacity_allocations WHERE organization_id = ${input.sponsorOrganizationId} AND budget_day = ${input.budgetDay} AND stripe_environment = ${input.stripeEnvironment} AND expires_at > ${input.createdAt}), 0) - COALESCE((SELECT SUM(${reservationUsedTokensSql("reservation")}) FROM billing_usage_reservations AS reservation WHERE reservation.organization_id = ${input.sponsorOrganizationId} AND reservation.status IN ('reserved', 'settled') AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.createdAt})) AND substr(reservation.created_at, 1, 10) = ${input.budgetDay}), 0) >= ${input.tokenAmount}`,
						input.sponsorDailySpendLimitMicros === null
							? sql`TRUE`
							: sql`${input.sponsorDailySpendLimitMicros} + COALESCE((SELECT SUM(spend_amount_micros) FROM billing_capacity_allocations WHERE organization_id = ${input.sponsorOrganizationId} AND budget_day = ${input.budgetDay} AND stripe_environment = ${input.stripeEnvironment} AND expires_at > ${input.createdAt}), 0) - COALESCE((SELECT SUM(spend_micros) FROM (SELECT estimated_charge_micros AS spend_micros FROM billing_usage_reservations WHERE organization_id = ${input.sponsorOrganizationId} AND status = 'reserved' AND datetime(expires_at) > datetime(${input.createdAt}) AND substr(created_at, 1, 10) = ${input.budgetDay} UNION ALL SELECT provider_cost_micros AS spend_micros FROM billing_usage_charges WHERE organization_id = ${input.sponsorOrganizationId} AND substr(occurred_at, 1, 10) = ${input.budgetDay})), 0) >= ${input.spendAmountMicros}`,
					),
				)
				.limit(1),
		)
		.onConflictDoNothing({ target: billingCapacityAllocations.idempotencyKey });

	const customerCredit = db
		.insert(billingCapacityAllocations)
		.select(
			db
				.select({
					id: sql<string>`${creditId}`.as("id"),
					organizationId: sql<string>`${input.customerOrganizationId}`.as(
						"organization_id",
					),
					packVersionId: sql<string | null>`NULL`.as("pack_version_id"),
					budgetDay: billingCapacityAllocations.budgetDay,
					tokenAmount: sql<number>`${input.tokenAmount}`.as("token_amount"),
					spendAmountMicros: sql<number>`${input.spendAmountMicros}`.as(
						"spend_amount_micros",
					),
					sourceType: sql<string>`'provider_sponsored_transfer'`.as(
						"source_type",
					),
					sourceRef: billingCapacityAllocations.sourceRef,
					idempotencyKey: sql<string>`${creditKey}`.as("idempotency_key"),
					stripeEnvironment: billingCapacityAllocations.stripeEnvironment,
					expiresAt: billingCapacityAllocations.expiresAt,
					metadata: sql<
						Record<string, JsonValue>
					>`json(${JSON.stringify(metadata)})`.as("metadata"),
					createdAt: sql<string>`${input.createdAt}`.as("created_at"),
				})
				.from(billingCapacityAllocations)
				.where(eq(billingCapacityAllocations.idempotencyKey, debitKey))
				.limit(1),
		)
		.onConflictDoNothing({ target: billingCapacityAllocations.idempotencyKey });

	await db.batch([sponsorDebit, customerCredit]);
	const rows = await db
		.select()
		.from(billingCapacityAllocations)
		.where(
			sql`${billingCapacityAllocations.idempotencyKey} IN (${debitKey}, ${creditKey})`,
		);
	const sponsorAllocation = rows.find((row) => row.idempotencyKey === debitKey);
	const customerAllocation = rows.find(
		(row) => row.idempotencyKey === creditKey,
	);
	if (!sponsorAllocation || !customerAllocation)
		throw new Error("Sponsor has insufficient active inference capacity");
	return {
		transferId: input.transferId,
		sponsorAllocation,
		customerAllocation,
	};
}

export interface InferenceCapacityDailyOverview {
	budgetDay: string;
	/**
	 * Mirrors `usedSpendMicros`: in-flight (`reserved`) rows count their
	 * estimate, settled rows count the actual tokens on their charge row(s), and
	 * a settled row with no charge yet falls back to its estimate.
	 */
	usedTokens: number;
	usedSpendMicros: number;
	allocatedTokens: number;
	allocatedSpendMicros: number;
	/**
	 * The part of the net allocation this organization sponsored to its
	 * embedded customers. Negative, in the same sign as the total.
	 *
	 * A provider reading `allocatedTokens: -3,000,000` against a 5,000,000 base
	 * has no way to know that onboarding five customers is what spent it — and
	 * when the remainder runs out its own tedis stop.
	 */
	sponsoredTokens: number;
	sponsoredSpendMicros: number;
	earliestExpiryAt: string | null;
}

export async function getInferenceCapacityDailyOverview(
	db: DbClient,
	input: {
		organizationId: string;
		stripeEnvironment: "test" | "live";
		now: string;
	},
): Promise<InferenceCapacityDailyOverview> {
	const budgetDay = input.now.slice(0, 10);
	const [row] = await db.all<{
		usedTokens: number;
		usedSpendMicros: number;
		allocatedTokens: number;
		allocatedSpendMicros: number;
		sponsoredTokens: number;
		sponsoredSpendMicros: number;
		earliestExpiryAt: string | null;
	}>(sql`
		SELECT
			COALESCE((
				SELECT SUM(${reservationUsedTokensSql("reservation")})
				FROM billing_usage_reservations AS reservation
				WHERE reservation.organization_id = ${input.organizationId}
					AND reservation.status IN ('reserved', 'settled')
					AND (reservation.status = 'settled' OR datetime(reservation.expires_at) > datetime(${input.now}))
					AND substr(reservation.created_at, 1, 10) = ${budgetDay}
			), 0) AS usedTokens,
			COALESCE((
				SELECT SUM(spend_micros)
				FROM (
					SELECT estimated_charge_micros AS spend_micros
					FROM billing_usage_reservations
					WHERE organization_id = ${input.organizationId}
						AND status = 'reserved'
						AND datetime(expires_at) > datetime(${input.now})
						AND substr(created_at, 1, 10) = ${budgetDay}
					UNION ALL
					SELECT provider_cost_micros AS spend_micros
					FROM billing_usage_charges
					WHERE organization_id = ${input.organizationId}
						AND substr(occurred_at, 1, 10) = ${budgetDay}
				)
			), 0) AS usedSpendMicros,
			COALESCE(SUM(token_amount), 0) AS allocatedTokens,
			COALESCE(SUM(spend_amount_micros), 0) AS allocatedSpendMicros,
			COALESCE(SUM(CASE WHEN source_type = 'provider_sponsored_transfer'
				THEN token_amount ELSE 0 END), 0) AS sponsoredTokens,
			COALESCE(SUM(CASE WHEN source_type = 'provider_sponsored_transfer'
				THEN spend_amount_micros ELSE 0 END), 0) AS sponsoredSpendMicros,
			MIN(expires_at) AS earliestExpiryAt
		FROM billing_capacity_allocations
		WHERE organization_id = ${input.organizationId}
			AND budget_day = ${budgetDay}
			AND stripe_environment = ${input.stripeEnvironment}
			AND datetime(expires_at) > datetime(${input.now})
	`);
	return {
		budgetDay,
		usedTokens: Number(row?.usedTokens ?? 0),
		usedSpendMicros: Number(row?.usedSpendMicros ?? 0),
		allocatedTokens: Number(row?.allocatedTokens ?? 0),
		allocatedSpendMicros: Number(row?.allocatedSpendMicros ?? 0),
		sponsoredTokens: Number(row?.sponsoredTokens ?? 0),
		sponsoredSpendMicros: Number(row?.sponsoredSpendMicros ?? 0),
		earliestExpiryAt: row?.earliestExpiryAt ?? null,
	};
}
