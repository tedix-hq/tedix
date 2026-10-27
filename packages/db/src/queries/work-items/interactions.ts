import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	decisionSourcesCurrent,
	DECISION_SOURCE_CHANGED,
} from "./decision-sources";
import {
	recordCardCreationEdges,
	recordDecisionResolutionEdges,
} from "../decision-graph-writers";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
	credentialCard,
} from "@tedix/api-contract/utils/card-secrets";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	getColumns,
	inArray,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { nextInteractionDigestAt } from "./interaction-digests";
import { workItems, workItemComments } from "../../schema/work-items";
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
import { policyPacks } from "../../schema/control-plane";
import {
	COORDINATION_TTL_DEFAULT_HOURS,
	COORDINATION_TTL_MAX_HOURS,
	COORDINATION_TTL_MIN_HOURS,
	REQUEST_TTL_DEFAULT_HOURS,
	REQUEST_TTL_MIN_HOURS,
	REQUEST_TTL_MAX_HOURS,
	humanReservedActionClasses,
} from "@tedix/api-contract/utils/approval-policy";
import { humanOnlyAskReasons } from "@tedix/api-contract/utils/human-only-ask";
import { cardScheduleDates } from "@tedix/api-contract/utils/card-schedule";
import {
	DEFAULT_DECK_ROUTING,
	DecisionEnvelopeSchema,
	matchesDeckClass,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { auditEvents } from "../../schema/audit-events";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import { organizations } from "../../schema/organizations";
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

export type InteractionActor = {
	type: "user" | "tedi" | "external_agent" | "system";
	id: string;
	sessionId?: string;
	externalSessionKey?: string;
};
export async function validateActor(
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
	// Reuse the existing create surface for recipient-authorized restore; source content wins.
	const restore = p.metadata?.restoreExpiry;
	if (restore !== undefined) {
		if (
			!restore ||
			typeof restore !== "object" ||
			Array.isArray(restore) ||
			typeof restore.interactionId !== "string" ||
			typeof restore.receiptId !== "string" ||
			typeof restore.expectedVersion !== "number" ||
			!Number.isInteger(restore.expectedVersion) ||
			p.creator.type !== "user" ||
			p.targetType !== "user" ||
			p.targetId !== p.creator.id
		)
			throw new WorkControlError(
				"NOT_ELIGIBLE",
				"Restore requires the addressed person and an exact receipt and version",
			);
		const restored = await restoreExpiredWorkInteraction(db, {
			orgId: p.orgId,
			interactionId: restore.interactionId,
			receiptId: restore.receiptId,
			expectedVersion: restore.expectedVersion,
			actor: p.creator,
			now: p.now,
			id: p.id,
		});
		const row =
			restored &&
			(await getWorkInteraction(db, {
				orgId: p.orgId,
				interactionId: restored.id,
			}));
		if (!row)
			throw new WorkControlError(
				"CONFLICT",
				"This expiry was already restored or changed",
			);
		return row;
	}
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
	const creatorSessionId =
		p.creator.sessionId ??
		(p.creator.type === "user" &&
		typeof p.metadata?.agentSession === "string" &&
		p.metadata.agentSession.length <= 300
			? p.metadata.agentSession
			: null);
	// Exact content and source/session fences preserve distinct choices and private asks.
	const equivalent = and(
		eq(workInteractions.orgId, p.orgId),
		eq(workInteractions.status, "open"),
		sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
		eq(workInteractions.creatorType, p.creator.type),
		eq(workInteractions.creatorId, p.creator.id),
		sql`${workInteractions.creatorSessionId} IS ${creatorSessionId}`,
		sql`${workInteractions.creatorExternalSessionKey} IS ${p.creator.externalSessionKey ?? null}`,
		sql`${workInteractions.workItemId} IS ${p.workItemId ?? null}`,
		sql`${workInteractions.caseId} IS ${p.caseId ?? null}`,
		sql`${workInteractions.projectId} IS ${p.projectId ?? null}`,
		eq(workInteractions.targetType, p.targetType),
		eq(workInteractions.targetId, p.targetId),
		eq(workInteractions.kind, p.kind),
		eq(workInteractions.subject, p.subject),
		eq(workInteractions.prompt, p.prompt),
		sql`json_remove(${workInteractions.metadata}, '$.notification', '$.followThrough') = json_remove(${JSON.stringify(metadata)}, '$.notification', '$.followThrough')`,
		p.metadata?.blockerRouting
			? undefined
			: sql`${workInteractions.dueAt} IS ${p.dueAt ?? null} AND ${workInteractions.expiresAt} IS ${p.expiresAt ?? null}`,
	);
	const dedupe = ["question", "input"].includes(p.kind);
	const created = (
		await db
			.insert(workInteractions)
			.select(
				db
					.select({
						id: sql<string>`${p.id}`.as("id"),
						orgId: sql<string>`${p.orgId}`.as("org_id"),
						workItemId: sql<string | null>`${p.workItemId ?? null}`.as(
							"work_item_id",
						),
						caseId: sql<string | null>`${p.caseId ?? null}`.as("case_id"),
						projectId: sql<string | null>`${p.projectId ?? null}`.as(
							"project_id",
						),
						kind: sql<string>`${p.kind}`.as("kind"),
						status: sql<string>`'open'`.as("status"),
						subject: sql<string>`${p.subject}`.as("subject"),
						prompt: sql<string>`${p.prompt}`.as("prompt"),
						creatorType: sql<string>`${p.creator.type}`.as("creator_type"),
						creatorId: sql<string>`${p.creator.id}`.as("creator_id"),
						creatorSessionId: sql<string | null>`${creatorSessionId}`.as(
							"creator_session_id",
						),
						creatorExternalSessionKey: sql<
							string | null
						>`${p.creator.externalSessionKey ?? null}`.as(
							"creator_external_session_key",
						),
						targetType: sql<string>`${p.targetType}`.as("target_type"),
						targetId: sql<string>`${p.targetId}`.as("target_id"),
						dueAt: sql<string | null>`${p.dueAt ?? null}`.as("due_at"),
						expiresAt: sql<string | null>`${p.expiresAt ?? null}`.as(
							"expires_at",
						),
						resolutionFence: sql<null>`NULL`.as("resolution_fence"),
						createdAt: sql<string>`${p.now}`.as("created_at"),
						version: sql<number>`1`.as("version"),
						metadata: sql<string>`${JSON.stringify(metadata)}`.as("metadata"),
					})
					.from(sql`(SELECT 1)`)
					.where(
						dedupe
							? sql`NOT EXISTS (SELECT 1 FROM ${workInteractions} WHERE ${equivalent})`
							: sql`1=1`,
					),
			)
			.onConflictDoNothing({
				target: [workInteractions.orgId, workInteractions.id],
			})
			.returning()
	)[0];
	if (!created && dedupe) {
		const [existing] = await db
			.select()
			.from(workInteractions)
			.where(equivalent)
			.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
			.limit(1);
		if (existing) return existing;
	}
	if (!created) {
		const existing = await getWorkInteraction(db, {
			orgId: p.orgId,
			interactionId: p.id,
		});
		if (
			!existing ||
			existing.creatorType !== p.creator.type ||
			existing.creatorId !== p.creator.id ||
			existing.kind !== p.kind ||
			existing.workItemId !== (p.workItemId ?? null) ||
			existing.caseId !== (p.caseId ?? null) ||
			existing.projectId !== (p.projectId ?? null)
		)
			throw new WorkControlError(
				"CONFLICT",
				"Interaction ID already belongs to another request",
			);
		// A retry must preserve answers, revisions, delegation and notification state.
		return existing;
	}
	await recordCardCreationEdges(db, created, work);
	return created;
}

interface RepositoryCiAlertParams {
	orgId: string;
	projectId: string;
	repository: string;
	branch: string;
	surface: string;
	sha: string;
	ownerTediId: string;
	escalationUserId: string;
	occurredAt?: string;
	now: string;
}

function repositoryCiScope(p: RepositoryCiAlertParams) {
	return sql`w.org_id=${p.orgId} AND w.project_id=${p.projectId}
		AND json_extract(w.metadata, '$.repositoryObserver')=1
		AND json_extract(w.metadata, '$.event.kind')='ci_red'
		AND json_extract(w.metadata, '$.event.repository')=${p.repository}
		AND json_extract(w.metadata, '$.event.branch')=${p.branch}
		AND json_extract(w.metadata, '$.event.surface')=${p.surface}`;
}

const ciAlertReason = "Failing checks need a decision after diagnosis";

export async function createRepositoryCiAlert(
	db: DbQueryClient,
	p: RepositoryCiAlertParams & {
		id: string;
		workItemId: string;
		subject: string;
		prompt: string;
	},
) {
	await validateActor(db, p.orgId, { type: "tedi", id: p.ownerTediId });
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: "user",
		id: p.escalationUserId,
	});
	const work = await requireWorkItem(db, p.orgId, p.workItemId);
	const deadline = [work.deadline, work.dueDate]
		.filter((at): at is string => Boolean(at))
		.sort()[0];
	const urgent = Boolean(
		deadline && Date.parse(deadline) - Date.parse(p.now) < 86_400_000,
	);
	const metadata = JSON.stringify({
		reason: ciAlertReason,
		notification: {
			state: urgent ? "immediate" : "deferred",
			reason: urgent ? "deadline_under_24h" : "quiet_batch",
			deliverAt: urgent ? p.now : nextInteractionDigestAt(p.now),
		},
	});
	await db.run(sql`INSERT INTO work_interactions
		(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
		SELECT ${p.id},${p.orgId},${p.workItemId},'coordination',${p.subject},${p.prompt},'tedi',${p.ownerTediId},'user',${p.escalationUserId},${p.now},${metadata}
		WHERE EXISTS (SELECT 1 FROM work_items w WHERE ${repositoryCiScope(p)} AND w.id=${p.workItemId} AND w.disposition IN ('proposed','accepted') AND json_extract(w.metadata, '$.ciRecoveredAt') IS NULL)
		AND NOT EXISTS (SELECT 1 FROM work_interactions a JOIN work_items w ON w.org_id=a.org_id AND w.id=a.work_item_id
			WHERE ${repositoryCiScope(p)} AND a.status='open' AND a.kind='coordination'
			AND json_extract(a.metadata, '$.reason')=${ciAlertReason})
		ON CONFLICT DO NOTHING`);
	const created = await getWorkInteraction(db, {
		orgId: p.orgId,
		interactionId: p.id,
	});
	if (created) await recordCardCreationEdges(db, created, work);
}

/**
 * Keep the one open CI alert of a repository, branch and surface current.
 *
 * Only writes the deployed `work_interaction_*_guard` triggers accept: an open
 * request's subject and metadata (bar `notification`/`followThrough`) are
 * immutable, and a status change may not edit metadata. The red period's SHAs
 * and failure count therefore stay on the CI observations (`work_items`).
 * - red: restarts the coordination expiry window by stamping
 *   `metadata.notification.refreshedAt`; status and version stay unchanged;
 * - green: cancels the alert without touching its metadata.
 * Returns the alerts in scope it updated.
 */
export async function refreshRepositoryCiAlerts(
	db: DbQueryClient,
	p: RepositoryCiAlertParams & { green: boolean },
) {
	return db
		.update(workInteractions)
		.set(
			p.green
				? {
						status: "cancelled" as const,
						cancelledAt: p.now,
						resolutionFence: crypto.randomUUID(),
						version: sql`${workInteractions.version}+1`,
					}
				: {
						metadata: sql`json_set(${workInteractions.metadata}, '$.notification.refreshedAt', ${p.now})`,
					},
		)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.kind, "coordination"),
				eq(workInteractions.status, "open"),
				sql`json_extract(${workInteractions.metadata}, '$.reason')=${ciAlertReason}`,
				eq(workInteractions.creatorType, "tedi"),
				eq(workInteractions.creatorId, p.ownerTediId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.escalationUserId),
				// bound-params: SQL subquery binds a fixed scope, not one parameter per result
				inArray(
					workInteractions.workItemId,
					db
						.select({ id: workItems.id })
						.from(workItems)
						.where(
							and(
								eq(workItems.orgId, p.orgId),
								eq(workItems.projectId, p.projectId),
								sql`json_extract(${workItems.metadata}, '$.repositoryObserver')=1`,
								sql`json_extract(${workItems.metadata}, '$.event.kind')='ci_red'`,
								sql`json_extract(${workItems.metadata}, '$.event.repository')=${p.repository}`,
								sql`json_extract(${workItems.metadata}, '$.event.branch')=${p.branch}`,
								sql`json_extract(${workItems.metadata}, '$.event.surface')=${p.surface}`,
							),
						),
				),
			),
		)
		.returning();
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
	const effect = p.metadata?.decisionEffect;
	const effectReceipt =
		effect && typeof effect === "object" && !Array.isArray(effect)
			? effect
			: null;
	// An effect may itself update a cited task. Its completion uses the source check
	// made at the persisted claim, never a client-supplied completion receipt alone.
	const claimedEffect =
		effectReceipt &&
		["succeeded", "failed"].includes(String(effectReceipt.status))
			? (
					await listWorkInteractionResponses(db, {
						orgId: p.orgId,
						interactionId: request.id,
						limit: 100,
					})
				).some((response) => {
					const started = response.metadata.decisionEffect;
					return (
						response.resolvedRequestVersion === p.expectedVersion &&
						response.responderType === p.responder.type &&
						response.responderId === p.responder.id &&
						started &&
						typeof started === "object" &&
						!Array.isArray(started) &&
						started.status === "started" &&
						started.kind === effectReceipt.kind
					);
				})
			: false;
	if (
		(resolvesRequest || effectReceipt?.status === "started") &&
		!claimedEffect &&
		!(await decisionSourcesCurrent(db, p.orgId, request))
	)
		throw new WorkControlError("CONFLICT", DECISION_SOURCE_CHANGED);
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
	if (
		p.responder.type === "user" &&
		(resolvesRequest || corrects) &&
		request.kind !== "coordination"
	)
		await recordDecisionResolutionEdges(db, {
			orgId: p.orgId,
			cardId: request.id,
			decisionId: response.id,
			workItemId: request.workItemId,
			occurredAt: response.respondedAt,
			source: "card_resolution",
			evidenceRef: `work-interaction-response:${response.id}`,
			note: response.body,
		});
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

/**
 * The organization's `governancePolicy.coordinationTtlHours` from its newest
 * active policy pack, else the published system default, else 48 h; clamped
 * like `parseKernelGovernancePolicy`. Correlated on the outer interaction row.
 */
function interactionTtlHoursSql(request = false) {
	const field = request
		? "$.governancePolicy.requestTtlHours"
		: "$.governancePolicy.coordinationTtlHours";
	const min = request ? REQUEST_TTL_MIN_HOURS : COORDINATION_TTL_MIN_HOURS;
	const max = request ? REQUEST_TTL_MAX_HOURS : COORDINATION_TTL_MAX_HOURS;
	const fallback = request
		? REQUEST_TTL_DEFAULT_HOURS
		: COORDINATION_TTL_DEFAULT_HOURS;
	const numeric = sql`CASE WHEN json_type(pp.definition, ${field}) IN ('integer','real') THEN json_extract(pp.definition, ${field}) END`;
	return sql`min(${max}, max(${min}, round(coalesce(
		(SELECT ${numeric} FROM ${policyPacks} pp WHERE pp.organization_id = ${workInteractions.orgId} AND pp.status = 'active' ORDER BY pp.version DESC LIMIT 1),
		(SELECT ${numeric} FROM ${policyPacks} pp WHERE pp.organization_id IS NULL AND pp.scope = 'system' AND pp.slug = 'system-default' AND pp.status = 'active' AND pp.published_at IS NOT NULL ORDER BY pp.version DESC LIMIT 1),
		${fallback}))))`;
}

const OBSOLETE_REQUEST_REASONS = {
	request_unanswered:
		"Nobody answered within the organization's request window.",
	original_request_closed: "Its original request is no longer open.",
	expiry_passed: "Its expiry date passed.",
	coordination_stale:
		"It was a status update that nobody refreshed within the organization's coordination window.",
	work_closed: "Its Work is completed or cancelled.",
	triage_unavailable:
		"Turn triage was unavailable; retained on the agent's Work.",
	proposal_unanswered: "The proposal received no response for fourteen days.",
} as const;
type ObsoleteRequestCause = keyof typeof OBSOLETE_REQUEST_REASONS;

function staleLaneReminder(now: string) {
	return sql`(json_type(${workInteractions.metadata},'$.laneNudge') IS 'object' AND NOT EXISTS (
		SELECT 1 FROM work_interactions original
		WHERE original.org_id=${workInteractions.orgId}
		AND original.id=json_extract(${workInteractions.metadata},'$.laneNudge.requestId')
		AND original.target_type=${workInteractions.targetType} AND original.target_id=${workInteractions.targetId}
		AND original.status='open' AND (original.expires_at IS NULL OR original.expires_at>${now})
	))`;
}

/** Effects and owner-only topics remain human decisions, including malformed declarations. */
function protectedExpiryRequest(row: WorkInteraction) {
	const m = row.metadata;
	const text = `${row.subject}\n${row.prompt}`;
	const d = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	const classId = String(
		(m.decisionDeck as Record<string, JsonValue> | undefined)?.classId ?? "",
	);
	return (
		Boolean(m.protected) ||
		m.schema === "tedix.outbound.v1" ||
		m.approvalOperation !== undefined ||
		Boolean(m.localImport) ||
		["high", "critical"].includes(String(m.riskLevel)) ||
		(m.protectedEffects !== undefined &&
			(!Array.isArray(m.protectedEffects) || m.protectedEffects.length > 0)) ||
		(m.decisionDeck !== undefined &&
			(!d.success ||
				d.data.protectedEffects.length > 0 ||
				["approval", "outbound"].includes(d.data.kind))) ||
		matchesDeckClass(classId, DEFAULT_DECK_ROUTING.criticalClasses) ||
		DEFAULT_DECK_ROUTING.criticalQuestionPatterns.some((pattern) =>
			new RegExp(pattern, "i").test(text),
		) ||
		humanReservedActionClasses(text).length > 0 ||
		humanOnlyAskReasons(row.subject).length > 0 ||
		credentialCard(text, m)
	);
}

const EXPIRY_SCAN = "interaction-expiry:v1";
const EXPIRY_RECEIPT = "interaction.expiry.run";

/** Receipts are tenant scoped audit records (30-day retention); restore is bounded to seven days. */
export async function listInteractionExpiryReceipts(
	db: DbQueryClient,
	orgId: string,
	limit = 10,
) {
	return db
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, orgId),
				eq(auditEvents.action, EXPIRY_RECEIPT),
			),
		)
		.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
		.limit(Math.min(100, Math.max(1, limit)));
}

/**
 * Round-robin organizations and keyset pages within each organization. All lifecycle
 * writes, exact-id receipts and cursor advances commit in one D1 batch. The global
 * checkpoint CAS fences overlapping fires; every statement also checks that fence.
 * `limit` budgets ALL row writes, including receipts, notes and checkpoints.
 * Each organization's first visit is dry-run; only a later fire may enforce.
 */
export async function sweepObsoleteWorkInteractions(
	db: DbQueryClient,
	p: { now: string; limit: number; dryRun?: boolean },
) {
	const budget = Math.min(100, Math.max(0, Math.floor(p.limit)));
	const empty = {
		observed: 0,
		expired: 0,
		candidates: 0,
		writes: 0,
		dryRun: 0,
	};
	if (!Number.isFinite(budget) || budget < 3) return empty;
	const [previous] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, EXPIRY_SCAN))
		.limit(1);
	if (previous && previous.through >= p.now) return empty;
	const runId = crypto.randomUUID();
	const gate = sql`EXISTS (SELECT 1 FROM ${platformCronCheckpoints} WHERE ${platformCronCheckpoints.scheduleId}=${EXPIRY_SCAN} AND ${platformCronCheckpoints.through}=${p.now} AND json_extract(${platformCronCheckpoints.cursor}, '$.tediId')=${runId})`;
	const orgs = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			exists(
				db
					.select({ id: workInteractions.id })
					.from(workInteractions)
					.where(
						and(
							eq(workInteractions.orgId, organizations.id),
							eq(workInteractions.status, "open"),
						),
					),
			),
		)
		.orderBy(
			sql`CASE WHEN ${organizations.id}>${previous?.cursor?.key ?? ""} THEN 0 ELSE 1 END`,
			asc(organizations.id),
		)
		.limit(10);
	if (!orgs.length) return empty;
	const statements = [];
	let writes = 1,
		observed = 0,
		candidates = 0,
		dryRuns = 0;
	let lastOrg = previous?.cursor?.key ?? "";
	const fences: string[] = [];
	const unanswered = sql`NOT EXISTS (SELECT 1 FROM ${workInteractionResponses} WHERE ${workInteractionResponses.orgId}=${workInteractions.orgId} AND ${workInteractionResponses.interactionId}=${workInteractions.id})`;
	const passedExpiry = sql`(${workInteractions.expiresAt} IS NOT NULL AND ${workInteractions.expiresAt}<=${p.now})`;
	const staleCoordination = sql`(${workInteractions.kind}='coordination' AND ${workInteractions.targetType}='user' AND ${workInteractions.expiresAt} IS NULL AND julianday(coalesce(json_extract(${workInteractions.metadata},'$.notification.refreshedAt'), json_extract(${workInteractions.metadata},'$.refreshedAt'), ${workInteractions.createdAt})) <= julianday(${p.now}) - ${interactionTtlHoursSql()} / 24.0)`;
	const staleAsk = sql`(${workInteractions.kind} IN ('question','input','handoff') AND ${workInteractions.targetType}='user' AND ${workInteractions.expiresAt} IS NULL AND julianday(${workInteractions.createdAt}) <= julianday(${p.now}) - ${interactionTtlHoursSql(true)} / 24.0)`;
	const terminalWork = sql`(${workInteractions.kind} IN ('question','input','handoff') AND EXISTS (SELECT 1 FROM ${workItems} WHERE ${workItems.orgId}=${workInteractions.orgId} AND ${workItems.id}=${workInteractions.workItemId} AND ${workItems.disposition} IN ('completed','cancelled')))`;
	const triageUnavailable = sql`(json_extract(${workInteractions.metadata},'$.schema')='tedix.decision-capture.v1' AND json_extract(${workInteractions.metadata},'$.triage.status') IS NOT 'ok')`;
	const legacyProposal = sql`(json_extract(${workInteractions.metadata},'$.schema')='tedix.work-proposal.v1' AND ${workInteractions.expiresAt} IS NULL AND julianday(${workInteractions.createdAt})<=julianday(${p.now})-14)`;
	const obsolete = sql`(${staleLaneReminder(p.now)} OR ${passedExpiry} OR ${staleCoordination} OR ${staleAsk} OR ${terminalWork} OR ${triageUnavailable} OR ${legacyProposal})`;
	for (const org of orgs) {
		if (writes + 2 > budget) break;
		const checkpointId = `${EXPIRY_SCAN}:${org.id}`;
		const [cursor] = await db
			.select()
			.from(platformCronCheckpoints)
			.where(eq(platformCronCheckpoints.scheduleId, checkpointId))
			.limit(1);
		const dryRun = p.dryRun !== false && (!cursor || p.dryRun === true);
		// Do not rotate past an organization without enough budget to serve it.
		if (!dryRun && writes + 4 > budget) break;
		const rows = await db
			.select({
				...getColumns(workInteractions),
				cause: sql<ObsoleteRequestCause>`CASE
                    WHEN ${staleLaneReminder(p.now)} THEN 'original_request_closed'
                    WHEN ${passedExpiry} THEN 'expiry_passed'
                    WHEN ${triageUnavailable} THEN 'triage_unavailable'
                    WHEN ${terminalWork} THEN 'work_closed'
                    WHEN ${staleCoordination} THEN 'coordination_stale'
                    WHEN ${staleAsk} THEN 'request_unanswered'
                    ELSE 'proposal_unanswered' END`.as("obsolete_cause"),
			})
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, org.id),
					eq(workInteractions.status, "open"),
					unanswered,
					obsolete,
				),
			)
			.orderBy(
				sql`CASE WHEN (${workInteractions.createdAt},${workInteractions.id})>(${cursor?.cursor?.changedAt ?? ""},${cursor?.cursor?.key ?? ""}) THEN 0 ELSE 1 END`,
				asc(workInteractions.createdAt),
				asc(workInteractions.id),
			)
			.limit(100);
		const fence = `${runId}:${org.id}`;
		fences.push(fence);
		const ids: string[] = [];
		let last = cursor?.cursor ?? null;
		writes += 2;
		for (const row of rows) {
			const note =
				row.workItemId && row.metadata.schema !== "tedix.decision-capture.v1";
			const cost = 1 + (note ? 1 : 0);
			if (!dryRun && writes + cost > budget) break;
			observed++;
			last = { changedAt: row.createdAt, key: row.id, tediId: "" };
			if (
				protectedExpiryRequest(row) ||
				row.dueAt !== null ||
				Object.entries(row.metadata).some(
					([key, value]) =>
						value != null &&
						["due", "dueat", "duedate", "deadline"].includes(
							key.replace(/[\s_-]/g, "").toLowerCase(),
						),
				) ||
				cardScheduleDates(row).some(
					(date) => Date.parse(date) > Date.parse(p.now),
				) ||
				(typeof (
					row.metadata.followThrough as Record<string, JsonValue> | undefined
				)?.snoozedUntil === "string" &&
					String(
						(row.metadata.followThrough as Record<string, JsonValue>)
							.snoozedUntil,
					) > p.now)
			)
				continue;
			ids.push(row.id);
			candidates++;
			if (dryRun) continue;
			writes += cost;
			statements.push(
				db
					.update(workInteractions)
					.set({
						status: "expired",
						expiredAt: p.now,
						resolutionFence: fence,
						version: sql`${workInteractions.version}+1`,
					})
					.where(
						and(
							gate,
							eq(workInteractions.orgId, row.orgId),
							eq(workInteractions.id, row.id),
							eq(workInteractions.version, row.version),
							eq(workInteractions.status, "open"),
							unanswered,
							sql`json(${workInteractions.metadata})=json(${JSON.stringify(row.metadata)})`,
							obsolete,
						),
					),
			);
			if (note)
				statements.push(
					db.insert(workItemComments).select(
						db
							.select({
								id: sql<string>`${crypto.randomUUID()}`.as("id"),
								workItemId: sql<string>`${row.workItemId}`.as("workItemId"),
								orgId: sql<string>`${org.id}`.as("orgId"),
								authorType: sql<string>`'system'`.as("authorType"),
								authorId: sql<string>`'tedix'`.as("authorId"),
								body: sql<string>`${`Closed obsolete request: ${row.subject}. ${OBSOLETE_REQUEST_REASONS[row.cause]}`}`.as(
									"body",
								),
								metadata:
									sql<string>`${JSON.stringify({ source: "interaction-expiry", requestId: row.id, cause: row.cause, runId })}`.as(
										"metadata",
									),
								createdAt: sql<string>`${p.now}`.as("createdAt"),
							})
							.from(workInteractions)
							.where(
								and(
									gate,
									eq(workInteractions.orgId, org.id),
									eq(workInteractions.id, row.id),
									eq(workInteractions.resolutionFence, fence),
								),
							),
					),
				);
		}
		if (dryRun) dryRuns++;
		const metadata = {
			runId,
			mode: dryRun ? "dry_run" : "enforce",
			candidateIds: ids,
			fence,
			at: p.now,
		};
		statements.push(
			db.insert(auditEvents).select(
				db
					.select({
						id: sql<string>`${fence}`.as("id"),
						organizationId: sql<string>`${org.id}`.as("organizationId"),
						actorId: sql<string>`'interaction-expiry'`.as("actorId"),
						actorType: sql<string>`'service'`.as("actorType"),
						action: sql<string>`${EXPIRY_RECEIPT}`.as("action"),
						resourceType: sql<string>`'work_interaction'`.as("resourceType"),
						resourceId: sql<string>`${runId}`.as("resourceId"),
						metadata:
							sql<string>`json_set(${JSON.stringify(metadata)},'$.expiredIds',json((SELECT json_group_array(id) FROM work_interactions WHERE org_id=${org.id} AND resolution_fence=${fence} AND status='expired')))`.as(
								"metadata",
							),
						timestamp: sql<number>`${Math.floor(Date.parse(p.now) / 1000)}`.as(
							"timestamp",
						),
					})
					.from(platformCronCheckpoints)
					.where(
						and(eq(platformCronCheckpoints.scheduleId, EXPIRY_SCAN), gate),
					),
			),
		);
		statements.push(
			db
				.insert(platformCronCheckpoints)
				.select(
					db
						.select({
							scheduleId: sql<string>`${checkpointId}`.as("scheduleId"),
							through: sql<string>`${p.now}`.as("through"),
							cursor: sql<
								string | null
							>`${dryRun ? null : JSON.stringify(last)}`.as("cursor"),
						})
						.from(platformCronCheckpoints)
						.where(
							and(eq(platformCronCheckpoints.scheduleId, EXPIRY_SCAN), gate),
						),
				)
				.onConflictDoUpdate({
					target: platformCronCheckpoints.scheduleId,
					set: { through: p.now, cursor: dryRun ? null : last },
					setWhere: gate,
				}),
		);
		lastOrg = org.id;
	}
	const claim = db
		.insert(platformCronCheckpoints)
		.values({
			scheduleId: EXPIRY_SCAN,
			through: p.now,
			cursor: { changedAt: p.now, key: lastOrg, tediId: runId },
		})
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: {
				through: p.now,
				cursor: { changedAt: p.now, key: lastOrg, tediId: runId },
			},
			setWhere: previous
				? eq(platformCronCheckpoints.through, previous.through)
				: sql`0`,
		})
		.returning({ id: platformCronCheckpoints.scheduleId });
	const [claimed] = await db.batch([claim, ...statements]);
	if (!claimed.length) return empty;
	const receipts = await db
		.select({ metadata: auditEvents.metadata })
		.from(auditEvents)
		// bound-params: at most one fence for each of the ten selected organizations.
		.where(inArray(auditEvents.id, fences));
	return {
		observed,
		candidates,
		expired: receipts.reduce(
			(n, r) =>
				n +
				(Array.isArray(r.metadata?.expiredIds)
					? r.metadata.expiredIds.length
					: 0),
			0,
		),
		writes,
		dryRun: dryRuns,
	};
}

/** Restore one receipted expiry as a new request; terminal history is immutable. */
export async function restoreExpiredWorkInteraction(
	db: DbQueryClient,
	p: {
		id?: string;
		orgId: string;
		interactionId: string;
		receiptId: string;
		expectedVersion: number;
		actor: InteractionActor;
		now: string;
	},
) {
	await validateActor(db, p.orgId, p.actor);
	if (p.actor.type !== "user")
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Only the addressed person can restore an expired request",
		);
	const [receipt] = await db
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.id, p.receiptId),
				eq(auditEvents.organizationId, p.orgId),
				eq(auditEvents.action, EXPIRY_RECEIPT),
			),
		)
		.limit(1);
	const ids = receipt?.metadata?.expiredIds;
	if (
		!receipt ||
		!Array.isArray(ids) ||
		!ids.includes(p.interactionId) ||
		Date.parse(p.now) - receipt.timestamp.getTime() > 7 * 86400000 ||
		Date.parse(p.now) < receipt.timestamp.getTime()
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Restore requires a matching expiry receipt no older than seven days",
		);
	const row = await getWorkInteraction(db, {
		orgId: p.orgId,
		interactionId: p.interactionId,
	});
	if (
		!row ||
		row.targetType !== "user" ||
		row.targetId !== p.actor.id ||
		row.status !== "expired" ||
		row.version !== p.expectedVersion ||
		row.resolutionFence !== receipt.metadata?.fence
	)
		throw new WorkControlError(
			"CONFLICT",
			"Expired request changed or belongs to another recipient",
		);
	const work = row.workItemId
		? await requireWorkItem(db, p.orgId, row.workItemId)
		: null;
	if (work && ["completed", "cancelled"].includes(work.disposition))
		throw new WorkControlError("NOT_ELIGIBLE", "Restore requires active Work");
	const metadata: Record<string, JsonValue> = {
		...row.metadata,
		restoredFrom: { id: row.id, receiptId: p.receiptId },
		refreshedAt: p.now,
	};
	// A restored FYI gets a fresh window rather than inheriting its old refresh clock.
	if (
		metadata.notification &&
		typeof metadata.notification === "object" &&
		!Array.isArray(metadata.notification)
	)
		metadata.notification = { ...metadata.notification, refreshedAt: p.now };
	const id = p.id ?? crypto.randomUUID();
	const [restored] = await db
		.insert(workInteractions)
		.select(
			db
				.select({
					orgId: workInteractions.orgId,
					workItemId: workInteractions.workItemId,
					caseId: workInteractions.caseId,
					projectId: workInteractions.projectId,
					kind: workInteractions.kind,
					subject: workInteractions.subject,
					prompt: workInteractions.prompt,
					creatorType: sql<string>`'user'`.as("creatorType"),
					creatorId: sql<string>`${p.actor.id}`.as("creatorId"),
					targetType: workInteractions.targetType,
					targetId: workInteractions.targetId,
					dueAt: workInteractions.dueAt,
					createdAt: sql<string>`${p.now}`.as("createdAt"),
					metadata: sql<string>`${JSON.stringify(metadata)}`.as("metadata"),
					id: sql<string>`${id}`.as("id"),
					status: sql<string>`'open'`.as("status"),
					version: sql<number>`1`.as("version"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.interactionId),
						eq(workInteractions.version, p.expectedVersion),
						eq(workInteractions.status, "expired"),
						eq(workInteractions.resolutionFence, row.resolutionFence!),
						sql`NOT EXISTS (SELECT 1 FROM work_interaction_responses WHERE org_id=${p.orgId} AND interaction_id=${p.interactionId})`,
						sql`NOT EXISTS (SELECT 1 FROM work_interactions successor WHERE successor.org_id=${p.orgId} AND json_extract(successor.metadata,'$.restoredFrom.id')=${p.interactionId} AND json_extract(successor.metadata,'$.restoredFrom.receiptId')=${p.receiptId})`,
						sql`NOT EXISTS (SELECT 1 FROM work_items source WHERE source.org_id=${p.orgId} AND source.id=${row.workItemId} AND source.disposition IN ('completed','cancelled'))`,
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: workInteractions.id });
	return restored ?? null;
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
/** Snoozing changes only follow-through display state, never the answer or version. */
export async function snoozeWorkInteraction(
	db: DbQueryClient,
	p: {
		orgId: string;
		interactionId: string;
		expectedVersion: number;
		actor: InteractionActor;
		until: string;
		now: string;
	},
) {
	await validateActor(db, p.orgId, p.actor);
	if (p.actor.type !== "user")
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the addressed person can snooze a card",
		);
	if (
		!Number.isFinite(Date.parse(p.until)) ||
		Date.parse(p.until) <= Date.parse(p.now)
	)
		throw new WorkControlError("NOT_ELIGIBLE", "Choose a future wake time");
	const [row] = await db
		.update(workInteractions)
		.set({
			metadata: sql`json_set(${workInteractions.metadata}, '$.followThrough.snoozedUntil', ${new Date(p.until).toISOString()})`,
		})
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.id, p.interactionId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.actor.id),
				eq(workInteractions.version, p.expectedVersion),
				eq(workInteractions.status, "open"),
				or(
					isNull(workInteractions.expiresAt),
					sql`${workInteractions.expiresAt}>${p.now}`,
				),
			),
		)
		.returning();
	if (!row)
		throw new WorkControlError(
			"CONFLICT",
			"The card changed or is not addressed to you",
		);
	return row;
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
			lastRelatedDecision: sql<
				string | null
			>`(SELECT json_object('requestId', prior.id, 'subject', prior.subject, 'body', answer.body, 'decidedAt', answer.responded_at)
    FROM work_interactions prior
    JOIN work_interaction_responses answer ON answer.org_id=prior.org_id AND answer.interaction_id=prior.id AND answer.resolves_request=1
    LEFT JOIN work_items prior_work ON prior_work.org_id=prior.org_id AND prior_work.id=prior.work_item_id
    WHERE prior.org_id=${workInteractions.orgId} AND prior.id<>${workInteractions.id}
    AND prior.status='resolved' AND prior.target_type=${workInteractions.targetType} AND prior.target_id=${workInteractions.targetId}
    AND (prior.work_item_id=${workInteractions.workItemId}
      OR coalesce(prior.project_id,prior_work.project_id)=coalesce(${workInteractions.projectId},${workItems.projectId})
      OR EXISTS (SELECT 1
       FROM json_each(coalesce(json_extract(prior.metadata,'$.decisionSources'),json_extract(prior.metadata,'$.decisionDeck.sources'),'[]')) old_source
       JOIN json_each(coalesce(json_extract(${workInteractions.metadata},'$.decisionSources'),json_extract(${workInteractions.metadata},'$.decisionDeck.sources'),'[]')) current_source
       ON json_extract(old_source.value,'$.kind')=json_extract(current_source.value,'$.kind')
       AND json_extract(old_source.value,'$.id')=json_extract(current_source.value,'$.id')
       AND json_extract(old_source.value,'$.tediId') IS json_extract(current_source.value,'$.tediId')))
    ORDER BY answer.responded_at DESC, answer.id DESC LIMIT 1)`.as(
				"last_related_decision",
			),
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
				sql`(${workInteractions.status}<>'open' OR NOT ${staleLaneReminder(p.observedAt)})`,
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
					? sql`(${workInteractions.status}<>'open' OR coalesce(json_extract(${workInteractions.metadata},'$.followThrough.snoozedUntil'),'')<=${p.observedAt})`
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
