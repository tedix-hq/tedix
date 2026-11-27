import { and, eq, sql, type SQL } from "drizzle-orm";
import {
	coreStore,
	jsonRead,
	jsonWrite,
	pgTextArray,
} from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

const BUDGET_PATH = ["organizationDailyBudgets", "backgroundMemoryChanges"];

function budgetExpressions(db: DbQueryClient) {
	if (coreStore(db) === "postgres") {
		const today = sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD')`;
		const day = jsonRead(db, organizations.metadata, [...BUDGET_PATH, "day"]);
		const reserved = jsonRead(
			db,
			organizations.metadata,
			[...BUDGET_PATH, "reserved"],
			"number",
		);
		const used = sql`case when ${day} = ${today}
 then case when ${reserved} = trunc(${reserved})
 and ${reserved} >= 0
 then (${reserved})::bigint else NULL end else 0 end`;
		return { today, day, used };
	}
	const today = sql`strftime('%Y-%m-%d', 'now')`;
	const day = sql`json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.day')`;
	const reserved = sql`json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.reserved')`;
	const reservedType = sql`json_type(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.reserved')`;
	const used = sql`case when ${day} = ${today}
 then case when ${reservedType} in ('integer', 'real')
 and ${reserved} = cast(${reserved} as integer)
 and ${reserved} >= 0
 then cast(${reserved} as integer) else NULL end else 0 end`;
	return { today, day, used };
}

/** Postgres json_set: creates missing parent objects like SQLite does. */
function pgJsonSet(
	column: SQL | typeof organizations.metadata,
	path: string[],
	value: SQL,
): SQL {
	let document = sql`coalesce(${column}, '{}'::jsonb)`;
	for (let length = 1; length < path.length; length++) {
		const prefix = pgTextArray(path.slice(0, length));
		document = sql`jsonb_set(${document}, ${prefix}::text[], coalesce(${column} #> ${prefix}::text[], '{}'::jsonb), true)`;
	}
	return sql`jsonb_set(${document}, ${pgTextArray(path)}::text[], ${value}, true)`;
}

export interface ReserveBackgroundMemoryChangeSlotsParams {
	organizationId: string;
	maxSlots: number;
	dailyLimit: number;
}

export interface BackgroundMemoryChangeSlotsReservation {
	reserved: number;
	capReached: boolean;
	/** True only for the call that first observed the UTC day at its limit. */
	logCap: boolean;
}

function validateReservation(
	input: ReserveBackgroundMemoryChangeSlotsParams,
): boolean {
	return (
		Number.isSafeInteger(input.maxSlots) &&
		input.maxSlots > 0 &&
		Number.isSafeInteger(input.dailyLimit) &&
		input.dailyLimit > 0
	);
}

/**
 * Atomically reserve up to maxSlots of background memory changes for one
 * organization on the current UTC day. Storage lives in organizations.metadata
 * so no schema migration is required. A corrupt counter fails closed
 * (reserves nothing) without emitting a cap line.
 */
export async function reserveBackgroundMemoryChangeSlots(
	db: DbQueryClient,
	input: ReserveBackgroundMemoryChangeSlotsParams,
): Promise<BackgroundMemoryChangeSlotsReservation> {
	if (!validateReservation(input)) {
		return { reserved: 0, capReached: true, logCap: false };
	}
	const { today, day, used } = budgetExpressions(db);
	const postgres = coreStore(db) === "postgres";
	// SQLite min() returns NULL for a corrupt counter; Postgres least() would ignore it.
	const slots = postgres
		? sql`case when (${used}) is null then NULL else least(${input.maxSlots}::bigint, ${input.dailyLimit}::bigint - (${used})) end`
		: sql`min(${input.maxSlots}, ${input.dailyLimit} - (${used}))`;
	const capLoggedPath = [...BUDGET_PATH, "capLogged"];
	const capLogged = postgres
		? sql`coalesce(${jsonRead(db, organizations.metadata, capLoggedPath, "number")}, 0)`
		: sql`coalesce(json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.capLogged'), 0)`;
	const [row] = await db
		.update(organizations)
		.set({
			metadata: postgres
				? pgJsonSet(
						organizations.metadata,
						BUDGET_PATH,
						sql`jsonb_build_object('day', ${today}, 'reserved', (${used}) + (${slots}), 'lastReservedSlots', (${slots}), 'capLogged', case when ${day} = ${today} then ${capLogged} else 0 end)`,
					)
				: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.organizationDailyBudgets.backgroundMemoryChanges',
 json_object('day', ${today}, 'reserved', (${used}) + (${slots}), 'lastReservedSlots', (${slots}), 'capLogged', case when ${day} = ${today} then ${capLogged} else 0 end))`,
		})
		.where(and(eq(organizations.id, input.organizationId), sql`${slots} > 0`))
		.returning({
			slots:
				sql<number>`${jsonRead(db, organizations.metadata, [...BUDGET_PATH, "lastReservedSlots"], "number")}`.mapWith(
					Number,
				),
			reservedAfter:
				sql<number>`${jsonRead(db, organizations.metadata, [...BUDGET_PATH, "reserved"], "number")}`.mapWith(
					Number,
				),
		});
	const reserved = row?.slots ?? 0;
	if (reserved > 0) {
		if ((row?.reservedAfter ?? 0) < input.dailyLimit) {
			return { reserved, capReached: false, logCap: false };
		}
		const cap = await markBackgroundMemoryCapLogged(db, input);
		return { reserved, capReached: true, logCap: cap.logCap };
	}
	return markBackgroundMemoryCapLogged(db, input);
}

async function markBackgroundMemoryCapLogged(
	db: DbQueryClient,
	input: ReserveBackgroundMemoryChangeSlotsParams,
): Promise<BackgroundMemoryChangeSlotsReservation> {
	const { today, day, used } = budgetExpressions(db);
	const capLoggedPath = [...BUDGET_PATH, "capLogged"];
	const [row] = await db
		.update(organizations)
		.set({
			metadata:
				coreStore(db) === "postgres"
					? jsonWrite(db, organizations.metadata, capLoggedPath, 1)
					: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.organizationDailyBudgets.backgroundMemoryChanges.capLogged', 1)`,
		})
		.where(
			and(
				eq(organizations.id, input.organizationId),
				sql`${day} = ${today}`,
				sql`(${used}) >= ${input.dailyLimit}`,
				sql`coalesce(${jsonRead(db, organizations.metadata, capLoggedPath, "number")}, 0) != 1`,
			),
		)
		.returning({ id: organizations.id });
	return { reserved: 0, capReached: true, logCap: row !== undefined };
}

export interface BackgroundMemoryChangeSlotsRemainingParams {
	organizationId: string;
	dailyLimit: number;
}

/** Remaining slots for the current UTC day; missing/corrupt counters fail closed. */
export async function getBackgroundMemoryChangeSlotsRemaining(
	db: DbQueryClient,
	input: BackgroundMemoryChangeSlotsRemainingParams,
): Promise<number> {
	if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit <= 0) {
		return 0;
	}
	const { day, used } = budgetExpressions(db);
	const [row] = await db
		.select({
			day: sql<string | null>`${day}`,
			used: sql<number | null>`${used}`.mapWith(Number),
		})
		.from(organizations)
		.where(eq(organizations.id, input.organizationId));
	if (!row) return 0;
	const today = new Date().toISOString().slice(0, 10);
	if (row.day !== today) return input.dailyLimit;
	if (row.used === null || row.used === undefined) return 0;
	return Math.max(0, input.dailyLimit - row.used);
}
