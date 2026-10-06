import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
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
