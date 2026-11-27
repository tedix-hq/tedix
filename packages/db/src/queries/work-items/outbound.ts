import {
	recordPersistedCardCreationEdges,
	recordPersistedCardResolutionEdges,
} from "../decision-graph-writers";
import {
	OUTBOUND_SCHEMA,
	OutboundPolicySchema,
	OutboundStateSchema,
	type OutboundState,
	type OutboundPolicy,
	type OutboundRecord,
} from "@tedix/api-contract/schemas/outbound";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { batchNonEmpty, chunkForBoundParams } from "../../utils/batch";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import {
	anyIds,
	booleanValue,
	coreStore,
	jsonParameter,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import { organizations as organizationsTable } from "../../schema/organizations";
import {
	workItems as workItemsTable,
	workEvents as workEventsTable,
} from "../../schema/work-items";
import {
	workInteractions as interactionsTable,
	workInteractionResponses as responsesTable,
	workInteractionCardRevisions,
} from "../../schema/work-factory";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { buildCardRevisionLearningStatement } from "./card-revisions";

/** A JSON parameter, or SQL NULL; INSERT ... SELECT casts it to the target column. */
function jsonOrNull(db: object, value: unknown): SQL {
	return value == null ? sql`${null}` : jsonParameter(db, value);
}

export async function getOutboundPolicy(
	db: DbQueryClient,
	orgId: string,
): Promise<OutboundPolicy> {
	const organizations = coreTable(db, organizationsTable);
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	return OutboundPolicySchema.parse(
		row?.metadata?.outboundReview ?? { routes: [] },
	);
}

export async function putOutboundPolicy(
	db: DbQueryClient,
	orgId: string,
	policy: OutboundPolicy,
) {
	const organizations = coreTable(db, organizationsTable);
	await db
		.update(organizations)
		.set({
			metadata: jsonWrite(
				db,
				organizations.metadata,
				["outboundReview"],
				policy,
			),
		})
		.where(eq(organizations.id, orgId));
}

export async function listOutbound(
	db: DbQueryClient,
	orgId: string,
	projectId: string | undefined,
	limit: number,
) {
	const workItems = coreTable(db, workItemsTable);
	const rows = await db
		.select({
			id: workItems.id,
			projectId: workItems.projectId,
			title: workItems.title,
			version: workItems.version,
			metadata: workItems.metadata,
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.workKind, "outbound"),
				...(projectId ? [eq(workItems.projectId, projectId)] : []),
			),
		)
		.orderBy(desc(workItems.updatedAt), desc(workItems.createdAt))
		.limit(limit);
	return rows.flatMap((row) => {
		const parsed = OutboundStateSchema.safeParse(row.metadata?.outbound);
		return parsed.success
			? [
					{
						workItemId: row.id,
						projectId: row.projectId,
						title: row.title,
						version: row.version,
						outbound: parsed.data,
					},
				]
			: [];
	});
}

/** Work and its human card change under one D1 CAS; a stale click cannot claim a send. */
export async function saveOutbound(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		expectedVersion: number;
		state: OutboundState;
		actor: {
			type: "user" | "tedi" | "external_agent" | "system";
			id: string;
			sessionId?: string;
			externalSessionKey?: string;
		};
		action: string;
		now: string;
		createInteraction?: boolean;
		revisionFeedback?: {
			summary?: string;
			keptHunks?: (typeof workInteractionCardRevisions.$inferInsert)["keptHunks"];
			parentRevision?: number;
		};
		response?: {
			body: string;
			feedback?: string;
			before: string;
			resolves: boolean;
			anchors?: (typeof workInteractionCardRevisions.$inferInsert)["anchors"];
			chips?: string[];
			fromRevision?: number;
		};
	},
) {
	const nextVersion = p.expectedVersion + 1;
	if (containsCardSecret([p.state.draft, p.response, p.revisionFeedback]))
		throw new Error(CARD_SECRET_MESSAGE);
	const workItems = coreTable(db, workItemsTable);
	const workEvents = coreTable(db, workEventsTable);
	const workInteractions = coreTable(db, interactionsTable);
	const workInteractionResponses = coreTable(db, responsesTable);
	const revisions = coreTable(db, workInteractionCardRevisions);
	const transitionId = crypto.randomUUID();
	const changed = sql`EXISTS (SELECT 1 FROM work_items WHERE org_id=${p.orgId} AND id=${p.workItemId} AND version=${nextVersion} AND ${jsonRead(db, sql`metadata`, ["outboundTransitionId"])}=${transitionId})`;
	const changeRequest = (column: string, kind: "text" | "json" = "text") =>
		sql`(SELECT ${column === "id" ? sql`id` : jsonRead(db, sql`metadata`, [column], kind)} FROM work_interaction_responses WHERE org_id=${p.orgId} AND interaction_id=${p.state.interactionId} AND ${jsonRead(db, sql`metadata`, ["cardAction"])}='ask_changes' ORDER BY resolved_request_version DESC,responded_at DESC,id DESC LIMIT 1)`;
	const statements: BatchItem<"sqlite">[] = [
		db
			.update(workItems)
			.set({
				workKind: "outbound",
				metadata: jsonWrite(
					db,
					jsonWrite(db, workItems.metadata, ["outbound"], p.state),
					["outboundTransitionId"],
					transitionId,
				),
				reviewerType: "tedi",
				reviewerId: p.state.reviewerTediId,
				updatedAt: p.now,
				version: nextVersion,
			})
			.where(
				and(
					eq(workItems.orgId, p.orgId),
					eq(workItems.id, p.workItemId),
					eq(workItems.version, p.expectedVersion),
					p.createInteraction
						? undefined
						: sql`EXISTS (SELECT 1 FROM work_interactions q WHERE q.org_id=${p.orgId} AND q.id=${p.state.interactionId} AND q.work_item_id=${p.workItemId} AND q.target_type='user' AND q.target_id=${p.state.ownerUserId} AND q.kind IN ('question','input') AND q.status='open' AND (q.expires_at IS NULL OR q.expires_at>${p.now}))`,
				),
			)
			.returning({ id: workItems.id }),
		db.insert(workEvents).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					orgId: workItems.orgId,
					workItemId: sql<string>`${workItems.id}`.as("work_item_id"),
					eventType: sql<string>`'outbound.action'`.as("event_type"),
					actorType: sql<typeof p.actor.type>`${p.actor.type}`.as("actor_type"),
					actorId: sql<string>`${p.actor.id}`.as("actor_id"),
					actorSessionId: sql<string | null>`${p.actor.sessionId ?? null}`.as(
						"actor_session_id",
					),
					payload:
						sql`${jsonParameter(db, { action: p.action, draftRevision: p.state.draftRevision })}`.as(
							"payload",
						),
					occurredAt: sql<string>`${p.now}`.as("occurred_at"),
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, p.orgId),
						eq(workItems.id, p.workItemId),
						changed,
					),
				),
		),
	];
	if (p.createInteraction)
		statements.push(
			db.insert(workInteractions).select(
				db
					.select({
						id: sql<string>`${p.state.interactionId}`.as("id"),
						orgId: workItems.orgId,
						workItemId: sql<string>`${workItems.id}`.as("work_item_id"),
						projectId: workItems.projectId,
						kind: sql<string>`'question'`.as("kind"),
						status: sql<string>`'open'`.as("status"),
						subject:
							sql<string>`${`Review ${p.state.draft.channel}: ${p.state.draft.subject || p.state.draft.recipient}`.slice(0, 300)}`.as(
								"subject",
							),
						prompt: sql<string>`${p.state.draft.body.slice(0, 20_000)}`.as(
							"prompt",
						),
						creatorType: sql<typeof p.actor.type>`${p.actor.type}`.as(
							"creator_type",
						),
						creatorId: sql<string>`${p.actor.id}`.as("creator_id"),
						creatorSessionId: sql<
							string | null
						>`${p.actor.sessionId ?? null}`.as("creator_session_id"),
						creatorExternalSessionKey: sql<
							string | null
						>`${p.actor.externalSessionKey ?? null}`.as(
							"creator_external_session_key",
						),
						targetType: sql<string>`'user'`.as("target_type"),
						targetId: sql<string>`${p.state.ownerUserId}`.as("target_id"),
						createdAt: sql<string>`${p.now}`.as("created_at"),
						metadata:
							sql`${jsonParameter(db, { schema: OUTBOUND_SCHEMA, outboundWorkItemId: p.workItemId, decisionClass: p.state.draft.topic, channel: p.state.draft.channel, personId: p.state.draft.recipient, proposerTediId: p.state.reviewerTediId })}`.as(
								"metadata",
							),
					})
					.from(workItems)
					.where(
						and(
							eq(workItems.orgId, p.orgId),
							eq(workItems.id, p.workItemId),
							changed,
						),
					),
			),
		);
	let responseId: string | undefined;
	if (p.response) {
		const response = p.response;
		responseId = crypto.randomUUID();
		statements.push(
			db.insert(workInteractionResponses).select(
				db
					.select({
						id: sql<string>`${responseId}`.as("id"),
						orgId: workInteractions.orgId,
						interactionId: sql<string>`${workInteractions.id}`.as(
							"interaction_id",
						),
						resolvedRequestVersion:
							sql<number>`${workInteractions.version} + 1`.as(
								"resolved_request_version",
							),
						resolutionFence: sql<string>`${crypto.randomUUID()}`.as(
							"resolution_fence",
						),
						responderType: sql<typeof p.actor.type>`${p.actor.type}`.as(
							"responder_type",
						),
						responderId: sql<string>`${p.actor.id}`.as("responder_id"),
						responseKind:
							sql<string>`CASE WHEN ${workInteractions.kind}='input' THEN 'input_provided' ELSE 'answer' END`.as(
								"response_kind",
							),
						body: sql<string>`${response.body}`.as("body"),
						resolvesRequest:
							sql<boolean>`${booleanValue(db, response.resolves)}`.as(
								"resolves_request",
							),
						respondedAt: sql<string>`${p.now}`.as("responded_at"),
						metadata:
							sql`${jsonParameter(db, { schema: OUTBOUND_SCHEMA, action: p.action, ...(p.action === "feedback" ? { cardAction: "ask_changes", instruction: response.feedback, anchors: response.anchors ?? [], chips: response.chips ?? [], fromRevision: response.fromRevision ?? p.state.draftRevision } : {}), before: response.before, after: response.body, feedback: response.feedback ?? null, draftRevision: p.state.draftRevision, source: "os-outbound" })}`.as(
								"metadata",
							),
					})
					.from(workInteractions)
					.where(
						and(
							eq(workInteractions.orgId, p.orgId),
							eq(workInteractions.id, p.state.interactionId),
							changed,
						),
					),
			),
		);
	}
	const revisionId = crypto.randomUUID();
	statements.push(
		db.insert(revisions).select(
			db
				.select({
					id: sql<string>`${revisionId}`.as("id"),
					orgId: workInteractions.orgId,
					requestId: sql<string>`${workInteractions.id}`.as("request_id"),
					revision:
						sql<number>`coalesce((SELECT max(revision) FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.state.interactionId}),0)+1`.as(
							"revision",
						),
					body: sql<string>`${p.state.draft.body}`.as("body"),
					field: sql<string>`'draft'`.as("field"),
					anchors: sql<
						(typeof workInteractionCardRevisions.$inferInsert)["anchors"]
					>`${changeRequest("anchors", "json")}`.as("anchors"),
					summary: sql<
						string | null
					>`${p.revisionFeedback?.summary ?? null}`.as("summary"),
					keptHunks: sql<
						(typeof workInteractionCardRevisions.$inferInsert)["keptHunks"]
					>`${jsonOrNull(db, p.revisionFeedback?.keptHunks)}`.as("kept_hunks"),
					learningEventId: sql<string>`${crypto.randomUUID()}`.as(
						"learning_event_id",
					),
					parentRevision: sql<
						number | null
					>`coalesce(${p.revisionFeedback?.parentRevision ?? null}, (SELECT max(revision) FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.state.interactionId}))`.as(
						"parent_revision",
					),
					cause: sql<
						"initial" | "human_edit" | "agent_rewrite" | "restore"
					>`CASE WHEN NOT EXISTS (SELECT 1 FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.state.interactionId}) THEN 'initial' WHEN ${p.action}='restore' THEN 'restore' WHEN ${p.actor.type}='user' THEN 'human_edit' ELSE 'agent_rewrite' END`.as(
						"cause",
					),
					actorType: sql<string>`${p.actor.type}`.as("actor_type"),
					actorId: sql<string>`${p.actor.id}`.as("actor_id"),
					actorSessionId: sql<string | null>`${p.actor.sessionId ?? null}`.as(
						"actor_session_id",
					),
					instruction: sql<
						string | null
					>`${p.action === "restore" ? sql`${p.response?.feedback ?? null}` : changeRequest("instruction")}`.as(
						"instruction",
					),
					responseId: sql<string | null>`${changeRequest("id")}`.as(
						"response_id",
					),
					createdAt: sql<string>`${p.now}`.as("created_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.state.interactionId),
						changed,
						sql`coalesce((SELECT body FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.state.interactionId} ORDER BY revision DESC LIMIT 1),'')<>${p.state.draft.body}`,
					),
				),
		),
	);
	statements.push(buildCardRevisionLearningStatement(db, p.orgId, revisionId));
	const results = await db.batch(batchNonEmpty(statements));
	const saved = (results[0] as Array<{ id: string }>).length === 1;
	if (saved && p.createInteraction)
		await recordPersistedCardCreationEdges(db, p.orgId, p.state.interactionId);
	if (saved && responseId)
		await recordPersistedCardResolutionEdges(db, p.orgId, responseId);
	return saved;
}

export async function outboundApprovalHistory(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
) {
	const workInteractionResponses = coreTable(db, responsesTable);
	const rows = await db
		.select({
			id: workInteractionResponses.id,
			body: workInteractionResponses.body,
			metadata: workInteractionResponses.metadata,
			at: workInteractionResponses.respondedAt,
			totalCount: sql<number>`count(*) over()`.as("total_count"),
		})
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, orgId),
				eq(workInteractionResponses.responderType, "user"),
				eq(workInteractionResponses.responderId, ownerUserId),
				sql`${jsonRead(db, workInteractionResponses.metadata, ["schema"])}=${OUTBOUND_SCHEMA}`,
				sql`${jsonRead(db, workInteractionResponses.metadata, ["action"])} IN ('approve_manual','approve_send')`,
			),
		)
		.orderBy(desc(workInteractionResponses.respondedAt))
		.limit(10);
	// Postgres returns count(*) as a bigint string.
	return rows.map((row) => ({ ...row, totalCount: Number(row.totalCount) }));
}

/** Projection only: the original Interaction's prompt, author and metadata stay immutable. */
export async function outboundInteractionOverlays(
	db: DbQueryClient,
	orgId: string,
	interactionIds: string[],
) {
	const overlays: {
		interactionId: string;
		workItemId: string;
		subject: string;
		status: OutboundState["status"];
		record: OutboundRecord;
	}[] = [];
	const workItems = coreTable(db, workItemsTable);
	const workInteractions = coreTable(db, interactionsTable);
	for (const ids of chunkForBoundParams(interactionIds, 50)) {
		const rows = await db
			.select({
				interactionId: sql<string>`${workInteractions.id}`.as("interaction_id"),
				workItemId: sql<string>`${workItems.id}`.as("work_item_id"),
				metadata: workItems.metadata,
				title: workItems.title,
				projectId: workItems.projectId,
				version: workItems.version,
			})
			.from(workInteractions)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, workInteractions.orgId),
					eq(workItems.id, workInteractions.workItemId),
				),
			)
			.where(
				and(
					eq(workInteractions.orgId, orgId),
					inArray(workInteractions.id, ids),
					eq(workItems.workKind, "outbound"),
				),
			);
		for (const row of rows) {
			const parsed = OutboundStateSchema.safeParse(row.metadata?.outbound);
			if (parsed.success && parsed.data.interactionId === row.interactionId)
				overlays.push({
					interactionId: row.interactionId,
					workItemId: row.workItemId,
					subject:
						`Review ${parsed.data.draft.channel}: ${parsed.data.draft.subject || parsed.data.draft.recipient}`.slice(
							0,
							300,
						),
					status: parsed.data.status,
					record: {
						workItemId: row.workItemId,
						title: row.title,
						projectId: row.projectId,
						version: row.version,
						outbound: parsed.data,
					},
				});
		}
	}
	return overlays;
}

/** Surface overdue drafts without manufacturing a reviewer verdict or human approval. */
export async function sweepStuckOutboundReviews(
	db: DbQueryClient,
	p: { now: string; limit: number; scope?: { orgId: string; ids: string[] } },
) {
	const workItems = coreTable(db, workItemsTable);
	const organizations = coreTable(db, organizationsTable);
	const outbound = (field: string) =>
		jsonRead(db, workItems.metadata, ["outbound", field]);
	const requestedAt = sql`coalesce(${outbound("reviewRequestedAt")}, (SELECT max(occurred_at) FROM work_events e WHERE e.org_id=${workItems.orgId} AND e.work_item_id=${workItems.id} AND e.event_type='outbound.action'), ${workItems.updatedAt}, ${workItems.createdAt})`;
	const timeoutMinutes = sql`coalesce(${jsonRead(db, organizations.metadata, ["outboundReview", "reviewTimeoutMinutes"], "number")}, 30)`;
	const rows = await db
		.select({
			orgId: workItems.orgId,
			id: workItems.id,
			version: workItems.version,
			metadata: workItems.metadata,
		})
		.from(workItems)
		.innerJoin(organizations, eq(organizations.id, workItems.orgId))
		.where(
			and(
				p.scope
					? and(
							eq(workItems.orgId, p.scope.orgId),
							anyIds(db, workItems.id, p.scope.ids),
						)
					: undefined,
				eq(workItems.workKind, "outbound"),
				sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
				sql`${outbound("status")} IN ('reviewing','feedback')`,
				coreStore(db) === "postgres"
					? sql`(${requestedAt})::timestamp + (${timeoutMinutes}) * interval '1 minute' <= (${p.now})::timestamp`
					: sql`julianday(${requestedAt}) + ${timeoutMinutes} / 1440.0 <= julianday(${p.now})`,
				sql`EXISTS (SELECT 1 FROM work_interactions q WHERE q.org_id=${workItems.orgId} AND q.work_item_id=${workItems.id} AND q.id=${outbound("interactionId")} AND q.target_type='user' AND q.target_id=${outbound("ownerUserId")} AND q.kind IN ('question','input') AND q.status='open' AND (q.expires_at IS NULL OR q.expires_at>${p.now}))`,
			),
		)
		.orderBy(requestedAt, workItems.id)
		.limit(p.limit);
	let timedOut = 0;
	for (const row of rows) {
		const parsed = OutboundStateSchema.safeParse(row.metadata?.outbound);
		if (!parsed.success) continue;
		if (
			await saveOutbound(db, {
				orgId: row.orgId,
				workItemId: row.id,
				expectedVersion: row.version,
				state: {
					...parsed.data,
					status: "waiting_on_you",
					review: null,
					reviewTimedOutAt: p.now,
				},
				actor: { type: "system", id: "outbound-review-timeout" },
				action: "review_timed_out",
				now: p.now,
			})
		)
			timedOut++;
	}
	return {
		outboundReviewCandidates: rows.length,
		outboundReviewsTimedOut: timedOut,
	};
}
