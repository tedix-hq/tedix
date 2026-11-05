import { and, desc, eq, sql } from "drizzle-orm";
import type { PgQueryClient } from "../query-client";
import { billingUsageReservations } from "../schema/billing";

export async function listBillingUsageReservations(
	db: PgQueryClient,
	params: {
		organizationId: string;
		status?: string;
		monetaryCurrency?: string;
		limit?: number;
	},
) {
	return db
		.select()
		.from(billingUsageReservations)
		.where(
			and(
				eq(billingUsageReservations.organizationId, params.organizationId),
				params.status
					? eq(billingUsageReservations.status, params.status)
					: undefined,
				params.monetaryCurrency
					? sql`${billingUsageReservations.metadata} #>> '{monetaryQuote,rateSnapshot,customerCurrency}' = ${params.monetaryCurrency}`
					: undefined,
			),
		)
		.orderBy(desc(billingUsageReservations.createdAt))
		.limit(params.limit ?? 100);
}
