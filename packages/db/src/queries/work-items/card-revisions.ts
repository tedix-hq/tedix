import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractionCardRevisions as revisions,
	workInteractions,
	workInteractionResponses,
} from "../../schema/work-factory";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { learningInteractionEvents } from "../../schema/learning-feedback";
import type { WorkProposal } from "@tedix/api-contract/schemas/work-interactions";

/** The training pair commits in the same D1 batch as its immutable revision. */
export function buildCardRevisionLearningStatement(
	db: DbQueryClient,
	orgId: string,
	revisionId: string,
) {
	return db
		.insert(learningInteractionEvents)
		.select(
			db
				.select({
					id: sql<string>`${revisions.learningEventId}`.as("id"),
					organizationId: revisions.orgId,
					actorType: sql<
						"user" | "tedi" | "service"
					>`CASE WHEN ${revisions.actorType} IN ('user','tedi') THEN ${revisions.actorType} ELSE 'service' END`.as(
						"actor_type",
					),
					actorId:
						sql<string>`CASE WHEN ${revisions.actorType}='user' THEN coalesce((SELECT m.descope_user_id FROM organization_members m WHERE m.organization_id=${revisions.orgId} AND m.user_id=${revisions.actorId} AND m.status='active' LIMIT 1),${revisions.actorId}) ELSE ${revisions.actorId} END`.as(
							"actor_id",
						),
					clientEventId: sql<string>`('card-revision:' || ${revisions.id})`.as(
						"client_event_id",
					),
					signalClass: sql<"quality">`'quality'`.as("signal_class"),
					eventKind: sql<
						"edited" | "manually_replaced" | "undone"
					>`CASE WHEN ${revisions.cause}='restore' THEN 'undone' WHEN ${revisions.cause}='human_edit' AND coalesce(json_array_length(${revisions.keptHunks}),0)=0 THEN 'manually_replaced' ELSE 'edited' END`.as(
						"event_kind",
					),
					scopeKind: sql<"personal">`'personal'`.as("scope_kind"),
					scopeId:
						sql<string>`coalesce((SELECT m.descope_user_id FROM organization_members m WHERE m.organization_id=${workInteractions.orgId} AND m.user_id=${workInteractions.targetId} AND m.status='active' LIMIT 1),${workInteractions.targetId})`.as(
							"scope_id",
						),
					surface: sql<string>`'decision_capture'`.as("surface"),
					targetType: sql<string>`'work_interaction'`.as("target_type"),
					targetId: revisions.requestId,
					metadata:
						sql`json_object('schema','tedix.card-revision-pair.v1','answerSource','card-revision','decisionClass','card-copy','before',(SELECT body FROM work_interaction_card_revisions prior WHERE prior.org_id=${revisions.orgId} AND prior.request_id=${revisions.requestId} AND prior.revision=${revisions.revision}-1),'after',${revisions.body},'instruction',${revisions.instruction},'responseId',${revisions.responseId},'revision',${revisions.revision},'cause',${revisions.cause},'fromRevision',${revisions.revision}-1,'field',${revisions.field},'anchors',json(coalesce(${revisions.anchors},'[]')),'summary',${revisions.summary},'keptHunks',json(coalesce(${revisions.keptHunks},'[]')),'learningEventId',${revisions.learningEventId},'parentRevision',${revisions.parentRevision},'actorSessionId',${revisions.actorSessionId},'serverObserved',json('true'))`.as(
							"metadata",
						),
					occurredAt: sql<string>`${revisions.createdAt}`.as("occurred_at"),
					createdAt: revisions.createdAt,
				})
				.from(revisions)
				.innerJoin(
					workInteractions,
					and(
						eq(workInteractions.orgId, revisions.orgId),
						eq(workInteractions.id, revisions.requestId),
					),
				)
				.where(
					and(
						eq(revisions.orgId, orgId),
						eq(revisions.id, revisionId),
						sql`${revisions.cause}<>'initial'`,
					),
				),
		)
		.onConflictDoNothing();
}

export async function listCardRevisions(
	db: DbQueryClient,
	orgId: string,
	requestId: string,
	beforeRevision?: number,
) {
	return (
		await db
			.select()
			.from(revisions)
			.where(
				and(
					eq(revisions.orgId, orgId),
					eq(revisions.requestId, requestId),
					beforeRevision
						? sql`${revisions.revision}<${beforeRevision}`
						: undefined,
				),
			)
			.orderBy(desc(revisions.revision))
			.limit(100)
	).reverse();
}

export async function getCardRevision(
	db: DbQueryClient,
	orgId: string,
	requestId: string,
	revision: number,
) {
	return (
		(
			await db
				.select()
				.from(revisions)
				.where(
					and(
						eq(revisions.orgId, orgId),
						eq(revisions.requestId, requestId),
						eq(revisions.revision, revision),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}

export async function latestCardChangeRequest(
	db: DbQueryClient,
	orgId: string,
	requestId: string,
) {
	const [response] = await db
		.select()
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, orgId),
				eq(workInteractionResponses.interactionId, requestId),
				sql`json_extract(${workInteractionResponses.metadata}, '$.cardAction')='ask_changes'`,
			),
		)
		.orderBy(
			desc(workInteractionResponses.resolvedRequestVersion),
			desc(workInteractionResponses.respondedAt),
			desc(workInteractionResponses.id),
		)
		.limit(1);
	return response ?? null;
}

/** Expected source and revision are checked by the insert itself, including concurrent writers. */
export async function appendCardRevision(
	db: DbQueryClient,
	p: {
		orgId: string;
		requestId: string;
		expectedVersion: number;
		expectedRevision: number;
		body: string;
		proposal?: WorkProposal | null;
		cause: (typeof revisions.$inferInsert)["cause"];
		actorType: string;
		actorId: string;
		actorSessionId?: string;
		instruction?: string;
		responseId?: string;
		field?: (typeof revisions.$inferInsert)["field"];
		anchors?: (typeof revisions.$inferInsert)["anchors"];
		anchorsResolved?: (typeof revisions.$inferInsert)["anchorsResolved"];
		summary?: string;
		keptHunks?: (typeof revisions.$inferInsert)["keptHunks"];
		parentRevision?: number;
	},
) {
	if (
		containsCardSecret([
			p.body,
			p.instruction,
			p.proposal,
			p.anchors,
			p.anchorsResolved,
			p.summary,
			p.keptHunks,
		])
	)
		throw new Error(CARD_SECRET_MESSAGE);
	const id = crypto.randomUUID();
	const learningEventId = p.cause === "initial" ? null : crypto.randomUUID();
	const insert = db
		.insert(revisions)
		.select(
			db
				.select({
					id: sql<string>`${id}`.as("id"),
					orgId: workInteractions.orgId,
					requestId: sql<string>`${workInteractions.id}`.as("request_id"),
					revision: sql<number>`${p.expectedRevision + 1}`.as("revision"),
					body: sql<string>`${p.body}`.as("body"),
					proposal:
						sql<WorkProposal | null>`${p.proposal ? JSON.stringify(p.proposal) : null}`.as(
							"proposal",
						),
					field: sql<typeof p.field>`${p.field ?? "draft"}`.as("field"),
					anchors: sql<
						typeof p.anchors
					>`${p.anchors ? JSON.stringify(p.anchors) : null}`.as("anchors"),
					anchorsResolved: sql<
						typeof p.anchorsResolved
					>`${p.anchorsResolved ? JSON.stringify(p.anchorsResolved) : null}`.as(
						"anchors_resolved",
					),
					summary: sql<string | null>`${p.summary ?? null}`.as("summary"),
					keptHunks: sql<
						typeof p.keptHunks
					>`${p.keptHunks ? JSON.stringify(p.keptHunks) : null}`.as(
						"kept_hunks",
					),
					learningEventId: sql<string | null>`${learningEventId}`.as(
						"learning_event_id",
					),
					parentRevision: sql<
						number | null
					>`${p.parentRevision ?? (p.expectedRevision || null)}`.as(
						"parent_revision",
					),
					cause: sql<typeof p.cause>`${p.cause}`.as("cause"),
					actorType: sql<string>`${p.actorType}`.as("actor_type"),
					actorId: sql<string>`${p.actorId}`.as("actor_id"),
					actorSessionId: sql<string | null>`${p.actorSessionId ?? null}`.as(
						"actor_session_id",
					),
					instruction: sql<string | null>`${p.instruction ?? null}`.as(
						"instruction",
					),
					responseId: sql<string | null>`${p.responseId ?? null}`.as(
						"response_id",
					),
					createdAt: sql<string>`${new Date().toISOString()}`.as("created_at"),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.requestId),
						eq(workInteractions.version, p.expectedVersion),
						eq(workInteractions.status, "open"),
						sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${new Date().toISOString()})`,
						sql`coalesce((SELECT max(revision) FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.requestId}),0)=${p.expectedRevision}`,
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	if (p.cause === "initial") return (await insert)[0] ?? null;
	const [rows] = await db.batch([
		insert,
		db
			.update(workInteractions)
			.set({
				metadata: p.proposal
					? sql`json_set(${workInteractions.metadata}, '$.cardContent', ${p.body}, '$.cardRevision', ${p.expectedRevision + 1}, '$.proposal', json(${JSON.stringify(p.proposal)}))`
					: sql`json_set(${workInteractions.metadata}, '$.cardContent', ${p.body}, '$.cardRevision', ${p.expectedRevision + 1})`,
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, p.requestId),
					eq(workInteractions.version, p.expectedVersion),
					sql`EXISTS (SELECT 1 FROM work_interaction_card_revisions WHERE id=${id})`,
				),
			),
		buildCardRevisionLearningStatement(db, p.orgId, id),
	]);
	return rows[0] ?? null;
}

export async function cardChangeHasRevision(
	db: DbQueryClient,
	orgId: string,
	requestId: string,
	responseId: string,
) {
	const [row] = await db
		.select({ id: revisions.id })
		.from(revisions)
		.where(
			and(
				eq(revisions.orgId, orgId),
				eq(revisions.requestId, requestId),
				eq(revisions.responseId, responseId),
			),
		)
		.limit(1);
	return Boolean(row);
}
