/**
 * Whether a user's answer reached the agent session that asked. A response is
 * undelivered while it has no delivery row with `delivered_at`; the asking
 * session's own user records delivery (and later acknowledgement) once each.
 */
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractionDeliveries,
	workInteractionResponses,
	workInteractions,
	type WorkInteractionDeliveryVia,
	type WorkInteractionTargetType,
} from "../../schema/work-factory";

export type WorkInteractionDeliveryRow =
	typeof workInteractionDeliveries.$inferSelect;

interface DeliveryActor {
	type: WorkInteractionTargetType;
	id: string;
}

/** The caller asked the question or was asked it. */
function callerOwns(actor: DeliveryActor) {
	return or(
		and(
			eq(workInteractions.creatorType, actor.type),
			eq(workInteractions.creatorId, actor.id),
		),
		and(
			eq(workInteractions.targetType, actor.type),
			eq(workInteractions.targetId, actor.id),
		),
	);
}

const sessionOf = sql<
	string | null
>`json_extract(${workInteractions.metadata},'$.sessionId')`;

export interface ListUndeliveredWorkInteractionResponsesParams {
	orgId: string;
	actor: DeliveryActor;
	/** Only answers given at or after this instant. */
	respondedAfter: string;
	sessionId?: string;
	host?: string;
	limit?: number;
}

/**
 * The caller's answered-but-undelivered session questions, oldest first: a
 * resolving answer by the asked user to a question that names its session,
 * except a reply typed in that same session (it is already there).
 */
export async function listUndeliveredWorkInteractionResponses(
	db: DbQueryClient,
	p: ListUndeliveredWorkInteractionResponsesParams,
) {
	return db
		.select({
			responseId: workInteractionResponses.id,
			interactionId: workInteractionResponses.interactionId,
			body: workInteractionResponses.body,
			respondedAt: workInteractionResponses.respondedAt,
			subject: workInteractions.subject,
			workItemId: workInteractions.workItemId,
			projectId: workInteractions.projectId,
			sessionId: sessionOf.as("delivery_session_id"),
			host: sql<
				string | null
			>`json_extract(${workInteractions.metadata},'$.host')`.as(
				"delivery_host",
			),
		})
		.from(workInteractionResponses)
		.innerJoin(
			workInteractions,
			and(
				eq(workInteractions.orgId, workInteractionResponses.orgId),
				eq(workInteractions.id, workInteractionResponses.interactionId),
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
				eq(workInteractionResponses.orgId, p.orgId),
				callerOwns(p.actor),
				eq(workInteractionResponses.resolvesRequest, true),
				eq(workInteractionResponses.responderType, "user"),
				eq(workInteractionResponses.responderId, workInteractions.targetId),
				isNull(workInteractionDeliveries.deliveredAt),
				gte(workInteractionResponses.respondedAt, p.respondedAfter),
				sql`${sessionOf} IS NOT NULL`,
				p.sessionId ? sql`${sessionOf}=${p.sessionId}` : undefined,
				p.host
					? sql`json_extract(${workInteractions.metadata},'$.host')=${p.host}`
					: undefined,
				sql`NOT (COALESCE(json_extract(${workInteractionResponses.metadata},'$.source'),'')='user-reply' AND json_extract(${workInteractionResponses.metadata},'$.sessionId') IS ${sessionOf})`,
			),
		)
		.orderBy(workInteractionResponses.respondedAt, workInteractionResponses.id)
		.limit(Math.min(p.limit ?? 50, 100));
}

export interface RecordWorkInteractionDeliveriesParams {
	orgId: string;
	actor: DeliveryActor;
	/** At most 50 per call (bound-parameter budget). */
	responseIds: string[];
	via: Exclude<WorkInteractionDeliveryVia, "legacy">;
	/** The session ran a turn on it, not only received it. */
	acknowledged: boolean;
	handoffTo?: string | null;
	handoffRef?: string | null;
	now: string;
}

/**
 * Record delivery (and acknowledgement) of the caller's own answers. Each
 * timestamp and the first channel are written once; repeats are no-ops.
 * Responses the caller does not own are ignored, never reported as found.
 */
export async function recordWorkInteractionDeliveries(
	db: DbQueryClient,
	p: RecordWorkInteractionDeliveriesParams,
): Promise<WorkInteractionDeliveryRow[]> {
	const ids = [...new Set(p.responseIds)].slice(0, 50);
	if (!ids.length) return [];
	const owned = await db
		.select({
			responseId: workInteractionResponses.id,
			interactionId: workInteractionResponses.interactionId,
		})
		.from(workInteractionResponses)
		.innerJoin(
			workInteractions,
			and(
				eq(workInteractions.orgId, workInteractionResponses.orgId),
				eq(workInteractions.id, workInteractionResponses.interactionId),
			),
		)
		.where(
			and(
				eq(workInteractionResponses.orgId, p.orgId),
				// bound-params: ids is capped at 50 above
				inArray(workInteractionResponses.id, ids),
				callerOwns(p.actor),
			),
		);
	if (!owned.length) return [];
	const acknowledgedAt = p.acknowledged ? p.now : null;
	const keep = (column: string) =>
		sql.raw(`COALESCE("${column}", excluded."${column}")`);
	return db
		.insert(workInteractionDeliveries)
		.values(
			owned.map((row) => ({
				orgId: p.orgId,
				responseId: row.responseId,
				interactionId: row.interactionId,
				deliveredAt: p.now,
				deliveredVia: p.via,
				acknowledgedAt,
				handoffTo: p.handoffTo ?? null,
				handoffRef: p.handoffRef ?? null,
				updatedAt: p.now,
			})),
		)
		.onConflictDoUpdate({
			target: [
				workInteractionDeliveries.orgId,
				workInteractionDeliveries.responseId,
			],
			set: {
				deliveredAt: keep("delivered_at"),
				deliveredVia: keep("delivered_via"),
				acknowledgedAt: keep("acknowledged_at"),
				handoffTo: keep("handoff_to"),
				handoffRef: keep("handoff_ref"),
				updatedAt: p.now,
			},
		})
		.returning();
}

/** Delivery rows of one interaction's responses. */
export async function listWorkInteractionDeliveries(
	db: DbQueryClient,
	p: { orgId: string; interactionId: string },
): Promise<WorkInteractionDeliveryRow[]> {
	return db
		.select()
		.from(workInteractionDeliveries)
		.where(
			and(
				eq(workInteractionDeliveries.orgId, p.orgId),
				eq(workInteractionDeliveries.interactionId, p.interactionId),
			),
		);
}
