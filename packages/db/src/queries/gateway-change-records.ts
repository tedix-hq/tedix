import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { gatewayChangeRecords } from "../schema/gateway-change-records";

function toRecord(row: typeof gatewayChangeRecords.$inferSelect) {
	return {
		...row.record,
		id: row.id,
		sequence: row.sequence,
		recordedAt: row.recordedAt,
	};
}

/**
 * Append one record. A record whose `id` this organization already stored is
 * returned as stored and nothing is written; the lookup runs only then.
 */
export async function appendGatewayChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	input: GatewayChangeRecordInput,
) {
	const { id = crypto.randomUUID(), recordedAt, ...record } = input;
	const [row] = await db
		.insert(gatewayChangeRecords)
		.values({
			id,
			organizationId,
			resource: record.resource,
			actorId: record.actor.id,
			recordedAt: recordedAt ?? new Date().toISOString(),
			record,
		})
		.onConflictDoNothing({ target: gatewayChangeRecords.id })
		.returning();
	if (row) return toRecord(row);
	const stored = await getGatewayChangeRecord(db, organizationId, id);
	if (!stored) throw new Error("Gateway change record was not stored");
	return stored;
}

export async function listGatewayChangeRecords(
	db: DbQueryClient,
	organizationId: string,
	query: {
		resource?: string;
		actorId?: string;
		afterSequence?: number;
		limit?: number;
	},
) {
	const rows = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				query.resource === undefined
					? undefined
					: eq(gatewayChangeRecords.resource, query.resource),
				query.actorId === undefined
					? undefined
					: eq(gatewayChangeRecords.actorId, query.actorId),
				query.afterSequence === undefined
					? undefined
					: gt(gatewayChangeRecords.sequence, query.afterSequence),
			),
		)
		.orderBy(asc(gatewayChangeRecords.sequence))
		.limit(query.limit ?? 1000);
	return rows.map(toRecord);
}

export async function getGatewayChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	const [row] = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				eq(gatewayChangeRecords.id, id),
			),
		)
		.limit(1);
	return row ? toRecord(row) : null;
}

export interface GatewayChangeRecordRangeParams {
	/** Inclusive start, as `Date.prototype.toISOString()` writes it. */
	from: string;
	/** Exclusive end, in the same form. */
	until: string;
	resource?: string;
	actorId?: string;
}

/**
 * `recorded_at` in the millisecond form the range bounds use, so a stored
 * timestamp without fractional seconds compares by time, not by text.
 */
const recordedAtMillis = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${gatewayChangeRecords.recordedAt})`;

function inRange(
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
) {
	return and(
		eq(gatewayChangeRecords.organizationId, organizationId),
		sql`${recordedAtMillis} >= ${range.from}`,
		sql`${recordedAtMillis} < ${range.until}`,
		range.resource === undefined
			? undefined
			: eq(gatewayChangeRecords.resource, range.resource),
		range.actorId === undefined
			? undefined
			: eq(gatewayChangeRecords.actorId, range.actorId),
	);
}

/** One page of an organization's records in a time range, oldest first. */
export async function listGatewayChangeRecordsInRange(
	db: DbQueryClient,
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
	page: { afterSequence?: number; limit: number },
) {
	const rows = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				inRange(organizationId, range),
				page.afterSequence === undefined
					? undefined
					: gt(gatewayChangeRecords.sequence, page.afterSequence),
			),
		)
		.orderBy(asc(gatewayChangeRecords.sequence))
		.limit(page.limit);
	return rows.map(toRecord);
}

/** Every record of an organization in a time range, whatever the page. */
export async function countGatewayChangeRecordsInRange(
	db: DbQueryClient,
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(gatewayChangeRecords)
		.where(inRange(organizationId, range));
	return row?.total ?? 0;
}
