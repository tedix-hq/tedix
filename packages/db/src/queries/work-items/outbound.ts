import {
	OUTBOUND_SCHEMA,
	OutboundPolicySchema,
	OutboundStateSchema,
	type OutboundState,
	type OutboundPolicy,
} from "@tedix/api-contract/schemas/outbound";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { batchNonEmpty, chunkForBoundParams } from "../../utils/batch";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { workItems, workEvents } from "../../schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
} from "../../schema/work-factory";

export async function getOutboundPolicy(
	db: DbQueryClient,
	orgId: string,
): Promise<OutboundPolicy> {
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
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.outboundReview', json(${JSON.stringify(policy)}))`,
		})
		.where(eq(organizations.id, orgId));
}

export async function listOutbound(
	db: DbQueryClient,
	orgId: string,
	projectId: string | undefined,
	limit: number,
) {
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
			type: "user" | "tedi" | "external_agent";
			id: string;
			sessionId?: string;
			externalSessionKey?: string;
		};
		action: string;
		now: string;
		createInteraction?: boolean;
		response?: {
			body: string;
			feedback?: string;
			before: string;
			resolves: boolean;
		};
	},
) {
	const nextVersion = p.expectedVersion + 1;
	const transitionId = crypto.randomUUID();
	const changed = sql`EXISTS (SELECT 1 FROM work_items WHERE org_id=${p.orgId} AND id=${p.workItemId} AND version=${nextVersion} AND json_extract(metadata, '$.outboundTransitionId')=${transitionId})`;
	const statements: BatchItem<"sqlite">[] = [
		db
			.update(workItems)
			.set({
				workKind: "outbound",
				metadata: sql`json_set(coalesce(${workItems.metadata}, '{}'), '$.outbound', json(${JSON.stringify(p.state)}), '$.outboundTransitionId', ${transitionId})`,
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
						sql`json_object('action', ${p.action}, 'draftRevision', ${p.state.draftRevision})`.as(
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
							sql`json(${JSON.stringify({ schema: OUTBOUND_SCHEMA, outboundWorkItemId: p.workItemId, decisionClass: p.state.draft.topic, channel: p.state.draft.channel, personId: p.state.draft.recipient, proposerTediId: p.state.reviewerTediId })})`.as(
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
	if (p.response) {
		const response = p.response;
		statements.push(
			db.insert(workInteractionResponses).select(
				db
					.select({
						id: sql<string>`${crypto.randomUUID()}`.as("id"),
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
						resolvesRequest: sql<boolean>`${response.resolves ? 1 : 0}`.as(
							"resolves_request",
						),
						respondedAt: sql<string>`${p.now}`.as("responded_at"),
						metadata:
							sql`json(${JSON.stringify({ schema: OUTBOUND_SCHEMA, action: p.action, before: response.before, after: response.body, feedback: response.feedback ?? null, draftRevision: p.state.draftRevision, source: "os-outbound" })})`.as(
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
	const results = await db.batch(batchNonEmpty(statements));
	return (results[0] as Array<{ id: string }>).length === 1;
}

export async function outboundApprovalHistory(
	db: DbQueryClient,
	orgId: string,
	ownerUserId: string,
) {
	return db
		.select({
			id: workInteractionResponses.id,
			body: workInteractionResponses.body,
			metadata: workInteractionResponses.metadata,
			at: workInteractionResponses.respondedAt,
		})
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, orgId),
				eq(workInteractionResponses.responderType, "user"),
				eq(workInteractionResponses.responderId, ownerUserId),
				sql`json_extract(${workInteractionResponses.metadata}, '$.schema')=${OUTBOUND_SCHEMA}`,
				sql`json_extract(${workInteractionResponses.metadata}, '$.action') IN ('approve_manual','approve_send')`,
			),
		)
		.orderBy(desc(workInteractionResponses.respondedAt))
		.limit(10);
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
	}[] = [];
	for (const ids of chunkForBoundParams(interactionIds, 50)) {
		const rows = await db
			.select({
				interactionId: sql<string>`${workInteractions.id}`.as("interaction_id"),
				workItemId: sql<string>`${workItems.id}`.as("work_item_id"),
				metadata: workItems.metadata,
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
				});
		}
	}
	return overlays;
}
