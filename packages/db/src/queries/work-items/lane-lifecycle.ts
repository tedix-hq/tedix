import { advancePlatformCronCheckpoint } from "../platform-cron-executions";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { tedis } from "../../schema/tedis";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";

export async function readLaneState(
	db: DbQueryClient,
	orgId: string,
	attemptId: string,
	now: string,
) {
	const [row] = await db
		.select({
			state: sql<
				"ready" | "needs-human" | "blocked" | "stale" | "failed" | "done" | null
			>`CASE
		WHEN json_extract(${workAttempts.metadata}, '$.lane') IS NOT 1 THEN NULL
		WHEN ${workAttempts.outcome} IN ('failed','expired','cancelled') OR ${workAttempts.expiresAt} <= ${now} AND ${workAttempts.outcome} IS NULL THEN 'failed'
		WHEN ${workAttempts.outcome} IS NULL AND julianday(${now}) >= (julianday(${workAttempts.heartbeatAt}) + julianday(${workAttempts.expiresAt})) / 2 THEN 'stale'
		WHEN EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id=${workAttempts.orgId} AND i.work_item_id=${workAttempts.workItemId} AND i.status='open' AND i.target_type='user' AND i.kind IN ('question','input','handoff') AND (i.expires_at IS NULL OR i.expires_at>${now})) THEN 'needs-human'
		WHEN EXISTS (SELECT 1 FROM agent_session_requests r JOIN external_agent_principals p ON p.organization_id=r.organization_id AND p.credential_binding_type='owner_user' AND p.credential_binding_id=r.user_id WHERE r.organization_id=${workAttempts.orgId} AND p.id=${workAttempts.executorId} AND r.harness || ':' || r.session_key=${workAttempts.externalSessionKey} AND r.project_id=${workItems.projectId} AND r.status_changed_at>=${workAttempts.startedAt} AND r.status='waiting_on_user') THEN 'blocked'
		WHEN ${workAttempts.outcome}='succeeded' THEN 'done'
		WHEN ${workAttempts.runtimeState}='waiting' OR ${workItems.disposition}='cancelled' THEN 'blocked'
		ELSE 'ready' END`.as("lane_state"),
		})
		.from(workAttempts)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workAttempts.orgId),
				eq(workItems.id, workAttempts.workItemId),
			),
		)
		.where(and(eq(workAttempts.orgId, orgId), eq(workAttempts.id, attemptId)))
		.limit(1);
	return row?.state ?? null;
}

/** N is half the server-issued lease; expiry at 2N remains the Work fence. */
export async function recordStaleLanes(
	db: DbQueryClient,
	now: string,
	scope?: { orgId: string; ids: string[] },
) {
	const due = and(
		scope
			? and(
					eq(workAttempts.orgId, scope.orgId),
					inArray(workAttempts.id, scope.ids),
				)
			: undefined,
		eq(workAttempts.executorType, "external_agent"),
		sql`json_extract(${workAttempts.metadata}, '$.lane') = 1`,
		sql`${workAttempts.outcome} IS NULL`,
		// An Attempt without an outcome is in one of these states
		// (chk_work_attempt_terminal_state), so this changes no result. It
		// is uniq_work_attempt_active's own condition, word for word, and
		// lets the sweep read the few live Attempts instead of every Attempt
		// ever made.
		sql`${workAttempts.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')`,
		sql`strftime('%Y-%m-%dT%H:%M:%fZ', (julianday(${workAttempts.heartbeatAt}) + julianday(${workAttempts.expiresAt})) / 2) <= ${now}`,
		sql`NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id = ${workAttempts.orgId} AND e.attempt_id = ${workAttempts.id} AND e.event_type = 'lane.stale' AND json_extract(e.payload, '$.heartbeatAt') = ${workAttempts.heartbeatAt})`,
	);
	const candidates = await db
		.select({
			id: workAttempts.id,
			orgId: workAttempts.orgId,
			heartbeatAt: workAttempts.heartbeatAt,
		})
		.from(workAttempts)
		.where(due)
		.orderBy(asc(workAttempts.heartbeatAt), asc(workAttempts.id))
		.limit(100);
	let recorded = 0;
	for (const candidate of candidates) {
		const rows = await db
			.insert(workEvents)
			.select(
				db
					.select({
						id: sql<string>`${crypto.randomUUID()}`.as("id"),
						orgId: workAttempts.orgId,
						workItemId: workAttempts.workItemId,
						attemptId: sql<string>`${workAttempts.id}`.as("attempt_id"),
						eventType: sql<string>`'lane.stale'`.as("event_type"),
						actorType: sql<string>`'system'`.as("actor_type"),
						actorId: sql<string>`'tedix'`.as("actor_id"),
						payload:
							sql<string>`json_object('heartbeatAt', ${workAttempts.heartbeatAt})`.as(
								"payload",
							),
						occurredAt: sql<string>`${now}`.as("occurred_at"),
					})
					.from(workAttempts)
					.where(
						and(
							due,
							eq(workAttempts.id, candidate.id),
							eq(workAttempts.orgId, candidate.orgId),
							eq(workAttempts.heartbeatAt, candidate.heartbeatAt),
						),
					),
			)
			.returning({ id: workEvents.id });
		recorded += rows.length;
	}
	return recorded;
}

/** Stopped-lane events at or below this sequence were examined by an earlier tick. */
const STOPPED_LANE_CHECKPOINT = "stopped-lane-notices";

/** Events one call notifies at most; the rest wait for the next call. */
const STOPPED_LANE_NOTICES_PER_CALL = 100;

/**
 * Retry notifications from the ledger even if a previous tick died after commit.
 *
 * A stopped-lane event is due a notice when it is written or never, unless
 * something outside the lane changes later: its agent is reactivated or its
 * Work is reopened. So a call examines
 * the events written since the last call that finished, which a checkpoint
 * remembers, and a call with `wholeLedger` examines every event ever written,
 * as each call used to. The checkpoint moves only after the notices of a call
 * are written; a call that dies examines the same events again.
 *
 * Without `wholeLedger`, an event that becomes due only through one of those
 * later changes is noticed by the next whole-ledger call instead of the next
 * call. Which events are noticed, and what a notice says, does not change.
 */
export async function notifyStoppedLanes(
	db: DbQueryClient,
	now: string,
	options: { wholeLedger?: boolean } = {},
) {
	const stoppedLaneEvent = sql`${workEvents.eventType} IN ('lane.stale', 'attempt.expired')`;
	let examinedThrough = 0;
	if (!options.wholeLedger) {
		const [checkpoint] = await db
			.select({ through: platformCronCheckpoints.through })
			.from(platformCronCheckpoints)
			.where(eq(platformCronCheckpoints.scheduleId, STOPPED_LANE_CHECKPOINT))
			.limit(1);
		const through = Number(checkpoint?.through);
		if (Number.isSafeInteger(through) && through > 0) examinedThrough = through;
	}
	// Read before the events: one written while this call runs has a higher
	// sequence and is left for the next call.
	const [newest] = await db
		.select({ sequence: workEvents.sequence })
		.from(workEvents)
		.where(stoppedLaneEvent)
		.orderBy(desc(workEvents.sequence))
		.limit(1);
	if (!newest || newest.sequence <= examinedThrough) return 0;
	const machineTedi = sql<string | null>`COALESCE(
		(SELECT id FROM ${tedis} WHERE organization_id=${workItems.orgId} AND id=${workItems.stewardId} AND ${workItems.stewardType}='tedi' AND retired_at IS NULL AND status='active'),
		(SELECT id FROM ${tedis} WHERE organization_id=${workItems.orgId} AND id=${workItems.accountableOwnerId} AND ${workItems.accountableOwnerType}='tedi' AND retired_at IS NULL AND status='active'))`;
	const targetType = sql<string>`CASE WHEN ${machineTedi} IS NOT NULL THEN 'tedi' ELSE 'external_agent' END`;
	const targetId = sql<string>`COALESCE(${machineTedi},${workAttempts.executorId})`;
	// Joining principals let SQLite drive from every principal and rescan its
	// tenant's stopped events (10.4M rows per tick in production); an existence
	// check keeps the partial stopped-lane index as the driving scan.
	const eligible = and(
		stoppedLaneEvent,
		sql`EXISTS (SELECT 1 FROM ${externalAgentPrincipals} p WHERE p.organization_id = ${workAttempts.orgId} AND p.id = ${workAttempts.executorId} AND p.status = 'active')`,
		sql`json_extract(${workAttempts.metadata}, '$.lane') = 1`,
		sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
		sql`NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = ${workEvents.orgId} AND i.id = ${workEvents.id})`,
		sql`NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id = ${workAttempts.orgId} AND a.work_item_id = ${workAttempts.workItemId} AND a.attempt_number > ${workAttempts.attemptNumber})`,
		sql`(${workEvents.eventType} = 'attempt.expired' OR (json_extract(${workEvents.payload}, '$.heartbeatAt') = ${workAttempts.heartbeatAt} AND ${workAttempts.outcome} IS NULL))`,
	);
	const rows = await db
		.select({
			id: workEvents.id,
			sequence: workEvents.sequence,
			eventType: workEvents.eventType,
			title: workItems.title,
			workItemId: sql<string>`${workItems.id}`.as("lane_work_item_id"),
			orgId: workEvents.orgId,
			targetType: targetType.as("repair_target_type"),
			targetId: targetId.as("repair_target_id"),
			attemptNumber: workAttempts.attemptNumber,
			maxAttempts: workItems.maxAttempts,
		})
		.from(workEvents)
		.innerJoin(
			workAttempts,
			and(
				eq(workAttempts.orgId, workEvents.orgId),
				eq(workAttempts.id, workEvents.attemptId),
			),
		)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workEvents.orgId),
				eq(workItems.id, workEvents.workItemId),
			),
		)
		.where(and(eligible, gt(workEvents.sequence, examinedThrough)))
		.orderBy(asc(workEvents.sequence))
		.limit(STOPPED_LANE_NOTICES_PER_CALL);
	let notified = 0;
	for (const row of rows) {
		const nextMover = { type: row.targetType, id: row.targetId };
		// The lane policy owns the budget; Work without one keeps one retry.
		const maxAttempts = row.maxAttempts ?? 2;
		const retryAvailable = row.attemptNumber < maxAttempts;
		const nextMoverLabel = `${nextMover.type} ${nextMover.id}`;
		const prompt = retryAvailable
			? `Heartbeat stopped. Tedix recorded ${row.eventType} for /work/items/${row.workItemId}. The named next mover is ${nextMoverLabel}. ${maxAttempts - row.attemptNumber === 1 ? "One automatic retry is allowed" : `${maxAttempts - row.attemptNumber} automatic retries are allowed`}; if it also stops, the item is blocked and needs the recovery action below.`
			: `The bounded retry for /work/items/${row.workItemId} also stopped (${row.eventType}). The item is blocked. The named next mover is ${nextMoverLabel}; inspect the latest Attempt and start one new governed Attempt after fixing the worker or scheduler.`;
		const laneLifecycle = {
			eventId: row.id,
			state: retryAvailable
				? row.eventType === "lane.stale"
					? "stale"
					: "failed"
				: "blocked",
			nextMover,
			recovery: retryAvailable
				? {
						action: "automatic_retry_once",
						attemptNumber: row.attemptNumber,
						maxAttempts,
					}
				: {
						action: "inspect_latest_attempt_and_start_governed_attempt",
						attemptNumber: row.attemptNumber,
						maxAttempts,
					},
		};
		const created = await db
			.insert(workInteractions)
			.select(
				db
					.select({
						id: sql<string>`${row.id}`.as("id"),
						orgId: workAttempts.orgId,
						workItemId: workAttempts.workItemId,
						projectId: workItems.projectId,
						kind: sql<string>`'coordination'`.as("kind"),
						creatorType: sql<string>`'system'`.as("creator_type"),
						creatorId: sql<string>`'tedix'`.as("creator_id"),
						targetType: targetType.as("target_type"),
						targetId: targetId.as("target_id"),
						subject:
							sql<string>`${`${row.eventType === "lane.stale" ? "Lane stale" : "Lane failed"}: ${row.title}`}`.as(
								"subject",
							),
						prompt: sql<string>`${prompt}`.as("prompt"),
						metadata:
							sql<string>`${JSON.stringify({ laneLifecycle, reason: "A stopped lane needs machine investigation, not human approval.", evidenceRefs: [`/work/items/${row.workItemId}`], notification: { state: "immediate" } })}`.as(
								"metadata",
							),
						dueAt:
							sql<string>`${new Date(Date.parse(now) + 3_600_000).toISOString()}`.as(
								"due_at",
							),
						createdAt: sql<string>`${now}`.as("created_at"),
						expiresAt:
							sql<string>`${new Date(Date.parse(now) + 86_400_000).toISOString()}`.as(
								"expires_at",
							),
					})
					.from(workAttempts)
					.innerJoin(
						workEvents,
						and(
							eq(workEvents.orgId, workAttempts.orgId),
							eq(workEvents.attemptId, workAttempts.id),
							eq(workEvents.id, row.id),
						),
					)
					.innerJoin(
						workItems,
						and(
							eq(workItems.orgId, workAttempts.orgId),
							eq(workItems.id, workAttempts.workItemId),
						),
					)
					.innerJoin(
						externalAgentPrincipals,
						and(
							eq(externalAgentPrincipals.organizationId, workAttempts.orgId),
							eq(externalAgentPrincipals.id, workAttempts.executorId),
							eq(externalAgentPrincipals.status, "active"),
						),
					)
					.where(
						and(
							eligible,
							sql`${targetType}=${row.targetType} AND ${targetId}=${row.targetId}`,
							eq(workAttempts.orgId, row.orgId),
							eq(workAttempts.workItemId, row.workItemId),
						),
					),
			)
			.onConflictDoNothing()
			.returning({ id: workInteractions.id });
		// A hold with its reason, like a runner's own: the Work is listed as
		// stuck and its next edit makes it ready again. This used to write a
		// `blocked` state that no list showed and no edit released; by 16 Nov
		// 2026 it had parked 110 of the 199 accepted tasks assigned to runners.
		const hold = {
			reason: `Run ${row.attemptNumber} of this task stopped before it finished (${row.eventType === "lane.stale" ? "no heartbeat" : "its time ran out"}). The task's retry budget of ${maxAttempts} ${maxAttempts === 1 ? "run" : "runs"} is spent. Check the last run, then edit the task to have an agent start it again.`,
		};
		if (created.length > 0 && !retryAvailable)
			await db
				.update(workItems)
				.set({
					dispatchState: "held",
					metadata: sql`json_set(${workItems.metadata}, '$.laneDispatch', json(${JSON.stringify(hold)}), '$.laneLifecycle', json(${JSON.stringify(laneLifecycle)}))`,
				})
				.where(
					and(eq(workItems.orgId, row.orgId), eq(workItems.id, row.workItemId)),
				);
		notified += created.length;
	}
	// A full page may have left due events behind it; a short one examined
	// every event up to the newest read above. Never moves backwards, so a
	// whole-ledger call that notices old events keeps the newer position.
	const examined =
		rows.length < STOPPED_LANE_NOTICES_PER_CALL
			? newest.sequence
			: rows.at(-1)!.sequence;
	await advancePlatformCronCheckpoint(db, {
		scheduleId: STOPPED_LANE_CHECKPOINT,
		through: String(examined),
		mode: "numeric",
	});
	return notified;
}
