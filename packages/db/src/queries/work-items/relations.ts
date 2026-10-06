import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, ne } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemDisposition,
	type WorkItemRelation,
	type WorkItemRelationType,
	workItemRelations,
	workItems,
} from "../../schema/work-items";

export interface AddWorkItemRelationParams {
	id: string;
	orgId: string;
	fromWorkItemId: string;
	toWorkItemId: string;
	relationType: WorkItemRelationType;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
}

export async function addWorkItemRelation(
	db: DbQueryClient,
	params: AddWorkItemRelationParams,
): Promise<WorkItemRelation> {
	if (params.fromWorkItemId === params.toWorkItemId)
		throw new Error("A Work Item cannot relate to itself");
	const endpoints = await db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.fromWorkItemId),
			),
		);
	const target = await db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.toWorkItemId),
			),
		)
		.limit(1);
	if (!endpoints[0] || !target[0])
		throw new Error("Both relation endpoints must exist in the organization");
	return (
		await db
			.insert(workItemRelations)
			.values({ ...params, metadata: params.metadata ?? {} })
			.returning()
	)[0]!;
}

export interface WorkItemDependencyRow {
	id: string;
	title: string;
	disposition: WorkItemDisposition;
}

export async function queryWorkItemBlockers(
	db: DbQueryClient,
	workItemId: string,
	orgId?: string,
): Promise<WorkItemDependencyRow[]> {
	return db
		.select({
			id: workItems.id,
			title: workItems.title,
			disposition: workItems.disposition,
		})
		.from(workItemRelations)
		.innerJoin(workItems, eq(workItems.id, workItemRelations.fromWorkItemId))
		.where(
			and(
				eq(workItemRelations.toWorkItemId, workItemId),
				eq(workItemRelations.relationType, "blocks"),
				orgId ? eq(workItemRelations.orgId, orgId) : undefined,
			),
		)
		.orderBy(asc(workItems.createdAt));
}

export async function findWorkItemsBlockedBy(
	db: DbQueryClient,
	blockerWorkItemId: string,
	orgId?: string,
): Promise<WorkItemDependencyRow[]> {
	return db
		.select({
			id: workItems.id,
			title: workItems.title,
			disposition: workItems.disposition,
		})
		.from(workItemRelations)
		.innerJoin(workItems, eq(workItems.id, workItemRelations.toWorkItemId))
		.where(
			and(
				eq(workItemRelations.fromWorkItemId, blockerWorkItemId),
				eq(workItemRelations.relationType, "blocks"),
				orgId ? eq(workItemRelations.orgId, orgId) : undefined,
			),
		)
		.orderBy(asc(workItems.createdAt));
}

export async function firstNonTerminalBlocker(
	db: DbQueryClient,
	workItemId: string,
	orgId?: string,
): Promise<WorkItemDependencyRow | null> {
	return (
		(
			await db
				.select({
					id: workItems.id,
					title: workItems.title,
					disposition: workItems.disposition,
				})
				.from(workItemRelations)
				.innerJoin(
					workItems,
					eq(workItems.id, workItemRelations.fromWorkItemId),
				)
				.where(
					and(
						eq(workItemRelations.toWorkItemId, workItemId),
						eq(workItemRelations.relationType, "blocks"),
						ne(workItems.disposition, "completed"),
						ne(workItems.disposition, "cancelled"),
						orgId ? eq(workItemRelations.orgId, orgId) : undefined,
					),
				)
				.limit(1)
		)[0] ?? null
	);
}

export interface WorkItemRelationRow {
	relation: WorkItemRelation;
	fromTitle: string;
	toTitle: string;
}

export async function listWorkItemRelations(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId?: string;
		projectId?: string;
		limit?: number;
	},
): Promise<WorkItemRelation[]> {
	return db
		.select()
		.from(workItemRelations)
		.where(
			and(
				eq(workItemRelations.orgId, params.orgId),
				params.workItemId
					? eq(workItemRelations.fromWorkItemId, params.workItemId)
					: undefined,
			),
		)
		.orderBy(asc(workItemRelations.createdAt))
		.limit(params.limit ?? 200);
}
