import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

function budgetExpressions() {
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
	const { today, day, used } = budgetExpressions();
	const slots = sql`min(${input.maxSlots}, ${input.dailyLimit} - (${used}))`;
	const capLogged = sql`coalesce(json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.capLogged'), 0)`;
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.organizationDailyBudgets.backgroundMemoryChanges',
 json_object('day', ${today}, 'reserved', (${used}) + (${slots}), 'lastReservedSlots', (${slots}), 'capLogged', case when ${day} = ${today} then ${capLogged} else 0 end))`,
		})
		.where(and(eq(organizations.id, input.organizationId), sql`${slots} > 0`))
		.returning({
			slots: sql<number>`json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.lastReservedSlots')`,
			reservedAfter: sql<number>`json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.reserved')`,
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
	const { today, day, used } = budgetExpressions();
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.organizationDailyBudgets.backgroundMemoryChanges.capLogged', 1)`,
		})
		.where(
			and(
				eq(organizations.id, input.organizationId),
				sql`${day} = ${today}`,
				sql`(${used}) >= ${input.dailyLimit}`,
				sql`coalesce(json_extract(${organizations.metadata}, '$.organizationDailyBudgets.backgroundMemoryChanges.capLogged'), 0) != 1`,
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
	const { day, used } = budgetExpressions();
	const [row] = await db
		.select({
			day: sql<string | null>`${day}`,
			used: sql<number | null>`${used}`,
		})
		.from(organizations)
		.where(eq(organizations.id, input.organizationId));
	if (!row) return 0;
	const today = new Date().toISOString().slice(0, 10);
	if (row.day !== today) return input.dailyLimit;
	if (row.used === null || row.used === undefined) return 0;
	return Math.max(0, input.dailyLimit - row.used);
}
