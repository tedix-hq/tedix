import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import { and, asc, count, eq, gt, gte, lt, min, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { gatewayChangeRecords } from "../schema/gateway-change-records";
import { getAffectedRows } from "../utils/d1-result";

/**
 * Gateway change records are kept for 90 days, then deleted by the daily
 * retention job (`pruneGatewayChangeRecords`). One platform-wide window; there
 * is no per-organization setting yet.
 */
export const GATEWAY_CHANGE_RECORD_RETENTION_DAYS = 90;

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
 * Plain text comparisons on `recorded_at`, so the organization/recorded-at
 * index is used. Correct because the column and both bounds are always in
 * `Date.prototype.toISOString()` form (the API normalizes them).
 */
function inRange(
	organizationId: string,
	range: GatewayChangeRecordRangeParams,
) {
	return and(
		eq(gatewayChangeRecords.organizationId, organizationId),
		gte(gatewayChangeRecords.recordedAt, range.from),
		lt(gatewayChangeRecords.recordedAt, range.until),
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

export interface PruneGatewayChangeRecordsParams {
	/** Delete records with `recorded_at` before this ISO timestamp. */
	before: string;
	/** Rows per DELETE statement. */
	batchSize: number;
	/** DELETE statements per run, at most. */
	maxBatches: number;
}

/**
 * Delete records older than `before`, oldest first, in bounded statements so
 * no single write holds the database for long. Stops at the first short
 * batch. Safe to repeat, and costs one index probe when nothing is old enough.
 * Returns the number of rows deleted.
 */
export async function pruneGatewayChangeRecords(
	db: DbQueryClient,
	params: PruneGatewayChangeRecordsParams,
): Promise<number> {
	let removed = 0;
	for (let batch = 0; batch < params.maxBatches; batch += 1) {
		// D1 has no `DELETE ... LIMIT`; the sub-select walks the recorded-at
		// index and binds two values whatever the batch size.
		const result = await db.delete(gatewayChangeRecords).where(
			sql`${gatewayChangeRecords.sequence} in (
				select ${gatewayChangeRecords.sequence}
				  from ${gatewayChangeRecords}
				 where ${gatewayChangeRecords.recordedAt} < ${params.before}
				 order by ${gatewayChangeRecords.recordedAt}
				 limit ${params.batchSize}
			)`,
		);
		const deleted = getAffectedRows(result);
		removed += deleted;
		if (deleted < params.batchSize) break;
	}
	return removed;
}

/** Table size for the retention log: every organization's rows. */
export async function getGatewayChangeRecordStats(
	db: DbQueryClient,
): Promise<{ rows: number; oldestRecordedAt: string | null }> {
	const [row] = await db
		.select({
			rows: count(),
			oldestRecordedAt: min(gatewayChangeRecords.recordedAt),
		})
		.from(gatewayChangeRecords);
	return {
		rows: row?.rows ?? 0,
		oldestRecordedAt: row?.oldestRecordedAt ?? null,
	};
}
