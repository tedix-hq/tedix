import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { recordWorkRelationEdges } from "../decision-graph-writers";
import { coreTable } from "../../core-store/client";
import { jsonParameter } from "../../core-store/dialect";
import { decisionEdges } from "../../schema/decision-graph";
import { getWorkItemById, lifecycleEventInsert } from "./crud";
import { WorkFactoryError, type WorkActor } from "./factory-state";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemDisposition,
	type WorkItemRelation,
	type WorkItemRelationType,
	workEvents,
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
	const items = coreTable(db, workItems);
	const relations = coreTable(db, workItemRelations);
	if (params.fromWorkItemId === params.toWorkItemId)
		throw new Error("A Work Item cannot relate to itself");
	const endpoints = await db
		.select({ id: items.id })
		.from(items)
		.where(
			and(eq(items.orgId, params.orgId), eq(items.id, params.fromWorkItemId)),
		);
	const target = await db
		.select({ id: items.id })
		.from(items)
		.where(
			and(eq(items.orgId, params.orgId), eq(items.id, params.toWorkItemId)),
		)
		.limit(1);
	if (!endpoints[0] || !target[0])
		throw new Error("Both relation endpoints must exist in the organization");
	const relation = (
		await db
			.insert(relations)
			.values({ ...params, metadata: params.metadata ?? {} })
			.returning()
	)[0]!;
	await recordWorkRelationEdges(db, params.orgId, [relation]);
	return relation;
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
	const items = coreTable(db, workItems);
	const relations = coreTable(db, workItemRelations);
	return db
		.select({
			id: items.id,
			title: items.title,
			disposition: items.disposition,
		})
		.from(relations)
		.innerJoin(items, eq(items.id, relations.fromWorkItemId))
		.where(
			and(
				eq(relations.toWorkItemId, workItemId),
				eq(relations.relationType, "blocks"),
				orgId ? eq(relations.orgId, orgId) : undefined,
			),
		)
		.orderBy(asc(items.createdAt));
}

export async function findWorkItemsBlockedBy(
	db: DbQueryClient,
	blockerWorkItemId: string,
	orgId?: string,
): Promise<WorkItemDependencyRow[]> {
	const items = coreTable(db, workItems);
	const relations = coreTable(db, workItemRelations);
	return db
		.select({
			id: items.id,
			title: items.title,
			disposition: items.disposition,
		})
		.from(relations)
		.innerJoin(items, eq(items.id, relations.toWorkItemId))
		.where(
			and(
				eq(relations.fromWorkItemId, blockerWorkItemId),
				eq(relations.relationType, "blocks"),
				orgId ? eq(relations.orgId, orgId) : undefined,
			),
		)
		.orderBy(asc(items.createdAt));
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
	const relations = coreTable(db, workItemRelations);
	return db
		.select()
		.from(relations)
		.where(
			and(
				eq(relations.orgId, params.orgId),
				params.workItemId
					? eq(relations.fromWorkItemId, params.workItemId)
					: undefined,
			),
		)
		.orderBy(asc(relations.createdAt))
		.limit(params.limit ?? 200);
}

/** The recursive predicate repeats validation at write time, including concurrent edits. */
export async function setWorkItemParent(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		parentWorkItemId: string | null;
		expectedWorkItemVersion: number;
		actor: WorkActor;
	},
) {
	const items = coreTable(db, workItems);
	const prior = await getWorkItemById(db, params.workItemId, params.orgId);
	if (!prior) throw new WorkFactoryError("NOT_FOUND", "Work Item not found");
	const visited = new Set([prior.id]);
	let ancestorId = params.parentWorkItemId;
	while (ancestorId) {
		if (visited.has(ancestorId))
			throw new WorkFactoryError(
				"NOT_READY",
				"Work Item parent would create a cycle",
			);
		visited.add(ancestorId);
		const ancestor = await getWorkItemById(db, ancestorId, params.orgId);
		if (!ancestor)
			throw new WorkFactoryError(
				"NOT_FOUND",
				"Parent Work Item not found in organization",
			);
		if (
			ancestorId === params.parentWorkItemId &&
			ancestor.disposition === "cancelled"
		)
			throw new WorkFactoryError("NOT_READY", "Parent Work Item is cancelled");
		ancestorId = ancestor.parentWorkItemId;
	}
	const now = new Date().toISOString();
	const specificationUpdateId = crypto.randomUUID();
	const parentGuard =
		params.parentWorkItemId === null
			? undefined
			: sql`
 EXISTS (SELECT 1 FROM ${items} p WHERE p.id = ${params.parentWorkItemId} AND p.org_id = ${params.orgId} AND p.disposition <> 'cancelled')
 AND NOT EXISTS (
 WITH RECURSIVE ancestors(id, parent_id) AS (
 SELECT p.id, p.parent_work_item_id FROM ${items} p WHERE p.id = ${params.parentWorkItemId} AND p.org_id = ${params.orgId}
 UNION
 SELECT p.id, p.parent_work_item_id FROM ${items} p JOIN ancestors a ON p.id = a.parent_id WHERE p.org_id = ${params.orgId}
 ) SELECT 1 FROM ancestors WHERE id = ${prior.id}
 )`;
	const [rows] = await db.batch([
		db
			.update(items)
			.set({
				parentWorkItemId: params.parentWorkItemId,
				version: sql`${items.version} + 1`,
				updatedAt: now,
				metadata: { ...prior.metadata, specificationUpdateId },
				admissionSpecRevision: crypto.randomUUID(),
			})
			.where(
				and(
					eq(items.orgId, params.orgId),
					eq(items.id, prior.id),
					eq(items.version, params.expectedWorkItemVersion),
					eq(items.version, prior.version),
					parentGuard,
				),
			)
			.returning({ id: items.id }),
		lifecycleEventInsert(db, {
			orgId: params.orgId,
			workItemId: prior.id,
			disposition: prior.disposition,
			expectedVersion: prior.version + 1,
			specificationUpdateId,
			eventType: "work.parent_changed",
			actor: params.actor,
			occurredAt: now,
			payload: { from: prior.parentWorkItemId, to: params.parentWorkItemId },
		}),
	]);
	if (!rows[0])
		throw new WorkFactoryError(
			"NOT_READY",
			"Work or parent changed before parent update",
		);
	return (await getWorkItemById(db, prior.id, params.orgId))!;
}

export async function removeWorkItemRelation(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		relatedWorkItemId: string;
		kind: WorkItemRelationType;
		actor: WorkActor;
	},
) {
	const relations = coreTable(db, workItemRelations);
	const events = coreTable(db, workEvents);
	const edges = coreTable(db, decisionEdges);
	const where = and(
		eq(relations.orgId, params.orgId),
		eq(relations.fromWorkItemId, params.workItemId),
		eq(relations.toWorkItemId, params.relatedWorkItemId),
		eq(relations.relationType, params.kind),
	);
	const now = new Date().toISOString();
	// Insert from the existing relation before deletion: no event for a repeated removal.
	const [, removed] = await db.batch([
		db.insert(events).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					orgId: relations.orgId,
					workItemId: relations.fromWorkItemId,
					eventType: sql<string>`'work.relation_removed'`.as("event_type"),
					actorType: sql<typeof params.actor.type>`${params.actor.type}`.as(
						"actor_type",
					),
					actorId: sql<string>`${params.actor.id}`.as("actor_id"),
					actorSessionId: sql<
						string | null
					>`${params.actor.sessionId ?? null}`.as("actor_session_id"),
					payload: sql<
						Record<string, JsonValue>
					>`${jsonParameter(db, { relatedWorkItemId: params.relatedWorkItemId, kind: params.kind })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${now}`.as("occurred_at"),
				})
				.from(relations)
				.where(where),
		),
		db.delete(relations).where(where).returning({ id: relations.id }),
		db
			.delete(edges)
			.where(
				and(
					eq(edges.orgId, params.orgId),
					eq(edges.source, "work_link"),
					eq(edges.fromKind, "work_item"),
					eq(edges.fromId, params.workItemId),
					eq(edges.toKind, "work_item"),
					eq(edges.toId, params.relatedWorkItemId),
					sql`${edges.kind} = ${params.kind}`,
				),
			),
	]);
	return { removed: removed.length > 0 };
}
