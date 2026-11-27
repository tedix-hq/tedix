import { and, eq, sql } from "drizzle-orm";
import { coreStore, jsonRead } from "../core-store/dialect";
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
	if (coreStore(db) === "postgres") {
		const today = sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD')`;
		const day = jsonRead(db, organizations.metadata, [
			"deckRankerBudget",
			"day",
		]);
		const reserved = jsonRead(
			db,
			organizations.metadata,
			["deckRankerBudget", "reservedMicros"],
			"number",
		);
		const used = sql`case when ${day} = ${today}
 then case when ${reserved} = trunc(${reserved}) and ${reserved} >= 0
 then ${reserved} else NULL end else 0 end`;
		// SQLite min() returns NULL for a corrupt counter; Postgres least() would ignore it.
		const slots = sql`case when (${used}) is null then NULL else least(${input.maxCards}::bigint, trunc((${input.dailyLimitMicros}::bigint - (${used})) / ${input.amountMicros}::bigint)::bigint) end`;
		const [row] = await db
			.update(organizations)
			.set({
				metadata: sql`jsonb_set(coalesce(${organizations.metadata}, '{}'::jsonb), '{deckRankerBudget}',
 jsonb_build_object('day', ${today}, 'reservedMicros', (${used}) + (${slots}) * ${input.amountMicros}::bigint, 'lastReservedCards', ${slots}), true)`,
			})
			.where(and(eq(organizations.id, input.organizationId), sql`${slots} > 0`))
			.returning({
				slots:
					sql<number>`${jsonRead(db, organizations.metadata, ["deckRankerBudget", "lastReservedCards"], "number")}`.mapWith(
						Number,
					),
			});
		return row?.slots ?? 0;
	}
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
