import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemComment,
	type WorkItemCommentAuthorType,
	type WorkItemCorroboration,
	type WorkItemCorroborationPrincipalType,
	type WorkItemCorroborationStance,
	workItemComments,
	workItemCorroborations,
	workItems,
} from "../../schema/work-items";

export interface AddWorkItemCommentParams {
	id: string;
	workItemId: string;
	orgId: string;
	authorType: WorkItemCommentAuthorType;
	authorId?: string;
	body: string;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
}

export async function getWorkItemCommentById(
	db: DbQueryClient,
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
	db: DbQueryClient,
	params: AddWorkItemCommentParams,
): Promise<WorkItemComment> {
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
	return (
		await db
			.insert(workItemComments)
			.values({ ...params, metadata: params.metadata ?? {} })
			.returning()
	)[0]!;
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
	const stance = params.stance ?? "corroborates";
	const sessionId = params.sessionId ?? null;
	const changed = or(
		ne(workItemCorroborations.stance, stance),
		ne(workItemCorroborations.evidenceRef, params.evidenceRef),
		ne(workItemCorroborations.body, params.body),
		sql`${workItemCorroborations.sessionId} IS NOT ${sessionId}`,
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
	return db
		.select()
		.from(workItemComments)
		.where(eq(workItemComments.workItemId, workItemId))
		.orderBy(asc(workItemComments.createdAt));
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
	const [row] = await db
		.select({ at: workItemComments.createdAt, id: workItemComments.id })
		.from(workItemComments)
		.where(eq(workItemComments.orgId, orgId))
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(1);
	return row ?? null;
}
