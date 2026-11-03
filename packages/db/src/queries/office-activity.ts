import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { OfficeActivityRow } from "@tedix/api-contract/schemas/office-activity";
import type { DbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { getUserConfig } from "./user-configs";
import {
	workInteractions,
	workInteractionResponses,
	workInteractionDeliveries,
} from "../schema/work-factory";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { workEvents, workAttempts } from "../schema/work-items";

export const OFFICE_HISTORY_LIMIT = 200;
export const OFFICE_HISTORY_MS = 24 * 60 * 60 * 1000;

function identity(owner: { organizationId: string; userId: string }) {
	return {
		userId: owner.userId,
		namespace: "office.operations.v1",
		key: owner.organizationId,
	};
}

/** One bounded personal snapshot per tenant, never an append-only event ledger.
 * SQL merges against the stored value, so overlapping hooks cannot lose rows.
 * Reads also enforce age: an offline reporter cannot extend history retention.
 */
export async function recordOfficeObservation(
	db: DbQueryClient,
	owner: { organizationId: string; userId: string },
	row: OfficeActivityRow,
	now: string,
) {
	const key = identity(owner);
	const cutoff = new Date(Date.parse(now) - OFFICE_HISTORY_MS).toISOString();
	await db
		.insert(userConfigs)
		.values({
			id: crypto.randomUUID(),
			...key,
			value: { rows: [row] },
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [userConfigs.userId, userConfigs.namespace, userConfigs.key],
			set: {
				value: sql`json_object('rows', json((SELECT json_group_array(json(value)) FROM (
 SELECT value FROM (
 SELECT value FROM json_each(${userConfigs.value}, '$.rows')
 UNION ALL SELECT value FROM json_each(excluded.value, '$.rows')
 WHERE NOT EXISTS (SELECT 1 FROM json_each(${userConfigs.value}, '$.rows') old WHERE json_extract(old.value, '$.id') = ${row.id})
 ) WHERE json_extract(value, '$.at') >= ${cutoff}
 ORDER BY json_extract(value, '$.at') DESC, json_extract(value, '$.id') DESC LIMIT ${OFFICE_HISTORY_LIMIT}
))))`,
				updatedAt: now,
			},
		});
}

export async function readOfficeObservations(
	db: DbQueryClient,
	owner: { organizationId: string; userId: string },
) {
	return (await getUserConfig(db, identity(owner)))?.value.rows ?? [];
}

export async function officeReplyReference(
	db: DbQueryClient,
	owner: { organizationId: string; userId: string; descopeUserId: string },
	input: {
		sessionKey: string;
		host: string;
		requestId?: string;
		responseId?: string;
	},
) {
	if (!input.requestId || !input.responseId) return null;
	const native = input.sessionKey.replace(new RegExp(`^${input.host}:`), "");
	const [row] = await db
		.select({ workItemId: workInteractions.workItemId })
		.from(workInteractions)
		.innerJoin(
			workInteractionResponses,
			and(
				eq(workInteractionResponses.orgId, workInteractions.orgId),
				eq(workInteractionResponses.interactionId, workInteractions.id),
			),
		)
		.where(
			and(
				eq(workInteractions.orgId, owner.organizationId),
				eq(workInteractions.id, input.requestId),
				eq(workInteractionResponses.id, input.responseId),
				eq(workInteractions.targetType, "user"),
				inArray(workInteractions.targetId, [owner.userId, owner.descopeUserId]),
				eq(workInteractionResponses.responderType, "user"),
				inArray(workInteractionResponses.responderId, [
					owner.userId,
					owner.descopeUserId,
				]),
				sql`json_extract(${workInteractions.metadata}, '$.sessionId') IN (${input.sessionKey}, ${native})`,
				sql`json_extract(${workInteractions.metadata}, '$.host') = ${input.host}`,
			),
		)
		.limit(1);
	return row ?? null;
}

/** Select receipt metadata only; neither answers nor Work summaries leave D1. */
export async function readOfficeCanonicalSources(
	db: DbQueryClient,
	owner: { organizationId: string; userId: string; descopeUserId: string },
	since: string,
) {
	const replies = await db
		.select({
			responseId: sql<string>`${workInteractionResponses.id}`.as(
				"office_response_id",
			),
			requestId: sql<string>`${workInteractions.id}`.as("office_request_id"),
			workItemId: workInteractions.workItemId,
			sessionKey: sql<
				string | null
			>`json_extract(${workInteractions.metadata}, '$.sessionId')`.as(
				"office_reply_session",
			),
			host: sql<
				string | null
			>`json_extract(${workInteractions.metadata}, '$.host')`.as(
				"office_reply_host",
			),
			savedAt: workInteractionResponses.respondedAt,
			deliveredAt: workInteractionDeliveries.deliveredAt,
			acknowledgedAt: workInteractionDeliveries.acknowledgedAt,
			via: workInteractionDeliveries.deliveredVia,
		})
		.from(workInteractions)
		.innerJoin(
			workInteractionResponses,
			and(
				eq(workInteractionResponses.orgId, workInteractions.orgId),
				eq(workInteractionResponses.interactionId, workInteractions.id),
			),
		)
		.leftJoin(
			workInteractionDeliveries,
			and(
				eq(workInteractionDeliveries.orgId, workInteractionResponses.orgId),
				eq(workInteractionDeliveries.responseId, workInteractionResponses.id),
			),
		)
		.where(
			and(
				eq(workInteractions.orgId, owner.organizationId),
				eq(workInteractions.targetType, "user"),
				inArray(workInteractions.targetId, [owner.userId, owner.descopeUserId]),
				eq(workInteractionResponses.responderType, "user"),
				inArray(workInteractionResponses.responderId, [
					owner.userId,
					owner.descopeUserId,
				]),
				gte(workInteractionResponses.respondedAt, since),
				sql`json_extract(${workInteractions.metadata}, '$.sessionId') IS NOT NULL`,
				sql`COALESCE(json_extract(${workInteractionResponses.metadata}, '$.delivery'), '') <> 'none'`,
			),
		)
		.orderBy(
			desc(workInteractionResponses.respondedAt),
			desc(workInteractionResponses.id),
		)
		.limit(50);
	const events = await db
		.select({
			id: workEvents.id,
			at: workEvents.occurredAt,
			eventType: workEvents.eventType,
			workItemId: workEvents.workItemId,
			attemptId: sql<string | null>`${workAttempts.id}`.as("office_attempt_id"),
			sessionKey: sql<
				string | null
			>`COALESCE(${workEvents.actorSessionId}, ${workAttempts.externalSessionKey})`.as(
				"office_work_session",
			),
			outcome: workAttempts.outcome,
			resultRecorded:
				sql<boolean>`CASE WHEN ${workAttempts.outcome} = 'succeeded' AND ${workAttempts.runtimeState} = 'finished' AND length(trim(COALESCE(${workAttempts.summary}, ''))) > 0 THEN 1 ELSE 0 END`
					.mapWith(Boolean)
					.as("office_result_recorded"),
		})
		.from(workEvents)
		.leftJoin(
			workAttempts,
			and(
				eq(workAttempts.orgId, workEvents.orgId),
				sql`(${workAttempts.id} = ${workEvents.attemptId} OR (${workEvents.eventType} = 'work.completed' AND ${workEvents.attemptId} IS NULL AND ${workAttempts.id} = (SELECT latest.id FROM ${workAttempts} latest WHERE latest.org_id = ${workEvents.orgId} AND latest.work_item_id = ${workEvents.workItemId} AND latest.started_at <= ${workEvents.occurredAt} ORDER BY latest.attempt_number DESC LIMIT 1)))`,
			),
		)
		.where(
			and(
				eq(workEvents.orgId, owner.organizationId),
				inArray(workEvents.eventType, ["work.completed", "attempt.settled"]),
				gte(workEvents.occurredAt, since),
				sql`EXISTS (SELECT 1 FROM ${workAgentSessions} s JOIN ${workAttempts} own_attempt ON own_attempt.org_id = s.organization_id AND own_attempt.external_session_key = s.session_key WHERE s.organization_id = ${owner.organizationId} AND s.user_id = ${owner.userId} AND own_attempt.work_item_id = ${workEvents.workItemId})`,
			),
		)
		.orderBy(desc(workEvents.occurredAt), desc(workEvents.id))
		.limit(100);
	return { replies, events };
}

/** Explicitly erase expired snapshots on the existing write path; no sweeper. */
export async function pruneOfficeObservations(
	db: DbQueryClient,
	owner: { userId: string; organizationId: string },
	now: string,
) {
	await db
		.delete(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, owner.userId),
				eq(userConfigs.namespace, "office.operations.v1"),
				eq(userConfigs.key, owner.organizationId),
				sql`${userConfigs.updatedAt} < ${new Date(Date.parse(now) - OFFICE_HISTORY_MS).toISOString()}`,
			),
		);
}

/** Existing retention tick only; a capped delete cannot starve the main ledger cleanup. */
export async function pruneExpiredOfficeSnapshots(
	db: DbQueryClient,
	now: string,
) {
	const rows = await db
		.delete(userConfigs)
		.where(sql`${userConfigs.id} IN (
 SELECT id FROM user_configs WHERE namespace = 'office.operations.v1' AND updated_at < ${new Date(Date.parse(now) - OFFICE_HISTORY_MS).toISOString()}
 ORDER BY updated_at, id LIMIT 200
 )`)
		.returning({ id: userConfigs.id });
	return rows.length;
}
