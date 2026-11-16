/**
 * One read of the organization's live Work for the Work Map: live items with
 * their latest event, comment and Attempt, the epics above them, child
 * progress, purposes, open requests, relations, active resource claims and
 * supervisor heartbeats. One sequential D1 batch; signals are derived by the
 * caller.
 */
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { dispatcherHealthReports } from "../../schema/dispatcher-health";
import { projects } from "../../schema/projects";
import { tediObjectives } from "../../schema/tedi-objectives";
import {
	workInteractions,
	workResourceReservations,
} from "../../schema/work-factory";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItemRelations,
	workItems,
} from "../../schema/work-items";

export const WORK_MAP_ITEM_LIMIT = 500;

export async function readWorkMapSnapshot(
	db: DbQueryClient,
	p: { orgId: string; now: string },
) {
	const e = alias(workEvents, "e");
	const c = alias(workItemComments, "c");
	const a = alias(workAttempts, "a");
	const child = alias(workItems, "child");
	const [
		items,
		epics,
		childCounts,
		projectRows,
		objectiveRows,
		interactions,
		relations,
		claims,
		heartbeats,
	] = await db.batch([
		db
			.select({
				id: workItems.id,
				title: workItems.title,
				disposition: workItems.disposition,
				priority: workItems.priority,
				projectId: workItems.projectId,
				objectiveId: workItems.objectiveId,
				workClass: workItems.workClass,
				parentId: workItems.parentWorkItemId,
				ownerType: workItems.accountableOwnerType,
				ownerId: workItems.accountableOwnerId,
				stewardType: workItems.stewardType,
				stewardId: workItems.stewardId,
				createdAt: workItems.createdAt,
				acceptedAt: workItems.acceptedAt,
				executor: sql<
					string | null
				>`json_extract(${workItems.metadata}, '$.executor')`.as("executor"),
				laneState: sql<
					string | null
				>`json_extract(${workItems.metadata}, '$.laneDispatch.state')`.as(
					"lane_state",
				),
				lastEventAt: sql<string | null>`(${db
					.select({ at: e.occurredAt })
					.from(e)
					.where(
						and(eq(e.orgId, workItems.orgId), eq(e.workItemId, workItems.id)),
					)
					.orderBy(desc(e.sequence))
					.limit(1)})`.as("last_event_at"),
				lastEventType: sql<string | null>`(${db
					.select({ type: e.eventType })
					.from(e)
					.where(
						and(eq(e.orgId, workItems.orgId), eq(e.workItemId, workItems.id)),
					)
					.orderBy(desc(e.sequence))
					.limit(1)})`.as("last_event_type"),
				lastComment: sql<string | null>`(${db
					.select({ body: sql`substr(${c.body}, 1, 400)` })
					.from(c)
					.where(eq(c.workItemId, workItems.id))
					.orderBy(desc(c.createdAt))
					.limit(1)})`.as("last_comment"),
				attemptState: sql<string | null>`(${db
					.select({ state: a.runtimeState })
					.from(a)
					.where(
						and(eq(a.orgId, workItems.orgId), eq(a.workItemId, workItems.id)),
					)
					.orderBy(desc(a.startedAt))
					.limit(1)})`.as("attempt_state"),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, p.orgId),
					inArray(workItems.disposition, ["proposed", "accepted"]),
				),
			)
			.orderBy(desc(workItems.createdAt))
			.limit(WORK_MAP_ITEM_LIMIT + 1),
		db
			.select({
				id: workItems.id,
				title: workItems.title,
				disposition: workItems.disposition,
				projectId: workItems.projectId,
				objectiveId: workItems.objectiveId,
				parentId: workItems.parentWorkItemId,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, p.orgId),
					// bound-params: subquery, no caller-supplied list
					inArray(
						workItems.id,
						db
							.selectDistinct({ id: sql<string>`${child.parentWorkItemId}` })
							.from(child)
							.where(
								and(
									eq(child.orgId, p.orgId),
									isNotNull(child.parentWorkItemId),
								),
							),
					),
				),
			)
			.limit(WORK_MAP_ITEM_LIMIT),
		db
			.select({
				parentId: sql<string>`${workItems.parentWorkItemId}`.as("parent_id"),
				disposition: workItems.disposition,
				count: sql<number>`COUNT(*)`.as("count"),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, p.orgId),
					isNotNull(workItems.parentWorkItemId),
				),
			)
			.groupBy(workItems.parentWorkItemId, workItems.disposition),
		db
			.select({
				id: projects.id,
				name: projects.name,
				objectiveId: projects.objectiveId,
				ownerUserId: projects.ownerUserId,
			})
			.from(projects)
			.where(and(eq(projects.orgId, p.orgId), isNull(projects.archivedAt)))
			.limit(WORK_MAP_ITEM_LIMIT),
		db
			.select({ id: tediObjectives.id, title: tediObjectives.title })
			.from(tediObjectives)
			.where(eq(tediObjectives.orgId, p.orgId))
			.limit(WORK_MAP_ITEM_LIMIT),
		db
			.select({
				id: workInteractions.id,
				workItemId: sql<string>`${workInteractions.workItemId}`.as(
					"work_item_id",
				),
				subject: workInteractions.subject,
				targetType: workInteractions.targetType,
				targetId: workInteractions.targetId,
				createdAt: workInteractions.createdAt,
			})
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.status, "open"),
					isNotNull(workInteractions.workItemId),
					or(
						isNull(workInteractions.expiresAt),
						gt(workInteractions.expiresAt, p.now),
					),
				),
			)
			.orderBy(desc(workInteractions.createdAt))
			.limit(WORK_MAP_ITEM_LIMIT),
		db
			.select({
				fromId: workItemRelations.fromWorkItemId,
				toId: workItemRelations.toWorkItemId,
				type: workItemRelations.relationType,
			})
			.from(workItemRelations)
			.where(
				and(
					eq(workItemRelations.orgId, p.orgId),
					inArray(workItemRelations.relationType, ["blocks", "duplicates"]),
				),
			)
			.limit(2000),
		db
			.select({
				workItemId: workResourceReservations.workItemId,
				resourceKey: workResourceReservations.resourceKey,
			})
			.from(workResourceReservations)
			.where(
				and(
					eq(workResourceReservations.orgId, p.orgId),
					eq(workResourceReservations.state, "active"),
					gt(workResourceReservations.expiresAt, p.now),
				),
			)
			.limit(2000),
		db
			.select()
			.from(dispatcherHealthReports)
			.where(eq(dispatcherHealthReports.orgId, p.orgId)),
	]);
	return {
		items: items.slice(0, WORK_MAP_ITEM_LIMIT),
		truncated: items.length > WORK_MAP_ITEM_LIMIT,
		epics,
		childCounts,
		projects: projectRows,
		objectives: objectiveRows,
		interactions,
		relations,
		claims,
		heartbeats,
	};
}

export type WorkMapSnapshot = Awaited<ReturnType<typeof readWorkMapSnapshot>>;
