import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	lte,
	min,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	gatewayChangeRecordCheckpoints,
	gatewayChangeRecords,
} from "../schema/gateway-change-records";

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

/** A record with its seal fields; both are null until the sealer reaches it. */
function toSealedRecord(row: typeof gatewayChangeRecords.$inferSelect) {
	return {
		...toRecord(row),
		recordDigest: row.recordDigest,
		chainHash: row.chainHash,
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
	/** Only records whose `subject.id` is this Work Item id. */
	subjectId?: string;
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
		range.subjectId === undefined
			? undefined
			: sql`json_extract(${gatewayChangeRecords.record}, '$.subject.id') = ${range.subjectId}`,
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
	return rows.map(toSealedRecord);
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

/** DELETE statements in one retention batch, at most. */
const PRUNE_CHECKPOINTS_PER_BATCH = 50;

export interface PruneGatewayChangeRecordsParams {
	/** Delete records whose checkpoint was sealed before this ISO timestamp. */
	before: string;
	/** Sealed rows looked at per round, lowest sequence first. */
	batchSize: number;
	/** Rounds per run, at most. */
	maxBatches: number;
}

/**
 * Delete old records one whole checkpoint at a time, so what remains can
 * still be verified offline: the earliest kept record is always the first
 * record of a checkpoint, whose signed `previous_chain_hash` is the chain
 * hash of the deleted record before it. Checkpoints themselves are kept.
 *
 * A checkpoint is old enough when it was sealed before `before` and its
 * evidence bundle (a verified copy of the checkpoint and its records in R2)
 * has been written; without a bundle its records stay. The sealer
 * seals only records recorded before its settling cut-off, so every record
 * of such a checkpoint is older than `before` too. Records that are not
 * sealed, and so not covered by a checkpoint, are never deleted.
 *
 * Each round reads the lowest-sequence sealed rows, finds the old-enough
 * checkpoints covering them and deletes those checkpoints' rows in one
 * batch, which D1 applies as a whole. A run stops at the first round that
 * deletes nothing: when the oldest sealed rows belong to a checkpoint that is
 * not old enough yet, deletion waits for it. Returns the rows deleted.
 */
export async function pruneGatewayChangeRecords(
	db: DbQueryClient,
	params: PruneGatewayChangeRecordsParams,
): Promise<number> {
	let removed = 0;
	for (let round = 0; round < params.maxBatches; round += 1) {
		const sample = await db
			.select({
				organizationId: gatewayChangeRecords.organizationId,
				sequence: gatewayChangeRecords.sequence,
			})
			.from(gatewayChangeRecords)
			.where(sql`${gatewayChangeRecords.chainHash} is not null`)
			.orderBy(asc(gatewayChangeRecords.sequence))
			.limit(params.batchSize);
		const spans = new Map<string, { low: number; high: number }>();
		for (const row of sample) {
			const span = spans.get(row.organizationId);
			spans.set(row.organizationId, {
				low: Math.min(span?.low ?? row.sequence, row.sequence),
				high: Math.max(span?.high ?? row.sequence, row.sequence),
			});
		}
		const checkpoints = (
			await Promise.all(
				[...spans].map(([organizationId, span]) =>
					db
						.select({
							organizationId: gatewayChangeRecordCheckpoints.organizationId,
							firstSequence: gatewayChangeRecordCheckpoints.firstSequence,
							lastSequence: gatewayChangeRecordCheckpoints.lastSequence,
						})
						.from(gatewayChangeRecordCheckpoints)
						.where(
							and(
								eq(
									gatewayChangeRecordCheckpoints.organizationId,
									organizationId,
								),
								gte(gatewayChangeRecordCheckpoints.lastSequence, span.low),
								lte(gatewayChangeRecordCheckpoints.firstSequence, span.high),
								lt(gatewayChangeRecordCheckpoints.sealedAt, params.before),
								// Only once a verified copy of the run is in long-term storage.
								isNotNull(gatewayChangeRecordCheckpoints.evidenceBundleKey),
							),
						),
				),
			)
		)
			.flat()
			.slice(0, PRUNE_CHECKPOINTS_PER_BATCH);
		const [first, ...rest] = checkpoints.map((checkpoint) =>
			db
				.delete(gatewayChangeRecords)
				.where(
					and(
						eq(gatewayChangeRecords.organizationId, checkpoint.organizationId),
						gte(gatewayChangeRecords.sequence, checkpoint.firstSequence),
						lte(gatewayChangeRecords.sequence, checkpoint.lastSequence),
						sql`${gatewayChangeRecords.chainHash} is not null`,
					),
				)
				// Counted from the returned rows: a batch reports no change count.
				.returning({ sequence: gatewayChangeRecords.sequence }),
		);
		if (!first) break;
		const results = await db.batch([first, ...rest]);
		const deleted = results.reduce((sum, rows) => sum + rows.length, 0);
		removed += deleted;
		if (deleted === 0) break;
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

/** Organizations with records waiting to be sealed, oldest waiting first. */
export async function listOrganizationsWithUnsealedGatewayChangeRecords(
	db: DbQueryClient,
	limit: number,
): Promise<string[]> {
	const rows = await db
		.select({
			organizationId: gatewayChangeRecords.organizationId,
			firstUnsealed: min(gatewayChangeRecords.sequence),
		})
		.from(gatewayChangeRecords)
		.where(isNull(gatewayChangeRecords.chainHash))
		.groupBy(gatewayChangeRecords.organizationId)
		.orderBy(asc(min(gatewayChangeRecords.sequence)))
		.limit(limit);
	return rows.map((row) => row.organizationId);
}

export type GatewayChangeRecordCheckpointRow =
	typeof gatewayChangeRecordCheckpoints.$inferSelect;

/** The organization's newest checkpoint: where its chain continues. */
export async function getLatestGatewayChangeRecordCheckpoint(
	db: DbQueryClient,
	organizationId: string,
): Promise<GatewayChangeRecordCheckpointRow | null> {
	const [row] = await db
		.select()
		.from(gatewayChangeRecordCheckpoints)
		.where(eq(gatewayChangeRecordCheckpoints.organizationId, organizationId))
		.orderBy(desc(gatewayChangeRecordCheckpoints.lastSequence))
		.limit(1);
	return row ?? null;
}

/**
 * The organization's next records to seal, in sequence order, as a reader
 * gets them back (without seal fields).
 */
export async function listUnsealedGatewayChangeRecords(
	db: DbQueryClient,
	organizationId: string,
	page: { afterSequence: number; limit: number },
) {
	const rows = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				isNull(gatewayChangeRecords.chainHash),
				gt(gatewayChangeRecords.sequence, page.afterSequence),
			),
		)
		.orderBy(asc(gatewayChangeRecords.sequence))
		.limit(page.limit);
	return rows.map(toRecord);
}

export interface SealGatewayChangeRecordsParams {
	organizationId: string;
	/**
	 * Sequence of the last sealed record the run continues from (the latest
	 * checkpoint's `lastSequence`), or 0 for the organization's first run.
	 */
	afterSequence: number;
	seals: ReadonlyArray<{
		sequence: number;
		recordDigest: string;
		chainHash: string;
	}>;
	checkpoint: Omit<
		typeof gatewayChangeRecordCheckpoints.$inferInsert,
		"organizationId"
	>;
}

/**
 * Write one sealed run and its checkpoint in one D1 batch, which lands
 * whole or not at all.
 *
 * - Each UPDATE fills a row only while it is unsealed and no row of the
 *   organization after the run's previous record is sealed: the chain must
 *   end exactly where this run continues it (the last-sealed-sequence guard).
 * - The checkpoint INSERT comes last. Unless every row of the range is now
 *   sealed and the last one holds the head chain hash, it evaluates
 *   `json()` on invalid JSON, which raises an error and aborts the batch: a
 *   skipped UPDATE undoes the whole run.
 * - A second run that started from the same checkpoint collides on the
 *   unique (organization_id, first_sequence) index and also aborts.
 *
 * Returns false when the batch was refused because another run got there
 * first, true when this run's rows and checkpoint were written.
 */
export async function sealGatewayChangeRecords(
	db: DbQueryClient,
	params: SealGatewayChangeRecordsParams,
): Promise<boolean> {
	const { organizationId, checkpoint } = params;
	let previousSequence = params.afterSequence;
	const updates = params.seals.map((seal) => {
		const guardSequence = previousSequence;
		previousSequence = seal.sequence;
		return db
			.update(gatewayChangeRecords)
			.set({ recordDigest: seal.recordDigest, chainHash: seal.chainHash })
			.where(
				and(
					eq(gatewayChangeRecords.sequence, seal.sequence),
					eq(gatewayChangeRecords.organizationId, organizationId),
					isNull(gatewayChangeRecords.chainHash),
					sql`not exists (
						select 1 from gateway_change_records as later
						 where later.organization_id = ${organizationId}
						   and later.sequence > ${guardSequence}
						   and later.chain_hash is not null
					)`,
				),
			);
	});
	// The head is written only if the run landed; otherwise `json()` on
	// invalid JSON raises an error inside the statement and aborts the batch.
	const head = sql`case when (
			select count(*) from gateway_change_records as covered
			 where covered.organization_id = ${organizationId}
			   and covered.sequence between ${checkpoint.firstSequence} and ${checkpoint.lastSequence}
			   and covered.chain_hash is not null
		) = ${checkpoint.recordCount}
		and (
			select tail.chain_hash from gateway_change_records as tail
			 where tail.sequence = ${checkpoint.lastSequence}
			   and tail.organization_id = ${organizationId}
		) = ${checkpoint.headChainHash}
		then ${checkpoint.headChainHash}
		else json('gateway_change_record_seal_refused') end`;
	const insert = db
		.insert(gatewayChangeRecordCheckpoints)
		.values({ ...checkpoint, organizationId, headChainHash: head });
	const [first, ...rest] = updates;
	if (!first) throw new Error("A sealed run needs at least one record");
	try {
		await db.batch([first, ...rest, insert]);
	} catch (error) {
		if (
			/malformed JSON|UNIQUE constraint failed: gateway_change_record_checkpoints/i.test(
				errorText(error),
			)
		)
			return false;
		throw error;
	}
	return true;
}

/** The message and causes of an error, which D1 and Drizzle may wrap. */
function errorText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current && depth < 5; depth += 1) {
		parts.push(String((current as Error).message ?? current));
		current = (current as Error).cause;
	}
	return parts.join("\n");
}

/** How far sealing lags, for the sealer's log line. */
export async function getUnsealedGatewayChangeRecordStats(
	db: DbQueryClient,
): Promise<{ rows: number; oldestRecordedAt: string | null }> {
	const [row] = await db
		.select({
			rows: count(),
			oldestRecordedAt: min(gatewayChangeRecords.recordedAt),
		})
		.from(gatewayChangeRecords)
		.where(isNull(gatewayChangeRecords.chainHash));
	return {
		rows: row?.rows ?? 0,
		oldestRecordedAt: row?.oldestRecordedAt ?? null,
	};
}

export interface GatewayChangeRecordCheckpointQuery {
	/** Checkpoints whose range ends at or after this sequence. */
	fromSequence?: number;
	/** Checkpoints whose range starts at or before this sequence. */
	untilSequence?: number;
	/** Checkpoints sealed at or after this ISO timestamp. */
	sealedFrom?: string;
	/** Checkpoints sealed before this ISO timestamp. */
	sealedUntil?: string;
	/** Page cursor: checkpoints ending after this sequence. */
	afterLastSequence?: number;
	limit: number;
}

/** One page of an organization's checkpoints, in chain order. */
export async function listGatewayChangeRecordCheckpoints(
	db: DbQueryClient,
	organizationId: string,
	query: GatewayChangeRecordCheckpointQuery,
): Promise<GatewayChangeRecordCheckpointRow[]> {
	const t = gatewayChangeRecordCheckpoints;
	return db
		.select()
		.from(t)
		.where(
			and(
				eq(t.organizationId, organizationId),
				query.fromSequence === undefined
					? undefined
					: gte(t.lastSequence, query.fromSequence),
				query.untilSequence === undefined
					? undefined
					: lte(t.firstSequence, query.untilSequence),
				query.sealedFrom === undefined
					? undefined
					: gte(t.sealedAt, query.sealedFrom),
				query.sealedUntil === undefined
					? undefined
					: lt(t.sealedAt, query.sealedUntil),
				query.afterLastSequence === undefined
					? undefined
					: gt(t.lastSequence, query.afterLastSequence),
			),
		)
		.orderBy(asc(t.lastSequence))
		.limit(query.limit);
}

/** Checkpoints whose evidence bundle is not written yet, oldest sealed first. */
export async function listGatewayChangeRecordCheckpointsWithoutBundle(
	db: DbQueryClient,
	limit: number,
): Promise<GatewayChangeRecordCheckpointRow[]> {
	const t = gatewayChangeRecordCheckpoints;
	return db
		.select()
		.from(t)
		.where(isNull(t.evidenceBundleKey))
		.orderBy(asc(t.sealedAt))
		.limit(limit);
}

/**
 * Every stored record of one checkpoint's range, with seal fields, in
 * sequence order. At most `recordCount` rows exist in a range.
 */
export async function listGatewayChangeRecordsForCheckpoint(
	db: DbQueryClient,
	checkpoint: Pick<
		GatewayChangeRecordCheckpointRow,
		"organizationId" | "firstSequence" | "lastSequence" | "recordCount"
	>,
) {
	const rows = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, checkpoint.organizationId),
				gte(gatewayChangeRecords.sequence, checkpoint.firstSequence),
				lte(gatewayChangeRecords.sequence, checkpoint.lastSequence),
			),
		)
		.orderBy(asc(gatewayChangeRecords.sequence))
		.limit(checkpoint.recordCount + 1);
	return rows.map(toSealedRecord);
}

/** Record that a checkpoint's verified evidence bundle is stored at `key`. */
export async function setGatewayChangeRecordCheckpointBundle(
	db: DbQueryClient,
	id: string,
	key: string,
): Promise<void> {
	await db
		.update(gatewayChangeRecordCheckpoints)
		.set({ evidenceBundleKey: key })
		.where(
			and(
				eq(gatewayChangeRecordCheckpoints.id, id),
				isNull(gatewayChangeRecordCheckpoints.evidenceBundleKey),
			),
		);
}

/**
 * Organizations with a checkpoint in main, fewest checkpoints first: the
 * order the organization log cutover takes them in. Reads only the
 * checkpoint index.
 */
export async function listOrganizationsWithGatewayChangeRecordCheckpoints(
	db: DbQueryClient,
): Promise<Array<{ organizationId: string; checkpoints: number }>> {
	const t = gatewayChangeRecordCheckpoints;
	return db
		.select({ organizationId: t.organizationId, checkpoints: count() })
		.from(t)
		.groupBy(t.organizationId)
		.orderBy(asc(count()), asc(t.organizationId));
}

/** The organization's records not sealed yet (partial unsealed index). */
export async function countUnsealedGatewayChangeRecords(
	db: DbQueryClient,
	organizationId: string,
): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				isNull(gatewayChangeRecords.chainHash),
			),
		);
	return row?.total ?? 0;
}
