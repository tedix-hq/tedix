/**
 * Durable graph-projection outbox, consumer lease, and canonical backfill
 * queries. The selected core store is authoritative; these helpers never read Neo4j.
 */

import { coreTable } from "../core-store/client";
import { coreStore, jsonRead } from "../core-store/dialect";
import {
	and,
	asc,
	count,
	eq,
	gt,
	getColumns,
	getTableName,
	inArray,
	isNotNull,
	isNull,
	lte,
	max,
	min,
	notExists,
	exists,
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
	graphProjectionConsumers as d1GraphProjectionConsumers,
	graphProjectionOutbox as d1GraphProjectionOutbox,
	graphProjectionReadiness as d1GraphProjectionReadiness,
} from "../schema/graph-projection";
import {
	memoryDomains as d1MemoryDomains,
	memoryEdges as d1MemoryEdges,
	memoryFacts as d1MemoryFacts,
} from "../schema/memory-graph";
import { organizations as d1Organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { tediRationaleRecords } from "../schema/rationale-records";
import { knowledgeEntries, skillEntries } from "../schema/cognitive";
import { projects } from "../schema/projects";
import { workItems } from "../schema/work-items";
import { workItemSources } from "../schema/work-item-sources";
import { decisionEdges } from "../schema/decision-graph";
import { orgCapabilities, capabilityLinks } from "../schema/capabilities";
import { tediExpertise } from "../schema/memory-graph";

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

export const GRAPH_PROJECTION_RETENTION_DAYS = 7;
/** Small delete batches keep each D1 write short; see the retention job. */
export const GRAPH_PROJECTION_PRUNE_BATCH_SIZE = 250;

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
	const graphProjectionReadiness = coreTable(db, d1GraphProjectionReadiness);
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
	const graphProjectionReadiness = coreTable(db, d1GraphProjectionReadiness);
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
	options?: {
		/**
		 * Skip a consumer whose last drain failed at or after this ISO instant:
		 * the dispatch-level backoff that keeps an unreachable graph database
		 * from being retried on every tick.
		 */
		failedSince?: string;
	},
): Promise<string[]> {
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
	const organizations = coreTable(db, d1Organizations);
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const wanted = Math.max(1, Math.min(500, Math.trunc(limit)));
	const consumers = db.$with("projection_candidates").as(
		db
			.select({
				organizationId:
					sql<string>`${graphProjectionConsumers.organizationId}`.as(
						"organization_id",
					),
				cursor:
					sql<number>`${graphProjectionConsumers.lastProjectedSequence}`.as(
						"cursor",
					),
				updatedAt:
					sql<string>`coalesce(${graphProjectionConsumers.updatedAt}, '')`.as(
						"updated_at",
					),
			})
			.from(graphProjectionConsumers)
			.where(
				options?.failedSince
					? or(
							isNull(graphProjectionConsumers.lastError),
							isNull(graphProjectionConsumers.updatedAt),
							sql`${graphProjectionConsumers.updatedAt} < ${options.failedSince}`,
						)
					: undefined,
			)
			.unionAll(
				db
					.select({
						organizationId: sql<string>`${organizations.id}`.as(
							"organization_id",
						),
						cursor: sql<number>`0`.as("cursor"),
						updatedAt: sql<string>`''`.as("updated_at"),
					})
					.from(organizations)
					.where(
						notExists(
							db
								.select({ one: sql`1` })
								.from(graphProjectionConsumers)
								.where(
									eq(graphProjectionConsumers.organizationId, organizations.id),
								),
						),
					),
			)
			.orderBy(sql`updated_at`, sql`organization_id`)
			.limit(GRAPH_PROJECTION_MAX_DISCOVERY_PROBES),
	);
	const rows = await db
		.with(consumers)
		.select({ organizationId: consumers.organizationId })
		.from(consumers)
		.where(
			exists(
				db
					.select({ one: sql`1` })
					.from(graphProjectionOutbox)
					.where(
						and(
							eq(
								graphProjectionOutbox.organizationId,
								consumers.organizationId,
							),
							gt(graphProjectionOutbox.sequence, consumers.cursor),
						),
					),
			),
		)
		.orderBy(asc(consumers.updatedAt), asc(consumers.organizationId))
		.limit(wanted);
	return rows.map((row) => row.organizationId);
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
	const graphProjectionReadiness = coreTable(db, d1GraphProjectionReadiness);
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
			sql`${graphProjectionReadiness.lastCertifiedAt} ASC NULLS FIRST`,
			asc(graphProjectionReadiness.organizationId),
		)
		.limit(Math.max(1, Math.min(100, Math.trunc(limit))));
	return rows.map((row) => row.organizationId);
}

export async function getGraphProjectionCursor(
	db: DbClient,
	organizationId: string,
): Promise<number> {
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
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
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
	const now = new Date();
	const nowIso = now.toISOString();
	const leaseUntil = new Date(
		now.getTime() + Math.max(1, Math.trunc(leaseMs)),
	).toISOString();
	const insert = db
		.insert(graphProjectionConsumers)
		.values({
			organizationId,
			lastProjectedSequence: 0,
			updatedAt: nowIso,
		})
		.onConflictDoNothing();
	const claim = db
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
	const [, rows] = await db.batch([insert, claim]);
	return rows[0]?.leaseToken === leaseToken;
}

export async function renewGraphProjectionLease(
	db: DbClient,
	organizationId: string,
	leaseToken: string,
	leaseMs = GRAPH_PROJECTION_LEASE_MS,
): Promise<boolean> {
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
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
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
	const attemptCount = event.attemptCount + 1;
	const poisoned = attemptCount >= GRAPH_PROJECTION_MAX_ATTEMPTS;
	const message = error instanceof Error ? error.message : String(error);
	const delaySeconds = Math.min(3600, 2 ** Math.min(attemptCount, 10));
	const now = new Date();
	const nextAttemptAt = new Date(
		now.getTime() + delaySeconds * 1000,
	).toISOString();
	const eventUpdate = db
		.update(graphProjectionOutbox)
		.set({
			attemptCount,
			lastError: message.slice(0, 2000),
			nextAttemptAt,
			poisonedAt: poisoned ? now.toISOString() : null,
		})
		.where(eq(graphProjectionOutbox.sequence, event.sequence));
	const consumerUpdate = db
		.update(graphProjectionConsumers)
		.set({ lastError: message.slice(0, 2000), updatedAt: now.toISOString() })
		.where(eq(graphProjectionConsumers.organizationId, event.organizationId));
	await db.batch([eventUpdate, consumerUpdate]);
}

export async function resetGraphProjectionFailure(
	db: DbClient,
	organizationId: string,
	sequence: number,
): Promise<boolean> {
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
		const statement = db.delete(graphProjectionOutbox).where(
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
		const batchRemoved =
			coreStore(db) === "postgres"
				? (
						await statement.returning({
							sequence: graphProjectionOutbox.sequence,
						})
					).length
				: getAffectedRows(await statement);
		removed += batchRemoved;
		if (batchRemoved < limit) break;
		if (batch + 1 < maxBatches)
			await new Promise((resolve) => setTimeout(resolve, 1_000));
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const graphProjectionConsumers = coreTable(db, d1GraphProjectionConsumers);
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
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
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

export type GraphProjectionBacklogMeasurement = {
	organizations: number;
	/** Pending events summed over organizations, each counted up to `cap`. */
	pending: number;
	/** Organizations whose backlog reached `cap`, so `pending` is a floor. */
	capped: number;
};

/**
 * Bounded backlog size for the given consumers: one indexed range count per
 * organization, each stopping at `cap` rows, composed into one D1 batch.
 */
export async function measureGraphProjectionBacklog(
	db: DbClient,
	consumers: readonly { organizationId: string; cursor: number }[],
	cap = 10_000,
): Promise<GraphProjectionBacklogMeasurement> {
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const limit = Math.max(1, Math.min(50_000, Math.trunc(cap)));
	const bounded = consumers.slice(0, GRAPH_PROJECTION_DISCOVERY_PROBE_CHUNK);
	if (bounded.length === 0) return { organizations: 0, pending: 0, capped: 0 };
	const input = JSON.stringify(bounded);
	const candidates = db.$with("backlog_candidates").as(
		db
			.select({
				organizationId: jsonRead(db, sql`value`, ["organizationId"]).as(
					"organization_id",
				),
				cursor: jsonRead(db, sql`value`, ["cursor"], "number").as("cursor"),
			})
			.from(
				coreStore(db) === "postgres"
					? sql`jsonb_array_elements(${input}::jsonb) AS candidates(value)`
					: sql`json_each(${input})`,
			),
	);
	const pendingRows = db
		.select({ sequence: graphProjectionOutbox.sequence })
		.from(graphProjectionOutbox)
		.where(
			and(
				eq(graphProjectionOutbox.organizationId, candidates.organizationId),
				gt(graphProjectionOutbox.sequence, candidates.cursor),
			),
		)
		.limit(limit)
		.as("pending_rows");
	const results = await db
		.with(candidates)
		.select({
			pending: sql<number>`(${db.select({ pending: count() }).from(pendingRows)})`,
		})
		.from(candidates);
	let pending = 0;
	let capped = 0;
	for (const row of results) {
		const value = Number(row.pending ?? 0);
		pending += value;
		if (value >= limit) capped += 1;
	}
	return { organizations: bounded.length, pending, capped };
}

export async function countPendingGraphProjectionEvents(
	db: DbClient,
	organizationId: string,
	afterSequence: number,
): Promise<number> {
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
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
 * arrived after certification. The single UPDATE...NOT EXISTS...RETURNING
 * statement is the atomic fence.
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
	const graphProjectionReadiness = coreTable(db, d1GraphProjectionReadiness);
	const graphProjectionOutbox = coreTable(db, d1GraphProjectionOutbox);
	const [row] = await db
		.update(graphProjectionReadiness)
		.set({
			state: "ready",
			reason: null,
			projectionEpoch: input.projectionEpoch,
			persistedWatermark: input.persistedWatermark,
			updatedAt: input.updatedAt,
		})
		.where(
			and(
				eq(graphProjectionReadiness.organizationId, input.organizationId),
				eq(graphProjectionReadiness.state, "ready"),
				eq(graphProjectionReadiness.projectionEpoch, input.projectionEpoch),
				notExists(
					db
						.select({ one: sql`1` })
						.from(graphProjectionOutbox)
						.where(
							and(
								eq(graphProjectionOutbox.organizationId, input.organizationId),
								gt(graphProjectionOutbox.sequence, input.persistedWatermark),
							),
						),
				),
			),
		)
		.returning({ state: graphProjectionReadiness.state });
	return row?.state === "ready";
}

const projectionHydrationTables = {
	fact: d1MemoryFacts,
	edge: d1MemoryEdges,
	domain: d1MemoryDomains,
	tedi: tedis,
	decision: tediRationaleRecords,
	knowledge_entry: knowledgeEntries,
	skill: skillEntries,
	project: projects,
	work_item: workItems,
	work_item_source: workItemSources,
	decision_edge: decisionEdges,
	tedi_expertise: tediExpertise,
	capability: orgCapabilities,
	capability_link: capabilityLinks,
};

/** Hydrate physical snake_case rows in one set query, preserving input order and tombstones. */
export async function hydrateCanonicalGraphProjectionRows(
	db: DbClient,
	events: GraphProjectionOutboxEvent[],
): Promise<Array<Record<string, unknown> | null>> {
	const input = events.flatMap((event, position) => {
		if (event.operation === "delete") return [];
		if (
			event.entityKind === "entity" ||
			event.entityKind === "entity_resolution"
		)
			throw new Error(
				`Entity projection kind ${event.entityKind} requires governed hydration`,
			);
		return [
			{
				position,
				kind: event.entityKind,
				id: event.entityId,
				org: event.organizationId,
			},
		];
	});
	const result: Array<Record<string, unknown> | null> = events.map(() => null);
	if (!input.length) return result;
	const postgres = coreStore(db) === "postgres";
	const document = JSON.stringify(input);
	const inputs = postgres
		? sql`SELECT (value->>'position')::bigint AS position, value->>'kind' AS kind,
			value->>'id' AS id, value->>'org' AS org FROM jsonb_array_elements(${document}::jsonb)`
		: sql`SELECT json_extract(value, '$.position') AS position, json_extract(value, '$.kind') AS kind,
			json_extract(value, '$.id') AS id, json_extract(value, '$.org') AS org FROM json_each(${document})`;
	const branches = [...new Set(input.map((event) => event.kind))].map(
		(kind) => {
			const table = projectionHydrationTables[kind];
			const through = kind === "edge" || kind === "tedi_expertise";
			const joins =
				kind === "edge"
					? sql`JOIN memory_facts owner ON owner.id = canonical.source_fact_id`
					: kind === "tedi_expertise"
						? sql`JOIN tedis owner ON owner.id = canonical.tedi_id`
						: sql``;
			const organization = through
				? sql`owner.organization_id`
				: [
							"decision",
							"project",
							"work_item",
							"work_item_source",
							"decision_edge",
					  ].includes(kind)
					? sql`canonical.org_id`
					: sql`canonical.organization_id`;
			const fields = Object.values(getColumns(table)).flatMap((column) => [
				sql.raw("'" + column.name.replaceAll("'", "''") + "'"),
				sql`canonical.${sql.identifier(column.name)}`,
			]);
			if (through) fields.push(sql`'organization_id'`, organization);
			const row = postgres
				? sql`to_jsonb(canonical) ${through ? sql`|| jsonb_build_object('organization_id', ${organization})` : sql``}`
				: sql`json_object(${sql.join(fields, sql`, `)})`;
			return sql`SELECT input.position AS position, ${row} AS row
			FROM input JOIN ${sql.identifier(getTableName(table))} AS canonical ON canonical.id = input.id
			${joins} WHERE input.kind = ${kind} AND ${organization} = input.org`;
		},
	);
	const rows = await db.all<{
		position: number;
		row: string | Record<string, unknown>;
	}>(sql`WITH input AS (${inputs}) ${sql.join(branches, sql` UNION ALL `)}`);
	for (const row of rows)
		result[Number(row.position)] =
			typeof row.row === "string" ? JSON.parse(row.row) : row.row;
	return result;
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
		"decision_edge",
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
): Promise<GraphProjectionBackfillPage<typeof d1MemoryFacts.$inferSelect>> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
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
): Promise<GraphProjectionBackfillPage<typeof d1MemoryDomains.$inferSelect>> {
	const memoryDomains = coreTable(db, d1MemoryDomains);
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

export type GraphEdgeBackfillRow = typeof d1MemoryEdges.$inferSelect & {
	organizationId: string;
};

export async function readGraphEdgeBackfillPage(
	db: DbClient,
	organizationId: string,
	options?: { afterId?: string; limit?: number },
): Promise<GraphProjectionBackfillPage<GraphEdgeBackfillRow>> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const memoryEdges = coreTable(db, d1MemoryEdges);
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
