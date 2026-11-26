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
	return (await reserveDeckRankingSlots(db, { ...input, maxCards: 1 })) === 1;
}

/** Reserve up to maxCards in one write, including a partial remaining daily allowance. */
export async function reserveDeckRankingSlots(
	db: DbQueryClient,
	input: {
		organizationId: string;
		amountMicros: number;
		dailyLimitMicros: number;
		maxCards: number;
	},
) {
	if (
		!Number.isSafeInteger(input.amountMicros) ||
		input.amountMicros <= 0 ||
		!Number.isSafeInteger(input.dailyLimitMicros) ||
		input.dailyLimitMicros < input.amountMicros ||
		!Number.isSafeInteger(input.maxCards) ||
		input.maxCards <= 0
	)
		return 0;
	const today = sql`strftime('%Y-%m-%d', 'now')`;
	const day = sql`json_extract(${organizations.metadata}, '$.deckRankerBudget.day')`;
	const used = sql`case when ${day} = ${today}
 then case when json_type(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') in ('integer', 'real')
 and json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') = cast(json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') as integer)
 and json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') >= 0
 then json_extract(${organizations.metadata}, '$.deckRankerBudget.reservedMicros') else NULL end else 0 end`;
	const slots = sql`min(${input.maxCards}, cast((${input.dailyLimitMicros} - ${used}) / ${input.amountMicros} as integer))`;
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.deckRankerBudget',
 json_object('day', ${today}, 'reservedMicros', ${used} + ${slots} * ${input.amountMicros}, 'lastReservedCards', ${slots}))`,
		})
		.where(and(eq(organizations.id, input.organizationId), sql`${slots} > 0`))
		.returning({
			// Return this write's receipt, not an allowance recomputed after the debit.
			slots: sql<number>`json_extract(${organizations.metadata}, '$.deckRankerBudget.lastReservedCards')`,
		});
	return row?.slots ?? 0;
}
