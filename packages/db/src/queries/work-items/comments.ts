import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { booleanValue, jsonRead, jsonWrite } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemComment,
	type WorkItemCommentAuthorType,
	workEvents as d1WorkEvents,
	workItemComments as d1WorkItemComments,
	workItems as d1WorkItems,
} from "../../schema/work-items";

import { WorkControlError } from "./factory-validation";
import {
	type WorkConfirmation,
	currentConfirmationEvent,
	OBSERVATION_EVENT,
	OBSERVATION_SCHEMA,
} from "./observation-ledger";

/**
 * Unclassified notes remain facts; exempt are the asking agent's declared
 * progress and the record of a person's own card answer.
 */
export function decisionRelevantWorkComment(
	db: DbQueryClient,
	request: {
		creatorType?: string;
		creatorId?: string;
		createdAt?: string;
	},
) {
	return decisionRelevantWorkCommentFields(db, {
		createdAt: sql`CAST(${request.createdAt || null} AS TEXT)`,
		creatorType: sql`CAST(${request.creatorType ?? null} AS TEXT)`,
		creatorId: sql`CAST(${request.creatorId || null} AS TEXT)`,
	});
}

/** The same relevance rule for a set of requests held in a query relation. */
export function decisionRelevantWorkCommentFields(
	db: DbQueryClient,
	request: {
		createdAt: SQL;
		creatorType: SQL;
		creatorId: SQL;
	},
) {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const answerRecord = sql`(${jsonRead(db, workItemComments.metadata, ["schema"])} = 'tedix.decision-answer.v1' AND ${workItemComments.createdAt} > ${request.createdAt})`;
	return sql`(${request.createdAt} IS NULL OR NOT coalesce(${answerRecord} OR (
		${request.creatorType} IN ('tedi', 'external_agent')
		AND ${request.creatorId} IS NOT NULL
		AND ${workItemComments.authorType} = ${request.creatorType}
		AND ${workItemComments.authorId} = ${request.creatorId}
		AND ${jsonRead(db, workItemComments.metadata, ["decisionImpact"])} = 'progress'
		AND ${workItemComments.createdAt} > ${request.createdAt}
	), ${booleanValue(db, false)}))`;
}

export interface AddWorkItemCommentParams {
	id: string;
	workItemId: string;
	orgId: string;
	authorType: WorkItemCommentAuthorType;
	authorId?: string;
	body: string;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
	recordActivity?: boolean;
}

/** A new decision wakes an existing deferred lane without revising its contract or source pins. */
export function buildWorkDecisionContinuationStatement(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		kind: "answer" | "approval";
		requestId: string;
		responseId: string;
		at: string;
		body?: string;
	},
	fence?: ReturnType<typeof sql>,
) {
	const workItems = coreTable(db, d1WorkItems);
	const signal = {
		kind: p.kind,
		requestId: p.requestId,
		responseId: p.responseId,
		at: p.at,
		...(p.body ? { body: p.body.slice(0, 4000) } : {}),
	};
	return db
		.update(workItems)
		.set({
			metadata: jsonWrite(
				db,
				workItems.metadata,
				["decisionContinuation"],
				signal,
			),
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, p.workItemId),
				eq(workItems.disposition, "accepted"),
				fence,
				sql`coalesce(${jsonRead(db, workItems.metadata, ["decisionContinuation", "at"])}, '') < ${p.at}`,
			),
		)
		.returning({ id: workItems.id });
}

export async function recordWorkDecisionContinuation(
	db: DbQueryClient,
	p: Parameters<typeof buildWorkDecisionContinuationStatement>[1],
) {
	return buildWorkDecisionContinuationStatement(db, p);
}

export async function getWorkItemCommentById(
	db: DbQueryClient,
	id: string,
): Promise<WorkItemComment | null> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	return (
		(
			await db
				.select()
				.from(workItemComments)
				.where(eq(workItemComments.id, id))
				.limit(1)
		)[0] ?? null
	);
}

export async function addWorkItemComment(
	db: DbQueryClient,
	params: AddWorkItemCommentParams,
): Promise<WorkItemComment> {
	const workEvents = coreTable(db, d1WorkEvents);
	const workItemComments = coreTable(db, d1WorkItemComments);
	const workItems = coreTable(db, d1WorkItems);
	if (containsCardSecret([params.body, params.metadata]))
		throw new Error(CARD_SECRET_MESSAGE);
	const item = (
		await db
			.select({ id: workItems.id })
			.from(workItems)
			.where(
				and(
					eq(workItems.id, params.workItemId),
					eq(workItems.orgId, params.orgId),
				),
			)
			.limit(1)
	)[0];
	if (!item)
		throw new Error(
			`Work Item ${params.workItemId} was not found in organization ${params.orgId}`,
		);
	const { recordActivity, ...comment } = params;
	const insert = db
		.insert(workItemComments)
		.values({ ...comment, metadata: params.metadata ?? {} })
		.returning();
	if (!recordActivity) return (await insert)[0]!;
	if (!params.authorId)
		throw new Error("Comment activity requires an authenticated author");
	const [rows] = await db.batch([
		insert,
		db.insert(workEvents).values({
			id: params.id,
			orgId: params.orgId,
			workItemId: params.workItemId,
			eventType: "comment",
			actorType: params.authorType,
			actorId: params.authorId,
			payload: {
				...params.metadata,
				summary: params.body,
				commentId: params.id,
			},
			occurredAt: params.createdAt,
		}),
	]);
	return rows[0]!;
}

export async function addWorkItemCommentIfAbsent(
	db: DbQueryClient,
	params: AddWorkItemCommentParams,
): Promise<{ comment: WorkItemComment; inserted: boolean }> {
	const existing = await getWorkItemCommentById(db, params.id);
	if (existing) return { comment: existing, inserted: false };
	return { comment: await addWorkItemComment(db, params), inserted: true };
}

export interface AddWorkConfirmationParams {
	id: string;
	workItemId: string;
	orgId: string;
	principalType: WorkConfirmation["principalType"];
	principalId: string;
	sessionId?: string;
	evidenceRef: string;
	/** Defaults to `corroborates`, which is what every pre-stance row meant. */
	stance?: WorkConfirmation["stance"];
	body: string;
	occurredAt: string;
	createdAt?: string;
}

export async function recordWorkConfirmation(
	db: DbQueryClient,
	params: AddWorkConfirmationParams,
): Promise<{ confirmation: WorkConfirmation; inserted: boolean }> {
	const events = coreTable(db, d1WorkEvents);
	const [previous] = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.orgId, params.orgId),
				eq(events.workItemId, params.workItemId),
				currentConfirmationEvent(db, events),
				sql`${jsonRead(db, events.payload, ["record", "principalType"])}=${params.principalType}`,
				sql`${jsonRead(db, events.payload, ["record", "principalId"])}=${params.principalId}`,
			),
		)
		.limit(1);
	const old = previous?.payload.record as WorkConfirmation | undefined;
	const stance = params.stance ?? "corroborates";
	const sessionId = params.sessionId ?? null;
	if (
		old &&
		old.stance === stance &&
		old.sessionId === sessionId &&
		old.evidenceRef === params.evidenceRef &&
		old.body === params.body
	)
		return { confirmation: old, inserted: false };
	const confirmation: WorkConfirmation = {
		...params,
		id: old?.id ?? params.id,
		stance,
		sessionId,
		createdAt: old?.createdAt ?? params.createdAt ?? params.occurredAt,
	};
	// Two writers based on the same revision share one insert fence. A stale
	// caller must read again; it cannot silently overwrite a newer correction.
	const key = encodeURIComponent(
		JSON.stringify([
			params.orgId,
			params.workItemId,
			params.principalType,
			params.principalId,
		]),
	);
	const written = await db
		.insert(events)
		.values({
			id: `work-confirmation:${key}:${previous?.sequence ?? 0}`,
			orgId: params.orgId,
			workItemId: params.workItemId,
			eventType: OBSERVATION_EVENT,
			actorType:
				params.principalType === "organization"
					? "system"
					: params.principalType,
			actorId:
				params.principalType === "organization"
					? `organization:${params.principalId}`
					: params.principalId,
			actorSessionId: sessionId,
			payload: {
				schema: OBSERVATION_SCHEMA,
				kind: "confirmation",
				record: confirmation,
				deliveryRevision: previous ? String(previous.sequence) : null,
				summary: params.body,
			},
			occurredAt: params.occurredAt,
		})
		.onConflictDoNothing({ target: events.id })
		.returning({ id: events.id });
	if (!written.length)
		throw new WorkControlError(
			"CONFLICT",
			"Work confirmation changed; read the current observation before correcting it",
		);
	return { confirmation, inserted: !old };
}

export async function listWorkItemComments(
	db: DbQueryClient,
	workItemId: string,
): Promise<WorkItemComment[]> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	return db
		.select()
		.from(workItemComments)
		.where(eq(workItemComments.workItemId, workItemId))
		.orderBy(asc(workItemComments.createdAt));
}

export interface ListRecentWorkItemCommentsParams {
	orgId: string;
	workItemId: string;
	limit: number;
}

export async function listRecentWorkItemComments(
	db: DbQueryClient,
	p: ListRecentWorkItemCommentsParams,
) {
	const workItemComments = coreTable(db, d1WorkItemComments);
	return db
		.select({
			id: workItemComments.id,
			authorType: workItemComments.authorType,
			authorId: workItemComments.authorId,
			body: workItemComments.body,
			createdAt: workItemComments.createdAt,
		})
		.from(workItemComments)
		.where(
			and(
				eq(workItemComments.orgId, p.orgId),
				eq(workItemComments.workItemId, p.workItemId),
			),
		)
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(p.limit);
}

/** Newest comment by one author on a Work Item, used to skip reposting an identical notice. */
export async function getLatestWorkItemCommentByAuthor(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		authorType: WorkItemCommentAuthorType;
		authorId: string;
	},
) {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const [row] = await db
		.select({ body: workItemComments.body })
		.from(workItemComments)
		.where(
			and(
				eq(workItemComments.orgId, p.orgId),
				eq(workItemComments.workItemId, p.workItemId),
				eq(workItemComments.authorType, p.authorType),
				eq(workItemComments.authorId, p.authorId),
			),
		)
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(1);
	return row ?? null;
}

/** Identifier-only projection for the MCP comment event feed. */
export type WorkCommentEventRow = Pick<
	WorkItemComment,
	"id" | "workItemId" | "authorType" | "authorId" | "createdAt"
>;

/** Org-scoped ascending keyset read; private content is never selected. */
export async function listWorkCommentEvents(
	db: DbQueryClient,
	p: {
		orgId: string;
		after: { at: string; id: string } | null;
		workItemId?: string;
		authorType?: WorkItemCommentAuthorType;
		limit: number;
	},
): Promise<WorkCommentEventRow[]> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	return db
		.select({
			id: workItemComments.id,
			workItemId: workItemComments.workItemId,
			authorType: workItemComments.authorType,
			authorId: workItemComments.authorId,
			createdAt: workItemComments.createdAt,
		})
		.from(workItemComments)
		.where(
			and(
				eq(workItemComments.orgId, p.orgId),
				p.workItemId
					? eq(workItemComments.workItemId, p.workItemId)
					: undefined,
				p.authorType
					? eq(workItemComments.authorType, p.authorType)
					: undefined,
				p.after
					? sql`(${workItemComments.createdAt}>${p.after.at} OR (${workItemComments.createdAt}=${p.after.at} AND ${workItemComments.id}>${p.after.id}))`
					: undefined,
			),
		)
		.orderBy(asc(workItemComments.createdAt), asc(workItemComments.id))
		.limit(p.limit);
}

/** Newest comment position in the org, used to poll "from now". */
export async function getLatestWorkCommentPosition(
	db: DbQueryClient,
	orgId: string,
): Promise<{ at: string; id: string } | null> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const [row] = await db
		.select({ at: workItemComments.createdAt, id: workItemComments.id })
		.from(workItemComments)
		.where(eq(workItemComments.orgId, orgId))
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(1);
	return row ?? null;
}
