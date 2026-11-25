/**
 * Whether a user's answer reached the agent session that asked. A response is
 * undelivered while it has no delivery row with `delivered_at`; the asking
 * session's own user records delivery (and later acknowledgement) once each.
 */
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import {
	anyIds,
	booleanValue,
	coreStore,
	jsonRead,
} from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractionDeliveries as d1WorkInteractionDeliveries,
	workInteractionResponses as d1WorkInteractionResponses,
	workInteractions as d1WorkInteractions,
	type WorkInteractionDeliveryVia,
	type WorkInteractionTargetType,
} from "../../schema/work-factory";

export type WorkInteractionDeliveryRow =
	typeof d1WorkInteractionDeliveries.$inferSelect;

interface DeliveryActor {
	type: WorkInteractionTargetType;
	id: string;
}

/** The caller asked the question or was asked it. */
function callerOwns(db: DbQueryClient, actor: DeliveryActor) {
	const workInteractions = coreTable(db, d1WorkInteractions);
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
 * or their later correction of a tedi's auto reply (`metadata.corrects`),
 * except a reply typed in that same session (it is already there) or a
 * closure that asks for no delivery (`metadata.delivery` = "none").
 */
export async function listUndeliveredWorkInteractionResponses(
	db: DbQueryClient,
	p: ListUndeliveredWorkInteractionResponsesParams,
) {
	const workInteractionDeliveries = coreTable(db, d1WorkInteractionDeliveries);
	const workInteractionResponses = coreTable(db, d1WorkInteractionResponses);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const sessionOf = sql<
		string | null
	>`coalesce(${jsonRead(db, workInteractions.metadata, ["sessionId"])}, ${workInteractions.creatorExternalSessionKey})`;
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
			>`${jsonRead(db, workInteractions.metadata, ["host"])}`.as(
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
				callerOwns(db, p.actor),
				sql`(${workInteractionResponses.resolvesRequest}=${booleanValue(db, true)} OR ${jsonRead(db, workInteractionResponses.metadata, ["corrects"])} IS NOT NULL OR ${jsonRead(db, workInteractionResponses.metadata, ["cardAction"])}='ask_changes')`,
				eq(workInteractionResponses.responderType, "user"),
				eq(workInteractionResponses.responderId, workInteractions.targetId),
				isNull(workInteractionDeliveries.deliveredAt),
				gte(workInteractionResponses.respondedAt, p.respondedAfter),
				sql`${sessionOf} IS NOT NULL`,
				p.sessionId ? sql`${sessionOf}=${p.sessionId}` : undefined,
				p.host
					? sql`${jsonRead(db, workInteractions.metadata, ["host"])}=${p.host}`
					: undefined,
				sql`NOT (COALESCE(${jsonRead(db, workInteractionResponses.metadata, ["source"])},'')='user-reply' AND ${jsonRead(db, workInteractionResponses.metadata, ["sessionId"])} ${coreStore(db) === "postgres" ? sql`IS NOT DISTINCT FROM` : sql`IS`} ${sessionOf})`,
				sql`COALESCE(${jsonRead(db, workInteractionResponses.metadata, ["delivery"])},'')<>'none'`,
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
	const workInteractionDeliveries = coreTable(db, d1WorkInteractionDeliveries);
	const workInteractionResponses = coreTable(db, d1WorkInteractionResponses);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const ids = [...new Set(p.responseIds)].slice(0, 50);
	if (!ids.length) return [];
	const acknowledgedAt = p.acknowledged ? p.now : null;
	const keep = (column: { name: string }) =>
		sql`COALESCE(${workInteractionDeliveries}.${sql.identifier(column.name)}, excluded.${sql.identifier(column.name)})`;
	return db
		.insert(workInteractionDeliveries)
		.select(
			db
				.select({
					orgId: workInteractionResponses.orgId,
					responseId: workInteractionResponses.id,
					interactionId: workInteractionResponses.interactionId,
					deliveredAt: sql<string>`${p.now}`.as("delivered_at"),
					deliveredVia: sql<string>`${p.via}`.as("delivered_via"),
					acknowledgedAt: sql<string | null>`${acknowledgedAt}`.as(
						"acknowledged_at",
					),
					handoffTo: sql<string | null>`${p.handoffTo ?? null}`.as(
						"handoff_to",
					),
					handoffRef: sql<string | null>`${p.handoffRef ?? null}`.as(
						"handoff_ref",
					),
					updatedAt: sql<string>`${p.now}`.as("updated_at"),
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
						anyIds(db, workInteractionResponses.id, ids),
						callerOwns(db, p.actor),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				workInteractionDeliveries.orgId,
				workInteractionDeliveries.responseId,
			],
			set: {
				deliveredAt: keep(workInteractionDeliveries.deliveredAt),
				deliveredVia: keep(workInteractionDeliveries.deliveredVia),
				acknowledgedAt: keep(workInteractionDeliveries.acknowledgedAt),
				handoffTo: keep(workInteractionDeliveries.handoffTo),
				handoffRef: keep(workInteractionDeliveries.handoffRef),
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
	const workInteractionDeliveries = coreTable(db, d1WorkInteractionDeliveries);
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
