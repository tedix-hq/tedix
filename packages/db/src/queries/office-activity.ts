import { coreTable } from "../core-store/client";
import { coreStore, jsonRead } from "../core-store/dialect";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { OfficeActivityRow } from "@tedix/api-contract/schemas/office-activity";
import type { DbQueryClient } from "../query-client";
import { userConfigs as schemaUserConfigs } from "../schema/user-configs";
import { getUserConfig } from "./user-configs";
import {
	workInteractions as schemaWorkInteractions,
	workInteractionResponses as schemaWorkInteractionResponses,
	workInteractionDeliveries as schemaWorkInteractionDeliveries,
} from "../schema/work-factory";
import { workAgentSessions as schemaWorkAgentSessions } from "../schema/work-agent-sessions";
import {
	workEvents as schemaWorkEvents,
	workAttempts as schemaWorkAttempts,
} from "../schema/work-items";

/** Supervisor reply rows keep their own share, so busy hooks cannot evict them. */
export const OFFICE_HOOK_LIMIT = 150;
export const OFFICE_SUPERVISOR_LIMIT = 50;
export const OFFICE_HISTORY_MS = 24 * 60 * 60 * 1000;

function identity(owner: { organizationId: string; userId: string }) {
	return {
		userId: owner.userId,
		namespace: "office.operations.v1",
		key: owner.organizationId,
	};
}

function postgresObservationValue(
	db: DbQueryClient,
	row: OfficeActivityRow,
	cutoff: string,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	const sameReport =
		row.source === "hook"
			? sql`value->>'source' = 'hook' AND value->>'host' = ${row.host}
		AND value->>'sessionKey' = ${row.sessionKey} AND value->>'trigger' = ${row.trigger}
		AND COALESCE(value->>'reportedState', '') = ${row.reportedState ?? ""}
		AND value->>'at' >= ${cutoff}`
			: sql`false`;
	const incoming = sql`excluded.value->'rows'->0`;
	const merged =
		row.source !== "hook"
			? incoming
			: sql`${incoming} || jsonb_build_object(
		'occurrences', LEAST(1000000, ${row.occurrences}::numeric + COALESCE((SELECT SUM((value->>'occurrences')::numeric) FROM matched), 0)),
		'firstAt', LEAST(${row.firstAt ?? row.at}::text, COALESCE((SELECT MIN(COALESCE(value->>'firstAt', value->>'at')) FROM matched), ${row.at}::text)),
		'at', GREATEST(${row.at}::text, COALESCE((SELECT MAX(value->>'at') FROM matched), ''))
	)`;
	return sql`(WITH stored AS (
		SELECT value FROM jsonb_array_elements(COALESCE(${userConfigs.value}->'rows', '[]'::jsonb)) AS old(value)
	), matched AS (SELECT value FROM stored WHERE ${sameReport}),
	duplicate AS (SELECT 1 FROM stored WHERE value->>'id' = ${row.id}),
	candidates AS (
		SELECT value FROM stored WHERE EXISTS (SELECT 1 FROM duplicate) OR NOT (${sameReport})
		UNION ALL SELECT ${merged} WHERE NOT EXISTS (SELECT 1 FROM duplicate)
	), ranked AS (
		SELECT value, ROW_NUMBER() OVER (PARTITION BY value->>'source' = 'supervisor'
		ORDER BY value->>'at' DESC, value->>'id' DESC) AS position
		FROM candidates WHERE value->>'at' >= ${cutoff}
	)
	SELECT jsonb_build_object('rows', COALESCE(jsonb_agg(value ORDER BY value->>'at' DESC, value->>'id' DESC), '[]'::jsonb))
	FROM ranked WHERE position <= CASE WHEN value->>'source' = 'supervisor' THEN ${OFFICE_SUPERVISOR_LIMIT}::integer ELSE ${OFFICE_HOOK_LIMIT}::integer END)`;
}

/** One bounded personal snapshot per tenant, never an append-only event ledger.
 * SQL merges against the stored value, so overlapping hooks cannot lose rows.
 * A hook row replaces the earlier row with the same session, trigger and
 * reported state, adding its count and keeping the first time. Without this an
 * OpenCode session reporting every few seconds filled the whole snapshot in
 * minutes. Reads also enforce age: an offline reporter cannot extend retention.
 */
export async function recordOfficeObservation(
	db: DbQueryClient,
	owner: { organizationId: string; userId: string },
	row: OfficeActivityRow,
	now: string,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	const key = identity(owner);
	const cutoff = new Date(Date.parse(now) - OFFICE_HISTORY_MS).toISOString();
	const stored = sql`json_each(${userConfigs.value}, '$.rows')`;
	const field = (alias: string, path: string) =>
		sql`json_extract(${sql.identifier(alias)}.value, ${`$.${path}`})`;
	const sameReport = (alias: string) =>
		row.source === "hook"
			? sql`(${field(alias, "source")} = 'hook' AND ${field(alias, "host")} = ${row.host} AND ${field(alias, "sessionKey")} = ${row.sessionKey} AND ${field(alias, "trigger")} = ${row.trigger} AND COALESCE(${field(alias, "reportedState")}, '') = ${row.reportedState ?? ""} AND ${field(alias, "at")} >= ${cutoff})`
			: sql`0`;
	const duplicate = sql`EXISTS (SELECT 1 FROM ${stored} dup WHERE ${field("dup", "id")} = ${row.id})`;
	const incoming = sql`json_extract(excluded.value, '$.rows[0]')`;
	const merged =
		row.source !== "hook"
			? incoming
			: sql`json_set(${incoming},
 '$.occurrences', MIN(1000000, ${row.occurrences} + COALESCE((SELECT SUM(${field("m", "occurrences")}) FROM ${stored} m WHERE ${sameReport("m")}), 0)),
 '$.firstAt', MIN(${row.firstAt ?? row.at}, COALESCE((SELECT MIN(COALESCE(${field("m", "firstAt")}, ${field("m", "at")})) FROM ${stored} m WHERE ${sameReport("m")}), ${row.at})),
 '$.at', MAX(${row.at}, COALESCE((SELECT MAX(${field("m", "at")}) FROM ${stored} m WHERE ${sameReport("m")}), ''))
)`;
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
				value:
					coreStore(db) === "postgres"
						? postgresObservationValue(db, row, cutoff)
						: sql`json_object('rows', json((SELECT json_group_array(json(value)) FROM (
 SELECT value FROM (
 SELECT value, json_extract(value, '$.source') AS source, ROW_NUMBER() OVER (
 PARTITION BY json_extract(value, '$.source') = 'supervisor'
 ORDER BY json_extract(value, '$.at') DESC, json_extract(value, '$.id') DESC
 ) AS position FROM (
 SELECT old.value AS value FROM ${stored} old WHERE ${duplicate} OR NOT ${sameReport("old")}
 UNION ALL SELECT ${merged} AS value WHERE NOT ${duplicate}
 ) WHERE json_extract(value, '$.at') >= ${cutoff}
 ) WHERE position <= CASE WHEN source = 'supervisor' THEN ${OFFICE_SUPERVISOR_LIMIT} ELSE ${OFFICE_HOOK_LIMIT} END
 ORDER BY json_extract(value, '$.at') DESC, json_extract(value, '$.id') DESC
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
	const workInteractions = coreTable(db, schemaWorkInteractions);
	const workInteractionResponses = coreTable(
		db,
		schemaWorkInteractionResponses,
	);
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
				sql`${jsonRead(db, workInteractions.metadata, ["sessionId"])} IN (${input.sessionKey}, ${native})`,
				sql`${jsonRead(db, workInteractions.metadata, ["host"])} = ${input.host}`,
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
	const workInteractions = coreTable(db, schemaWorkInteractions);
	const workInteractionResponses = coreTable(
		db,
		schemaWorkInteractionResponses,
	);
	const workInteractionDeliveries = coreTable(
		db,
		schemaWorkInteractionDeliveries,
	);
	const workAgentSessions = coreTable(db, schemaWorkAgentSessions);
	const workEvents = coreTable(db, schemaWorkEvents);
	const workAttempts = coreTable(db, schemaWorkAttempts);
	const sessionSeparator =
		coreStore(db) === "d1"
			? sql`instr(own_attempt.external_session_key, ':')`
			: sql`strpos(own_attempt.external_session_key, ':')`;
	const sessionHarness =
		coreStore(db) === "d1"
			? sql`substr(own_attempt.external_session_key, 1, ${sessionSeparator} - 1)`
			: sql`split_part(own_attempt.external_session_key, ':', 1)`;
	const replies = await db
		.select({
			responseId: sql<string>`${workInteractionResponses.id}`.as(
				"office_response_id",
			),
			requestId: sql<string>`${workInteractions.id}`.as("office_request_id"),
			workItemId: workInteractions.workItemId,
			sessionKey: sql<
				string | null
			>`${jsonRead(db, workInteractions.metadata, ["sessionId"])}`.as(
				"office_reply_session",
			),
			host: sql<
				string | null
			>`${jsonRead(db, workInteractions.metadata, ["host"])}`.as(
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
				sql`${jsonRead(db, workInteractions.metadata, ["sessionId"])} IS NOT NULL`,
				sql`COALESCE(${jsonRead(db, workInteractionResponses.metadata, ["delivery"])}, '') <> 'none'`,
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
				// `+started_at` keeps the lookup on the (org, item) key instead of an
				// org-wide started_at range; see office-activity.plan.test.ts.
				sql`(${workAttempts.id} = ${workEvents.attemptId} OR (${workEvents.eventType} = 'work.completed' AND ${workEvents.attemptId} IS NULL AND ${workAttempts.id} = (SELECT latest.id FROM ${workAttempts} latest WHERE latest.org_id = ${workEvents.orgId} AND latest.work_item_id = ${workEvents.workItemId} AND ${coreStore(db) === "d1" ? sql`+latest.started_at` : sql`latest.started_at`} <= ${workEvents.occurredAt} ORDER BY latest.attempt_number DESC LIMIT 1)))`,
			),
		)
		.where(
			and(
				eq(workEvents.orgId, owner.organizationId),
				inArray(workEvents.eventType, ["work.completed", "attempt.settled"]),
				gte(workEvents.occurredAt, since),
				// Attempts store `harness:session`; hook-reported sessions store the
				// bare id under their harness. Older Attempts stored the bare id.
				sql`(EXISTS (SELECT 1 FROM ${workAttempts} own_attempt JOIN ${workAgentSessions} s ON s.organization_id = own_attempt.org_id AND s.user_id = ${owner.userId} AND s.harness = ${sessionHarness} AND s.session_key = substr(own_attempt.external_session_key, ${sessionSeparator} + 1) WHERE own_attempt.org_id = ${owner.organizationId} AND own_attempt.work_item_id = ${workEvents.workItemId} AND ${sessionSeparator} > 0) OR EXISTS (SELECT 1 FROM ${workAgentSessions} s JOIN ${workAttempts} own_attempt ON own_attempt.org_id = s.organization_id AND own_attempt.external_session_key = s.session_key WHERE s.organization_id = ${owner.organizationId} AND s.user_id = ${owner.userId} AND own_attempt.work_item_id = ${workEvents.workItemId}))`,
			),
		)
		// Do not trade the event-type/time range for the org-wide ordering index.
		.orderBy(
			desc(
				coreStore(db) === "d1"
					? sql`+${workEvents.occurredAt}`
					: workEvents.occurredAt,
			),
			desc(workEvents.id),
		)
		.limit(100);
	return { replies, events };
}

/** Explicitly erase expired snapshots on the existing write path; no sweeper. */
export async function pruneOfficeObservations(
	db: DbQueryClient,
	owner: { userId: string; organizationId: string },
	now: string,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
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
	const userConfigs = coreTable(db, schemaUserConfigs);
	const rows = await db
		.delete(userConfigs)
		.where(sql`${userConfigs.id} IN (
 SELECT id FROM user_configs WHERE namespace = 'office.operations.v1' AND updated_at < ${new Date(Date.parse(now) - OFFICE_HISTORY_MS).toISOString()}
 ORDER BY updated_at, id LIMIT 200
 )`)
		.returning({ id: userConfigs.id });
	return rows.length;
}
