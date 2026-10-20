import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	inArray,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { nudgeLaneHandoffs } from "./lane-handoffs";
import {
	workItems,
	workItemComments,
	workAttempts,
} from "../../schema/work-items";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import {
	workInteractionAttention,
	workInteractionDeliveries,
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
	notificationReason?: "update" | "failure" | "blocked_approval";
	reviewAfterDays?: number;
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
	const [work] = await Promise.all([
		p.workItemId
			? requireWorkItem(db, p.orgId, p.workItemId)
			: Promise.resolve(),
		p.caseId ? requireWorkCase(db, p.orgId, p.caseId) : Promise.resolve(),
		p.projectId ? requireProject(db, p.orgId, p.projectId) : Promise.resolve(),
	]);
	const machineUpdate =
		p.targetType === "user" &&
		p.kind === "coordination" &&
		(p.creator.type === "tedi" || p.creator.type === "external_agent");
	const deadline = [p.dueAt, work?.deadline, work?.dueDate]
		.filter((at): at is string => Boolean(at))
		.sort()[0];
	const urgent =
		p.notificationReason === "failure" ||
		p.notificationReason === "blocked_approval" ||
		Boolean(deadline && Date.parse(deadline) - Date.parse(p.now) < 86_400_000);
	const metadata = { ...p.metadata };
	delete metadata.notification;
	delete metadata.followThrough;
	if (
		p.targetType === "user" &&
		p.kind !== "coordination" &&
		(p.creator.type === "tedi" || p.creator.type === "external_agent")
	) {
		metadata.followThrough = {
			reviewAt: new Date(
				Date.parse(p.now) + (p.reviewAfterDays ?? 3) * 86_400_000,
			).toISOString(),
		};
	}
	if (machineUpdate)
		metadata.notification = {
			state: urgent ? "immediate" : "deferred",
			reason: urgent
				? (p.notificationReason ?? "deadline_under_24h")
				: "quiet_batch",
			deliverAt: urgent ? p.now : nextInteractionDigestAt(p.now),
		};
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
				// Owner-authenticated harness calls retain their requester session as
				// provenance; it never grants external-agent authority.
				creatorSessionId:
					p.creator.sessionId ??
					(p.creator.type === "user" &&
					typeof p.metadata?.agentSession === "string" &&
					p.metadata.agentSession.length <= 300
						? p.metadata.agentSession
						: null),
				creatorExternalSessionKey: p.creator.externalSessionKey,
				targetType: p.targetType,
				targetId: p.targetId,
				dueAt: p.dueAt,
				expiresAt: p.expiresAt,
				resolutionFence: null,
				createdAt: p.now,
				version: 1,
				metadata,
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
/** Mirrors the kind check in `work_interaction_response_insert_guard`. */
const RESPONSE_KINDS_BY_REQUEST_KIND: Record<
	WorkInteractionKind,
	readonly WorkInteractionResponseKind[]
> = {
	question: ["answer"],
	input: ["input_provided"],
	handoff: ["handoff_accepted", "handoff_declined"],
	coordination: ["coordination_update"],
};
/**
 * The tedi auto reply that resolved a user's question, when the question is
 * resolved and that is how; null otherwise. Such a question still takes the
 * asked user's correction (a non-resolving answer naming it).
 */
export async function autoReplyToCorrect(
	db: DbQueryClient,
	request: Pick<
		WorkInteraction,
		"orgId" | "id" | "status" | "kind" | "targetType"
	>,
): Promise<WorkInteractionResponse | null> {
	if (
		request.status !== "resolved" ||
		request.kind !== "question" ||
		request.targetType !== "user"
	)
		return null;
	const [row] = await db
		.select()
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, request.orgId),
				eq(workInteractionResponses.interactionId, request.id),
				eq(workInteractionResponses.resolvesRequest, true),
				eq(workInteractionResponses.responderType, "tedi"),
				sql`json_extract(${workInteractionResponses.metadata},'$.draftOutcome')='auto'`,
			),
		)
		.limit(1);
	return row ?? null;
}

export async function respondToWorkInteraction(
	db: DbQueryClient,
	p: RespondWorkInteractionParams,
): Promise<WorkInteractionResponse> {
	if (containsCardSecret([p.body, p.metadata]))
		throw new WorkControlError("INVALID_TRANSITION", CARD_SECRET_MESSAGE);
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
					sql`(${workInteractions.status}='open' AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now}) OR ${workInteractions.status}='resolved')`,
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
	// A resolved question takes only the asked user's correction of a tedi's
	// auto reply; the trigger mirrors this.
	const corrects =
		request.status === "resolved"
			? await autoReplyToCorrect(db, request)
			: null;
	if (request.status === "resolved" && !corrects)
		throw new WorkControlError(
			"CONFLICT",
			"Interaction is no longer respondable",
		);
	const acceptedKinds = RESPONSE_KINDS_BY_REQUEST_KIND[request.kind];
	if (!acceptedKinds.includes(p.responseKind))
		throw new WorkControlError(
			"INVALID_TRANSITION",
			`A ${request.kind} request takes responseKind ${acceptedKinds.join(" or ")}, not ${p.responseKind}`,
		);
	const resolvesRequest = corrects ? false : p.resolvesRequest;
	const laneAction = p.metadata?.laneAction;
	const follow = request.metadata.followThrough;
	const lane =
		request.metadata.laneHandoff ??
		(follow && typeof follow === "object" && !Array.isArray(follow)
			? follow.laneHandoff
			: undefined);
	const isLane = lane && typeof lane === "object" && !Array.isArray(lane);
	if (
		laneAction !== undefined &&
		(!isLane ||
			!["done", "snooze"].includes(String(laneAction)) ||
			p.responder.type !== "user" ||
			(laneAction === "snooze" ? resolvesRequest : !resolvesRequest))
	)
		throw new WorkControlError(
			"INVALID_TRANSITION",
			"Done resolves a lane ask; Snooze keeps it open for one day",
		);
	const metadata = corrects
		? { ...p.metadata, corrects: corrects.id }
		: (p.metadata ?? {});
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
					resolvesRequest: sql<boolean>`${resolvesRequest ? 1 : 0}`.as(
						"resolves_request",
					),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(metadata)}`.as("metadata"),
					respondedAt: sql<string>`${p.now}`.as("responded_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
						eq(workInteractions.version, p.expectedVersion),
						corrects
							? eq(workInteractions.status, "resolved")
							: and(
									eq(workInteractions.status, "open"),
									sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
								),
						and(
							eq(workInteractions.targetType, p.responder.type),
							eq(workInteractions.targetId, p.responder.id),
						),
					),
				),
		)
		.returning();
	let response: WorkInteractionResponse;
	try {
		const [responses] = await db.batch([
			responseInsert,
			...(p.metadata?.cardAction === "ask_changes"
				? [
						db
							.update(workInteractions)
							.set({
								metadata: sql`json_remove(json_set(${workInteractions.metadata}, '$.followThrough.reviewAt', ${p.now}), '$.followThrough.reviewWakeVersion')`,
							})
							.where(
								and(
									eq(workInteractions.orgId, p.orgId),
									eq(workInteractions.id, p.interactionId),
									sql`EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.id=${p.id} AND r.org_id=${p.orgId})`,
								),
							),
					]
				: []),
			...(isLane
				? [
						db
							.update(workInteractions)
							.set({
								metadata: sql`json_set(${workInteractions.metadata},'$.followThrough.snoozedUntil',${laneAction === "snooze" ? new Date(Date.parse(p.now) + 86_400_000).toISOString() : p.now})`,
							})
							.where(
								and(
									eq(workInteractions.orgId, p.orgId),
									eq(workInteractions.id, p.interactionId),
									sql`EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=${p.orgId} AND r.id=${p.id})`,
								),
							),
						db
							.update(agentSessionRequests)
							.set({
								status: resolvesRequest ? "done" : "waiting_on_user",
								statusChangedAt: p.now,
								updatedAt: p.now,
							})
							.where(
								and(
									eq(agentSessionRequests.organizationId, p.orgId),
									eq(agentSessionRequests.userId, p.responder.id),
									eq(
										agentSessionRequests.evidence,
										`/work/interactions/${p.interactionId}`,
									),
									sql`EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=${p.orgId} AND r.id=${p.id})`,
								),
							),
					]
				: []),
			db
				.update(workInteractions)
				.set({
					metadata: sql`json_remove(${workInteractions.metadata},'$.followThrough.receipt')`,
				})
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
						sql`json_type(${workInteractions.metadata},'$.followThrough.receipt') IS NOT NULL`,
						sql`EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=${p.orgId} AND r.id=${p.id} AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL))`,
					),
				),
		]);
		if (!responses[0]) throw new Error("lost race");
		response = responses[0];
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new WorkControlError(
			"CONFLICT",
			cause === "lost race" || /resolution race|stale/.test(cause)
				? "Interaction response lost its resolution race"
				: `Interaction response was rejected: ${cause}`,
		);
	}
	// A closure that asks for no delivery (`metadata.delivery: "none"`) is
	// ledgered with the answer as already settled (no channel), so no client
	// wakes or hands off for it; the overlay reads the marker from the answer.
	if (metadata.delivery === "none")
		await db
			.insert(workInteractionDeliveries)
			.values({
				orgId: p.orgId,
				responseId: response.id,
				interactionId: response.interactionId,
				deliveredAt: p.now,
				deliveredVia: null,
				acknowledgedAt: null,
				updatedAt: p.now,
			})
			.onConflictDoNothing();
	return response;
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

function supportDraftCandidateSource() {
	return and(
		sql`json_type(${workInteractions.metadata}, '$.supportTicketId') = 'text'`,
		sql`json_type(${workInteractions.metadata}, '$.supportVersion') = 'integer'`,
		or(
			sql`json_extract(${workInteractions.metadata}, '$.source') = 'support-draft'`,
			and(
				sql`json_extract(${workInteractions.metadata}, '$.source') = 'night-source-adapter'`,
				sql`json_extract(${workInteractions.metadata}, '$.originalSource') = 'support-work-draft'`,
				sql`json_extract(${workInteractions.metadata}, '$.sourceKey') = 'support-draft:' || json_extract(${workInteractions.metadata}, '$.supportTicketId') || ':' || json_extract(${workInteractions.metadata}, '$.supportVersion')`,
				sql`json_extract(${workInteractions.metadata}, '$.decisionDeck.classId') = 'support.reply'`,
				sql`json_extract(${workInteractions.metadata}, '$.decisionDeck.kind') = 'outbound'`,
			),
		),
	);
}

function supportDraftSupersession(now: string, supersededBy: string) {
	return {
		status: "expired" as const,
		expiredAt: now,
		resolutionFence: crypto.randomUUID(),
		version: sql`${workInteractions.version}+1`,
		metadata: sql`json_set(${workInteractions.metadata}, '$.supersession', json(${JSON.stringify({ reason: "newer_support_draft", supersededBy, at: now })}))`,
	};
}

/** Retain previous drafts as expired history, without answering for the recipient. */
export async function supersedeSupportDraftInteractions(
	db: DbQueryClient,
	p: { orgId: string; ticketId: string; targetId: string; now: string },
) {
	const sameSource = and(
		eq(workInteractions.orgId, p.orgId),
		eq(workInteractions.targetType, "user"),
		eq(workInteractions.targetId, p.targetId),
		sql`json_extract(${workInteractions.metadata}, '$.supportTicketId') = ${p.ticketId}`,
		supportDraftCandidateSource(),
	);
	const [latest] = await db
		.select({ id: workInteractions.id, metadata: workInteractions.metadata })
		.from(workInteractions)
		.where(
			and(
				sameSource,
				sql`json_extract(${workInteractions.metadata}, '$.source') = 'support-draft'`,
			),
		)
		.orderBy(
			desc(sql`json_extract(${workInteractions.metadata}, '$.supportVersion')`),
			desc(workInteractions.id),
		)
		.limit(1);
	if (!latest) return [];
	return db
		.update(workInteractions)
		.set(supportDraftSupersession(p.now, latest.id))
		.where(
			and(
				sameSource,
				eq(workInteractions.status, "open"),
				sql`json_extract(${workInteractions.metadata}, '$.supportVersion') < ${latest.metadata.supportVersion}`,
			),
		)
		.returning({ id: workInteractions.id });
}

/** Select only obsolete candidates, so bounded refreshes cannot starve later tickets. */
export async function sweepSupersededSupportDraftInteractions(
	db: DbQueryClient,
	p: {
		orgId: string;
		targetId: string;
		projectId?: string;
		now: string;
		limit: number;
	},
) {
	const newer = alias(workInteractions, "newer_support_draft");
	const replacement = db
		.select({ id: newer.id })
		.from(newer)
		.where(
			and(
				eq(newer.orgId, p.orgId),
				eq(newer.targetType, "user"),
				eq(newer.targetId, p.targetId),
				sql`json_extract(${newer.metadata}, '$.source') = 'support-draft'`,
				sql`json_type(${newer.metadata}, '$.supportVersion') = 'integer'`,
				sql`json_extract(${newer.metadata}, '$.supportTicketId') = json_extract(${workInteractions.metadata}, '$.supportTicketId')`,
				sql`json_extract(${newer.metadata}, '$.supportVersion') > json_extract(${workInteractions.metadata}, '$.supportVersion')`,
			),
		)
		.orderBy(
			desc(sql`json_extract(${newer.metadata}, '$.supportVersion')`),
			desc(newer.id),
		)
		.limit(1);
	const rows = await db
		.select({
			id: workInteractions.id,
			version: workInteractions.version,
			supersededBy: sql<string>`(${replacement})`.as("superseded_by"),
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.targetId),
				eq(workInteractions.status, "open"),
				supportDraftCandidateSource(),
				exists(replacement),
				p.projectId
					? or(
							eq(workInteractions.projectId, p.projectId),
							exists(
								db
									.select({ id: workItems.id })
									.from(workItems)
									.where(
										and(
											eq(workItems.orgId, p.orgId),
											eq(workItems.id, workInteractions.workItemId),
											eq(workItems.projectId, p.projectId),
										),
									),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(p.limit + 1);
	const selected = rows.slice(0, p.limit);
	const [first, ...rest] = selected.map((row) =>
		db
			.update(workInteractions)
			.set(supportDraftSupersession(p.now, row.supersededBy))
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, row.id),
					eq(workInteractions.version, row.version),
					eq(workInteractions.status, "open"),
				),
			)
			.returning({ id: workInteractions.id }),
	);
	const closed = first ? await db.batch([first, ...rest]) : [];
	return {
		superseded: closed.reduce((count, rows) => count + rows.length, 0),
		scanned: selected.length,
		hasMore: rows.length > p.limit,
	};
}

/** Retire obsolete requests without answering in the recipient's name. */
export async function sweepObsoleteWorkInteractions(
	db: DbQueryClient,
	p: { now: string; limit: number },
) {
	const cutoff = new Date(Date.parse(p.now) - 3 * 86_400_000).toISOString();
	const proposalCutoff = new Date(
		Date.parse(p.now) - 14 * 86_400_000,
	).toISOString();
	const obsolete = sql`(
		(${workInteractions.expiresAt} IS NOT NULL AND ${workInteractions.expiresAt}<=${p.now}) OR
		(json_extract(${workInteractions.metadata},'$.schema')='tedix.work-proposal.v1' AND ${workInteractions.expiresAt} IS NULL AND ${workInteractions.createdAt}<=${proposalCutoff} AND NOT EXISTS (SELECT 1 FROM ${workInteractionResponses} WHERE ${workInteractionResponses.orgId}=${workInteractions.orgId} AND ${workInteractionResponses.interactionId}=${workInteractions.id})) OR
		(${workInteractions.kind}='question' AND ${workInteractions.createdAt}<${cutoff} AND EXISTS (
			SELECT 1 FROM ${workItems} WHERE ${workItems.orgId}=${workInteractions.orgId} AND ${workItems.id}=${workInteractions.workItemId} AND ${workItems.disposition} IN ('completed','cancelled')
		)) OR
		(json_extract(${workInteractions.metadata},'$.schema')='tedix.decision-capture.v1' AND json_extract(${workInteractions.metadata},'$.triage.status') IS NOT 'ok')
	)`;
	const rows = await db
		.select()
		.from(workInteractions)
		.where(and(eq(workInteractions.status, "open"), obsolete))
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(p.limit);
	let expired = 0;
	for (const row of rows) {
		const fence = crypto.randomUUID();
		const update = db
			.update(workInteractions)
			.set({
				status: "expired",
				expiredAt: p.now,
				resolutionFence: fence,
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, row.orgId),
					eq(workInteractions.id, row.id),
					eq(workInteractions.version, row.version),
					eq(workInteractions.status, "open"),
					obsolete,
				),
			)
			.returning({ id: workInteractions.id });
		const reason =
			row.expiresAt && row.expiresAt <= p.now
				? "Its expiry date passed."
				: row.metadata.schema === "tedix.decision-capture.v1"
					? "Turn triage was unavailable; retained on the agent's Work."
					: row.metadata.schema === "tedix.work-proposal.v1"
						? "The proposal received no response for fourteen days."
						: "Its Work is completed or cancelled and the question is older than three days.";
		const body = `Closed obsolete request: ${row.subject}. ${reason}`;
		const note =
			row.workItemId && row.metadata.schema !== "tedix.decision-capture.v1"
				? db.insert(workItemComments).select(
						db
							.select({
								id: sql<string>`${crypto.randomUUID()}`.as("id"),
								workItemId: sql<string>`${row.workItemId}`.as("workItemId"),
								orgId: sql<string>`${row.orgId}`.as("orgId"),
								authorType: sql<string>`'system'`.as("authorType"),
								authorId: sql<string>`'tedix'`.as("authorId"),
								body: sql<string>`${body}`.as("body"),
								metadata:
									sql<string>`${JSON.stringify({ source: "interaction-expiry", requestId: row.id })}`.as(
										"metadata",
									),
								createdAt: sql<string>`${p.now}`.as("createdAt"),
							})
							.from(workInteractions)
							.where(
								and(
									eq(workInteractions.orgId, row.orgId),
									eq(workInteractions.id, row.id),
									eq(workInteractions.resolutionFence, fence),
								),
							),
					)
				: null;
		const [closed] = note
			? await db.batch([update, note])
			: await db.batch([update]);
		expired += closed.length;
	}
	return { observed: rows.length, expired };
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
		/** Organization audits must not select private captured session content. */
		excludeSessionCapture?: boolean;
		states?: Array<"open" | "resolved" | "cancelled" | "expired">;
		kinds?: WorkInteractionKind[];
		decisionKind?: "approval";
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
	const urgency = sql`CASE WHEN json_extract(${workInteractions.metadata},'$.notification.state')='immediate' THEN 'now' WHEN ${workInteractionAttention.kind}='fyi' THEN 'later' ELSE COALESCE(json_extract(${workInteractions.metadata},'$.triage.urgency'),'later') END`;
	const resolution = alias(workInteractionResponses, "resolution");
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
				disposition: sql`${workItems.disposition}`
					.mapWith(workItems.disposition)
					.as("work_interaction_item_disposition"),
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
			resolution: {
				id: sql<string | null>`${resolution.id}`.as(
					"work_interaction_resolution_id",
				),
				responderType: sql<string | null>`${resolution.responderType}`.as(
					"work_interaction_resolution_by_type",
				),
				source: sql<
					string | null
				>`json_extract(${resolution.metadata},'$.source')`.as(
					"work_interaction_resolution_source",
				),
				sessionId: sql<
					string | null
				>`json_extract(${resolution.metadata},'$.sessionId')`.as(
					"work_interaction_resolution_session_id",
				),
				delivery: sql<
					string | null
				>`json_extract(${resolution.metadata},'$.delivery')`.as(
					"work_interaction_resolution_delivery",
				),
				deliveredAt: sql<
					string | null
				>`${workInteractionDeliveries.deliveredAt}`.as(
					"work_interaction_delivered_at",
				),
				deliveredVia: sql<
					string | null
				>`${workInteractionDeliveries.deliveredVia}`.as(
					"work_interaction_delivered_via",
				),
				acknowledgedAt: sql<
					string | null
				>`${workInteractionDeliveries.acknowledgedAt}`.as(
					"work_interaction_acknowledged_at",
				),
				handoffTo: sql<
					string | null
				>`${workInteractionDeliveries.handoffTo}`.as(
					"work_interaction_handoff_to",
				),
			},
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
		// At most one response resolves a request (the resolution trigger).
		.leftJoin(
			resolution,
			and(
				eq(resolution.orgId, workInteractions.orgId),
				eq(resolution.interactionId, workInteractions.id),
				eq(resolution.resolvesRequest, true),
			),
		)
		.leftJoin(
			workInteractionDeliveries,
			and(
				eq(workInteractionDeliveries.orgId, resolution.orgId),
				eq(workInteractionDeliveries.responseId, resolution.id),
			),
		)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				p.excludeSessionCapture
					? sql`json_extract(${workInteractions.metadata},'$.schema') IS NOT 'tedix.decision-capture.v1'`
					: undefined,
				// bound-params: states is a closed four-value interaction-state enum
				p.states?.length ? inArray(effective, p.states) : undefined,
				// bound-params: kinds is a closed five-value interaction-kind enum
				p.kinds?.length ? inArray(workInteractions.kind, p.kinds) : undefined,
				p.decisionKind === "approval"
					? sql`(
					(json_type(${workInteractions.metadata},'$.approvalOperation')='text'
					AND length(trim(json_extract(${workInteractions.metadata},'$.approvalOperation')))>0
					AND json_type(${workInteractions.metadata},'$.approvalTarget')='text'
					AND length(trim(json_extract(${workInteractions.metadata},'$.approvalTarget')))>0)
					OR json_extract(${workInteractions.metadata},'$.decisionDeck.kind')='approval'
				)`
					: undefined,
				p.workItemId
					? eq(workInteractions.workItemId, p.workItemId)
					: undefined,
				p.projectId
					? or(
							eq(workInteractions.projectId, p.projectId),
							eq(workItems.projectId, p.projectId),
						)
					: undefined,
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
				p.targetType === "user"
					? sql`coalesce(json_extract(${workInteractions.metadata},'$.notification.state'),'immediate') NOT IN ('deferred','bundled','suppressed')`
					: undefined,
				p.targetType === "user"
					? sql`coalesce(json_extract(${workInteractions.metadata},'$.followThrough.snoozedUntil'),'')<=${p.observedAt}`
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

/** Identifier-only projection for the MCP interaction event feed. */
export type RequestedWorkInteractionEventRow = Pick<
	WorkInteraction,
	| "id"
	| "workItemId"
	| "projectId"
	| "kind"
	| "targetType"
	| "targetId"
	| "creatorType"
	| "dueAt"
	| "createdAt"
>;

/** Org-scoped ascending keyset read; private content is never selected. */
export async function listRequestedWorkInteractionEvents(
	db: DbQueryClient,
	p: {
		orgId: string;
		laneRequestsOnly?: boolean;
		after: { at: string; id: string } | null;
		workItemId?: string;
		targetId?: string;
		kind?: WorkInteractionKind;
		limit: number;
	},
): Promise<RequestedWorkInteractionEventRow[]> {
	return db
		.select({
			id: workInteractions.id,
			workItemId: workInteractions.workItemId,
			projectId: workInteractions.projectId,
			kind: workInteractions.kind,
			targetType: workInteractions.targetType,
			targetId: workInteractions.targetId,
			creatorType: workInteractions.creatorType,
			dueAt: workInteractions.dueAt,
			createdAt: workInteractions.createdAt,
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				p.workItemId
					? eq(workInteractions.workItemId, p.workItemId)
					: undefined,
				p.targetId ? eq(workInteractions.targetId, p.targetId) : undefined,
				p.kind ? eq(workInteractions.kind, p.kind) : undefined,
				p.laneRequestsOnly
					? sql`${workInteractions.kind} = 'handoff' AND ${workInteractions.targetType} = 'user' AND ${workInteractions.workItemId} IS NOT NULL AND ${workInteractions.status} = 'open' AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt} > ${new Date().toISOString()}) AND json_extract(${workInteractions.metadata}, '$.laneRequest.harness') IN ('codex','claude-code')`
					: undefined,
				sql`(${workInteractions.targetType}<>'user' OR coalesce(json_extract(${workInteractions.metadata},'$.notification.state'),'immediate') NOT IN ('deferred','bundled','suppressed'))`,
				p.after
					? sql`(${workInteractions.createdAt}>${p.after.at} OR (${workInteractions.createdAt}=${p.after.at} AND ${workInteractions.id}>${p.after.id}))`
					: undefined,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(p.limit);
}

/** Newest interaction position in the org, used to poll "from now". */
export async function getLatestWorkInteractionPosition(
	db: DbQueryClient,
	orgId: string,
): Promise<{ at: string; id: string } | null> {
	const [row] = await db
		.select({ at: workInteractions.createdAt, id: workInteractions.id })
		.from(workInteractions)
		.where(eq(workInteractions.orgId, orgId))
		.orderBy(desc(workInteractions.createdAt), desc(workInteractions.id))
		.limit(1);
	return row ?? null;
}

/** ID-only response feed; joined parent scope is required for Work Item filters. */
export async function listWorkInteractionResponseEvents(
	db: DbQueryClient,
	p: {
		orgId: string;
		after: { at: string; id: string } | null;
		requestId?: string;
		workItemId?: string;
		responderType?: WorkInteractionTargetType;
		limit: number;
	},
) {
	return db
		.select({
			id: workInteractionResponses.id,
			interactionId: workInteractionResponses.interactionId,
			responderType: workInteractionResponses.responderType,
			responderId: workInteractionResponses.responderId,
			respondedAt: workInteractionResponses.respondedAt,
			workItemId: workInteractions.workItemId,
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
				p.requestId
					? eq(workInteractionResponses.interactionId, p.requestId)
					: undefined,
				p.workItemId
					? eq(workInteractions.workItemId, p.workItemId)
					: undefined,
				p.responderType
					? eq(workInteractionResponses.responderType, p.responderType)
					: undefined,
				p.after
					? sql`(${workInteractionResponses.respondedAt}>${p.after.at} OR (${workInteractionResponses.respondedAt}=${p.after.at} AND ${workInteractionResponses.id}>${p.after.id}))`
					: undefined,
			),
		)
		.orderBy(
			asc(workInteractionResponses.respondedAt),
			asc(workInteractionResponses.id),
		)
		.limit(p.limit);
}

/** Newest response position in the org, used to poll "from now". */
export async function getLatestWorkInteractionResponsePosition(
	db: DbQueryClient,
	orgId: string,
): Promise<{ at: string; id: string } | null> {
	const [row] = await db
		.select({
			at: workInteractionResponses.respondedAt,
			id: workInteractionResponses.id,
		})
		.from(workInteractionResponses)
		.where(eq(workInteractionResponses.orgId, orgId))
		.orderBy(
			desc(workInteractionResponses.respondedAt),
			desc(workInteractionResponses.id),
		)
		.limit(1);
	return row ?? null;
}

/** Four-hour digests, with overnight preparation held for the 08:00 UTC brief. */
export function nextInteractionDigestAt(now: string): string {
	const next = new Date(
		Math.floor(Date.parse(now) / 14_400_000) * 14_400_000 + 14_400_000,
	);
	if (next.getUTCHours() < 8) next.setUTCHours(8, 0, 0, 0);
	return next.toISOString();
}

/** Global maintenance; each digest is scoped to one exact tenant and recipient. */
export async function flushWorkInteractionDigests(
	db: DbQueryClient,
	now: string,
) {
	await nudgeLaneHandoffs(db, now);
	const nearDeadline = new Date(Date.parse(now) + 86_400_000).toISOString();
	const slotStart = new Date(
		Math.floor(Date.parse(now) / 14_400_000) * 14_400_000,
	).toISOString();
	const rows = await db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				sql`json_extract(${workInteractions.metadata},'$.notification.state')='deferred'`,
				sql`(${workInteractions.expiresAt}<=${now} OR ${workInteractions.dueAt}<${nearDeadline}
					OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND (w.disposition IN ('completed','cancelled') OR coalesce(w.deadline,w.due_date)<${nearDeadline}))
					OR (json_extract(${workInteractions.metadata},'$.notification.deliverAt')<=${now} AND NOT EXISTS (SELECT 1 FROM work_interactions digest WHERE digest.org_id=${workInteractions.orgId} AND digest.target_id=${workInteractions.targetId} AND json_extract(digest.metadata,'$.notification.state')='digest' AND digest.created_at>=${slotStart})))`,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(100);
	const groups = new Map<string, WorkInteraction[]>();
	let suppressed = 0,
		escalated = 0,
		digests = 0;
	for (const row of rows) {
		const work = row.workItemId
			? await requireWorkItem(db, row.orgId, row.workItemId)
			: null;
		const obsolete =
			(row.expiresAt !== null && row.expiresAt <= now) ||
			work?.disposition === "completed" ||
			work?.disposition === "cancelled";
		const deadline = [row.dueAt, work?.deadline, work?.dueDate]
			.filter((at): at is string => Boolean(at))
			.sort()[0];
		const urgent = Boolean(
			deadline && Date.parse(deadline) - Date.parse(now) < 86_400_000,
		);
		if (obsolete || urgent) {
			await db
				.update(workInteractions)
				.set({
					metadata: sql`json_set(${workInteractions.metadata},'$.notification.state',${obsolete ? "suppressed" : "immediate"},'$.notification.reason',${obsolete ? "already_handled" : "deadline_under_24h"})`,
				})
				.where(
					and(
						eq(workInteractions.orgId, row.orgId),
						eq(workInteractions.id, row.id),
						eq(workInteractions.status, "open"),
					),
				);
			if (obsolete) suppressed++;
			else escalated++;
			continue;
		}
		const notification = row.metadata.notification as { deliverAt: string };
		if (notification.deliverAt > now || new Date(now).getUTCHours() < 8)
			continue;
		const key = `${row.orgId}:${row.targetId}`;
		const group = groups.get(key) ?? [];
		if (group.length < 20) group.push(row);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const first = group[0]!;
		const slot = Math.floor(Date.parse(now) / 14_400_000);
		const hash = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					`digest:${first.orgId}:${first.targetId}:${slot}`,
				),
			),
		);
		const hex = [...hash.slice(0, 16)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const ids = group.map((row) => row.id);
		// The membership test prevents a racing tick from claiming rows omitted
		// from the winning digest. A late arrival waits for the following slot.
		const [created] = await db.batch([
			db
				.insert(workInteractions)
				.select(
					db
						.select({
							id: sql<string>`${id}`.as("id"),
							orgId: sql<string>`${first.orgId}`.as("org_id"),
							workItemId: sql<string | null>`${first.workItemId}`.as(
								"work_item_id",
							),
							caseId: sql<string | null>`${first.caseId}`.as("case_id"),
							projectId: sql<string | null>`${first.projectId}`.as(
								"project_id",
							),
							kind: sql<"coordination">`'coordination'`.as("kind"),
							status: sql<"open">`'open'`.as("status"),
							creatorType: sql<"system">`'system'`.as("creator_type"),
							creatorId: sql<string>`'tedix'`.as("creator_id"),
							targetType: sql<"user">`'user'`.as("target_type"),
							targetId: sql<string>`${first.targetId}`.as("target_id"),
							subject:
								sql<string>`'Tedi digest: ' || count(*) || ' updates'`.as(
									"subject",
								),
							prompt:
								sql<string>`group_concat('- ' || ${workInteractions.subject} || ': ' || substr(${workInteractions.prompt},1,500) || char(10) || 'Request: ' || ${workInteractions.id}, char(10))`.as(
									"prompt",
								),
							metadata: sql<
								Record<string, JsonValue>
							>`json_object('notification',json_object('state','digest','requestIds',json_group_array(${workInteractions.id})))`.as(
								"metadata",
							),
							createdAt: sql<string>`${now}`.as("created_at"),
						})
						.from(workInteractions)
						.where(
							and(
								eq(workInteractions.orgId, first.orgId),
								eq(workInteractions.targetId, first.targetId!),
								eq(workInteractions.status, "open"),
								sql`json_extract(${workInteractions.metadata},'$.notification.state')='deferred'`,
								sql`(${workInteractions.dueAt} IS NULL OR ${workInteractions.dueAt}>=${nearDeadline})`,
								// bound-params: at most 20 digest members
								inArray(workInteractions.id, ids),
								sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})`,
								sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND (w.disposition IN ('completed','cancelled') OR coalesce(w.deadline,w.due_date)<${nearDeadline}))`,
							),
						)
						.having(sql`count(*)>0`),
				)
				.onConflictDoNothing()
				.returning({ id: workInteractions.id }),
			...group.map((row) =>
				db
					.update(workInteractions)
					.set({
						metadata: sql`json_set(${workInteractions.metadata},'$.notification.state','bundled','$.notification.digestId',${id})`,
					})
					.where(
						and(
							eq(workInteractions.orgId, row.orgId),
							eq(workInteractions.id, row.id),
							eq(workInteractions.status, "open"),
							sql`json_extract(${workInteractions.metadata},'$.notification.state')='deferred'`,
							sql`EXISTS (SELECT 1 FROM work_interactions digest, json_each(digest.metadata,'$.notification.requestIds') member WHERE digest.org_id=${row.orgId} AND digest.id=${id} AND member.value=${row.id})`,
						),
					),
			),
		]);
		digests += created.length;
	}
	return { digests, suppressed, escalated };
}

export interface ReviewWorkInteractionParams {
	orgId: string;
	interactionId: string;
	expectedVersion: number;
	actor: InteractionActor;
	action: "close" | "reask" | "continued";
	note: string;
	responseId?: string;
	evidenceId?: string;
	now: string;
}

/** Only the original asker (and exact harness session) owns the next step. */
export async function reviewWorkInteraction(
	db: DbQueryClient,
	p: ReviewWorkInteractionParams,
) {
	await validateActor(db, p.orgId, p.actor);
	const request = await getWorkInteraction(db, p);
	if (
		!request ||
		request.creatorType !== p.actor.type ||
		request.creatorId !== p.actor.id ||
		(request.creatorType === "external_agent" &&
			request.creatorSessionId !== p.actor.sessionId)
	) {
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the original ask owner may review or continue it",
		);
	}
	const rawFollow = request.metadata.followThrough;
	const follow =
		rawFollow && typeof rawFollow === "object" && !Array.isArray(rawFollow)
			? rawFollow
			: undefined;
	let continuation: Record<string, JsonValue> | null = null;
	if (p.action === "continued") {
		const [answer] = await db
			.select()
			.from(workInteractionResponses)
			.where(
				and(
					eq(workInteractionResponses.orgId, p.orgId),
					eq(workInteractionResponses.interactionId, request.id),
					sql`(${workInteractionResponses.resolvesRequest}=1 OR json_extract(${workInteractionResponses.metadata},'$.corrects') IS NOT NULL)`,
				),
			)
			.orderBy(
				desc(workInteractionResponses.respondedAt),
				desc(workInteractionResponses.id),
			)
			.limit(1);
		if (
			request.status !== "resolved" ||
			!answer ||
			answer.id !== p.responseId ||
			!p.evidenceId
		)
			throw new WorkControlError(
				"CONFLICT",
				"Continuation requires the current exact answer and action evidence",
			);
		const evidence =
			p.actor.type === "tedi"
				? await db
						.select({ id: tediRuntimeEvents.id })
						.from(tediRuntimeEvents)
						.where(
							and(
								eq(tediRuntimeEvents.organizationId, p.orgId),
								eq(tediRuntimeEvents.tediId, p.actor.id),
								eq(tediRuntimeEvents.id, p.evidenceId),
								eq(tediRuntimeEvents.kind, "tool.completed"),
								sql`${tediRuntimeEvents.createdAt}>=${answer.respondedAt}`,
								sql`coalesce(json_extract(${tediRuntimeEvents.payload},'$.success'),1)<>0`,
							),
						)
						.limit(1)
				: p.actor.type === "external_agent"
					? await db
							.select({ id: workAttempts.id })
							.from(workAttempts)
							.where(
								and(
									eq(workAttempts.orgId, p.orgId),
									eq(workAttempts.id, p.evidenceId),
									eq(workAttempts.workItemId, request.workItemId ?? ""),
									eq(workAttempts.executorType, "external_agent"),
									eq(workAttempts.executorId, p.actor.id),
									eq(workAttempts.executorSessionId, p.actor.sessionId!),
									eq(workAttempts.outcome, "succeeded"),
									sql`${workAttempts.finishedAt}>=${answer.respondedAt}`,
								),
							)
							.limit(1)
					: [];
		if (!evidence.length)
			throw new WorkControlError(
				"CONFLICT",
				"Owner continuation action evidence was not found after the answer",
			);
		if (
			follow?.receipt &&
			typeof follow.receipt === "object" &&
			!Array.isArray(follow.receipt) &&
			follow.receipt.responseId === p.responseId &&
			follow.receipt.evidenceId === p.evidenceId
		)
			return request;
		continuation = {
			responseId: answer.id,
			evidenceId: p.evidenceId,
			note: p.note,
			at: p.now,
		};
	} else {
		const reviewAt =
			typeof follow?.reviewAt === "string"
				? follow.reviewAt
				: new Date(
						Date.parse(request.createdAt) + 3 * 86_400_000,
					).toISOString();
		if (
			request.status !== "open" ||
			(request.expiresAt && request.expiresAt <= p.now) ||
			reviewAt > p.now
		)
			throw new WorkControlError(
				"CONFLICT",
				"This ask is not due for an unanswered review",
			);
		if (p.action === "reask" && follow?.reaskedAt)
			throw new WorkControlError(
				"CONFLICT",
				"An unanswered ask may be re-asked only once",
			);
		if (p.action === "reask" && request.workItemId) {
			const work = await requireWorkItem(db, p.orgId, request.workItemId);
			if (work.disposition === "completed" || work.disposition === "cancelled")
				throw new WorkControlError(
					"CONFLICT",
					"Do not re-ask about completed or cancelled Work",
				);
		}
	}
	if (request.version !== p.expectedVersion)
		throw new WorkControlError(
			"CONFLICT",
			"Interaction changed; read it again",
		);
	const nextFollow: Record<string, JsonValue> = {
		...follow,
		reviewedAt: p.now,
		note: p.note,
		...(continuation ? { receipt: continuation } : {}),
		...(p.action === "reask"
			? {
					reaskedAt: p.now,
					reaskNote: p.note,
					reviewAt: new Date(Date.parse(p.now) + 3 * 86_400_000).toISOString(),
				}
			: {}),
	};
	const mutation = db
		.update(workInteractions)
		.set({
			metadata: { ...request.metadata, followThrough: nextFollow },
			...(p.action === "close"
				? {
						status: "cancelled" as const,
						cancelledAt: p.now,
						resolutionFence: crypto.randomUUID(),
					}
				: {}),
			version: sql`${workInteractions.version}+1`,
		})
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.id, request.id),
				eq(workInteractions.version, p.expectedVersion),
			),
		)
		.returning();
	const [rows] = await db.batch([
		mutation,
		...(p.action === "close" &&
		request.targetType === "user" &&
		request.targetId &&
		(request.metadata.laneHandoff || follow?.laneHandoff)
			? [
					db
						.update(agentSessionRequests)
						.set({
							status: "cancelled",
							statusChangedAt: p.now,
							updatedAt: p.now,
						})
						.where(
							and(
								eq(agentSessionRequests.organizationId, p.orgId),
								eq(agentSessionRequests.userId, request.targetId),
								eq(
									agentSessionRequests.evidence,
									`/work/interactions/${request.id}`,
								),
								sql`EXISTS (SELECT 1 FROM work_interactions i WHERE i.org_id=${p.orgId} AND i.id=${request.id} AND i.status='cancelled' AND i.version=${p.expectedVersion + 1})`,
							),
						),
				]
			: []),
	]);
	const updated = rows[0];
	if (!updated)
		throw new WorkControlError("CONFLICT", "Interaction changed during review");
	return updated;
}

/** Global scheduler read. Finished Work and ended owner sessions never get nudged. */
export async function listDueWorkInteractionReviews(
	db: DbQueryClient,
	now: string,
) {
	return db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.targetType, "user"),
				sql`${workInteractions.kind}<>'coordination'`,
				sql`((${workInteractions.status}='open'
					AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.reviewAt'),strftime('%Y-%m-%dT%H:%M:%fZ',${workInteractions.createdAt},'+3 days'))<=${now}
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.reviewWakeVersion'),0)<>${workInteractions.version})
				 OR (${workInteractions.status}='resolved'
					AND coalesce(json_extract(${workInteractions.metadata},'$.followThrough.continuationRetryAt'),'')<=${now}
					AND EXISTS (SELECT 1 FROM work_interaction_responses r WHERE r.org_id=${workInteractions.orgId} AND r.interaction_id=${workInteractions.id}
						AND (r.resolves_request=1 OR json_extract(r.metadata,'$.corrects') IS NOT NULL)
						AND coalesce(json_extract(r.metadata,'$.delivery'),'')<>'none'
						AND r.responded_at<=${new Date(Date.parse(now) - 300_000).toISOString()}
						AND r.id IS NOT json_extract(${workInteractions.metadata},'$.followThrough.receipt.responseId')
						AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id AND (newer.resolves_request=1 OR json_extract(newer.metadata,'$.corrects') IS NOT NULL) AND (newer.responded_at>r.responded_at OR (newer.responded_at=r.responded_at AND newer.id>r.id))))))`,
				sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`,
				sql`((${workInteractions.creatorType}='tedi' AND EXISTS (SELECT 1 FROM tedis t WHERE t.id=${workInteractions.creatorId} AND t.organization_id=${workInteractions.orgId} AND t.status='active')) OR
		(${workInteractions.creatorType}='external_agent' AND EXISTS (SELECT 1 FROM external_agent_sessions s WHERE s.id=${workInteractions.creatorSessionId} AND s.organization_id=${workInteractions.orgId} AND s.principal_id=${workInteractions.creatorId} AND s.status='active')) OR EXISTS (SELECT 1 FROM work_items w JOIN tedis t ON t.id=w.accountable_owner_id AND t.organization_id=w.org_id WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.accountable_owner_type='tedi' AND t.status='active' AND t.retired_at IS NULL))`,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(50);
}

export async function recordWorkInteractionReviewWake(
	db: DbQueryClient,
	row: WorkInteraction,
	now: string,
	runId: string | null,
) {
	await db
		.update(workInteractions)
		.set({
			metadata:
				row.status === "resolved"
					? sql`json_set(${workInteractions.metadata},'$.followThrough.continuationWakeAt',${now},'$.followThrough.continuationRunId',${runId},'$.followThrough.continuationRetryAt',${new Date(Date.parse(now) + 6 * 3_600_000).toISOString()})`
					: sql`json_set(${workInteractions.metadata},'$.followThrough.reviewWakeVersion',${row.version},'$.followThrough.reviewRunId',${runId})`,
		})
		.where(
			and(
				eq(workInteractions.orgId, row.orgId),
				eq(workInteractions.id, row.id),
				eq(workInteractions.version, row.version),
				eq(workInteractions.status, row.status),
			),
		);
}

/** Recognize a manually prepared deadline card before the automatic source runs. */
export async function getDeadlineDecision(
	db: DbQueryClient,
	input: {
		orgId: string;
		userId: string;
		workItemId: string;
		deadlineKey: string;
	},
) {
	return (
		(
			await db
				.select()
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, input.orgId),
						eq(workInteractions.workItemId, input.workItemId),
						eq(workInteractions.targetType, "user"),
						eq(workInteractions.targetId, input.userId),
						sql`json_extract(${workInteractions.metadata}, '$.source') = 'deadline-decisions'`,
						sql`json_extract(${workInteractions.metadata}, '$.deadlineKey') = ${input.deadlineKey}`,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
