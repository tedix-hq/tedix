import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { and, asc, desc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemComment,
	type WorkItemCommentAuthorType,
	type WorkItemCorroboration,
	type WorkItemCorroborationPrincipalType,
	type WorkItemCorroborationStance,
	workEvents as d1WorkEvents,
	workItemComments as d1WorkItemComments,
	workItemCorroborations as d1WorkItemCorroborations,
	workItems as d1WorkItems,
} from "../../schema/work-items";

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
	db: DbQueryClient,
	params: AddWorkItemCorroborationParams,
): Promise<{ corroboration: WorkItemCorroboration; inserted: boolean }> {
	const workItemCorroborations = coreTable(db, d1WorkItemCorroborations);
	const stance = params.stance ?? "corroborates";
	const sessionId = params.sessionId ?? null;
	const changed = or(
		ne(workItemCorroborations.stance, stance),
		ne(workItemCorroborations.evidenceRef, params.evidenceRef),
		ne(workItemCorroborations.body, params.body),
		sql`${workItemCorroborations.sessionId} ${coreStore(db) === "postgres" ? sql`IS DISTINCT FROM` : sql`IS NOT`} ${sessionId}`,
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
	db: DbQueryClient,
	workItemId: string,
): Promise<WorkItemCorroboration[]> {
	const workItemCorroborations = coreTable(db, d1WorkItemCorroborations);
	return db
		.select()
		.from(workItemCorroborations)
		.where(eq(workItemCorroborations.workItemId, workItemId))
		.orderBy(asc(workItemCorroborations.createdAt));
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
