import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	jsonParameter,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import type { DeckCurationState } from "@tedix/api-contract/schemas/deck-curation";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractionCardRevisions as revisionsTable,
	workInteractions as interactionsTable,
	workInteractionStoredColumns,
	workInteractionResponses as responsesTable,
	workInteractionCardPresentations as presentationsTable,
} from "../../schema/work-factory";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { learningInteractionEvents as learningEventsTable } from "../../schema/learning-feedback";
import type { WorkProposal } from "@tedix/api-contract/schemas/work-interactions";
import { workItems as workItemsTable } from "../../schema/work-items";

/** Stored (non-generated) interaction columns of the selected store's table. */
function storedInteractionColumns(table: typeof interactionsTable) {
	return Object.fromEntries(
		Object.keys(workInteractionStoredColumns).map((key) => [
			key,
			table[key as keyof typeof workInteractionStoredColumns],
		]),
	) as typeof workInteractionStoredColumns;
}

/** A JSON parameter, or SQL NULL; INSERT ... SELECT casts it to the target column. */
function jsonOrNull(db: object, value: unknown): SQL {
	return value == null ? sql`${null}` : jsonParameter(db, value);
}

/** The training pair commits in the same D1 batch as its immutable revision. */
export function buildCardRevisionLearningStatement(
	db: DbQueryClient,
	orgId: string,
	revisionId: string,
) {
	const revisions = coreTable(db, revisionsTable);
	const workInteractions = coreTable(db, interactionsTable);
	const postgres = coreStore(db) === "postgres";
	const before = sql`(SELECT body FROM work_interaction_card_revisions prior WHERE prior.org_id=${revisions.orgId} AND prior.request_id=${revisions.requestId} AND prior.revision=${revisions.revision}-1)`;
	const keptHunkCount = postgres
		? sql`CASE WHEN jsonb_typeof(${revisions.keptHunks})='array' THEN jsonb_array_length(${revisions.keptHunks}) ELSE 0 END`
		: sql`coalesce(json_array_length(${revisions.keptHunks}),0)`;
	const metadata = postgres
		? sql`jsonb_build_object('schema','tedix.card-revision-pair.v1','answerSource','card-revision','decisionClass','card-copy','before',${before},'after',${revisions.body},'instruction',${revisions.instruction},'responseId',${revisions.responseId},'revision',${revisions.revision},'cause',${revisions.cause},'fromRevision',${revisions.revision}-1,'field',${revisions.field},'anchors',coalesce(${revisions.anchors},'[]'::jsonb),'summary',${revisions.summary},'keptHunks',coalesce(${revisions.keptHunks},'[]'::jsonb),'learningEventId',${revisions.learningEventId},'parentRevision',${revisions.parentRevision},'actorSessionId',${revisions.actorSessionId},'serverObserved',true)`
		: sql`json_object('schema','tedix.card-revision-pair.v1','answerSource','card-revision','decisionClass','card-copy','before',${before},'after',${revisions.body},'instruction',${revisions.instruction},'responseId',${revisions.responseId},'revision',${revisions.revision},'cause',${revisions.cause},'fromRevision',${revisions.revision}-1,'field',${revisions.field},'anchors',json(coalesce(${revisions.anchors},'[]')),'summary',${revisions.summary},'keptHunks',json(coalesce(${revisions.keptHunks},'[]')),'learningEventId',${revisions.learningEventId},'parentRevision',${revisions.parentRevision},'actorSessionId',${revisions.actorSessionId},'serverObserved',json('true'))`;
	return db
		.insert(coreTable(db, learningEventsTable))
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
					>`CASE WHEN ${revisions.cause}='restore' THEN 'undone' WHEN ${revisions.cause}='human_edit' AND ${keptHunkCount}=0 THEN 'manually_replaced' ELSE 'edited' END`.as(
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
					metadata: metadata.as("metadata"),
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
	const revisions = coreTable(db, revisionsTable);
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
	const revisions = coreTable(db, revisionsTable);
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
	const workInteractionResponses = coreTable(db, responsesTable);
	const [response] = await db
		.select()
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, orgId),
				eq(workInteractionResponses.interactionId, requestId),
				sql`${jsonRead(db, workInteractionResponses.metadata, ["cardAction"])}='ask_changes'`,
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
		presentation?: DecisionCardPresentation;
		cause: (typeof revisionsTable.$inferInsert)["cause"];
		actorType: string;
		actorId: string;
		actorSessionId?: string;
		instruction?: string;
		responseId?: string;
		field?: (typeof revisionsTable.$inferInsert)["field"];
		anchors?: (typeof revisionsTable.$inferInsert)["anchors"];
		anchorsResolved?: (typeof revisionsTable.$inferInsert)["anchorsResolved"];
		summary?: string;
		keptHunks?: (typeof revisionsTable.$inferInsert)["keptHunks"];
		parentRevision?: number;
		curation?: DeckCurationState;
		expectedStatus?: "open" | "cancelled";
		/** Refuse the revision once anyone has responded to the request. */
		unanswered?: boolean;
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
			p.presentation,
		])
	)
		throw new Error(CARD_SECRET_MESSAGE);
	const revisions = coreTable(db, revisionsTable);
	const workInteractions = coreTable(db, interactionsTable);
	const workInteractionCardPresentations = coreTable(db, presentationsTable);
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
					proposal: sql<WorkProposal | null>`${jsonOrNull(db, p.proposal)}`.as(
						"proposal",
					),
					field: sql<typeof p.field>`${p.field ?? "draft"}`.as("field"),
					anchors: sql<typeof p.anchors>`${jsonOrNull(db, p.anchors)}`.as(
						"anchors",
					),
					anchorsResolved: sql<
						typeof p.anchorsResolved
					>`${jsonOrNull(db, p.anchorsResolved)}`.as("anchors_resolved"),
					summary: sql<string | null>`${p.summary ?? null}`.as("summary"),
					keptHunks: sql<typeof p.keptHunks>`${jsonOrNull(db, p.keptHunks)}`.as(
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
						eq(workInteractions.status, p.expectedStatus ?? "open"),
						sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${new Date().toISOString()})`,
						sql`coalesce((SELECT max(revision) FROM work_interaction_card_revisions WHERE org_id=${p.orgId} AND request_id=${p.requestId}),0)=${p.expectedRevision}`,
						p.unanswered
							? sql`NOT EXISTS (SELECT 1 FROM work_interaction_responses WHERE org_id=${p.orgId} AND interaction_id=${p.requestId})`
							: undefined,
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	if (p.cause === "initial") return (await insert)[0] ?? null;
	const faceWrites = p.presentation
		? [
				db
					.insert(workInteractionCardPresentations)
					.select(
						db
							.select({
								orgId: workInteractions.orgId,
								interactionId: workInteractions.id,
								personId: sql<string>`${workInteractions.targetId}`.as(
									"person_id",
								),
								requestVersion: workInteractions.version,
								presentation:
									sql<DecisionCardPresentation>`${jsonParameter(db, p.presentation)}`.as(
										"presentation",
									),
								updatedAt: sql<string>`${new Date().toISOString()}`.as(
									"updated_at",
								),
							})
							.from(workInteractions)
							.where(
								and(
									eq(workInteractions.orgId, p.orgId),
									eq(workInteractions.id, p.requestId),
									eq(workInteractions.targetType, "user"),
									eq(workInteractions.version, p.expectedVersion + 1),
									sql`EXISTS (SELECT 1 FROM work_interaction_card_revisions WHERE id=${id})`,
								),
							),
					)
					.onConflictDoUpdate({
						target: [
							workInteractionCardPresentations.orgId,
							workInteractionCardPresentations.interactionId,
						],
						set: {
							requestVersion: p.expectedVersion + 1,
							presentation: p.presentation,
							updatedAt: new Date().toISOString(),
						},
					}),
			]
		: [];
	const [rows] = await db.batch([
		insert,
		db
			.update(workInteractions)
			.set({
				...(p.curation
					? {
							status: p.curation.status,
							cancelledAt:
								p.curation.status === "cancelled"
									? new Date().toISOString()
									: null,
						}
					: {}),
				metadata: (
					[
						["cardContent", p.body],
						["cardRevision", p.expectedRevision + 1],
						...(p.proposal ? [["proposal", p.proposal]] : []),
						...(p.curation ? [["curation", p.curation]] : []),
					] as [string, unknown][]
				).reduce<SQL>(
					(document, [key, value]) => jsonWrite(db, document, [key], value),
					sql`${workInteractions.metadata}`,
				),
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
		...faceWrites,
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
	const revisions = coreTable(db, revisionsTable);
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

/** Recipient-scoped, immutable policy receipts for the Feed; no pending decision is executed by a read. */
export async function listHandledInternalDecisionCards(
	db: DbQueryClient,
	p: { orgId: string; recipientId: string; projectId?: string; limit: number },
) {
	const workInteractions = coreTable(db, interactionsTable);
	const workItems = coreTable(db, workItemsTable);
	const project = sql<
		string | null
	>`coalesce(${workInteractions.projectId}, (SELECT ${workItems.projectId} FROM ${workItems} WHERE ${workItems.orgId}=${workInteractions.orgId} AND ${workItems.id}=${workInteractions.workItemId}))`;
	return db
		.select({
			...storedInteractionColumns(workInteractions),
			projectId: project.as("project_id"),
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.recipientId),
				eq(workInteractions.status, "cancelled"),
				p.projectId ? eq(project, p.projectId) : undefined,
				sql`${jsonRead(db, workInteractions.metadata, ["curation", "internalTask", "taskId"])} IS NOT NULL`,
				sql`${jsonRead(db, workInteractions.metadata, ["curation", "revision"], "number")} = ${jsonRead(db, workInteractions.metadata, ["cardRevision"], "number")}`,
			),
		)
		.orderBy(desc(workInteractions.cancelledAt), desc(workInteractions.id))
		.limit(Math.min(Math.max(p.limit, 1), 100));
}
