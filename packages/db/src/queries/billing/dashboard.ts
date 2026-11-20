import { and, desc, eq, gte, gt, lt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	billingCreditConsumptions,
	billingCreditTopUps,
} from "../../schema/billing";

export async function listDailyCreditUsage(
	db: DbQueryClient,
	input: {
		organizationId: string;
		from: string;
		to: string;
		periodStart?: string;
	},
) {
	const consumption = billingCreditConsumptions;
	const day = sql<string>`substr(${consumption.createdAt}, 1, 10)`;
	return db
		.select({
			day: day.as("usage_day"),
			kind: consumption.kind,
			credits: sql<number>`sum(${consumption.credits})`.as("credits_used"),
		})
		.from(consumption)
		.where(
			and(
				eq(consumption.organizationId, input.organizationId),
				input.periodStart
					? eq(consumption.periodStart, input.periodStart)
					: and(
							gt(consumption.periodEnd, input.from),
							lt(consumption.periodStart, input.to),
						),
				gte(consumption.createdAt, input.from),
				lt(consumption.createdAt, input.to),
			),
		)
		.groupBy(day, consumption.kind)
		.orderBy(day);
}

export async function listPurchasedCreditPacks(
	db: DbQueryClient,
	organizationId: string,
) {
	const pack = billingCreditTopUps;
	return db
		.select({
			id: pack.id,
			credits: pack.credits,
			purchasedAt: pack.createdAt,
			expiresAt: pack.expiresAt,
		})
		.from(pack)
		.where(
			and(
				eq(pack.organizationId, organizationId),
				eq(pack.sourceType, "stripe_checkout"),
			),
		)
		.orderBy(desc(pack.createdAt), desc(pack.id));
}
