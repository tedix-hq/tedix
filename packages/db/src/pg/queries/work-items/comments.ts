import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { PgQueryClient } from "../../client";
import {
	type WorkItemComment,
	type WorkItemCommentAuthorType,
	type WorkItemCorroboration,
	type WorkItemCorroborationPrincipalType,
	type WorkItemCorroborationStance,
	workEvents,
	workItemComments,
	workItemCorroborations,
	workItems,
} from "../../schema/work-items";

/**
 * Unclassified notes remain facts; exempt are the asking agent's declared
 * progress and the record of a person's own card answer.
 */
export function decisionRelevantWorkComment(request: {
	creatorType?: string;
	creatorId?: string;
	createdAt?: string;
}) {
	if (!request.createdAt) return sql`1`;
	const answerRecord = sql`((${workItemComments.metadata} #>> '{schema}') = 'tedix.decision-answer.v1' AND ${workItemComments.createdAt} > ${request.createdAt})`;
	if (
		!["tedi", "external_agent"].includes(request.creatorType ?? "") ||
		!request.creatorId
	)
		return sql`NOT coalesce(${answerRecord}, 0)`;
	return sql`NOT coalesce(${answerRecord} OR (
		${workItemComments.authorType} = ${request.creatorType}
		AND ${workItemComments.authorId} = ${request.creatorId}
		AND (${workItemComments.metadata} #>> '{decisionImpact}') = 'progress'
		AND ${workItemComments.createdAt} > ${request.createdAt}
	), 0)`;
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

export async function getWorkItemCommentById(
	db: PgQueryClient,
	id: string,
): Promise<WorkItemComment | null> {
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
	db: PgQueryClient,
	params: AddWorkItemCommentParams,
): Promise<WorkItemComment> {
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
	const insert = (q: PgQueryClient) =>
		q
			.insert(workItemComments)
			.values({ ...comment, metadata: params.metadata ?? {} })
			.returning();
	if (!recordActivity) return (await insert(db))[0]!;
	if (!params.authorId)
		throw new Error("Comment activity requires an authenticated author");
	const eventRow: typeof workEvents.$inferInsert = {
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
	};
	const [rows] = await db.transaction(async (tx) => {
		const __r: any[] = [];
		for (const __s of [insert(tx), tx.insert(workEvents).values(eventRow)])
			__r.push(await __s);
		return __r;
	});
	return rows[0]!;
}

export async function addWorkItemCommentIfAbsent(
	db: PgQueryClient,
	params: AddWorkItemCommentParams,
): Promise<{ comment: WorkItemComment; inserted: boolean }> {
	const existing = await getWorkItemCommentById(db, params.id);
	if (existing) return { comment: existing, inserted: false };
	return { comment: await addWorkItemComment(db, params), inserted: true };
}

export interface AddWorkItemCorroborationParams {
	id: string;
	workItemId: string;
	orgId: string;
	principalType: WorkItemCorroborationPrincipalType;
	principalId: string;
	sessionId?: string;
	evidenceRef: string;
	/** Defaults to `corroborates`, which is what every pre-stance row meant. */
	stance?: WorkItemCorroborationStance;
	body: string;
	occurredAt: string;
	createdAt?: string;
}

export async function addWorkItemCorroboration(
	db: PgQueryClient,
	params: AddWorkItemCorroborationParams,
): Promise<{ corroboration: WorkItemCorroboration; inserted: boolean }> {
	const stance = params.stance ?? "corroborates";
	const sessionId = params.sessionId ?? null;
	const changed = or(
		ne(workItemCorroborations.stance, stance),
		ne(workItemCorroborations.evidenceRef, params.evidenceRef),
		ne(workItemCorroborations.body, params.body),
		sql`${workItemCorroborations.sessionId} IS DISTINCT FROM ${sessionId}`,
	);
	const inserted = await db
		.insert(workItemCorroborations)
		.values({ ...params, stance, sessionId })
		.onConflictDoNothing({
			target: [
				workItemCorroborations.orgId,
				workItemCorroborations.workItemId,
				workItemCorroborations.principalType,
				workItemCorroborations.principalId,
			],
		})
		.returning();
	if (inserted[0]) return { corroboration: inserted[0], inserted: true };
	const corrected = await db
		.update(workItemCorroborations)
		.set({
			stance,
			evidenceRef: params.evidenceRef,
			body: params.body,
			sessionId,
			occurredAt: params.occurredAt,
		})
		.where(
			and(
				eq(workItemCorroborations.orgId, params.orgId),
				eq(workItemCorroborations.workItemId, params.workItemId),
				eq(workItemCorroborations.principalType, params.principalType),
				eq(workItemCorroborations.principalId, params.principalId),
				changed,
			),
		)
		.returning();
	if (corrected[0]) return { corroboration: corrected[0], inserted: false };
	const existing = (
		await db
			.select()
			.from(workItemCorroborations)
			.where(
				and(
					eq(workItemCorroborations.orgId, params.orgId),
					eq(workItemCorroborations.workItemId, params.workItemId),
					eq(workItemCorroborations.principalType, params.principalType),
					eq(workItemCorroborations.principalId, params.principalId),
				),
			)
			.limit(1)
	)[0];
	if (!existing)
		throw new Error("Corroboration write did not return an existing row");
	return { corroboration: existing, inserted: false };
}

export async function listWorkItemCorroborations(
	db: PgQueryClient,
	workItemId: string,
): Promise<WorkItemCorroboration[]> {
	return db
		.select()
		.from(workItemCorroborations)
		.where(eq(workItemCorroborations.workItemId, workItemId))
		.orderBy(asc(workItemCorroborations.createdAt));
}

export async function listWorkItemComments(
	db: PgQueryClient,
	workItemId: string,
): Promise<WorkItemComment[]> {
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
	db: PgQueryClient,
	p: ListRecentWorkItemCommentsParams,
) {
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

/** Identifier-only projection for the MCP comment event feed. */
export type WorkCommentEventRow = Pick<
	WorkItemComment,
	"id" | "workItemId" | "authorType" | "authorId" | "createdAt"
>;

/** Org-scoped ascending keyset read; private content is never selected. */
export async function listWorkCommentEvents(
	db: PgQueryClient,
	p: {
		orgId: string;
		after: { at: string; id: string } | null;
		workItemId?: string;
		authorType?: WorkItemCommentAuthorType;
		limit: number;
	},
): Promise<WorkCommentEventRow[]> {
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
	db: PgQueryClient,
	orgId: string,
): Promise<{ at: string; id: string } | null> {
	const [row] = await db
		.select({ at: workItemComments.createdAt, id: workItemComments.id })
		.from(workItemComments)
		.where(eq(workItemComments.orgId, orgId))
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(1);
	return row ?? null;
}
