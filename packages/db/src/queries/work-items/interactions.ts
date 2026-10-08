import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workItems } from "../../schema/work-items";
import {
	workInteractionAttention,
	workInteractionResponses,
	workInteractions,
	type WorkInteraction,
	type WorkInteractionKind,
	type WorkInteractionResponse,
	type WorkInteractionResponseKind,
	type WorkInteractionTargetType,
} from "../../schema/work-factory";
import { prefixedColumns } from "../../utils/select";
import { tedis } from "../../schema/tedis";

export type WorkInteractionAttentionRow =
	typeof workInteractionAttention.$inferSelect;
import {
	WorkControlError,
	requireActivePrincipal,
	requireExternalSession,
	requireProject,
	requireWorkCase,
	requireWorkItem,
} from "./factory-validation";

type InteractionActor = {
	type: "user" | "tedi" | "external_agent" | "system";
	id: string;
	sessionId?: string;
	externalSessionKey?: string;
};
async function validateActor(
	db: DbQueryClient,
	orgId: string,
	actor: InteractionActor,
) {
	await requireActivePrincipal(db, { orgId, type: actor.type, id: actor.id });
	if (actor.type === "external_agent") {
		if (!actor.sessionId || !actor.externalSessionKey)
			throw new WorkControlError(
				"INVALID_PRINCIPAL",
				"External interaction actor requires exact session fence",
			);
		await requireExternalSession(db, {
			orgId,
			principalId: actor.id,
			sessionId: actor.sessionId,
			externalSessionKey: actor.externalSessionKey,
		});
	}
}
export interface CreateWorkInteractionParams {
	id: string;
	orgId: string;
	workItemId?: string | null;
	caseId?: string | null;
	projectId?: string | null;
	kind: WorkInteractionKind;
	subject: string;
	prompt: string;
	creator: InteractionActor;
	targetType: WorkInteractionTargetType;
	targetId: string;
	dueAt?: string | null;
	expiresAt?: string | null;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function createWorkInteraction(
	db: DbQueryClient,
	p: CreateWorkInteractionParams,
): Promise<WorkInteraction> {
	if (!p.workItemId && !p.caseId && !p.projectId)
		throw new WorkControlError(
			"NOT_FOUND",
			"Interaction requires work, case, or project context",
		);
	if (!p.targetType || !p.targetId)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Interaction requires an exact target type and id",
		);
	await validateActor(db, p.orgId, p.creator);
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: p.targetType,
		id: p.targetId,
	});
	await Promise.all([
		p.workItemId
			? requireWorkItem(db, p.orgId, p.workItemId)
			: Promise.resolve(),
		p.caseId ? requireWorkCase(db, p.orgId, p.caseId) : Promise.resolve(),
		p.projectId ? requireProject(db, p.orgId, p.projectId) : Promise.resolve(),
	]);
	return (
		await db
			.insert(workInteractions)
			.values({
				id: p.id,
				orgId: p.orgId,
				workItemId: p.workItemId,
				caseId: p.caseId,
				projectId: p.projectId,
				kind: p.kind,
				status: "open",
				subject: p.subject,
				prompt: p.prompt,
				creatorType: p.creator.type,
				creatorId: p.creator.id,
				creatorSessionId: p.creator.sessionId,
				creatorExternalSessionKey: p.creator.externalSessionKey,
				targetType: p.targetType,
				targetId: p.targetId,
				dueAt: p.dueAt,
				expiresAt: p.expiresAt,
				resolutionFence: null,
				createdAt: p.now,
				version: 1,
				metadata: p.metadata ?? {},
			})
			.returning()
	)[0]!;
}

export interface RespondWorkInteractionParams {
	id: string;
	orgId: string;
	interactionId: string;
	expectedVersion: number;
	responder: {
		type: WorkInteractionTargetType;
		id: string;
		sessionId?: string;
		externalSessionKey?: string;
	};
	responseKind: WorkInteractionResponseKind;
	body: string;
	artifactRef?: string | null;
	artifactVersion?: string | null;
	artifactDigest?: string | null;
	resolvesRequest: boolean;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function respondToWorkInteraction(
	db: DbQueryClient,
	p: RespondWorkInteractionParams,
): Promise<WorkInteractionResponse> {
	await validateActor(db, p.orgId, p.responder);
	const request = (
		await db
			.select()
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, p.interactionId),
					eq(workInteractions.version, p.expectedVersion),
					eq(workInteractions.status, "open"),
					sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
				),
			)
			.limit(1)
	)[0];
	if (!request)
		throw new WorkControlError(
			"CONFLICT",
			"Interaction is no longer respondable",
		);
	if (
		request.targetType !== p.responder.type ||
		request.targetId !== p.responder.id
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Responder is not the request target",
		);
	const resolutionFence = crypto.randomUUID();
	const resolvedVersion = p.expectedVersion + 1;
	const responseInsert = db
		.insert(workInteractionResponses)
		.select(
			db
				.select({
					id: sql<string>`${p.id}`.as("id"),
					orgId: workInteractions.orgId,
					interactionId: workInteractions.id,
					resolvedRequestVersion: sql<number>`${resolvedVersion}`.as(
						"resolved_request_version",
					),
					resolutionFence: sql<string>`${resolutionFence}`.as(
						"resolution_fence",
					),
					responderType: sql<typeof p.responder.type>`${p.responder.type}`.as(
						"responder_type",
					),
					responderId: sql<string>`${p.responder.id}`.as("responder_id"),
					responderSessionId: sql<
						string | null
					>`${p.responder.sessionId ?? null}`.as("responder_session_id"),
					responderExternalSessionKey: sql<
						string | null
					>`${p.responder.externalSessionKey ?? null}`.as(
						"responder_external_session_key",
					),
					body: sql<string>`${p.body}`.as("body"),
					responseKind: sql<typeof p.responseKind>`${p.responseKind}`.as(
						"response_kind",
					),
					artifactRef: sql<string | null>`${p.artifactRef ?? null}`.as(
						"artifact_ref",
					),
					artifactVersion: sql<string | null>`${p.artifactVersion ?? null}`.as(
						"artifact_version",
					),
					artifactDigest: sql<string | null>`${p.artifactDigest ?? null}`.as(
						"artifact_digest",
					),
					resolvesRequest: sql<boolean>`${p.resolvesRequest ? 1 : 0}`.as(
						"resolves_request",
					),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(p.metadata ?? {})}`.as("metadata"),
					respondedAt: sql<string>`${p.now}`.as("responded_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
						eq(workInteractions.version, p.expectedVersion),
						eq(workInteractions.status, "open"),
						sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
						and(
							eq(workInteractions.targetType, p.responder.type),
							eq(workInteractions.targetId, p.responder.id),
						),
					),
				),
		)
		.returning();
	try {
		const responses = await responseInsert;
		if (!responses[0]) throw new Error("lost race");
		return responses[0];
	} catch {
		throw new WorkControlError(
			"CONFLICT",
			"Interaction response lost its resolution race",
		);
	}
}
/** One explicit handoff by the human currently asked to answer, never impersonation. */
export async function delegateWorkInteraction(
	db: DbQueryClient,
	p: {
		orgId: string;
		interactionId: string;
		expectedVersion: number;
		actor: InteractionActor;
		tediId: string;
		now: string;
	},
) {
	if (p.actor.type !== "user")
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the requested human can delegate a question",
		);
	await validateActor(db, p.orgId, p.actor);
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: "tedi",
		id: p.tediId,
	});
	const activeTedi = (
		await db
			.select({ id: tedis.id })
			.from(tedis)
			.where(
				and(
					eq(tedis.organizationId, p.orgId),
					eq(tedis.id, p.tediId),
					eq(tedis.status, "active"),
					isNull(tedis.retiredAt),
				),
			)
			.limit(1)
	)[0];
	if (!activeTedi)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Question delegation requires an active tedi",
		);
	const request = await getWorkInteraction(db, {
		orgId: p.orgId,
		interactionId: p.interactionId,
	});
	if (
		!request ||
		request.targetType !== "user" ||
		request.targetId !== p.actor.id
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the request target can delegate it",
		);
	const row = (
		await db
			.update(workInteractions)
			.set({
				targetType: "tedi",
				targetId: p.tediId,
				metadata: {
					...request.metadata,
					delegation: {
						fromType: "user",
						fromId: p.actor.id,
						toTediId: p.tediId,
						delegatedAt: p.now,
					},
				},
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, p.interactionId),
					eq(workInteractions.version, p.expectedVersion),
					eq(workInteractions.kind, "question"),
					eq(workInteractions.status, "open"),
					eq(workInteractions.targetType, "user"),
					eq(workInteractions.targetId, p.actor.id),
					sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
				),
			)
			.returning()
	)[0];
	if (!row)
		throw new WorkControlError("CONFLICT", "Question is no longer delegatable");
	return row;
}

export async function cancelWorkInteraction(
	db: DbQueryClient,
	p: {
		orgId: string;
		interactionId: string;
		expectedVersion: number;
		actor: InteractionActor;
		now: string;
	},
) {
	await validateActor(db, p.orgId, p.actor);
	const resolutionFence = crypto.randomUUID();
	const row = (
		await db
			.update(workInteractions)
			.set({
				status: "cancelled",
				cancelledAt: p.now,
				resolutionFence,
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, p.interactionId),
					eq(workInteractions.version, p.expectedVersion),
					eq(workInteractions.status, "open"),
					eq(workInteractions.creatorType, p.actor.type),
					eq(workInteractions.creatorId, p.actor.id),
				),
			)
			.returning()
	)[0];
	if (!row)
		throw new WorkControlError(
			"CONFLICT",
			"Interaction is not cancellable by this actor",
		);
	return row;
}
export interface SetWorkInteractionAttentionParams {
	orgId: string;
	interactionId: string;
	kind: WorkInteractionAttentionRow["kind"];
	need: string | null;
	asks: number | null;
	decidedAt: string;
}

/** Store (or replace) the attention verdict of one question. */
export async function setWorkInteractionAttention(
	db: DbQueryClient,
	p: SetWorkInteractionAttentionParams,
): Promise<void> {
	const values = {
		kind: p.kind,
		need: p.need,
		asks: p.asks,
		decidedAt: p.decidedAt,
	};
	await db
		.insert(workInteractionAttention)
		.values({ orgId: p.orgId, interactionId: p.interactionId, ...values })
		.onConflictDoUpdate({
			target: [
				workInteractionAttention.orgId,
				workInteractionAttention.interactionId,
			],
			set: values,
		});
}

/** The attention verdict of one question, or null when none was stored. */
export async function getWorkInteractionAttention(
	db: DbQueryClient,
	p: { orgId: string; interactionId: string },
): Promise<WorkInteractionAttentionRow | null> {
	return (
		(
			await db
				.select()
				.from(workInteractionAttention)
				.where(
					and(
						eq(workInteractionAttention.orgId, p.orgId),
						eq(workInteractionAttention.interactionId, p.interactionId),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}

/**
 * Expire an open question now: the lifecycle's non-destructive close. It
 * neither answers nor cancels the question. Null when it is no longer open at
 * `expectedVersion`.
 */
export async function expireWorkInteraction(
	db: DbQueryClient,
	p: {
		orgId: string;
		interactionId: string;
		expectedVersion: number;
		now: string;
	},
) {
	return (
		(
			await db
				.update(workInteractions)
				.set({
					status: "expired",
					expiredAt: p.now,
					resolutionFence: crypto.randomUUID(),
					version: sql`${workInteractions.version}+1`,
				})
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
						eq(workInteractions.version, p.expectedVersion),
						eq(workInteractions.status, "open"),
					),
				)
				.returning({ id: workInteractions.id })
		)[0] ?? null
	);
}

export async function getWorkInteraction(
	db: DbQueryClient,
	p: { orgId: string; interactionId: string },
) {
	return (
		(
			await db
				.select()
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function listWorkInteractionResponses(
	db: DbQueryClient,
	p: {
		orgId: string;
		interactionId: string;
		limit?: number;
		afterRespondedAt?: string;
		afterId?: string;
	},
) {
	return db
		.select()
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, p.orgId),
				eq(workInteractionResponses.interactionId, p.interactionId),
				p.afterRespondedAt
					? sql`(${workInteractionResponses.respondedAt}>${p.afterRespondedAt} OR (${workInteractionResponses.respondedAt}=${p.afterRespondedAt} AND ${workInteractionResponses.id}>${p.afterId ?? ""}))`
					: undefined,
			),
		)
		.orderBy(workInteractionResponses.respondedAt, workInteractionResponses.id)
		.limit(Math.min(p.limit ?? 100, 500));
}
export type WorkInteractionUrgency = "now" | "later";
export async function listWorkInteractionInbox(
	db: DbQueryClient,
	p: {
		orgId: string;
		states?: Array<"open" | "resolved" | "cancelled" | "expired">;
		kinds?: WorkInteractionKind[];
		workItemId?: string;
		projectId?: string;
		creatorType?: InteractionActor["type"];
		creatorId?: string;
		targetType?: WorkInteractionTargetType | null;
		targetId?: string | null;
		/**
		 * Triage urgency recorded at create time in `metadata.triage.urgency`.
		 * "later" also covers every interaction without triage, and every one
		 * whose stored attention is `fyi` (it asks nothing of the user), so the
		 * two values partition the inbox exactly.
		 */
		urgency?: WorkInteractionUrgency;
		cursor?: { at: string; id: string };
		limit?: number;
		observedAt: string;
	},
) {
	const effective = sql<
		"open" | "resolved" | "cancelled" | "expired"
	>`CASE WHEN ${workInteractions.status}='open' AND ${workInteractions.expiresAt} IS NOT NULL AND ${workInteractions.expiresAt}<=${p.observedAt} THEN 'expired' ELSE ${workInteractions.status} END`;
	const limit = Math.min(p.limit ?? 50, 200);
	const urgency = sql`CASE WHEN ${workInteractionAttention.kind}='fyi' THEN 'later' ELSE COALESCE(json_extract(${workInteractions.metadata},'$.triage.urgency'),'later') END`;
	const rows = await db
		.select({
			request: prefixedColumns(workInteractions, "work_interaction"),
			effectiveState: effective.as("effective_state"),
			workItem: {
				id: sql`${workItems.id}`
					.mapWith(workItems.id)
					.as("work_interaction_item_id"),
				title: sql`${workItems.title}`
					.mapWith(workItems.title)
					.as("work_interaction_item_title"),
				projectId: sql`${workItems.projectId}`
					.mapWith(workItems.projectId)
					.as("work_interaction_item_project_id"),
			},
			responseCount:
				sql<number>`(SELECT COUNT(*) FROM work_interaction_responses response_count WHERE response_count.org_id=${workInteractions.orgId} AND response_count.interaction_id=${workInteractions.id})`.as(
					"response_count",
				),
			attentionKind: sql<
				WorkInteractionAttentionRow["kind"] | null
			>`${workInteractionAttention.kind}`.as("work_interaction_attention_kind"),
			attentionNeed: sql<string | null>`${workInteractionAttention.need}`.as(
				"work_interaction_attention_need",
			),
		})
		.from(workInteractions)
		.leftJoin(
			workItems,
			and(
				eq(workItems.orgId, workInteractions.orgId),
				eq(workItems.id, workInteractions.workItemId),
			),
		)
		.leftJoin(
			workInteractionAttention,
			and(
				eq(workInteractionAttention.orgId, workInteractions.orgId),
				eq(workInteractionAttention.interactionId, workInteractions.id),
			),
		)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				// bound-params: states is a closed four-value interaction-state enum
				p.states?.length ? inArray(effective, p.states) : undefined,
				// bound-params: kinds is a closed five-value interaction-kind enum
				p.kinds?.length ? inArray(workInteractions.kind, p.kinds) : undefined,
				p.workItemId
					? eq(workInteractions.workItemId, p.workItemId)
					: undefined,
				p.projectId ? eq(workInteractions.projectId, p.projectId) : undefined,
				p.creatorType
					? eq(workInteractions.creatorType, p.creatorType)
					: undefined,
				p.creatorId ? eq(workInteractions.creatorId, p.creatorId) : undefined,
				p.targetType
					? eq(workInteractions.targetType, p.targetType)
					: p.targetType === null
						? isNull(workInteractions.targetType)
						: undefined,
				p.targetId
					? eq(workInteractions.targetId, p.targetId)
					: p.targetId === null
						? isNull(workInteractions.targetId)
						: undefined,
				p.urgency === "now"
					? sql`${urgency}='now'`
					: p.urgency === "later"
						? sql`${urgency}<>'now'`
						: undefined,
				p.cursor
					? sql`(${workInteractions.createdAt}<${p.cursor.at} OR (${workInteractions.createdAt}=${p.cursor.at} AND ${workInteractions.id}<${p.cursor.id}))`
					: undefined,
			),
		)
		.orderBy(desc(workInteractions.createdAt), desc(workInteractions.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);
	const last = data.at(-1);
	return {
		data,
		hasMore,
		nextCursor:
			hasMore && last
				? { at: last.request.createdAt, id: last.request.id }
				: null,
		observedAt: p.observedAt,
	};
}
