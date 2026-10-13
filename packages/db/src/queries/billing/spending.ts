import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";

/** Settled monetary receipts only; neither provider estimates nor Output allocation. */
export async function listMonetaryInferenceSpending(
	db: DbClient,
	input: { organizationId: string; from: string; to: string; limit: number },
) {
	const rows = await db
		.select({
			id: billingUsageCharges.id,
			runId: billingUsageReservations.runId,
			traceId: billingUsageReservations.traceId,
			provider: billingUsageCharges.provider,
			model: billingUsageCharges.model,
			occurredAt: billingUsageCharges.occurredAt,
			creditAppliedMicros: billingUsageCharges.creditAppliedMicros,
			customerChargeMicros: billingUsageCharges.customerChargeMicros,
			currency: sql<"eur">`'eur'`,
			creditValueMicros: sql<
				number | null
			>`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.rateSnapshot.creditValueMicros')`,
			rateVersionId: billingUsageCharges.rateCardVersion,
		})
		.from(billingUsageCharges)
		.leftJoin(
			billingUsageReservations,
			and(
				eq(billingUsageCharges.reservationId, billingUsageReservations.id),
				eq(
					billingUsageCharges.organizationId,
					billingUsageReservations.organizationId,
				),
			),
		)
		.where(
			and(
				eq(billingUsageCharges.organizationId, input.organizationId),
				gte(billingUsageCharges.occurredAt, input.from),
				lt(billingUsageCharges.occurredAt, input.to),
				sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.schemaVersion') = 1`,
				sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.rateSnapshot.customerCurrency') = 'EUR'`,
			),
		)
		.orderBy(desc(billingUsageCharges.occurredAt), desc(billingUsageCharges.id))
		.limit(input.limit + 1);
	return {
		rows: rows.slice(0, input.limit),
		hasMore: rows.length > input.limit,
	};
}
