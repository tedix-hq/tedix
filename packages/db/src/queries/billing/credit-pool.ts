/**
 * The organization credit pool: one monthly pool per organization and billing
 * period, shared by AI use, code runs and service operations.
 *
 * Capacity = included credits left this period (plan value or operator
 * override) + unexpired top-up credits + pay-as-you-go room when an admin
 * opted in, minus credits held by in-flight reservations. Optional per-tedi
 * and per-member monthly caps narrow it further.
 *
 * Consumption is recorded once per settled call in billing_credit_consumptions,
 * split into included, top-up (soonest-expiring first) and pay-as-you-go
 * parts, and added to the period totals that admission reads.
 */

import type { CreditFxRate } from "@tedix/api-contract/schemas/billing";
import {
	CREDIT_NOTICE_THRESHOLDS,
	CREDIT_VALUE_EUR_MICROS,
	type CreditNoticeThreshold,
} from "@tedix/api-contract/utils/credit-pricing";
import {
	type AnyColumn,
	and,
	asc,
	eq,
	exists,
	gt,
	lte,
	notExists,
	type SQL,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { auditEvents } from "../../schema/audit-events";
import {
	type BillingAccount,
	type BillingAccountStatus,
	type BillingCreditKind,
	type BillingPlanKey,
	billingAccounts,
	billingCreditCaps,
	billingCreditConsumptions,
	billingCreditMeterOutbox,
	billingCreditNotices,
	billingCreditTopUps,
	billingCreditUsageTotals,
	billingPlanVersions,
	billingServiceCreditReservations,
	billingTopUpPackVersions,
	billingUsageReservations,
} from "../../schema/billing";
import { liveAtSql } from "./usage-window";

export type CreditRefusalCode =
	| "billing_not_configured"
	| "subscription_inactive"
	| "billing_period_inactive"
	| "monthly_credit_limit_reached"
	| "tedi_monthly_credit_cap_reached"
	| "member_monthly_credit_cap_reached";

export interface CreditSubject {
	tediId?: string | null;
	userId?: string | null;
}

type Ref = SQLWrapper | AnyColumn;

const account = alias(billingAccounts, "account");
const plan = alias(billingPlanVersions, "plan");
const orgTotal = alias(billingCreditUsageTotals, "organization_total");
const usedTotal = alias(billingCreditUsageTotals, "used_total");
const topUp = alias(billingCreditTopUps, "top_up");
const heldAi = alias(billingUsageReservations, "held_ai");
const heldService = alias(billingServiceCreditReservations, "held_service");
const tediCap = alias(billingCreditCaps, "tedi_cap");
const memberCap = alias(billingCreditCaps, "member_cap");

/**
 * Credits held by live reservations of one organization and period: AI and
 * service reservations, optionally narrowed to one tedi or member.
 */
function heldCredits(
	db: DbClient,
	ref: { organizationId: Ref; periodStart: Ref; periodEnd: Ref },
	now: string,
	filter?: { kind: "tedi" | "member"; value: string | null },
): SQL {
	const ai = db
		.select({ total: sql`SUM(${heldAi.credits})` })
		.from(heldAi)
		.where(
			and(
				sql`${heldAi.organizationId} = ${ref.organizationId}`,
				eq(heldAi.status, "reserved"),
				liveAtSql("held_ai.expires_at", now),
				sql`${heldAi.periodStart} = ${ref.periodStart}`,
				sql`${heldAi.periodEnd} = ${ref.periodEnd}`,
				filter?.kind === "tedi"
					? sql`${heldAi.tediId} = ${filter.value}`
					: filter?.kind === "member"
						? sql`${heldAi.userId} = ${filter.value}`
						: undefined,
			),
		);
	const service = db
		.select({ total: sql`SUM(${heldService.creditsReserved})` })
		.from(heldService)
		.where(
			and(
				sql`${heldService.organizationId} = ${ref.organizationId}`,
				eq(heldService.status, "reserved"),
				liveAtSql("held_service.expires_at", now),
				sql`${heldService.periodStart} = ${ref.periodStart}`,
				sql`${heldService.periodEnd} = ${ref.periodEnd}`,
				filter?.kind === "tedi"
					? sql`${heldService.tediId} = ${filter.value}`
					: filter?.kind === "member"
						? sql`${heldService.userId} = ${filter.value}`
						: undefined,
			),
		);
	return sql`(COALESCE((${ai}), 0) + COALESCE((${service}), 0))`;
}

/** Credits a tedi or member used this period, from the running totals. */
function subjectUsed(
	db: DbClient,
	ref: { organizationId: Ref; periodStart: Ref },
	kind: "tedi" | "member",
	key: string | null,
): SQL {
	const total = db
		.select({
			used: sql`${usedTotal.aiCredits} + ${usedTotal.codeRunCredits} + ${usedTotal.serviceCredits}`,
		})
		.from(usedTotal)
		.where(
			and(
				sql`${usedTotal.organizationId} = ${ref.organizationId}`,
				sql`${usedTotal.periodStart} = ${ref.periodStart}`,
				eq(usedTotal.subjectKind, kind),
				sql`${usedTotal.subjectKey} = ${key}`,
			),
		);
	return sql`COALESCE((${total}), 0)`;
}

/** One row per organization: account state, remaining capacity and caps. */
export function buildCreditPoolSelect(
	db: DbClient,
	input: { organizationId: string; now: string; subject?: CreditSubject },
) {
	const tediId = input.subject?.tediId ?? null;
	const userId = input.subject?.userId ?? null;
	const topUpRemaining = db
		.select({
			remaining: sql`SUM(${topUp.credits} - ${topUp.consumedCredits})`,
		})
		.from(topUp)
		.where(
			and(
				eq(topUp.organizationId, account.organizationId),
				sql`${topUp.consumedCredits} < ${topUp.credits}`,
				liveAtSql("top_up.expires_at", input.now),
			),
		);
	const cap = (
		table: typeof tediCap | typeof memberCap,
		kind: "tedi" | "member",
		key: string | null,
	) =>
		db
			.select({ cap: table.monthlyCapCredits })
			.from(table)
			.where(
				and(
					eq(table.organizationId, account.organizationId),
					eq(table.subjectKind, kind),
					sql`${table.subjectKey} = ${key}`,
				),
			);
	return db
		.select({
			organizationId: sql<string>`${account.organizationId}`.as(
				"organization_id",
			),
			planVersionId: sql<string>`${account.planVersionId}`.as(
				"plan_version_id",
			),
			planKey: sql<BillingPlanKey>`${plan.planKey}`.as("plan_key"),
			planName: sql<string>`${plan.name}`.as("plan_name"),
			planPriceMicros: sql<number>`${plan.monthlyPriceMicros}`.as(
				"plan_price_micros",
			),
			creditFx: sql<unknown>`${plan.creditFx}`.as("credit_fx"),
			status: sql<BillingAccountStatus>`${account.status}`.as("status"),
			billingMode: sql<
				BillingAccount["billingMode"]
			>`${account.billingMode}`.as("billing_mode"),
			stripeEnvironment: sql<
				"test" | "live" | null
			>`${account.stripeEnvironment}`.as("stripe_environment"),
			stripeCustomerId: sql<string | null>`${account.stripeCustomerId}`.as(
				"stripe_customer_id",
			),
			periodStart: sql<string>`${account.periodStart}`.as("period_start"),
			periodEnd: sql<string>`${account.periodEnd}`.as("period_end"),
			planIncludedCredits: sql<number>`${plan.includedMonthlyCredits}`.as(
				"plan_included_credits",
			),
			includedCreditsOverride: sql<
				number | null
			>`${account.includedCreditsOverride}`.as("included_credits_override"),
			includedCredits:
				sql<number>`COALESCE(${account.includedCreditsOverride}, ${plan.includedMonthlyCredits})`.as(
					"included_credits",
				),
			includedUsed: sql<number>`COALESCE(${orgTotal.includedCredits}, 0)`.as(
				"included_used",
			),
			topUpUsed: sql<number>`COALESCE(${orgTotal.topUpCredits}, 0)`.as(
				"top_up_used",
			),
			paygUsed: sql<number>`COALESCE(${orgTotal.paygCredits}, 0)`.as(
				"payg_used",
			),
			paygChargeMicros:
				sql<number>`COALESCE(${orgTotal.paygChargeMicros}, 0)`.as(
					"payg_charge_micros",
				),
			aiCredits: sql<number>`COALESCE(${orgTotal.aiCredits}, 0)`.as(
				"ai_credits",
			),
			codeRunCredits: sql<number>`COALESCE(${orgTotal.codeRunCredits}, 0)`.as(
				"code_run_credits",
			),
			serviceCredits: sql<number>`COALESCE(${orgTotal.serviceCredits}, 0)`.as(
				"service_credits",
			),
			paygEnabled:
				sql<number>`(${plan.allowOverage} = 1 AND ${account.overageEnabled} = 1 AND ${account.hardSpendLimitMicros} IS NOT NULL)`.as(
					"payg_enabled",
				),
			paygOptedIn: sql<number>`${account.overageEnabled}`.as("payg_opted_in"),
			paygAllowed: sql<number>`${plan.allowOverage}`.as("payg_allowed"),
			paygCapMicros: sql<number | null>`${account.hardSpendLimitMicros}`.as(
				"payg_cap_micros",
			),
			topUpRemaining: sql<number>`COALESCE((${topUpRemaining}), 0)`.as(
				"top_up_remaining",
			),
			heldCredits: sql<number>`${heldCredits(
				db,
				{
					organizationId: account.organizationId,
					periodStart: account.periodStart,
					periodEnd: account.periodEnd,
				},
				input.now,
			)}`.as("held_credits"),
			tediCap: sql<number | null>`(${cap(tediCap, "tedi", tediId)})`.as(
				"tedi_cap",
			),
			memberCap: sql<number | null>`(${cap(memberCap, "member", userId)})`.as(
				"member_cap",
			),
		})
		.from(account)
		.innerJoin(plan, eq(plan.id, account.planVersionId))
		.leftJoin(
			orgTotal,
			and(
				eq(orgTotal.organizationId, account.organizationId),
				eq(orgTotal.periodStart, account.periodStart),
				eq(orgTotal.subjectKind, "organization"),
				eq(orgTotal.subjectKey, "organization"),
			),
		)
		.where(eq(account.organizationId, input.organizationId));
}

export type CreditPoolCte = ReturnType<typeof creditPoolCte>;
export function creditPoolCte(
	db: DbClient,
	input: { organizationId: string; now: string; subject?: CreditSubject },
) {
	return db.$with("pool").as(buildCreditPoolSelect(db, input));
}

/**
 * Over `pool`: available credits and, only where a cap exists, the tedi's
 * and member's use including their live holds. SQLite evaluates a CASE
 * branch's subqueries only when that branch is taken.
 */
export function buildCreditCapacitySelect(
	db: DbClient,
	pool: CreditPoolCte,
	input: { now: string; subject?: CreditSubject },
) {
	const tediId = input.subject?.tediId ?? null;
	const userId = input.subject?.userId ?? null;
	const ref = {
		organizationId: pool.organizationId,
		periodStart: pool.periodStart,
		periodEnd: pool.periodEnd,
	};
	return db
		.select({
			organizationId: pool.organizationId,
			planVersionId: pool.planVersionId,
			planKey: pool.planKey,
			planName: pool.planName,
			planPriceMicros: pool.planPriceMicros,
			creditFx: pool.creditFx,
			status: pool.status,
			billingMode: pool.billingMode,
			stripeEnvironment: pool.stripeEnvironment,
			stripeCustomerId: pool.stripeCustomerId,
			periodStart: pool.periodStart,
			periodEnd: pool.periodEnd,
			planIncludedCredits: pool.planIncludedCredits,
			includedCreditsOverride: pool.includedCreditsOverride,
			includedCredits: pool.includedCredits,
			includedUsed: pool.includedUsed,
			topUpUsed: pool.topUpUsed,
			paygUsed: pool.paygUsed,
			paygChargeMicros: pool.paygChargeMicros,
			aiCredits: pool.aiCredits,
			codeRunCredits: pool.codeRunCredits,
			serviceCredits: pool.serviceCredits,
			paygEnabled: pool.paygEnabled,
			paygOptedIn: pool.paygOptedIn,
			paygAllowed: pool.paygAllowed,
			paygCapMicros: pool.paygCapMicros,
			topUpRemaining: pool.topUpRemaining,
			heldCredits: pool.heldCredits,
			tediCap: pool.tediCap,
			memberCap: pool.memberCap,
			availableCredits:
				sql<number>`MAX(${pool.includedCredits} - ${pool.includedUsed}, 0)
				+ ${pool.topUpRemaining}
				+ CASE WHEN ${pool.paygEnabled}
					THEN MAX(CAST((${pool.paygCapMicros} - ${pool.paygChargeMicros}) / ${CREDIT_VALUE_EUR_MICROS} AS INTEGER), 0)
					ELSE 0 END
				- ${pool.heldCredits}`.as("available_credits"),
			tediUsed: sql<number>`CASE WHEN ${pool.tediCap} IS NULL THEN 0 ELSE
				${subjectUsed(db, ref, "tedi", tediId)}
				+ ${heldCredits(db, ref, input.now, { kind: "tedi", value: tediId })}
			END`.as("tedi_used"),
			memberUsed: sql<number>`CASE WHEN ${pool.memberCap} IS NULL THEN 0 ELSE
				${subjectUsed(db, ref, "member", userId)}
				+ ${heldCredits(db, ref, input.now, { kind: "member", value: userId })}
			END`.as("member_used"),
		})
		.from(pool);
}

export type CreditCapacityCte = ReturnType<typeof creditCapacityCte>;
export function creditCapacityCte(
	db: DbClient,
	pool: CreditPoolCte,
	input: { now: string; subject?: CreditSubject },
) {
	return db.$with("capacity").as(buildCreditCapacitySelect(db, pool, input));
}

/** Predicate over `capacity` admitting `credits` more credits now. */
export function creditAdmissionPredicate(
	capacity: Pick<
		CreditCapacityCte,
		| "status"
		| "periodStart"
		| "periodEnd"
		| "availableCredits"
		| "tediCap"
		| "tediUsed"
		| "memberCap"
		| "memberUsed"
	>,
	input: { now: string; credits: number | SQL | SQLWrapper },
): SQL {
	return sql`${capacity.status} IN ('trial', 'active')
		AND ${input.now} >= ${capacity.periodStart}
		AND ${input.now} < ${capacity.periodEnd}
		AND ${capacity.availableCredits} >= ${input.credits}
		AND (${capacity.tediCap} IS NULL OR ${capacity.tediUsed} + ${input.credits} <= ${capacity.tediCap})
		AND (${capacity.memberCap} IS NULL OR ${capacity.memberUsed} + ${input.credits} <= ${capacity.memberCap})`;
}

export interface CreditPoolSnapshot {
	organizationId: string;
	planVersionId: string;
	planKey: BillingPlanKey;
	planName: string;
	planPriceMicros: number;
	status: BillingAccountStatus;
	billingMode: BillingAccount["billingMode"];
	stripeEnvironment: "test" | "live" | null;
	stripeCustomerId: string | null;
	periodStart: string;
	periodEnd: string;
	planIncludedCredits: number;
	includedCreditsOverride: number | null;
	includedCredits: number;
	usedCredits: number;
	includedUsedCredits: number;
	remainingIncludedCredits: number;
	topUpUsedCredits: number;
	topUpCredits: number;
	breakdown: { ai: number; codeRuns: number; services: number };
	heldCredits: number;
	availableCredits: number;
	payAsYouGo: {
		allowed: boolean;
		enabled: boolean;
		monthlyCapMicros: number | null;
		spentMicros: number;
		usedCredits: number;
	};
	/** ECB rate pinned on the current plan; null leaves AI use unpriced. */
	creditFx: CreditFxRate | null;
	tediCap: number | null;
	tediUsedCredits: number;
	memberCap: number | null;
	memberUsedCredits: number;
}

type CapacityRow = Awaited<
	ReturnType<typeof buildCreditCapacitySelect>
>[number];

function snapshotFromRow(row: CapacityRow): CreditPoolSnapshot {
	const n = (value: unknown) => Number(value ?? 0);
	const nullable = (value: unknown) =>
		value === null || value === undefined ? null : Number(value);
	const ai = n(row.aiCredits);
	const codeRuns = n(row.codeRunCredits);
	const services = n(row.serviceCredits);
	const includedCredits = n(row.includedCredits);
	const includedUsed = n(row.includedUsed);
	return {
		organizationId: String(row.organizationId),
		planVersionId: String(row.planVersionId),
		planKey: row.planKey,
		planName: String(row.planName),
		planPriceMicros: n(row.planPriceMicros),
		status: row.status,
		billingMode: row.billingMode,
		stripeEnvironment: row.stripeEnvironment ?? null,
		stripeCustomerId: row.stripeCustomerId ?? null,
		periodStart: String(row.periodStart),
		periodEnd: String(row.periodEnd),
		planIncludedCredits: n(row.planIncludedCredits),
		includedCreditsOverride: nullable(row.includedCreditsOverride),
		includedCredits,
		usedCredits: ai + codeRuns + services,
		includedUsedCredits: includedUsed,
		remainingIncludedCredits: Math.max(includedCredits - includedUsed, 0),
		topUpUsedCredits: n(row.topUpUsed),
		topUpCredits: n(row.topUpRemaining),
		breakdown: { ai, codeRuns, services },
		heldCredits: n(row.heldCredits),
		availableCredits: Math.max(n(row.availableCredits), 0),
		payAsYouGo: {
			allowed: Boolean(n(row.paygAllowed)),
			enabled: Boolean(n(row.paygOptedIn)),
			monthlyCapMicros: nullable(row.paygCapMicros),
			spentMicros: n(row.paygChargeMicros),
			usedCredits: n(row.paygUsed),
		},
		creditFx: parseCreditFx(row.creditFx),
		tediCap: nullable(row.tediCap),
		tediUsedCredits: n(row.tediUsed),
		memberCap: nullable(row.memberCap),
		memberUsedCredits: n(row.memberUsed),
	};
}

/** The pool as one organization (and optionally one tedi or member) sees it now. */
export async function getCreditPoolSnapshot(
	db: DbClient,
	input: { organizationId: string; now: string; subject?: CreditSubject },
): Promise<CreditPoolSnapshot | null> {
	const pool = creditPoolCte(db, input);
	const capacity = creditCapacityCte(db, pool, input);
	const [row] = await db.with(pool, capacity).select().from(capacity).limit(1);
	return row ? snapshotFromRow(row as CapacityRow) : null;
}

/** Why `credits` more credits cannot be admitted now, or null when they can. */
export function creditRefusalReason(
	snapshot: CreditPoolSnapshot | null,
	input: { now: string; credits: number },
): CreditRefusalCode | null {
	if (!snapshot) return "billing_not_configured";
	if (snapshot.status !== "trial" && snapshot.status !== "active")
		return "subscription_inactive";
	if (input.now < snapshot.periodStart || input.now >= snapshot.periodEnd)
		return "billing_period_inactive";
	if (snapshot.availableCredits < input.credits)
		return "monthly_credit_limit_reached";
	if (
		snapshot.tediCap !== null &&
		snapshot.tediUsedCredits + input.credits > snapshot.tediCap
	)
		return "tedi_monthly_credit_cap_reached";
	if (
		snapshot.memberCap !== null &&
		snapshot.memberUsedCredits + input.credits > snapshot.memberCap
	)
		return "member_monthly_credit_cap_reached";
	return null;
}

export interface CreditConsumptionInput {
	/** Fresh per attempt; a duplicate source inserts nothing and later statements no-op. */
	id: string;
	organizationId: string;
	kind: BillingCreditKind;
	sourceRef: string;
	tediId?: string | null;
	userId?: string | null;
	periodStart: string;
	periodEnd: string;
	/** A literal credit count, or a scalar subquery reading it from this batch's row. */
	credits: number | SQLWrapper;
	now: string;
	stripeEnvironment?: "test" | "live";
	/** When set, the insert is refused unless the pool admits the credits now. */
	admit?: boolean;
}

export const CREDIT_METER_EVENT = "tedix_credits";

/**
 * The D1 batch statements that record one consumption and apply it: insert
 * the split row, draw top-ups soonest-expiring first, add to the period
 * totals for the organization, tedi and member, raise the 80%/100% notices,
 * and queue pay-as-you-go credits for the Stripe meter. Statements after the
 * insert read the new row by id, so a duplicate source changes nothing.
 */
export function buildCreditConsumptionStatements(
	db: DbClient,
	input: CreditConsumptionInput,
) {
	const subject = { tediId: input.tediId, userId: input.userId };
	const amount = sql<number>`(${input.credits})`;
	const pool = creditPoolCte(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	const capacity = creditCapacityCte(db, pool, { now: input.now, subject });
	const periodIncludedUsed = db
		.select({ used: billingCreditUsageTotals.includedCredits })
		.from(billingCreditUsageTotals)
		.where(
			and(
				eq(billingCreditUsageTotals.organizationId, input.organizationId),
				eq(billingCreditUsageTotals.periodStart, input.periodStart),
				eq(billingCreditUsageTotals.subjectKind, "organization"),
				eq(billingCreditUsageTotals.subjectKey, "organization"),
			),
		);
	const split = db.$with("split").as(
		db
			.select({
				organizationId: capacity.organizationId,
				status: capacity.status,
				periodStart: capacity.periodStart,
				periodEnd: capacity.periodEnd,
				availableCredits: capacity.availableCredits,
				tediCap: capacity.tediCap,
				tediUsed: capacity.tediUsed,
				memberCap: capacity.memberCap,
				memberUsed: capacity.memberUsed,
				paygEnabled: capacity.paygEnabled,
				topUpRemaining: capacity.topUpRemaining,
				amount: sql<number>`${amount}`.as("amount"),
				includedPart:
					sql<number>`MIN(${amount}, MAX(${capacity.includedCredits} - COALESCE((${periodIncludedUsed}), 0), 0))`.as(
						"included_part",
					),
			})
			.from(capacity),
	);
	const topUpPart = sql<number>`MIN(${split.amount} - ${split.includedPart}, ${split.topUpRemaining})`;
	const paygPart = sql<number>`${split.amount} - ${split.includedPart} - ${topUpPart}`;
	const insert = db
		.with(pool, capacity, split)
		.insert(billingCreditConsumptions)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: split.organizationId,
					tediId: sql<string | null>`${input.tediId ?? null}`.as("tedi_id"),
					userId: sql<string | null>`${input.userId ?? null}`.as("user_id"),
					kind: sql<BillingCreditKind>`${input.kind}`.as("kind"),
					sourceRef: sql<string>`${input.sourceRef}`.as("source_ref"),
					periodStart: sql<string>`${input.periodStart}`.as(
						"consumption_period_start",
					),
					periodEnd: sql<string>`${input.periodEnd}`.as(
						"consumption_period_end",
					),
					credits: split.amount,
					includedCredits: split.includedPart,
					topUpCredits: sql<number>`${topUpPart}`.as("top_up_credits"),
					paygCredits: sql<number>`${paygPart}`.as("payg_credits"),
					paygChargeMicros:
						sql<number>`CASE WHEN ${split.paygEnabled} THEN (${paygPart}) * ${CREDIT_VALUE_EUR_MICROS} ELSE 0 END`.as(
							"payg_charge_micros",
						),
					createdAt: sql<string>`${input.now}`.as("created_at"),
				})
				.from(split)
				.where(
					and(
						sql`${split.amount} >= 0`,
						input.admit
							? creditAdmissionPredicate(split, {
									now: input.now,
									credits: split.amount,
								})
							: undefined,
					),
				),
		)
		.onConflictDoNothing({
			target: [
				billingCreditConsumptions.kind,
				billingCreditConsumptions.sourceRef,
			],
		});

	const need = db
		.select({ credits: billingCreditConsumptions.topUpCredits })
		.from(billingCreditConsumptions)
		.where(eq(billingCreditConsumptions.id, input.id));
	const ordered = db.$with("ordered").as(
		db
			.select({
				topUpId: sql<string>`${billingCreditTopUps.id}`.as("top_up_id"),
				remaining:
					sql<number>`${billingCreditTopUps.credits} - ${billingCreditTopUps.consumedCredits}`.as(
						"remaining",
					),
				before:
					sql<number>`COALESCE(SUM(${billingCreditTopUps.credits} - ${billingCreditTopUps.consumedCredits}) OVER (
					ORDER BY ${billingCreditTopUps.expiresAt}, ${billingCreditTopUps.id}
					ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
				), 0)`.as("before_credits"),
			})
			.from(billingCreditTopUps)
			.where(
				and(
					eq(billingCreditTopUps.organizationId, input.organizationId),
					sql`${billingCreditTopUps.consumedCredits} < ${billingCreditTopUps.credits}`,
					liveAtSql("billing_credit_top_ups.expires_at", input.now),
				),
			),
	);
	const drawTopUps = db
		.with(ordered)
		.update(billingCreditTopUps)
		.set({
			consumedCredits: sql`${billingCreditTopUps.consumedCredits} + MIN(${ordered.remaining}, (${need}) - ${ordered.before})`,
			updatedAt: input.now,
		})
		.from(ordered)
		.where(
			and(
				sql`${billingCreditTopUps.id} = ${ordered.topUpId}`,
				sql`${ordered.before} < COALESCE((${need}), 0)`,
			),
		);

	const consumption = billingCreditConsumptions;
	const addTotals = (
		subjectKind: "organization" | "tedi" | "member",
		key: SQL,
		filter?: SQL,
	) =>
		db
			.insert(billingCreditUsageTotals)
			.select(
				db
					.select({
						organizationId: consumption.organizationId,
						periodStart: consumption.periodStart,
						periodEnd: consumption.periodEnd,
						subjectKind: sql<typeof subjectKind>`${subjectKind}`.as(
							"subject_kind",
						),
						subjectKey: sql<string>`${key}`.as("subject_key"),
						aiCredits:
							sql<number>`CASE ${consumption.kind} WHEN 'ai' THEN ${consumption.credits} ELSE 0 END`.as(
								"ai_credits",
							),
						codeRunCredits:
							sql<number>`CASE ${consumption.kind} WHEN 'code_run' THEN ${consumption.credits} ELSE 0 END`.as(
								"code_run_credits",
							),
						serviceCredits:
							sql<number>`CASE ${consumption.kind} WHEN 'service' THEN ${consumption.credits} ELSE 0 END`.as(
								"service_credits",
							),
						includedCredits: consumption.includedCredits,
						topUpCredits: consumption.topUpCredits,
						paygCredits: consumption.paygCredits,
						paygChargeMicros: consumption.paygChargeMicros,
						updatedAt: sql<string>`${input.now}`.as("updated_at"),
					})
					.from(consumption)
					.where(and(eq(consumption.id, input.id), filter)),
			)
			.onConflictDoUpdate({
				target: [
					billingCreditUsageTotals.organizationId,
					billingCreditUsageTotals.periodStart,
					billingCreditUsageTotals.subjectKind,
					billingCreditUsageTotals.subjectKey,
				],
				set: {
					aiCredits: sql`${billingCreditUsageTotals.aiCredits} + excluded.ai_credits`,
					codeRunCredits: sql`${billingCreditUsageTotals.codeRunCredits} + excluded.code_run_credits`,
					serviceCredits: sql`${billingCreditUsageTotals.serviceCredits} + excluded.service_credits`,
					includedCredits: sql`${billingCreditUsageTotals.includedCredits} + excluded.included_credits`,
					topUpCredits: sql`${billingCreditUsageTotals.topUpCredits} + excluded.top_up_credits`,
					paygCredits: sql`${billingCreditUsageTotals.paygCredits} + excluded.payg_credits`,
					paygChargeMicros: sql`${billingCreditUsageTotals.paygChargeMicros} + excluded.payg_charge_micros`,
					updatedAt: sql`excluded.updated_at`,
				},
			});

	const total = alias(billingCreditUsageTotals, "notice_total");
	const noticeAccount = alias(billingAccounts, "notice_account");
	const noticePlan = alias(billingPlanVersions, "notice_plan");
	const raiseNotice = (threshold: CreditNoticeThreshold) =>
		db
			.insert(billingCreditNotices)
			.select(
				db
					.select({
						organizationId: total.organizationId,
						periodStart: total.periodStart,
						threshold: sql<number>`${threshold}`.as("threshold"),
						reachedAt: sql<string>`${input.now}`.as("reached_at"),
					})
					.from(total)
					.innerJoin(
						noticeAccount,
						eq(noticeAccount.organizationId, total.organizationId),
					)
					.innerJoin(noticePlan, eq(noticePlan.id, noticeAccount.planVersionId))
					.where(
						and(
							eq(total.organizationId, input.organizationId),
							eq(total.periodStart, input.periodStart),
							eq(total.subjectKind, "organization"),
							eq(total.subjectKey, "organization"),
							exists(
								db
									.select({ one: sql`1` })
									.from(billingCreditConsumptions)
									.where(eq(billingCreditConsumptions.id, input.id)),
							),
							sql`(${total.aiCredits} + ${total.codeRunCredits} + ${total.serviceCredits}) * 100
								>= ${threshold} * COALESCE(${noticeAccount.includedCreditsOverride}, ${noticePlan.includedMonthlyCredits})`,
						),
					),
			)
			.onConflictDoNothing();

	const meterAccount = alias(billingAccounts, "meter_account");
	const meter = db
		.insert(billingCreditMeterOutbox)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					organizationId: consumption.organizationId,
					consumptionId: sql<string>`${consumption.id}`.as("consumption_id"),
					stripeCustomerId: sql<string>`${meterAccount.stripeCustomerId}`.as(
						"stripe_customer_id",
					),
					stripeEnvironment: sql<
						"test" | "live"
					>`${input.stripeEnvironment ?? "live"}`.as("stripe_environment"),
					eventName: sql<string>`${CREDIT_METER_EVENT}`.as("event_name"),
					quantity: sql<number>`${consumption.paygCredits}`.as("quantity"),
					idempotencyKey: sql<string>`'credit-meter:' || ${consumption.id}`.as(
						"idempotency_key",
					),
					status: sql<"pending">`'pending'`.as("status"),
					attemptCount: sql<number>`0`.as("attempt_count"),
					nextAttemptAt: sql<string>`${input.now}`.as("next_attempt_at"),
					leaseExpiresAt: sql<null>`NULL`.as("lease_expires_at"),
					stripeEventId: sql<null>`NULL`.as("stripe_event_id"),
					lastError: sql<null>`NULL`.as("last_error"),
					sentAt: sql<null>`NULL`.as("sent_at"),
					createdAt: sql<string>`${input.now}`.as("meter_created_at"),
					updatedAt: sql<string>`${input.now}`.as("meter_updated_at"),
				})
				.from(consumption)
				.innerJoin(
					meterAccount,
					eq(meterAccount.organizationId, consumption.organizationId),
				)
				.where(
					and(
						eq(consumption.id, input.id),
						gt(consumption.paygChargeMicros, 0),
						eq(meterAccount.billingMode, "stripe"),
						sql`${meterAccount.stripeCustomerId} IS NOT NULL`,
						eq(
							meterAccount.stripeEnvironment,
							input.stripeEnvironment ?? "live",
						),
					),
				),
		)
		.onConflictDoNothing();

	return [
		insert,
		drawTopUps,
		addTotals("organization", sql`'organization'`),
		addTotals(
			"tedi",
			sql`${consumption.tediId}`,
			sql`${consumption.tediId} IS NOT NULL`,
		),
		addTotals(
			"member",
			sql`${consumption.userId}`,
			sql`${consumption.userId} IS NOT NULL`,
		),
		raiseNotice(CREDIT_NOTICE_THRESHOLDS[0]),
		raiseNotice(CREDIT_NOTICE_THRESHOLDS[1]),
		meter,
	] as const;
}

/** Has this consumption id been recorded? One read after the batch. */
export async function creditConsumptionRecorded(
	db: DbClient,
	id: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: billingCreditConsumptions.id })
		.from(billingCreditConsumptions)
		.where(eq(billingCreditConsumptions.id, id))
		.limit(1);
	return rows.length > 0;
}

export interface CodeRunAdmissionInput {
	organizationId: string;
	/** Stable per execution; a retried execution is charged once. */
	executionId: string;
	tediId?: string | null;
	userId?: string | null;
	credits: number;
	now: string;
	stripeEnvironment?: "test" | "live";
}

export type CodeRunAdmissionDecision =
	| { allowed: true; replayed: boolean; credits: number }
	| { allowed: false; code: CreditRefusalCode };

/**
 * Admit and charge one code run in a single D1 batch: the consumption row is
 * inserted only while the pool, tedi cap and member cap all have room.
 */
export async function admitCodeRun(
	db: DbClient,
	input: CodeRunAdmissionInput,
): Promise<CodeRunAdmissionDecision> {
	const [existing] = await db
		.select({ credits: billingCreditConsumptions.credits })
		.from(billingCreditConsumptions)
		.where(
			and(
				eq(billingCreditConsumptions.kind, "code_run"),
				eq(billingCreditConsumptions.sourceRef, input.executionId),
				eq(billingCreditConsumptions.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (existing)
		return { allowed: true, replayed: true, credits: existing.credits };
	const subject = { tediId: input.tediId, userId: input.userId };
	const snapshot = await getCreditPoolSnapshot(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	if (!snapshot) return { allowed: false, code: "billing_not_configured" };
	const id = crypto.randomUUID();
	await db.batch(
		buildCreditConsumptionStatements(db, {
			id,
			organizationId: input.organizationId,
			kind: "code_run",
			sourceRef: input.executionId,
			tediId: input.tediId,
			userId: input.userId,
			periodStart: snapshot.periodStart,
			periodEnd: snapshot.periodEnd,
			credits: input.credits,
			now: input.now,
			stripeEnvironment: input.stripeEnvironment,
			admit: true,
		}),
	);
	if (await creditConsumptionRecorded(db, id))
		return { allowed: true, replayed: false, credits: input.credits };
	const refreshed = await getCreditPoolSnapshot(db, {
		organizationId: input.organizationId,
		now: input.now,
		subject,
	});
	return {
		allowed: false,
		code:
			creditRefusalReason(refreshed, {
				now: input.now,
				credits: input.credits,
			}) ?? "monthly_credit_limit_reached",
	};
}

export interface CreditNoticeRow {
	threshold: CreditNoticeThreshold;
	reachedAt: string;
}

export async function listCreditNotices(
	db: DbClient,
	input: { organizationId: string; periodStart: string },
): Promise<CreditNoticeRow[]> {
	const rows = await db
		.select({
			threshold: billingCreditNotices.threshold,
			reachedAt: billingCreditNotices.reachedAt,
		})
		.from(billingCreditNotices)
		.where(
			and(
				eq(billingCreditNotices.organizationId, input.organizationId),
				eq(billingCreditNotices.periodStart, input.periodStart),
			),
		)
		.orderBy(asc(billingCreditNotices.threshold));
	return rows.map((row) => ({
		threshold: row.threshold as CreditNoticeThreshold,
		reachedAt: row.reachedAt,
	}));
}

export interface CreditSubjectUsageRow {
	subjectKey: string;
	usedCredits: number;
	monthlyCapCredits: number | null;
}

/** Per-tedi or per-member use this period together with any caps. */
export async function listCreditSubjectUsage(
	db: DbClient,
	input: {
		organizationId: string;
		periodStart: string;
		subjectKind: "tedi" | "member";
	},
): Promise<CreditSubjectUsageRow[]> {
	const [totals, caps] = await db.batch([
		db
			.select({
				subjectKey: billingCreditUsageTotals.subjectKey,
				used: sql<number>`${billingCreditUsageTotals.aiCredits} + ${billingCreditUsageTotals.codeRunCredits} + ${billingCreditUsageTotals.serviceCredits}`,
			})
			.from(billingCreditUsageTotals)
			.where(
				and(
					eq(billingCreditUsageTotals.organizationId, input.organizationId),
					eq(billingCreditUsageTotals.periodStart, input.periodStart),
					eq(billingCreditUsageTotals.subjectKind, input.subjectKind),
				),
			),
		db
			.select({
				subjectKey: billingCreditCaps.subjectKey,
				cap: billingCreditCaps.monthlyCapCredits,
			})
			.from(billingCreditCaps)
			.where(
				and(
					eq(billingCreditCaps.organizationId, input.organizationId),
					eq(billingCreditCaps.subjectKind, input.subjectKind),
				),
			),
	]);
	const rows = new Map<string, CreditSubjectUsageRow>();
	for (const total of totals)
		rows.set(total.subjectKey, {
			subjectKey: total.subjectKey,
			usedCredits: Number(total.used),
			monthlyCapCredits: null,
		});
	for (const cap of caps) {
		const row = rows.get(cap.subjectKey) ?? {
			subjectKey: cap.subjectKey,
			usedCredits: 0,
			monthlyCapCredits: null,
		};
		row.monthlyCapCredits = cap.cap;
		rows.set(cap.subjectKey, row);
	}
	return [...rows.values()];
}

export interface SetCreditCapsInput {
	organizationId: string;
	caps: Array<{
		subjectKind: "tedi" | "member";
		subjectKey: string;
		monthlyCapCredits: number | null;
	}>;
	updatedBy: string;
	now: string;
}

/**
 * Set or clear tedi and member caps in one batch. A cap only narrows what a
 * tedi or member may draw from the pool; it never adds credits.
 */
export async function setCreditCaps(
	db: DbClient,
	input: SetCreditCapsInput,
): Promise<void> {
	const statements = input.caps.map((cap) => {
		if (cap.monthlyCapCredits === null)
			return db
				.delete(billingCreditCaps)
				.where(
					and(
						eq(billingCreditCaps.organizationId, input.organizationId),
						eq(billingCreditCaps.subjectKind, cap.subjectKind),
						eq(billingCreditCaps.subjectKey, cap.subjectKey),
					),
				);
		if (
			!Number.isSafeInteger(cap.monthlyCapCredits) ||
			cap.monthlyCapCredits < 0
		)
			throw new Error("Monthly credit caps must be non-negative integers");
		return db
			.insert(billingCreditCaps)
			.values({
				organizationId: input.organizationId,
				subjectKind: cap.subjectKind,
				subjectKey: cap.subjectKey,
				monthlyCapCredits: cap.monthlyCapCredits,
				updatedBy: input.updatedBy,
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [
					billingCreditCaps.organizationId,
					billingCreditCaps.subjectKind,
					billingCreditCaps.subjectKey,
				],
				set: {
					monthlyCapCredits: cap.monthlyCapCredits,
					updatedBy: input.updatedBy,
					updatedAt: input.now,
				},
			});
	});
	const [first, ...rest] = statements;
	if (first) await db.batch([first, ...rest]);
}

/** Admin pay-as-you-go opt-in at EUR 0.01 per credit up to a monthly EUR cap. */
export async function setPayAsYouGo(
	db: DbClient,
	input: {
		organizationId: string;
		enabled: boolean;
		monthlyCapMicros: number | null;
		now: string;
	},
): Promise<boolean> {
	if (input.enabled && input.monthlyCapMicros === null)
		throw new Error("Pay-as-you-go requires a monthly cap");
	const rows = await db
		.update(billingAccounts)
		.set({
			overageEnabled: input.enabled,
			hardSpendLimitMicros: input.enabled ? input.monthlyCapMicros : null,
			updatedAt: input.now,
		})
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.returning({ organizationId: billingAccounts.organizationId });
	return rows.length > 0;
}

export interface SetAccountCreditsInput {
	organizationId: string;
	includedCreditsOverride: number | null;
	reason: string;
	actor: { id: string; type: string };
	now: string;
}

/**
 * Operator-only included-credit override. Bumps the entitlement version and
 * writes an audit row in the same batch; the audit insert selects from the
 * updated account, so it records only a change that happened.
 */
export async function setAccountCredits(
	db: DbClient,
	input: SetAccountCreditsInput,
): Promise<{ entitlementVersion: number; previous: number | null } | null> {
	if (
		input.includedCreditsOverride !== null &&
		(!Number.isSafeInteger(input.includedCreditsOverride) ||
			input.includedCreditsOverride < 0)
	)
		throw new Error("Included credits must be a non-negative integer");
	const [current] = await db
		.select({
			previous: billingAccounts.includedCreditsOverride,
			version: billingAccounts.entitlementVersion,
		})
		.from(billingAccounts)
		.where(eq(billingAccounts.organizationId, input.organizationId))
		.limit(1);
	if (!current) return null;
	const nextVersion = current.version + 1;
	const auditId = `billing-credits:${input.organizationId}:${nextVersion}`;
	const metadata = JSON.stringify({
		previousIncludedCreditsOverride: current.previous,
		includedCreditsOverride: input.includedCreditsOverride,
		reason: input.reason,
		actor: input.actor,
		entitlementVersion: nextVersion,
	});
	await db.batch([
		db
			.update(billingAccounts)
			.set({
				includedCreditsOverride: input.includedCreditsOverride,
				entitlementVersion: nextVersion,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(billingAccounts.organizationId, input.organizationId),
					eq(billingAccounts.entitlementVersion, current.version),
				),
			),
		db
			.insert(auditEvents)
			.select(
				db
					.select({
						id: sql<string>`${auditId}`.as("id"),
						organizationId: billingAccounts.organizationId,
						actorId: sql<string>`${input.actor.id}`.as("actor_id"),
						actorType: sql<string>`${input.actor.type}`.as("actor_type"),
						action: sql<string>`'billing.included_credits_set'`.as("action"),
						resourceType: sql<string>`'billing_account'`.as("resource_type"),
						resourceId: sql<string>`${billingAccounts.organizationId}`.as(
							"resource_id",
						),
						metadata: sql<string>`${metadata}`.as("metadata"),
						ipAddress: sql<null>`NULL`.as("ip_address"),
						userAgent: sql<null>`NULL`.as("user_agent"),
						timestamp:
							sql<number>`${Math.floor(Date.parse(input.now) / 1000)}`.as(
								"timestamp",
							),
					})
					.from(billingAccounts)
					.where(
						and(
							eq(billingAccounts.organizationId, input.organizationId),
							eq(billingAccounts.entitlementVersion, nextVersion),
						),
					),
			)
			.onConflictDoNothing(),
	]);
	const [saved] = await db
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(eq(auditEvents.id, auditId))
		.limit(1);
	if (!saved)
		throw new Error(
			"Billing entitlement changed concurrently; re-read and retry",
		);
	return { entitlementVersion: nextVersion, previous: current.previous };
}

const topUpPackColumns = {
	id: billingTopUpPackVersions.id,
	packKey: billingTopUpPackVersions.packKey,
	version: billingTopUpPackVersions.version,
	name: billingTopUpPackVersions.name,
	currency: billingTopUpPackVersions.currency,
	priceMicros: billingTopUpPackVersions.priceMicros,
	credits: billingTopUpPackVersions.credits,
	validMonths: billingTopUpPackVersions.validMonths,
	stripeLookupKey: billingTopUpPackVersions.stripeLookupKey,
};

export interface TopUpPackRow {
	id: string;
	packKey: string;
	version: number;
	name: string;
	currency: string;
	priceMicros: number;
	credits: number;
	validMonths: number;
	stripeLookupKey: string;
}

/** Active one-time top-up packs for one Stripe environment, smallest first. */
export async function listActiveTopUpPacks(
	db: DbClient,
	input: { stripeEnvironment: "test" | "live"; now: string },
): Promise<TopUpPackRow[]> {
	const newer = alias(billingTopUpPackVersions, "newer");
	return db
		.select(topUpPackColumns)
		.from(billingTopUpPackVersions)
		.where(
			and(
				eq(billingTopUpPackVersions.stripeEnvironment, input.stripeEnvironment),
				eq(billingTopUpPackVersions.status, "active"),
				lte(billingTopUpPackVersions.effectiveAt, input.now),
				notExists(
					db
						.select({ one: sql`1` })
						.from(newer)
						.where(
							and(
								eq(newer.packKey, billingTopUpPackVersions.packKey),
								eq(
									newer.stripeEnvironment,
									billingTopUpPackVersions.stripeEnvironment,
								),
								eq(newer.status, "active"),
								lte(newer.effectiveAt, input.now),
								gt(newer.version, billingTopUpPackVersions.version),
							),
						),
				),
			),
		)
		.orderBy(asc(billingTopUpPackVersions.credits));
}

export async function getTopUpPackVersion(
	db: DbClient,
	input: { id: string; stripeEnvironment: "test" | "live" },
): Promise<TopUpPackRow | null> {
	const [row] = await db
		.select(topUpPackColumns)
		.from(billingTopUpPackVersions)
		.where(
			and(
				eq(billingTopUpPackVersions.id, input.id),
				eq(billingTopUpPackVersions.stripeEnvironment, input.stripeEnvironment),
			),
		)
		.limit(1);
	return row ?? null;
}

export interface GrantTopUpCreditsInput {
	id: string;
	organizationId: string;
	credits: number;
	sourceType: "stripe_checkout" | "operator_grant";
	sourceRef?: string | null;
	packVersionId?: string | null;
	idempotencyKey: string;
	expiresAt: string;
	metadata?: Record<string, string | number | boolean | null>;
	now: string;
}

/** Idempotently add top-up credits; returns the surviving row. */
export async function grantTopUpCredits(
	db: DbClient,
	input: GrantTopUpCreditsInput,
): Promise<{ id: string; credits: number; expiresAt: string }> {
	if (!Number.isSafeInteger(input.credits) || input.credits <= 0)
		throw new Error("Top-up credits must be a positive integer");
	await db
		.insert(billingCreditTopUps)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: billingAccounts.organizationId,
					credits: sql<number>`${input.credits}`.as("credits"),
					consumedCredits: sql<number>`0`.as("consumed_credits"),
					sourceType: sql<
						GrantTopUpCreditsInput["sourceType"]
					>`${input.sourceType}`.as("source_type"),
					sourceRef: sql<string | null>`${input.sourceRef ?? null}`.as(
						"source_ref",
					),
					packVersionId: sql<string | null>`${input.packVersionId ?? null}`.as(
						"pack_version_id",
					),
					idempotencyKey: sql<string>`${input.idempotencyKey}`.as(
						"idempotency_key",
					),
					expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					metadata: sql<string>`${JSON.stringify(input.metadata ?? {})}`.as(
						"metadata",
					),
					createdAt: sql<string>`${input.now}`.as("created_at"),
					updatedAt: sql<string>`${input.now}`.as("updated_at"),
				})
				.from(billingAccounts)
				.where(eq(billingAccounts.organizationId, input.organizationId)),
		)
		.onConflictDoNothing({ target: billingCreditTopUps.idempotencyKey });
	const [row] = await db
		.select({
			id: billingCreditTopUps.id,
			organizationId: billingCreditTopUps.organizationId,
			credits: billingCreditTopUps.credits,
			expiresAt: billingCreditTopUps.expiresAt,
		})
		.from(billingCreditTopUps)
		.where(eq(billingCreditTopUps.idempotencyKey, input.idempotencyKey))
		.limit(1);
	if (!row || row.organizationId !== input.organizationId)
		throw new Error(
			"Top-up grant failed or its key belongs to another organization",
		);
	return { id: row.id, credits: row.credits, expiresAt: row.expiresAt };
}

/**
 * A refunded top-up stops being spendable in proportion to the refund. The
 * unused part is forfeited by raising `consumed_credits`; repeated or partial
 * refund events only ever move it up, so replays are harmless.
 */
export async function forfeitRefundedTopUp(
	db: DbClient,
	input: {
		paymentIntentId: string;
		amount: number;
		amountRefunded: number;
		now: string;
	},
): Promise<boolean> {
	if (
		!Number.isSafeInteger(input.amount) ||
		input.amount <= 0 ||
		!Number.isSafeInteger(input.amountRefunded) ||
		input.amountRefunded < 0
	)
		throw new Error("Refund amounts must be non-negative integers");
	const refunded = Math.min(input.amountRefunded, input.amount);
	const rows = await db
		.update(billingCreditTopUps)
		.set({
			consumedCredits: sql`MIN(${billingCreditTopUps.credits}, MAX(${billingCreditTopUps.consumedCredits},
				CAST((${billingCreditTopUps.credits} * ${refunded} + ${input.amount} - 1) / ${input.amount} AS INTEGER)))`,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(billingCreditTopUps.sourceType, "stripe_checkout"),
				sql`json_extract(${billingCreditTopUps.metadata}, '$.paymentIntentId') = ${input.paymentIntentId}`,
			),
		)
		.returning({ id: billingCreditTopUps.id });
	return rows.length > 0;
}

/** Parse a plan's pinned FX rate; null when it is missing or malformed. */
export function parseCreditFx(value: unknown): CreditFxRate | null {
	const raw =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (!raw || typeof raw !== "object") return null;
	const fx = raw as Partial<CreditFxRate>;
	return typeof fx.microUsdPerEur === "number" &&
		Number.isSafeInteger(fx.microUsdPerEur) &&
		fx.microUsdPerEur > 0 &&
		typeof fx.source === "string" &&
		typeof fx.asOf === "string"
		? (fx as CreditFxRate)
		: null;
}
