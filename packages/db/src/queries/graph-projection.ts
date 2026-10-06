/**
 * Durable graph-projection outbox, consumer lease, and canonical backfill
 * queries. D1 is authoritative; these helpers never read Neo4j.
 */

import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	max,
	min,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { getAffectedRows } from "../utils/d1-result";
import {
	type GraphProjectionEntityKind,
	type GraphProjectionOutboxEvent,
	type GraphProjectionReadinessState,
	type GraphProjectionRepairPhase,
	graphProjectionConsumers,
	graphProjectionOutbox,
	graphProjectionReadiness,
} from "../schema/graph-projection";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../schema/memory-graph";
import { organizations } from "../schema/organizations";

export const GRAPH_PROJECTION_BATCH_SIZE = 100;
export const GRAPH_PROJECTION_MAX_BATCH_SIZE = 500;
export const GRAPH_PROJECTION_MAX_ATTEMPTS = 8;
export const GRAPH_PROJECTION_LEASE_MS = 15 * 60 * 1000;
/**
 * Ceiling on how many organizations one discovery tick probes. Rotation is
 * oldest-serviced-first, so a platform larger than this never starves anyone --
 * it just takes more than one tick to sweep the whole fleet.
 */
export const GRAPH_PROJECTION_MAX_DISCOVERY_PROBES = 500;
const GRAPH_PROJECTION_DISCOVERY_PROBE_CHUNK = 100;
type GraphProjectionProbe = Parameters<DbClient["batch"]>[0][number];

export const GRAPH_PROJECTION_RETENTION_DAYS = 7;
export const GRAPH_PROJECTION_PRUNE_BATCH_SIZE = 1_000;

function boundedLimit(limit: number): number {
	if (!Number.isFinite(limit)) return GRAPH_PROJECTION_BATCH_SIZE;
	return Math.max(
		1,
		Math.min(GRAPH_PROJECTION_MAX_BATCH_SIZE, Math.trunc(limit)),
	);
}

export type GraphProjectionBackfillPage<T> = {
	rows: T[];
	nextCursor: string | null;
	done: boolean;
};

export type GraphProjectionReadState = {
	state: GraphProjectionReadinessState;
	reason: string | null;
	persistedWatermark: number;
	gdsWatermark: number;
	projectionEpoch: string | null;
	gdsEpoch: string | null;
	nodeMismatchCount: number | null;
	edgeMismatchCount: number | null;
	lifecycleMismatchCount: number | null;
	repairId: string | null;
	repairPhase: GraphProjectionRepairPhase | null;
	repairCursor: string | null;
	repairHighWater: number | null;
	repairStartedAt: string | null;
	lastCertifiedAt: string | null;
};

export type GraphProjectionBacklogStats = {
	cursor: number;
	highWaterSequence: number;
	pendingCount: number;
	retryCount: number;
	poisonedCount: number;
	oldestPendingAt: string | null;
};

export async function getGraphProjectionReadState(
	db: DbClient,
	organizationId: string,
): Promise<GraphProjectionReadState | null> {
	const [row] = await db
		.select({
			state: graphProjectionReadiness.state,
			reason: graphProjectionReadiness.reason,
			persistedWatermark: graphProjectionReadiness.persistedWatermark,
			gdsWatermark: graphProjectionReadiness.gdsWatermark,
			projectionEpoch: graphProjectionReadiness.projectionEpoch,
			gdsEpoch: graphProjectionReadiness.gdsEpoch,
			nodeMismatchCount: graphProjectionReadiness.nodeMismatchCount,
			edgeMismatchCount: graphProjectionReadiness.edgeMismatchCount,
			lifecycleMismatchCount: graphProjectionReadiness.lifecycleMismatchCount,
			repairId: graphProjectionReadiness.repairId,
			repairPhase: graphProjectionReadiness.repairPhase,
			repairCursor: graphProjectionReadiness.repairCursor,
			repairHighWater: graphProjectionReadiness.repairHighWater,
			repairStartedAt: graphProjectionReadiness.repairStartedAt,
			lastCertifiedAt: graphProjectionReadiness.lastCertifiedAt,
		})
		.from(graphProjectionReadiness)
		.where(eq(graphProjectionReadiness.organizationId, organizationId))
		.limit(1);
	return row ?? null;
}

/**
 * Update projection admission state without rotating the active projection
 * generation unless the caller explicitly supplies a new `projectionEpoch`.
 */
export async function setGraphProjectionReadiness(
	db: DbClient,
	input: {
		organizationId: string;
		state: GraphProjectionReadinessState;
		reason?: string | null;
		projectionEpoch?: string | null;
		persistedWatermark?: number;
		gdsWatermark?: number;
		gdsEpoch?: string | null;
		nodeMismatchCount?: number | null;
		edgeMismatchCount?: number | null;
		lifecycleMismatchCount?: number | null;
		repairId?: string | null;
		repairPhase?: GraphProjectionRepairPhase | null;
		repairCursor?: string | null;
		repairHighWater?: number | null;
		repairStartedAt?: string | null;
		certified?: boolean;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(graphProjectionReadiness)
		.values({
			organizationId: input.organizationId,
			state: input.state,
			reason: input.reason ?? null,
			projectionEpoch: input.projectionEpoch,
			persistedWatermark: input.persistedWatermark ?? 0,
			gdsWatermark: input.gdsWatermark ?? 0,
			gdsEpoch: input.gdsEpoch,
			nodeMismatchCount: input.nodeMismatchCount,
			edgeMismatchCount: input.edgeMismatchCount,
			lifecycleMismatchCount: input.lifecycleMismatchCount,
			repairId: input.repairId,
			repairPhase: input.repairPhase,
			repairCursor: input.repairCursor,
			repairHighWater: input.repairHighWater,
			repairStartedAt: input.repairStartedAt,
			lastCertifiedAt: input.certified ? now : undefined,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: graphProjectionReadiness.organizationId,
			set: {
				state: input.state,
				reason: input.reason ?? null,
				...(input.projectionEpoch !== undefined
					? { projectionEpoch: input.projectionEpoch }
					: {}),
				...(input.persistedWatermark !== undefined
					? { persistedWatermark: input.persistedWatermark }
					: {}),
				...(input.gdsWatermark !== undefined
					? { gdsWatermark: input.gdsWatermark }
					: {}),
				...(input.gdsEpoch !== undefined ? { gdsEpoch: input.gdsEpoch } : {}),
				...(input.nodeMismatchCount !== undefined
					? { nodeMismatchCount: input.nodeMismatchCount }
					: {}),
				...(input.edgeMismatchCount !== undefined
					? { edgeMismatchCount: input.edgeMismatchCount }
					: {}),
				...(input.lifecycleMismatchCount !== undefined
					? { lifecycleMismatchCount: input.lifecycleMismatchCount }
					: {}),
				...(input.repairId !== undefined ? { repairId: input.repairId } : {}),
				...(input.repairPhase !== undefined
					? { repairPhase: input.repairPhase }
					: {}),
				...(input.repairCursor !== undefined
					? { repairCursor: input.repairCursor }
					: {}),
				...(input.repairHighWater !== undefined
					? { repairHighWater: input.repairHighWater }
					: {}),
				...(input.repairStartedAt !== undefined
					? { repairStartedAt: input.repairStartedAt }
					: {}),
				...(input.certified ? { lastCertifiedAt: now } : {}),
				updatedAt: now,
			},
		});
}

/**
 * List every organization with an unacknowledged event, including a poisoned
 * head. Consumer recency provides fair rotation between busy organizations.
 *
 * Discovery is driven from the two SMALL sides rather than by DISTINCT-ing the
 * outbox. `SELECT DISTINCT organization_id` reads every outbox row even though
 * `idx_graph_projection_outbox_org_sequence` leads with that column -- SQLite
 * has no skip-scan, so it walks the whole index instead of seeking group to
 * group; joined against the consumer table that is hundreds of thousands of
 * rows every two minutes, all to return nothing. A per-organization probe
 * against the same index costs two rows, so the rewrite gives the same answer
 * for a tiny fraction of the reads.
 *
 * The two sides together are a complete cover: `graph_projection_consumers`
 * holds every organization that has ever been leased, and `organizations`
 * covers the ones that have not -- the consumer row is created by
 * `acquireGraphProjectionLease`, which necessarily runs AFTER discovery, so the
 * old `IS NULL` branch existed precisely to break that chicken-and-egg. An
 * organization is invisible to both only if its row was deleted before it was
 * ever projected, which no code path does and which production confirms (zero
 * outbox rows whose organization is missing).
 */
export async function listGraphProjectionOrganizations(
	db: DbClient,
	limit = 100,
): Promise<string[]> {
	const wanted = Math.max(1, Math.min(500, Math.trunc(limit)));
	const [consumerRows, organizationRows] = await db.batch([
		db
			.select({
				organizationId: graphProjectionConsumers.organizationId,
				lastProjectedSequence: graphProjectionConsumers.lastProjectedSequence,
				updatedAt: graphProjectionConsumers.updatedAt,
			})
			.from(graphProjectionConsumers),
		db.select({ organizationId: organizations.id }).from(organizations),
	]);

	const leased = new Set(consumerRows.map((row) => row.organizationId));
	const candidates = [
		...consumerRows.map((row) => ({
			organizationId: row.organizationId,
			cursor: row.lastProjectedSequence,
			updatedAt: row.updatedAt as string | null,
		})),
		...organizationRows
			.filter((row) => !leased.has(row.organizationId))
			.map((row) => ({
				organizationId: row.organizationId,
				cursor: 0,
				updatedAt: null,
			})),
	]
		.sort((left, right) => {
			// SQLite sorts NULL first under ASC and the old ORDER BY relied on it:
			// an organization with no consumer row has never been serviced, so it
			// keeps that priority here.
			const leftAt = left.updatedAt ?? "";
			const rightAt = right.updatedAt ?? "";
			if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
			return left.organizationId < right.organizationId ? -1 : 1;
		})
		.slice(0, GRAPH_PROJECTION_MAX_DISCOVERY_PROBES);

	// Probing in rotation order lets a busy platform stop as soon as it has
	// enough work, and starves nobody: servicing an organization bumps its
	// consumer `updated_at`, which moves it to the back of the next tick.
	const pending: string[] = [];
	for (
		let offset = 0;
		offset < candidates.length && pending.length < wanted;
		offset += GRAPH_PROJECTION_DISCOVERY_PROBE_CHUNK
	) {
		const chunk = candidates.slice(
			offset,
			offset + GRAPH_PROJECTION_DISCOVERY_PROBE_CHUNK,
		);
		const probes = chunk.map((candidate) =>
			db
				.select({ sequence: graphProjectionOutbox.sequence })
				.from(graphProjectionOutbox)
				.where(
					and(
						eq(graphProjectionOutbox.organizationId, candidate.organizationId),
						gt(graphProjectionOutbox.sequence, candidate.cursor),
					),
				)
				.limit(1),
		);
		const probed = (await db.batch(
			probes as unknown as [GraphProjectionProbe, ...GraphProjectionProbe[]],
		)) as { sequence: number }[][];
		probed.forEach((rows, position) => {
			const candidate = chunk[position];
			if (rows.length > 0 && candidate) {
				pending.push(candidate.organizationId);
			}
		});
	}
	return pending.slice(0, wanted);
}

/**
 * Quiet projections are periodically re-certified even when no outbox event
 * is pending. Baseline-complete degraded/catching-up rows are also retried
 * after a cooldown so one transient Neo4j read failure cannot strand a tenant.
 */
export async function listGraphProjectionCertificationOrganizations(
	db: DbClient,
	certifiedBefore: string,
	retryBefore: string,
	limit = 5,
): Promise<string[]> {
	const rows = await db
		.select({ organizationId: graphProjectionReadiness.organizationId })
		.from(graphProjectionReadiness)
		.where(
			and(
				eq(graphProjectionReadiness.repairPhase, "complete"),
				isNotNull(graphProjectionReadiness.repairHighWater),
				or(
					and(
						eq(graphProjectionReadiness.state, "ready"),
						or(
							isNull(graphProjectionReadiness.lastCertifiedAt),
							lte(graphProjectionReadiness.lastCertifiedAt, certifiedBefore),
						),
					),
					and(
						inArray(graphProjectionReadiness.state, [
							"catching_up",
							"degraded",
						]),
						lte(graphProjectionReadiness.updatedAt, retryBefore),
					),
				),
			),
		)
		.orderBy(
			asc(graphProjectionReadiness.lastCertifiedAt),
			asc(graphProjectionReadiness.organizationId),
		)
		.limit(Math.max(1, Math.min(100, Math.trunc(limit))));
	return rows.map((row) => row.organizationId);
}

export async function getGraphProjectionCursor(
	db: DbClient,
	organizationId: string,
): Promise<number> {
	const [row] = await db
		.select({
			lastProjectedSequence: graphProjectionConsumers.lastProjectedSequence,
		})
		.from(graphProjectionConsumers)
		.where(eq(graphProjectionConsumers.organizationId, organizationId))
		.limit(1);
	return row?.lastProjectedSequence ?? 0;
}

export async function getGraphProjectionHighWater(
	db: DbClient,
	organizationId: string,
): Promise<number> {
	const [row] = await db
		.select({ sequence: max(graphProjectionOutbox.sequence) })
		.from(graphProjectionOutbox)
		.where(eq(graphProjectionOutbox.organizationId, organizationId));
	return row?.sequence ?? 0;
}

/**
 * Acquire one organization lease by compare-and-swap. A Workflow retry may
 * reacquire its own token, while a different live token is never displaced.
 */
export async function acquireGraphProjectionLease(
	db: DbClient,
	organizationId: string,
	leaseToken: string,
	leaseMs = GRAPH_PROJECTION_LEASE_MS,
): Promise<boolean> {
	const now = new Date();
	const nowIso = now.toISOString();
	const leaseUntil = new Date(
		now.getTime() + Math.max(1, Math.trunc(leaseMs)),
	).toISOString();
	await db
		.insert(graphProjectionConsumers)
		.values({
			organizationId,
			lastProjectedSequence: 0,
			updatedAt: nowIso,
		})
		.onConflictDoNothing();
	const rows = await db
		.update(graphProjectionConsumers)
		.set({ leaseToken, leaseUntil, updatedAt: nowIso })
		.where(
			and(
				eq(graphProjectionConsumers.organizationId, organizationId),
				or(
					isNull(graphProjectionConsumers.leaseUntil),
					lte(graphProjectionConsumers.leaseUntil, nowIso),
					eq(graphProjectionConsumers.leaseToken, leaseToken),
				),
			),
		)
		.returning({ leaseToken: graphProjectionConsumers.leaseToken });
	return rows[0]?.leaseToken === leaseToken;
}

export async function renewGraphProjectionLease(
	db: DbClient,
	organizationId: string,
	leaseToken: string,
	leaseMs = GRAPH_PROJECTION_LEASE_MS,
): Promise<boolean> {
	const now = new Date();
	const rows = await db
		.update(graphProjectionConsumers)
		.set({
			leaseUntil: new Date(
				now.getTime() + Math.max(1, Math.trunc(leaseMs)),
			).toISOString(),
			updatedAt: now.toISOString(),
		})
		.where(
			and(
				eq(graphProjectionConsumers.organizationId, organizationId),
				eq(graphProjectionConsumers.leaseToken, leaseToken),
			),
		)
		.returning({ leaseToken: graphProjectionConsumers.leaseToken });
	return rows[0]?.leaseToken === leaseToken;
}

export async function releaseGraphProjectionLease(
	db: DbClient,
	organizationId: string,
	leaseToken: string,
): Promise<void> {
	await db
		.update(graphProjectionConsumers)
		.set({
			leaseToken: null,
			leaseUntil: null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(graphProjectionConsumers.organizationId, organizationId),
				eq(graphProjectionConsumers.leaseToken, leaseToken),
			),
		);
}

/**
 * Read the strict sequence prefix after `afterSequence`. Retry and poison
 * filters deliberately do not appear here: the first blocked event must remain
 * visible so the Workflow cannot acknowledge a later event past it.
 */
export async function readGraphProjectionBatch(
	db: DbClient,
	organizationId: string,
	afterSequence: number,
	limit = GRAPH_PROJECTION_BATCH_SIZE,
): Promise<GraphProjectionOutboxEvent[]> {
	return db
		.select()
		.from(graphProjectionOutbox)
		.where(
			and(
				eq(graphProjectionOutbox.organizationId, organizationId),
				gt(graphProjectionOutbox.sequence, afterSequence),
			),
		)
		.orderBy(asc(graphProjectionOutbox.sequence))
		.limit(boundedLimit(limit));
}

/**
 * Advance monotonically only while the caller still owns an unexpired lease.
 *
 * The lease fence and optional expected cursor are evaluated in the same D1
 * update that acknowledges the verified Neo4j batch. A stale Workflow can
 * therefore never advance after another worker has acquired the organization.
 *
 * `expectedCursor` also admits a cursor already sitting at `sequence`, which
 * makes the acknowledgement re-runnable: a durable Workflow step that
 * committed this exact advance and was then replayed sees its own outcome
 * rather than a fence. Nothing else is admitted — the lease token still has to
 * match, the lease still has to be unexpired, and the cursor still only moves
 * forward — and only the lease holder can have produced that state.
 */
export async function advanceGraphProjectionCursor(
	db: DbClient,
	organizationId: string,
	leaseToken: string,
	sequence: number,
	options?: { expectedCursor?: number },
): Promise<boolean> {
	const now = new Date().toISOString();
	const rows = await db
		.update(graphProjectionConsumers)
		.set({
			lastProjectedSequence: sequence,
			lastSuccessAt: now,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(graphProjectionConsumers.organizationId, organizationId),
				eq(graphProjectionConsumers.leaseToken, leaseToken),
				gt(graphProjectionConsumers.leaseUntil, now),
				lte(graphProjectionConsumers.lastProjectedSequence, sequence),
				options?.expectedCursor === undefined
					? undefined
					: or(
							eq(
								graphProjectionConsumers.lastProjectedSequence,
								options.expectedCursor,
							),
							eq(graphProjectionConsumers.lastProjectedSequence, sequence),
						),
			),
		)
		.returning({
			lastProjectedSequence: graphProjectionConsumers.lastProjectedSequence,
		});
	return rows[0]?.lastProjectedSequence === sequence;
}

export async function recordGraphProjectionFailure(
	db: DbClient,
	event: GraphProjectionOutboxEvent,
	error: unknown,
): Promise<void> {
	const attemptCount = event.attemptCount + 1;
	const poisoned = attemptCount >= GRAPH_PROJECTION_MAX_ATTEMPTS;
	const message = error instanceof Error ? error.message : String(error);
	const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10));
	const now = new Date();
	const nextAttemptAt = new Date(
		now.getTime() + delaySeconds * 1000,
	).toISOString();
	await db
		.update(graphProjectionOutbox)
		.set({
			attemptCount,
			lastError: message.slice(0, 2000),
			nextAttemptAt,
			poisonedAt: poisoned ? now.toISOString() : null,
		})
		.where(eq(graphProjectionOutbox.sequence, event.sequence));
	await db
		.update(graphProjectionConsumers)
		.set({ lastError: message.slice(0, 2000), updatedAt: now.toISOString() })
		.where(eq(graphProjectionConsumers.organizationId, event.organizationId));
}

export async function resetGraphProjectionFailure(
	db: DbClient,
	organizationId: string,
	sequence: number,
): Promise<boolean> {
	const [updated] = await db
		.update(graphProjectionOutbox)
		.set({
			attemptCount: 0,
			nextAttemptAt: null,
			lastError: null,
			poisonedAt: null,
		})
		.where(
			and(
				eq(graphProjectionOutbox.organizationId, organizationId),
				eq(graphProjectionOutbox.sequence, sequence),
			),
		)
		.returning({ sequence: graphProjectionOutbox.sequence });
	return Boolean(updated);
}

/**
 * SQLite-native UTC timestamp literal (`YYYY-MM-DD HH:MM:SS`).
 *
 * `graph_projection_outbox.created_at` has no TypeScript writer: every row is
 * stamped by a SQL trigger that leaves the column on its `CURRENT_TIMESTAMP`
 * default, so every stored value is space-separated (verified on production:
 * zero rows contain `T`). An ISO-8601 cutoff mis-sorts against those rows --
 * `'T'` (0x54) > `' '` (0x20), so a space-format row anywhere on the cutoff DAY
 * compares below an ISO cutoff and is pruned up to a day early. Same rule as
 * `deleteOldRowsBatched` in queries/catalog/maintenance.ts: the cutoff must
 * match the column's stored format.
 */
function sqliteUtcTimestamp(at: Date): string {
	return at.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Lowest sequence in the prunable set -- acknowledged and past retention -- or
 * null when nothing is prunable. Same join and predicate as the prune, so it is
 * exactly the keyset a working prune advances, which is what lets the prune
 * verify that its own reported deletions actually landed.
 */
async function prunableGraphProjectionHead(
	db: DbClient,
	cutoff: string,
): Promise<number | null> {
	const [row] = await db
		.select({ head: min(graphProjectionOutbox.sequence) })
		.from(graphProjectionOutbox)
		.innerJoin(
			graphProjectionConsumers,
			eq(
				graphProjectionConsumers.organizationId,
				graphProjectionOutbox.organizationId,
			),
		)
		.where(
			and(
				lte(
					graphProjectionOutbox.sequence,
					graphProjectionConsumers.lastProjectedSequence,
				),
				lte(graphProjectionOutbox.createdAt, cutoff),
			),
		);
	return row?.head ?? null;
}

/**
 * Delete only acknowledged events older than the diagnostic retention window,
 * in up to `maxBatches` keyset-bounded passes.
 *
 * Counts deletions from D1's `changes`, NOT from a `RETURNING` row count. The
 * distinction is load-bearing: the first wiring of this prune returned
 * `.returning().length`, which reports how many rows the statement MATCHED, so
 * five consecutive nightly runs reported 50,000 deletions (10 passes x the
 * 5,000 cap) against an outbox from which nothing had ever been deleted --
 * max(sequence) - min(sequence) + 1 still equalled the row count. `changes` is
 * the only count that distinguishes "deleted" from "matched", and the loop's
 * short-batch exit needs that same distinction to terminate at all.
 *
 * A prune that reports deletions must move the prunable head. When it does not,
 * throw rather than return a number nobody can trust: an ineffective prune is a
 * defect, and the alternative is another five nights of false success.
 */
export async function pruneAcknowledgedGraphProjectionEvents(
	db: DbClient,
	options?: {
		now?: Date;
		retentionDays?: number;
		limit?: number;
		maxBatches?: number;
	},
): Promise<number> {
	const now = options?.now ?? new Date();
	const retentionDays = Math.max(
		1,
		Math.min(
			90,
			Math.trunc(options?.retentionDays ?? GRAPH_PROJECTION_RETENTION_DAYS),
		),
	);
	const limit = Math.max(
		1,
		Math.min(
			5_000,
			Math.trunc(options?.limit ?? GRAPH_PROJECTION_PRUNE_BATCH_SIZE),
		),
	);
	const maxBatches = Math.max(
		1,
		Math.min(50, Math.trunc(options?.maxBatches ?? 1)),
	);
	const cutoff = sqliteUtcTimestamp(
		new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
	);
	const headBefore = await prunableGraphProjectionHead(db, cutoff);
	if (headBefore === null) return 0;

	let removed = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		// `DELETE ... WHERE sequence IN (SELECT ... LIMIT n)` is the portable
		// bounded-delete idiom the other retention prunes use (D1 has no
		// `DELETE ... LIMIT`), and it binds two params regardless of batch size,
		// so it is immune to D1's 100-bound-param ceiling.
		const result = await db.delete(graphProjectionOutbox).where(
			sql`${graphProjectionOutbox.sequence} in (
				select ${graphProjectionOutbox.sequence}
				  from ${graphProjectionOutbox}
				  join ${graphProjectionConsumers}
				    on ${graphProjectionConsumers.organizationId} = ${graphProjectionOutbox.organizationId}
				 where ${graphProjectionOutbox.sequence} <= ${graphProjectionConsumers.lastProjectedSequence}
				   and ${graphProjectionOutbox.createdAt} <= ${cutoff}
				 order by ${graphProjectionOutbox.sequence}
				 limit ${limit}
			)`,
		);
		const batchRemoved = getAffectedRows(result);
		removed += batchRemoved;
		if (batchRemoved < limit) break;
	}

	if (removed > 0) {
		const headAfter = await prunableGraphProjectionHead(db, cutoff);
		if (headAfter !== null && headAfter <= headBefore) {
			throw new Error(
				`graph-projection outbox prune reported ${removed} deleted row(s) but the prunable head did not advance past ${headBefore}`,
			);
		}
	}
	return removed;
}

/**
 * Fleet-only health evidence for the platform digest. Each indexed outbox probe
 * stays scoped to its consumer and starts after its acknowledged watermark.
 * Activity/lease timestamps deliberately cannot stand in for successful work.
 */
export async function listGraphProjectionConsumerHealth(db: DbClient) {
	const pendingHead = db
		.select({ createdAt: graphProjectionOutbox.createdAt })
		.from(graphProjectionOutbox)
		.where(
			and(
				eq(
					graphProjectionOutbox.organizationId,
					graphProjectionConsumers.organizationId,
				),
				gt(
					graphProjectionOutbox.sequence,
					graphProjectionConsumers.lastProjectedSequence,
				),
			),
		)
		.orderBy(asc(graphProjectionOutbox.sequence))
		.limit(1);
	return db
		.select({
			organizationId: graphProjectionConsumers.organizationId,
			lastSuccessAt: graphProjectionConsumers.lastSuccessAt,
			oldestPendingAt: sql<string | null>`(${pendingHead})`,
		})
		.from(graphProjectionConsumers)
		.orderBy(asc(graphProjectionConsumers.organizationId));
}

export async function getGraphProjectionBacklogStats(
	db: DbClient,
	organizationId: string,
): Promise<GraphProjectionBacklogStats> {
	const cursor = await getGraphProjectionCursor(db, organizationId);
	const [row] = await db
		.select({
			highWaterSequence: max(graphProjectionOutbox.sequence),
			pendingCount: count(),
			retryCount: sql<number>`SUM(CASE WHEN ${graphProjectionOutbox.attemptCount} > 0 AND ${graphProjectionOutbox.poisonedAt} IS NULL THEN 1 ELSE 0 END)`,
			poisonedCount: sql<number>`SUM(CASE WHEN ${graphProjectionOutbox.poisonedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
			oldestPendingAt: min(graphProjectionOutbox.createdAt),
		})
		.from(graphProjectionOutbox)
		.where(
			and(
				eq(graphProjectionOutbox.organizationId, organizationId),
				gt(graphProjectionOutbox.sequence, cursor),
			),
		);
	return {
		cursor,
		highWaterSequence: row?.highWaterSequence ?? cursor,
		pendingCount: row?.pendingCount ?? 0,
		retryCount: Number(row?.retryCount ?? 0),
		poisonedCount: Number(row?.poisonedCount ?? 0),
		oldestPendingAt: row?.oldestPendingAt ?? null,
	};
}

export async function countPendingGraphProjectionEvents(
	db: DbClient,
	organizationId: string,
	afterSequence: number,
): Promise<number> {
	const [row] = await db
		.select({ count: count() })
		.from(graphProjectionOutbox)
		.where(
			and(
				eq(graphProjectionOutbox.organizationId, organizationId),
				gt(graphProjectionOutbox.sequence, afterSequence),
			),
		);
	return Number(row?.count ?? 0);
}

/**
 * Final readiness CAS: readiness may become ready only if no newer outbox row
 * arrived after certification. Raw SQL is retained here because the
 * UPDATE...NOT EXISTS...RETURNING statement is the atomic fence.
 */
export async function confirmGraphProjectionReadyWithoutBacklog(
	db: DbClient,
	input: {
		organizationId: string;
		projectionEpoch: string;
		persistedWatermark: number;
		updatedAt: string;
	},
): Promise<boolean> {
	const d1 = db.$client;
	const row = await d1
		.prepare(
			`UPDATE graph_projection_readiness
			 SET state = 'ready',
				reason = NULL,
				projection_epoch = ?,
				persisted_watermark = ?,
				updated_at = ?
			 WHERE organization_id = ?
				AND state = 'ready'
				AND projection_epoch = ?
				AND NOT EXISTS (
					SELECT 1 FROM graph_projection_outbox
					WHERE organization_id = ? AND sequence > ?
				)
			 RETURNING state`,
		)
		.bind(
			input.projectionEpoch,
			input.persistedWatermark,
			input.updatedAt,
			input.organizationId,
			input.projectionEpoch,
			input.organizationId,
			input.persistedWatermark,
		)
		.first<{ state: string }>();
	return row?.state === "ready";
}

function canonicalProjectionQuery(event: GraphProjectionOutboxEvent): string {
	if (event.operation === "delete") {
		return "SELECT ? AS entity_id, ? AS organization_id WHERE 0";
	}
	switch (event.entityKind) {
		case "fact":
			return "SELECT * FROM memory_facts WHERE id = ? AND organization_id = ?";
		case "edge":
			return `SELECT e.*, f.organization_id
				FROM memory_edges e
				JOIN memory_facts f ON f.id = e.source_fact_id
				WHERE e.id = ? AND f.organization_id = ?`;
		case "domain":
			return "SELECT * FROM memory_domains WHERE id = ? AND organization_id = ?";
		case "tedi":
			return "SELECT * FROM tedis WHERE id = ? AND organization_id = ?";
		case "decision":
			return "SELECT * FROM tedi_rationale_records WHERE id = ? AND org_id = ?";
		case "knowledge_entry":
			return "SELECT * FROM knowledge_entries WHERE id = ? AND organization_id = ?";
		case "skill":
			return "SELECT * FROM skill_entries WHERE id = ? AND organization_id = ?";
		case "project":
			return "SELECT * FROM projects WHERE id = ? AND org_id = ?";
		case "work_item":
			return "SELECT * FROM work_items WHERE id = ? AND org_id = ?";
		case "work_item_source":
			return "SELECT * FROM work_item_sources WHERE id = ? AND org_id = ?";
		case "tedi_expertise":
			return `SELECT e.*, t.organization_id
				FROM tedi_expertise e
				JOIN tedis t ON t.id = e.tedi_id
				WHERE e.id = ? AND t.organization_id = ?`;
		case "capability":
			return "SELECT * FROM org_capabilities WHERE id = ? AND organization_id = ?";
		case "capability_link":
			return "SELECT * FROM capability_links WHERE id = ? AND organization_id = ?";
		case "entity":
		case "entity_resolution":
			throw new Error(
				`Entity projection kind ${event.entityKind} requires governed hydration`,
			);
	}
}

/**
 * Batch heterogeneous canonical-row hydration. The entity-kind switch cannot
 * be represented as one Drizzle table query; it remains parameterized and
 * tenant-scoped inside the query owner.
 */
export async function hydrateCanonicalGraphProjectionRows(
	db: DbClient,
	events: GraphProjectionOutboxEvent[],
): Promise<Array<Record<string, unknown> | null>> {
	if (events.length === 0) return [];
	const d1 = db.$client;
	const results = await d1.batch(
		events.map((event) =>
			d1
				.prepare(canonicalProjectionQuery(event))
				.bind(event.entityId, event.organizationId),
		),
	);
	return results.map(
		(result) =>
			(result.results?.[0] as Record<string, unknown> | undefined) ?? null,
	);
}

/**
 * Collapse redundant node mutations while preserving every ordered relation
 * event. Nodes stay ahead of relationships so an edge cannot race an endpoint
 * within a projection batch.
 */
export function coalesceGraphProjectionEvents(
	events: GraphProjectionOutboxEvent[],
): GraphProjectionOutboxEvent[] {
	const relationKinds = new Set<GraphProjectionEntityKind>([
		"edge",
		"tedi_expertise",
		"capability_link",
		"entity_resolution",
	]);
	const latestNodes = new Map<string, GraphProjectionOutboxEvent>();
	const relations: GraphProjectionOutboxEvent[] = [];
	for (const event of events) {
		if (relationKinds.has(event.entityKind)) {
			relations.push(event);
			continue;
		}
		latestNodes.set(`${event.entityKind}:${event.entityId}`, event);
	}
	return [
		...[...latestNodes.values()].sort((a, b) => a.sequence - b.sequence),
		...relations.sort((a, b) => a.sequence - b.sequence),
	];
}

/**
 * Stable full-fact scan for baseline repair. Deliberately no lifecycle,
 * memory-scope, use-policy, or graph-anchor filter: Neo4j must receive
 * archived/invalidated state and graph anchors too.
 */
export async function readGraphFactBackfillPage(
	db: DbClient,
	organizationId: string,
	options?: { afterId?: string; limit?: number },
): Promise<GraphProjectionBackfillPage<typeof memoryFacts.$inferSelect>> {
	const limit = boundedLimit(options?.limit ?? GRAPH_PROJECTION_BATCH_SIZE);
	const rows = await db
		.select()
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				options?.afterId ? gt(memoryFacts.id, options.afterId) : undefined,
			),
		)
		.orderBy(asc(memoryFacts.id))
		.limit(limit + 1);
	const done = rows.length <= limit;
	const page = rows.slice(0, limit);
	return {
		rows: page,
		nextCursor: done ? null : (page.at(-1)?.id ?? null),
		done,
	};
}

export async function readGraphDomainBackfillPage(
	db: DbClient,
	organizationId: string,
	options?: { afterId?: string; limit?: number },
): Promise<GraphProjectionBackfillPage<typeof memoryDomains.$inferSelect>> {
	const limit = boundedLimit(options?.limit ?? GRAPH_PROJECTION_BATCH_SIZE);
	const rows = await db
		.select()
		.from(memoryDomains)
		.where(
			and(
				eq(memoryDomains.organizationId, organizationId),
				options?.afterId ? gt(memoryDomains.id, options.afterId) : undefined,
			),
		)
		.orderBy(asc(memoryDomains.id))
		.limit(limit + 1);
	const done = rows.length <= limit;
	const page = rows.slice(0, limit);
	return {
		rows: page,
		nextCursor: done ? null : (page.at(-1)?.id ?? null),
		done,
	};
}

export type GraphEdgeBackfillRow = typeof memoryEdges.$inferSelect & {
	organizationId: string;
};

export async function readGraphEdgeBackfillPage(
	db: DbClient,
	organizationId: string,
	options?: { afterId?: string; limit?: number },
): Promise<GraphProjectionBackfillPage<GraphEdgeBackfillRow>> {
	const limit = boundedLimit(options?.limit ?? GRAPH_PROJECTION_BATCH_SIZE);
	const sourceFact = alias(memoryFacts, "graph_projection_source_fact");
	const targetFact = alias(memoryFacts, "graph_projection_target_fact");
	const rows = await db
		.select({
			id: memoryEdges.id,
			sourceFactId: memoryEdges.sourceFactId,
			targetFactId: memoryEdges.targetFactId,
			relationType: memoryEdges.relationType,
			strength: memoryEdges.strength,
			context: memoryEdges.context,
			createdAt: memoryEdges.createdAt,
			organizationId: sourceFact.organizationId,
		})
		.from(memoryEdges)
		.innerJoin(sourceFact, eq(sourceFact.id, memoryEdges.sourceFactId))
		.innerJoin(targetFact, eq(targetFact.id, memoryEdges.targetFactId))
		.where(
			and(
				eq(sourceFact.organizationId, organizationId),
				eq(targetFact.organizationId, organizationId),
				options?.afterId ? gt(memoryEdges.id, options.afterId) : undefined,
			),
		)
		.orderBy(asc(memoryEdges.id))
		.limit(limit + 1);
	const done = rows.length <= limit;
	const page = rows.slice(0, limit);
	return {
		rows: page,
		nextCursor: done ? null : (page.at(-1)?.id ?? null),
		done,
	};
}
