import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

/** Atomic organization-wide UTC-day reservations; failed inference keeps its reservation. */
export async function reserveDeckRankingBudget(
	db: DbQueryClient,
	input: {
		organizationId: string;
		amountMicros: number;
		dailyLimitMicros: number;
	},
) {
	if (
		!Number.isSafeInteger(input.amountMicros) ||
		input.amountMicros <= 0 ||
		!Number.isSafeInteger(input.dailyLimitMicros) ||
		input.dailyLimitMicros < input.amountMicros
	)
		return false;
	const today = sql`strftime('%Y-%m-%d', 'now')`;
	const day = sql`json_extract(${organizations.metadata}, '$.deckRankerBudget.day')`;
	const used = sql`case when ${day} = ${today}
 then case when json_type(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') in ('integer', 'real')
 and json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') = cast(json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') as integer)
 and json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') >= 0
 then json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') else NULL end else 0 end`;
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.deckRankerBudget',
 json_object('day', ${today}, 'reservedMicros', ${used} + ${input.amountMicros}))`,
		})
		.where(
			and(
				eq(organizations.id, input.organizationId),
				sql`${used} + ${input.amountMicros} <= ${input.dailyLimitMicros}`,
			),
		)
		.returning({ id: organizations.id });
	return Boolean(row);
}
