import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";

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
		WHEN EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id=${workAttempts.orgId} AND i.work_item_id=${workAttempts.workItemId} AND i.status='open' AND i.target_type='user' AND i.kind IN ('question','input','handoff') AND (i.expires_at IS NULL OR i.expires_at>${now}))
			OR EXISTS (SELECT 1 FROM agent_session_requests r JOIN external_agent_principals p ON p.organization_id=r.organization_id AND p.credential_binding_type='owner_user' AND p.credential_binding_id=r.user_id WHERE r.organization_id=${workAttempts.orgId} AND p.id=${workAttempts.executorId} AND r.harness || ':' || r.session_key=${workAttempts.externalSessionKey} AND r.project_id=${workItems.projectId} AND r.status_changed_at>=${workAttempts.startedAt} AND r.status='waiting_on_user') THEN 'needs-human'
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
export async function recordStaleLanes(db: DbQueryClient, now: string) {
	const due = and(
		eq(workAttempts.executorType, "external_agent"),
		sql`json_extract(${workAttempts.metadata}, '$.lane') = 1`,
		sql`${workAttempts.outcome} IS NULL`,
		sql`julianday(${now}) >= (julianday(${workAttempts.heartbeatAt}) + julianday(${workAttempts.expiresAt})) / 2`,
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

/** Retry notifications from the ledger even if a previous tick died after commit. */
export async function notifyStoppedLanes(db: DbQueryClient, now: string) {
	const eligible = and(
		sql`${workEvents.eventType} IN ('lane.stale', 'attempt.expired')`,
		sql`json_extract(${workAttempts.metadata}, '$.lane') = 1`,
		sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
		sql`NOT EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id = ${workEvents.orgId} AND i.id = ${workEvents.id})`,
		sql`NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id = ${workAttempts.orgId} AND a.work_item_id = ${workAttempts.workItemId} AND a.attempt_number > ${workAttempts.attemptNumber})`,
		sql`(${workEvents.eventType} = 'attempt.expired' OR (json_extract(${workEvents.payload}, '$.heartbeatAt') = ${workAttempts.heartbeatAt} AND ${workAttempts.outcome} IS NULL))`,
	);
	const rows = await db
		.select({
			id: workEvents.id,
			eventType: workEvents.eventType,
			title: workItems.title,
			workItemId: sql<string>`${workItems.id}`.as("lane_work_item_id"),
			orgId: workEvents.orgId,
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
		.innerJoin(
			externalAgentPrincipals,
			and(
				eq(externalAgentPrincipals.organizationId, workAttempts.orgId),
				eq(externalAgentPrincipals.id, workAttempts.executorId),
				eq(externalAgentPrincipals.credentialBindingType, "owner_user"),
			),
		)
		.where(eligible)
		.orderBy(asc(workEvents.sequence))
		.limit(100);
	let notified = 0;
	for (const row of rows) {
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
						targetType: sql<string>`'user'`.as("target_type"),
						targetId: externalAgentPrincipals.credentialBindingId,
						subject:
							sql<string>`${`${row.eventType === "lane.stale" ? "Lane stale" : "Lane failed"}: ${row.title}`}`.as(
								"subject",
							),
						prompt:
							sql<string>`${`Heartbeat stopped. Tedix recorded ${row.eventType} for /work/items/${row.workItemId}. Read the current Attempt before retrying. Work remains in its project backlog after the lease expires.`}`.as(
								"prompt",
							),
						metadata:
							sql<string>`${JSON.stringify({ laneLifecycle: { eventId: row.id, state: row.eventType === "lane.stale" ? "stale" : "failed" }, notification: { state: "immediate" } })}`.as(
								"metadata",
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
							eq(externalAgentPrincipals.credentialBindingType, "owner_user"),
						),
					)
					.where(
						and(
							eligible,
							eq(workAttempts.orgId, row.orgId),
							eq(workAttempts.workItemId, row.workItemId),
						),
					),
			)
			.onConflictDoNothing()
			.returning({ id: workInteractions.id });
		notified += created.length;
	}
	return notified;
}
