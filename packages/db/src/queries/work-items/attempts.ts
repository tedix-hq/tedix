import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	WorkAttemptRepositorySchema,
	type WorkAttemptRepository,
	type WorkAttemptRepositoryLifecycle,
} from "@tedix/api-contract/schemas/work-items";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkAttempt,
	type WorkAttemptOutcome,
	type WorkAttemptRuntimeState,
	type WorkItem,
	workAttempts,
	workEvents,
	workItems,
} from "../../schema/work-items";
import {
	workAdmissions,
	workBudgetReservations,
	workResourceReservations,
} from "../../schema/work-factory";
import {
	ACTIVE_ATTEMPT_STATES,
	getScopedWorkItem,
	WorkFactoryError,
	type WorkExecutor,
} from "./factory-state";

export async function getAuthoritativeWorkItemAttempt(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		executor?: WorkExecutor;
		sessionId?: string;
		externalSessionKey?: string;
		at?: string;
	},
): Promise<WorkAttempt> {
	const at = params.at ?? new Date().toISOString();
	const attempt = (
		await db
			.select()
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.id, params.attemptId),
					eq(workAttempts.orgId, params.orgId),
					eq(workAttempts.workItemId, params.workItemId),
					params.executor
						? eq(workAttempts.executorType, params.executor.type)
						: undefined,
					params.executor
						? eq(workAttempts.executorId, params.executor.id)
						: undefined,
					params.sessionId
						? eq(workAttempts.executorSessionId, params.sessionId)
						: undefined,
					params.externalSessionKey
						? eq(workAttempts.externalSessionKey, params.externalSessionKey)
						: undefined,
					inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
					sql`${workAttempts.expiresAt} > ${at}`,
				),
			)
			.limit(1)
	)[0];
	if (!attempt)
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			`Attempt ${params.attemptId} is no longer authoritative`,
		);
	if (
		attempt.executorType === "external_agent" &&
		(!params.externalSessionKey ||
			params.externalSessionKey !== attempt.externalSessionKey)
	) {
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			"External attempt session fence does not match",
		);
	}
	return attempt;
}

/** The exact timed-out attempt a retirement is fenced to. */
interface TimedOutAttempt {
	id: string;
	admissionId: string | null;
	orgId: string;
	workItemId: string;
	expiresAt: string | null;
	version: number;
}

/**
 * Resolve the one active attempt on a Work Item whose lease has elapsed.
 *
 * The boundary is `expires_at <= at`, exactly matching
 * `getAuthoritativeWorkItemAttempt`, which requires `expires_at > at`. An
 * attempt whose lease expires on the instant is therefore never authoritative
 * and always sweepable — there is no window in which both are true, and none in
 * which neither is. A NULL `expires_at` is a lease that never elapses and is
 * never touched.
 *
 * `uniq_work_attempt_active` guarantees at most one row can match.
 */
async function findTimedOutAttempt(
	db: DbQueryClient,
	params: { orgId: string; workItemId: string; at: string },
): Promise<TimedOutAttempt | null> {
	return (
		(
			await db
				.select({
					id: workAttempts.id,
					admissionId: workAttempts.admissionId,
					orgId: workAttempts.orgId,
					workItemId: workAttempts.workItemId,
					expiresAt: workAttempts.expiresAt,
					version: workAttempts.version,
				})
				.from(workAttempts)
				.where(
					and(
						eq(workAttempts.orgId, params.orgId),
						eq(workAttempts.workItemId, params.workItemId),
						inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
						sql`${workAttempts.expiresAt} IS NOT NULL AND ${workAttempts.expiresAt} <= ${params.at}`,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}

/**
 * How a budget reservation settles. `consumed_micros` on an ACTIVE row is the
 * spend committed so far (recorded by heartbeat or settle); the row itself
 * still counts at its full reserved amount until it settles.
 *
 * - A committed amount above zero consumes exactly that amount, capped at the
 *   reserved amount.
 * - No committed spend releases the reservation, unless `fullOnUnknown` asks
 *   for the reserved amount: a run that finished without ever reporting cost is
 *   charged its reservation, while an expired or cancelled run with nothing
 *   committed gives the budget back.
 */
function budgetSettlementValues(p: {
	committedMicros: number | null | undefined;
	fullOnUnknown: boolean;
}) {
	const committed =
		p.committedMicros === undefined || p.committedMicros === null
			? sql`COALESCE(${workBudgetReservations.consumedMicros}, 0)`
			: sql`${Math.max(0, Math.trunc(p.committedMicros))}`;
	const fallback = p.fullOnUnknown
		? sql`${workBudgetReservations.amountMicros}`
		: sql`0`;
	// `work_budget_reservation_update_guard` rejects consumption above the
	// reserved amount; spend beyond the reservation is capped, not refused.
	const finalMicros = sql`MIN(CASE WHEN ${committed} > 0 THEN ${committed} ELSE ${fallback} END, ${workBudgetReservations.amountMicros})`;
	return {
		state: sql<
			"consumed" | "released"
		>`CASE WHEN ${finalMicros} > 0 THEN 'consumed' ELSE 'released' END`,
		consumedMicros: sql<
			number | null
		>`CASE WHEN ${finalMicros} > 0 THEN ${finalMicros} ELSE NULL END`,
	};
}

/**
 * The single retirement policy for a timed-out Attempt.
 *
 * Both the admission path (`startWorkItemAttempt`, which reaps the previous
 * lease as it acquires a fresh fence) and the standalone sweeper compose these
 * four statements, so an Attempt retired without a successor is settled under
 * exactly the same rule as one retired by its successor: the Attempt goes
 * terminal, its capacity reservation is released as `expired`, its budget
 * reservation is settled to the spend actually committed against it (released
 * when nothing was committed, otherwise `consumed` at that amount, never the
 * full reserved amount), and one `attempt.expired` event records it.
 *
 * Every statement is fenced to `timedOut.version + 1`, so the reservations and
 * the event land only if this batch is the one that actually flipped the
 * Attempt. A concurrent winner leaves every statement here a no-op, which is
 * what makes the sweep idempotent and safe to run repeatedly.
 *
 * `chk_work_attempt_terminal_state` requires `runtime_state`, `outcome` and
 * `finished_at` to move together; they are set in one statement for that reason.
 */
function buildAttemptExpiryStatements(
	db: DbQueryClient,
	params: {
		timedOut: TimedOutAttempt;
		at: string;
		reapedBy: "admission" | "sweeper";
	},
) {
	const { timedOut, at } = params;
	const nextVersion = timedOut.version + 1;
	const expireAttempt = db
		.update(workAttempts)
		.set({
			runtimeState: "expired",
			outcome: "expired",
			finishedAt: at,
			version: sql`${workAttempts.version} + 1`,
		})
		.where(
			and(
				eq(workAttempts.id, timedOut.id),
				eq(workAttempts.orgId, timedOut.orgId),
				eq(workAttempts.workItemId, timedOut.workItemId),
				eq(workAttempts.version, timedOut.version),
				inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
				sql`${workAttempts.expiresAt} IS NOT NULL AND ${workAttempts.expiresAt} <= ${at}`,
			),
		)
		.returning({ expiredAttemptId: workAttempts.id });
	const expireResources = db
		.update(workResourceReservations)
		.set({
			state: "expired",
			settledAt: at,
			version: sql`${workResourceReservations.version} + 1`,
		})
		.where(
			and(
				eq(workResourceReservations.orgId, timedOut.orgId),
				eq(workResourceReservations.workItemId, timedOut.workItemId),
				eq(workResourceReservations.state, "active"),
				sql`${workResourceReservations.expiresAt} <= ${at}`,
				sql`EXISTS (SELECT 1 FROM work_attempts AS timed_out_attempt WHERE timed_out_attempt.id = ${timedOut.id} AND timed_out_attempt.admission_id = ${workResourceReservations.admissionId} AND timed_out_attempt.org_id = ${workResourceReservations.orgId} AND timed_out_attempt.work_item_id = ${workResourceReservations.workItemId} AND timed_out_attempt.version = ${nextVersion} AND timed_out_attempt.runtime_state = 'expired' AND timed_out_attempt.finished_at = ${at})`,
			),
		);
	const consumeBudgets = db
		.update(workBudgetReservations)
		.set({
			...budgetSettlementValues({
				committedMicros: null,
				fullOnUnknown: false,
			}),
			settledAt: at,
			version: sql`${workBudgetReservations.version} + 1`,
		})
		.where(
			and(
				eq(workBudgetReservations.orgId, timedOut.orgId),
				eq(workBudgetReservations.workItemId, timedOut.workItemId),
				eq(workBudgetReservations.state, "active"),
				sql`${workBudgetReservations.expiresAt} <= ${at}`,
				sql`EXISTS (SELECT 1 FROM work_attempts AS timed_out_attempt WHERE timed_out_attempt.id = ${timedOut.id} AND timed_out_attempt.admission_id = ${workBudgetReservations.admissionId} AND timed_out_attempt.org_id = ${workBudgetReservations.orgId} AND timed_out_attempt.work_item_id = ${workBudgetReservations.workItemId} AND timed_out_attempt.version = ${nextVersion} AND timed_out_attempt.runtime_state = 'expired' AND timed_out_attempt.finished_at = ${at})`,
			),
		);
	const expiryEvent = db.insert(workEvents).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("id"),
				orgId: sql`${workAttempts.orgId}`
					.mapWith(workAttempts.orgId)
					.as("org_id"),
				workItemId: sql`${workAttempts.workItemId}`
					.mapWith(workAttempts.workItemId)
					.as("work_item_id"),
				attemptId: sql`${workAttempts.id}`
					.mapWith(workAttempts.id)
					.as("attempt_id"),
				eventType: sql<string>`'attempt.expired'`.as("event_type"),
				actorType: sql`${workAttempts.executorType}`
					.mapWith(workAttempts.executorType)
					.as("actor_type"),
				actorId: sql`${workAttempts.executorId}`
					.mapWith(workAttempts.executorId)
					.as("actor_id"),
				actorSessionId: sql`${workAttempts.executorSessionId}`
					.mapWith(workAttempts.executorSessionId)
					.as("actor_session_id"),
				payload: sql<Record<string, JsonValue>>`${JSON.stringify({
					outcome: "expired",
					reason: "lease_elapsed",
					expiresAt: timedOut.expiresAt,
					reapedBy: params.reapedBy,
				})}`.as("payload"),
				occurredAt: sql<string>`${at}`.as("occurred_at"),
			})
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.id, timedOut.id),
					eq(workAttempts.version, nextVersion),
					eq(workAttempts.runtimeState, "expired"),
					// `finished_at` is what distinguishes THIS batch's retirement
					// from a concurrent writer that reached the same version and
					// state at a different instant. Without it the event fires for
					// the winner's work.
					eq(workAttempts.finishedAt, at),
				),
			),
	);
	return [expireAttempt, expireResources, consumeBudgets, expiryEvent] as const;
}

export interface SweepElapsedWorkAttemptsResult {
	/** Timed-out attempts observed in this bounded pass. */
	observed: number;
	/** Attempts this pass moved to a terminal `expired` state. */
	expired: number;
	/** Attempts a concurrent writer had already retired. */
	skipped: number;
}

/**
 * Retire every Attempt whose lease has elapsed, without a fresh admission.
 *
 * An elapsed lease is normally reaped by the NEXT admitted `work start`, which
 * expires it and acquires a new fence in one batch. That path works, but it is
 * only reachable when the Work Item can be admitted at all: an item whose
 * operational purpose exception has expired fails admission on the purpose gate
 * BEFORE the reaping runs, so its dead lease is never retired, its capacity and
 * budget stay reserved against real envelopes, and `uniq_work_attempt_active`
 * keeps holding a slot for an executor that no longer exists. That is a
 * permanent strand: nothing in the admission path can ever clear it.
 *
 * This sweep decouples retirement from admission. It is scoped by lease, not by
 * org or item, so it needs no tenant context and no readiness evaluation, and
 * it reads through `idx_work_attempt_expiry` — an index that existed for this
 * job and had no user. It is bounded per pass and safe to run on any cadence:
 * re-running finds nothing because every retired Attempt has left the active
 * states its candidate query selects.
 */
export async function sweepElapsedWorkAttempts(
	db: DbQueryClient,
	options: { now?: string; limit?: number } = {},
): Promise<SweepElapsedWorkAttemptsResult> {
	const at = options.now ?? new Date().toISOString();
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200);
	const candidates = await db
		.select({
			id: workAttempts.id,
			admissionId: workAttempts.admissionId,
			orgId: workAttempts.orgId,
			workItemId: workAttempts.workItemId,
			expiresAt: workAttempts.expiresAt,
			version: workAttempts.version,
		})
		.from(workAttempts)
		.where(
			and(
				inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
				sql`${workAttempts.expiresAt} IS NOT NULL AND ${workAttempts.expiresAt} <= ${at}`,
			),
		)
		.orderBy(asc(workAttempts.expiresAt), asc(workAttempts.id))
		.limit(limit);
	const result: SweepElapsedWorkAttemptsResult = {
		observed: candidates.length,
		expired: 0,
		skipped: 0,
	};
	for (const candidate of candidates) {
		// One batch per Attempt: D1 batches are the transaction primitive, and an
		// Attempt's own retirement must be all-or-nothing. Retiring several in one
		// batch would need a per-row event id, which SQL cannot mint uniquely here.
		const [expiredRows] = await db.batch(
			buildAttemptExpiryStatements(db, {
				timedOut: candidate,
				at,
				reapedBy: "sweeper",
			}),
		);
		if (expiredRows.length > 0) result.expired += 1;
		else result.skipped += 1;
	}
	return result;
}

export async function startWorkItemAttempt(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		admissionId: string;
		executor: WorkExecutor;
		sessionId?: string;
		externalSessionKey?: string;
		runId?: string;
		expiresAt: string;
		metadata?: Record<string, JsonValue>;
		startedAt?: string;
	},
): Promise<{ workItem: WorkItem; attempt: WorkAttempt; resumed: boolean }> {
	const startedAt = params.startedAt ?? new Date().toISOString();
	const releaseLosingReservations = async () => {
		await db.batch([
			db
				.update(workResourceReservations)
				.set({
					state: "released",
					settledAt: startedAt,
					version: sql`${workResourceReservations.version} + 1`,
				})
				.where(
					and(
						eq(workResourceReservations.orgId, params.orgId),
						eq(workResourceReservations.admissionId, params.admissionId),
						eq(workResourceReservations.state, "active"),
					),
				),
			db
				.update(workBudgetReservations)
				.set({
					state: "released",
					settledAt: startedAt,
					version: sql`${workBudgetReservations.version} + 1`,
				})
				.where(
					and(
						eq(workBudgetReservations.orgId, params.orgId),
						eq(workBudgetReservations.admissionId, params.admissionId),
						eq(workBudgetReservations.state, "active"),
					),
				),
		]);
	};
	if (
		params.executor.type === "external_agent" &&
		(!params.sessionId || !params.externalSessionKey)
	) {
		throw new WorkFactoryError(
			"NOT_READY",
			"External attempts require a verified session id and immutable external session key",
		);
	}
	const existing = (
		await db
			.select()
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.admissionId, params.admissionId),
					eq(workAttempts.orgId, params.orgId),
					eq(workAttempts.workItemId, params.workItemId),
					eq(workAttempts.executorType, params.executor.type),
					eq(workAttempts.executorId, params.executor.id),
					params.sessionId
						? eq(workAttempts.executorSessionId, params.sessionId)
						: isNull(workAttempts.executorSessionId),
					params.externalSessionKey
						? eq(workAttempts.externalSessionKey, params.externalSessionKey)
						: isNull(workAttempts.externalSessionKey),
					inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
				),
			)
			.limit(1)
	)[0];
	if (existing && (!existing.expiresAt || existing.expiresAt > startedAt)) {
		return {
			workItem: await getScopedWorkItem(db, params.orgId, params.workItemId),
			attempt: existing,
			resumed: true,
		};
	}
	const attemptId = crypto.randomUUID();
	// The lease this admission reaps, resolved before the batch so the retirement
	// is fenced to an exact row and version. `expiresAt` is immutable for the
	// life of a lease, so evaluating the boundary against the same `startedAt`
	// here and inside the batch cannot disagree.
	const timedOut = await findTimedOutAttempt(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		at: startedAt,
	});
	const [
		expireTimedOut,
		expireTimedOutResources,
		consumeTimedOutBudgets,
		expiryEvent,
	] = timedOut
		? buildAttemptExpiryStatements(db, {
				timedOut,
				at: startedAt,
				reapedBy: "admission",
			})
		: buildAttemptExpiryStatements(db, {
				// No elapsed lease: keep the batch shape static with statements
				// whose primary-key predicate cannot match any row.
				timedOut: {
					id: "",
					admissionId: null,
					orgId: params.orgId,
					workItemId: params.workItemId,
					expiresAt: null,
					version: 0,
				},
				at: startedAt,
				reapedBy: "admission",
			});
	const insertAttempt = db
		.insert(workAttempts)
		.select(
			db
				.select({
					id: sql<string>`${attemptId}`.as("id"),
					admissionId: sql`${workAdmissions.id}`
						.mapWith(workAdmissions.id)
						.as("admission_id"),
					workItemId: sql`${workItems.id}`
						.mapWith(workItems.id)
						.as("work_item_id"),
					orgId: sql`${workItems.orgId}`.mapWith(workItems.orgId).as("org_id"),
					executorType: sql<
						"tedi" | "external_agent"
					>`${params.executor.type}`.as("executor_type"),
					executorId: sql<string>`${params.executor.id}`.as("executor_id"),
					executorSessionId: sql<string | null>`${params.sessionId ?? null}`.as(
						"executor_session_id",
					),
					externalSessionKey: sql<
						string | null
					>`${params.externalSessionKey ?? null}`.as("external_session_key"),
					runId: sql<string | null>`${params.runId ?? null}`.as("run_id"),
					runtimeState: sql<"running">`'running'`.as("runtime_state"),
					outcome: sql<null>`NULL`.as("outcome"),
					attemptNumber:
						sql<number>`COALESCE((SELECT MAX(prior.attempt_number) + 1 FROM work_attempts AS prior WHERE prior.org_id = ${params.orgId} AND prior.work_item_id = ${params.workItemId}), 1)`.as(
							"attempt_number",
						),
					startedAt: sql<string>`${startedAt}`.as("started_at"),
					heartbeatAt: sql<string>`${startedAt}`.as("heartbeat_at"),
					expiresAt: sql`${workAdmissions.expiresAt}`
						.mapWith(workAdmissions.expiresAt)
						.as("expires_at"),
					finishedAt: sql<null>`NULL`.as("finished_at"),
					summary: sql<null>`NULL`.as("summary"),
					version: sql<number>`1`.as("version"),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(params.metadata ?? {})}`.as("metadata"),
				})
				.from(workAdmissions)
				.innerJoin(
					workItems,
					and(
						eq(workItems.orgId, workAdmissions.orgId),
						eq(workItems.id, workAdmissions.workItemId),
					),
				)
				.where(
					and(
						eq(workAdmissions.id, params.admissionId),
						eq(workAdmissions.orgId, params.orgId),
						eq(workAdmissions.workItemId, params.workItemId),
						eq(workAdmissions.decision, "admitted"),
						sql`${workAdmissions.expiresAt} > ${startedAt}`,
						eq(workAdmissions.expiresAt, params.expiresAt),
						eq(workAdmissions.executorType, params.executor.type),
						eq(workAdmissions.executorId, params.executor.id),
						params.sessionId
							? eq(workAdmissions.executorSessionId, params.sessionId)
							: isNull(workAdmissions.executorSessionId),
						params.externalSessionKey
							? eq(workAdmissions.externalSessionKey, params.externalSessionKey)
							: isNull(workAdmissions.externalSessionKey),
						eq(workItems.version, workAdmissions.workItemVersion),
						eq(
							workItems.admissionSpecRevision,
							workAdmissions.admissionSpecRevision,
						),
						eq(workItems.disposition, "accepted"),
						// Recheck the server-derived factory cap in the INSERT itself.
						// An admitted receipt may predate another completed attempt.
						sql`(json_type(${workItems.metadata}, '$.factoryCycle') IS NULL OR (
							json_type(${workItems.metadata}, '$.factoryCycle.maxAttempts') = 'integer'
							AND json_extract(${workItems.metadata}, '$.factoryCycle.maxAttempts') BETWEEN 1 AND 5
							AND (SELECT COUNT(*) FROM work_attempts AS factory_prior
								WHERE factory_prior.org_id = ${params.orgId}
								AND factory_prior.work_item_id = ${params.workItemId})
								< json_extract(${workItems.metadata}, '$.factoryCycle.maxAttempts')
						))`,
					),
				),
		)
		.returning();
	const startEvent = db.insert(workEvents).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as("id"),
				orgId: workAttempts.orgId,
				workItemId: workAttempts.workItemId,
				attemptId: workAttempts.id,
				eventType: sql<string>`'attempt.started'`.as("event_type"),
				actorType: workAttempts.executorType,
				actorId: workAttempts.executorId,
				actorSessionId: workAttempts.executorSessionId,
				payload: sql<
					Record<string, JsonValue>
				>`${JSON.stringify({ runtimeState: "running" })}`.as("payload"),
				occurredAt: sql<string>`${startedAt}`.as("occurred_at"),
			})
			.from(workAttempts)
			.where(eq(workAttempts.id, attemptId)),
	);
	// D1 batch is the transaction primitive: expiring the timed-out authority and
	// acquiring its unique active slot must either both commit or neither commit.
	let attempt: WorkAttempt | undefined;
	try {
		const [, , , , inserted] = await db.batch([
			expireTimedOut,
			expireTimedOutResources,
			consumeTimedOutBudgets,
			expiryEvent,
			insertAttempt,
			startEvent,
		]);
		attempt = inserted[0];
	} catch (error) {
		const winner = (
			await db
				.select({ id: workAttempts.id })
				.from(workAttempts)
				.where(
					and(
						eq(workAttempts.orgId, params.orgId),
						eq(workAttempts.workItemId, params.workItemId),
						inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
						sql`${workAttempts.expiresAt}>${startedAt}`,
					),
				)
				.limit(1)
		)[0];
		if (!winner) throw error;
		// Only an authoritative active-slot winner proves this was a lost race.
		await releaseLosingReservations();
		throw new WorkFactoryError(
			"NOT_READY",
			"Attempt lost the active-slot race",
		);
	}
	if (!attempt) {
		await releaseLosingReservations();
		throw new WorkFactoryError("NOT_READY", "Attempt lost the admission race");
	}
	return {
		workItem: await getScopedWorkItem(db, params.orgId, params.workItemId),
		attempt,
		resumed: false,
	};
}

/**
 * Persist the secret-free repository receipt under the same live Attempt
 * fence used by heartbeat and evidence writes. Artifacts repository state is
 * provenance only: it never creates, extends, or revives execution authority.
 */
export async function recordWorkAttemptRepository(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		executor: WorkExecutor;
		sessionId?: string;
		externalSessionKey?: string;
		repository: WorkAttemptRepository;
		recordedAt?: string;
	},
): Promise<WorkAttempt> {
	const recordedAt = params.recordedAt ?? new Date().toISOString();
	if (
		params.repository.workItemId !== params.workItemId ||
		params.repository.attemptId !== params.attemptId
	) {
		throw new WorkFactoryError(
			"NOT_READY",
			"Repository provenance does not match the authoritative Attempt",
		);
	}
	const [attempt] = await db
		.update(workAttempts)
		.set({
			metadata: sql<
				Record<string, JsonValue>
			>`json_set(COALESCE(${workAttempts.metadata}, '{}'), '$.repository', json(${JSON.stringify(params.repository)}))`,
			version: sql`${workAttempts.version} + 1`,
		})
		.where(
			and(
				eq(workAttempts.id, params.attemptId),
				eq(workAttempts.orgId, params.orgId),
				eq(workAttempts.workItemId, params.workItemId),
				eq(workAttempts.admissionId, params.repository.admissionId),
				eq(workAttempts.executorType, params.executor.type),
				eq(workAttempts.executorId, params.executor.id),
				params.sessionId
					? eq(workAttempts.executorSessionId, params.sessionId)
					: isNull(workAttempts.executorSessionId),
				params.externalSessionKey
					? eq(workAttempts.externalSessionKey, params.externalSessionKey)
					: isNull(workAttempts.externalSessionKey),
				inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
				sql`${workAttempts.expiresAt} > ${recordedAt}`,
			),
		)
		.returning();
	if (!attempt) {
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			`Attempt ${params.attemptId} is no longer authoritative`,
		);
	}
	return attempt;
}

export async function heartbeatWorkItemAttempt(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		executor: WorkExecutor;
		sessionId?: string;
		externalSessionKey?: string;
		heartbeatAt?: string;
		leaseTtlMs: number;
		/** Spend committed so far by this Attempt, in micros; replaces the running total. */
		costMicros?: number;
	},
): Promise<WorkAttempt> {
	const heartbeatAt = params.heartbeatAt ?? new Date().toISOString();
	if (
		!Number.isFinite(params.leaseTtlMs) ||
		params.leaseTtlMs < 1_000 ||
		params.leaseTtlMs > 3_600_000
	) {
		throw new WorkFactoryError(
			"NOT_READY",
			"leaseTtlMs must be between 1000 and 3600000",
		);
	}
	const expiresAt = new Date(
		Date.parse(heartbeatAt) + params.leaseTtlMs,
	).toISOString();
	const heartbeatMutation = db
		.update(workAttempts)
		.set({
			heartbeatAt,
			expiresAt,
			version: sql`${workAttempts.version} + 1`,
		})
		.where(
			and(
				eq(workAttempts.id, params.attemptId),
				eq(workAttempts.orgId, params.orgId),
				eq(workAttempts.workItemId, params.workItemId),
				eq(workAttempts.executorType, params.executor.type),
				eq(workAttempts.executorId, params.executor.id),
				params.sessionId
					? eq(workAttempts.executorSessionId, params.sessionId)
					: isNull(workAttempts.executorSessionId),
				params.externalSessionKey
					? eq(workAttempts.externalSessionKey, params.externalSessionKey)
					: isNull(workAttempts.externalSessionKey),
				inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
				sql`${workAttempts.heartbeatAt} <= ${heartbeatAt}`,
				sql`${workAttempts.expiresAt} > ${heartbeatAt}`,
			),
		)
		.returning();
	const extendResources = db
		.update(workResourceReservations)
		.set({ expiresAt, version: sql`${workResourceReservations.version} + 1` })
		.where(
			and(
				eq(workResourceReservations.orgId, params.orgId),
				eq(workResourceReservations.workItemId, params.workItemId),
				eq(workResourceReservations.state, "active"),
				sql`EXISTS (SELECT 1 FROM work_attempts AS heartbeat_winner WHERE heartbeat_winner.id=${params.attemptId} AND heartbeat_winner.admission_id=${workResourceReservations.admissionId} AND heartbeat_winner.org_id=${workResourceReservations.orgId} AND heartbeat_winner.work_item_id=${workResourceReservations.workItemId} AND heartbeat_winner.heartbeat_at=${heartbeatAt} AND heartbeat_winner.expires_at=${expiresAt})`,
			),
		);
	const extendBudgets = db
		.update(workBudgetReservations)
		.set({
			expiresAt,
			...(params.costMicros === undefined
				? {}
				: {
						consumedMicros: sql`MIN(${Math.max(0, Math.trunc(params.costMicros))}, ${workBudgetReservations.amountMicros})`,
					}),
			version: sql`${workBudgetReservations.version} + 1`,
		})
		.where(
			and(
				eq(workBudgetReservations.orgId, params.orgId),
				eq(workBudgetReservations.workItemId, params.workItemId),
				eq(workBudgetReservations.state, "active"),
				sql`EXISTS (SELECT 1 FROM work_attempts AS heartbeat_winner WHERE heartbeat_winner.id=${params.attemptId} AND heartbeat_winner.admission_id=${workBudgetReservations.admissionId} AND heartbeat_winner.org_id=${workBudgetReservations.orgId} AND heartbeat_winner.work_item_id=${workBudgetReservations.workItemId} AND heartbeat_winner.heartbeat_at=${heartbeatAt} AND heartbeat_winner.expires_at=${expiresAt})`,
			),
		);
	const [heartbeatRows] = await db.batch([
		heartbeatMutation,
		extendResources,
		extendBudgets,
	]);
	const attempt = heartbeatRows[0];
	if (!attempt)
		throw new WorkFactoryError(
			"STALE_ATTEMPT",
			`Attempt ${params.attemptId} is no longer authoritative`,
		);
	return attempt;
}

/** Same-Attempt heartbeats racing a settle; each retry re-checks every fence. */
const SETTLE_VERSION_RETRIES = 3;

export async function settleWorkItemAttempt(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		executor: WorkExecutor;
		sessionId?: string;
		externalSessionKey?: string;
		outcome: WorkAttemptOutcome;
		summary?: string;
		metadata?: Record<string, JsonValue>;
		repositoryLifecycle?: WorkAttemptRepositoryLifecycle;
		/** Spend committed by this Attempt, in micros; replaces any running total. */
		costMicros?: number;
		settledAt?: string;
	},
): Promise<{ workItem: WorkItem; attempt: WorkAttempt }> {
	const settledAt = params.settledAt ?? new Date().toISOString();
	// A heartbeat from this same Attempt bumps its version without changing who
	// owns it. If one lands between the read and the write, re-check ownership
	// and retry instead of refusing a valid settle; anything that really changed
	// the fences (another executor or session, an ended state, an expired lease)
	// still fails in getAuthoritativeWorkItemAttempt.
	for (let tries = 0; ; tries++) {
		const prior = await getAuthoritativeWorkItemAttempt(db, {
			orgId: params.orgId,
			workItemId: params.workItemId,
			attemptId: params.attemptId,
			executor: params.executor,
			sessionId: params.sessionId,
			externalSessionKey: params.externalSessionKey,
			at: settledAt,
		});
		const runtimeState: WorkAttemptRuntimeState =
			params.outcome === "succeeded" ? "finished" : params.outcome;
		const settlementMetadata = buildWorkAttemptSettlementMetadata({
			priorMetadata: prior.metadata,
			metadata: params.metadata,
			repositoryLifecycle: params.repositoryLifecycle,
			attemptId: params.attemptId,
			workItemId: params.workItemId,
		});
		const settleMutation = db
			.update(workAttempts)
			.set({
				runtimeState,
				outcome: params.outcome,
				summary: params.summary,
				finishedAt: settledAt,
				metadata: settlementMetadata,
				version: sql`${workAttempts.version} + 1`,
			})
			.where(
				and(
					eq(workAttempts.id, params.attemptId),
					eq(workAttempts.orgId, params.orgId),
					eq(workAttempts.workItemId, params.workItemId),
					eq(workAttempts.executorType, params.executor.type),
					eq(workAttempts.executorId, params.executor.id),
					eq(workAttempts.version, prior.version),
					params.sessionId
						? eq(workAttempts.executorSessionId, params.sessionId)
						: isNull(workAttempts.executorSessionId),
					params.externalSessionKey
						? eq(workAttempts.externalSessionKey, params.externalSessionKey)
						: isNull(workAttempts.externalSessionKey),
					inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
					sql`${workAttempts.expiresAt} > ${settledAt}`,
				),
			)
			.returning();
		const settleEvent = db.insert(workEvents).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					orgId: workAttempts.orgId,
					workItemId: workAttempts.workItemId,
					attemptId: workAttempts.id,
					eventType: sql<string>`'attempt.settled'`.as("event_type"),
					actorType: workAttempts.executorType,
					actorId: workAttempts.executorId,
					actorSessionId: workAttempts.executorSessionId,
					payload: sql<
						Record<string, JsonValue>
					>`${JSON.stringify({ outcome: params.outcome, summary: params.summary ?? null })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${settledAt}`.as("occurred_at"),
				})
				.from(workAttempts)
				.where(
					and(
						eq(workAttempts.id, params.attemptId),
						eq(workAttempts.version, prior.version + 1),
						eq(workAttempts.runtimeState, runtimeState),
					),
				),
		);
		const releaseResources = db
			.update(workResourceReservations)
			.set({
				state: "released",
				settledAt,
				version: sql`${workResourceReservations.version} + 1`,
			})
			.where(
				and(
					eq(workResourceReservations.orgId, params.orgId),
					eq(workResourceReservations.workItemId, params.workItemId),
					eq(workResourceReservations.state, "active"),
					sql`EXISTS (SELECT 1 FROM work_attempts AS settlement_winner WHERE settlement_winner.id=${params.attemptId} AND settlement_winner.admission_id=${workResourceReservations.admissionId} AND settlement_winner.org_id=${workResourceReservations.orgId} AND settlement_winner.work_item_id=${workResourceReservations.workItemId} AND settlement_winner.version=${prior.version + 1} AND settlement_winner.runtime_state=${runtimeState})`,
				),
			);
		const consumeBudgets = db
			.update(workBudgetReservations)
			.set({
				...budgetSettlementValues({
					committedMicros: params.costMicros,
					fullOnUnknown:
						params.outcome === "succeeded" || params.outcome === "failed",
				}),
				settledAt,
				version: sql`${workBudgetReservations.version} + 1`,
			})
			.where(
				and(
					eq(workBudgetReservations.orgId, params.orgId),
					eq(workBudgetReservations.workItemId, params.workItemId),
					eq(workBudgetReservations.state, "active"),
					sql`EXISTS (SELECT 1 FROM work_attempts AS settlement_winner WHERE settlement_winner.id=${params.attemptId} AND settlement_winner.admission_id=${workBudgetReservations.admissionId} AND settlement_winner.org_id=${workBudgetReservations.orgId} AND settlement_winner.work_item_id=${workBudgetReservations.workItemId} AND settlement_winner.version=${prior.version + 1} AND settlement_winner.runtime_state=${runtimeState})`,
				),
			);
		const [settledRows] = await db.batch([
			settleMutation,
			releaseResources,
			consumeBudgets,
			settleEvent,
		]);
		const attempt = settledRows[0];
		if (attempt)
			return {
				workItem: await getScopedWorkItem(db, params.orgId, params.workItemId),
				attempt,
			};
		if (tries >= SETTLE_VERSION_RETRIES)
			throw new WorkFactoryError(
				"STALE_ATTEMPT",
				`Attempt ${params.attemptId} is no longer authoritative`,
			);
	}
}

/** Preserve admission provenance while accepting bounded settlement receipts. */
export function buildWorkAttemptSettlementMetadata(params: {
	priorMetadata: Record<string, JsonValue>;
	metadata?: Record<string, JsonValue>;
	repositoryLifecycle?: WorkAttemptRepositoryLifecycle;
	attemptId: string;
	workItemId: string;
}): Record<string, JsonValue> {
	const {
		repository: _ignoredRepository,
		repositoryLifecycle: _ignoredLifecycle,
		...callerMetadata
	} = params.metadata ?? {};
	if (params.repositoryLifecycle) {
		const repository = WorkAttemptRepositorySchema.safeParse(
			params.priorMetadata.repository,
		);
		if (
			!repository.success ||
			repository.data.status !== "ready" ||
			repository.data.attemptId !== params.attemptId ||
			repository.data.workItemId !== params.workItemId
		) {
			throw new WorkFactoryError(
				"NOT_READY",
				"Repository lifecycle receipt requires this Attempt's ready Artifacts repository",
			);
		}
	}
	return {
		...params.priorMetadata,
		...callerMetadata,
		...(params.repositoryLifecycle
			? { repositoryLifecycle: params.repositoryLifecycle }
			: {}),
	} as Record<string, JsonValue>;
}

export async function listWorkItemAttempts(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		cursor?: { startedAt: string; id: string };
		limit?: number;
	},
): Promise<{
	data: WorkAttempt[];
	nextCursor: { startedAt: string; id: string } | null;
}> {
	const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 50)), 100);
	const rows = await db
		.select()
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				eq(workAttempts.workItemId, params.workItemId),
				params.cursor
					? or(
							lt(workAttempts.startedAt, params.cursor.startedAt),
							and(
								eq(workAttempts.startedAt, params.cursor.startedAt),
								lt(workAttempts.id, params.cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(workAttempts.startedAt), desc(workAttempts.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit),
		last = data.at(-1);
	return {
		data,
		nextCursor:
			rows.length > limit && last
				? { startedAt: last.startedAt, id: last.id }
				: null,
	};
}

/**
 * Runtime states in which an Attempt still holds its Work Item. Mirrors the
 * partial index `idx_work_attempt_live` and the schema CHECK that pairs a live
 * state with a null `finishedAt`/`outcome` — keep the three in step.
 */
export const LIVE_WORK_ATTEMPT_RUNTIME_STATES = [
	"queued",
	"running",
	"waiting",
	"retrying",
] as const;

export type LiveWorkAttemptHolder = {
	attemptId: string;
	executorType: string;
	executorId: string;
	agentSession: string | null;
	startedAt: string;
	heartbeatAt: string;
	expiresAt: string | null;
};

/**
 * Who currently holds each Work Item in this org, keyed by work item id.
 *
 * Deliberately a SEPARATE query rather than a join onto the list page. Two
 * reasons, both load-bearing: D1 batch results are object rows and collapse
 * two selected columns sharing an output name before Drizzle maps them, so a
 * join here would have to carry `prefixedColumns()` forever; and the list page
 * may return up to 100 ids, which with the org id would sit exactly at D1's
 * 100 bound-parameter ceiling. Filtering by org and live state instead takes
 * five parameters regardless of page size.
 *
 * Live attempts are few — they expire on a short lease — so `limit` exists to
 * bound a pathological org rather than to paginate. Callers get whatever fits;
 * a missing holder renders as "no live attempt", which is also what a caller
 * would conclude from a stale read a moment later.
 */
export async function listLiveWorkAttemptHolders(
	db: DbQueryClient,
	params: { orgId: string; limit?: number },
): Promise<Map<string, LiveWorkAttemptHolder>> {
	const limit = Math.min(Math.max(Math.trunc(params.limit ?? 200), 1), 500);
	const rows = await db
		.select({
			workItemId: workAttempts.workItemId,
			attemptId: workAttempts.id,
			executorType: workAttempts.executorType,
			executorId: workAttempts.executorId,
			externalSessionKey: workAttempts.externalSessionKey,
			startedAt: workAttempts.startedAt,
			heartbeatAt: workAttempts.heartbeatAt,
			expiresAt: workAttempts.expiresAt,
		})
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				inArray(workAttempts.runtimeState, [
					...LIVE_WORK_ATTEMPT_RUNTIME_STATES,
				]),
			),
		)
		.orderBy(desc(workAttempts.startedAt))
		.limit(limit);
	const holders = new Map<string, LiveWorkAttemptHolder>();
	for (const row of rows) {
		// Ordered newest first, so the first row for an item is the current one.
		if (holders.has(row.workItemId)) continue;
		holders.set(row.workItemId, {
			attemptId: row.attemptId,
			executorType: row.executorType,
			executorId: row.executorId,
			agentSession: row.externalSessionKey ?? null,
			startedAt: row.startedAt,
			heartbeatAt: row.heartbeatAt,
			expiresAt: row.expiresAt ?? null,
		});
	}
	return holders;
}
