import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkSprintStatus,
	workSprintItems,
	workSprints,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireProject,
	requireWorkItem,
} from "./factory-validation";

export async function createWorkSprint(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		projectId: string;
		name: string;
		goal?: string | null;
		status?: WorkSprintStatus;
		startAt: string;
		endAt: string;
		now: string;
	},
) {
	await requireProject(db, p.orgId, p.projectId);
	if (Date.parse(p.endAt) < Date.parse(p.startAt))
		throw new WorkControlError("CONFLICT", "Sprint end must follow its start");
	return (
		await db
			.insert(workSprints)
			.values({ ...p, status: p.status ?? "planned", createdAt: p.now })
			.returning()
	)[0]!;
}

export async function listWorkSprints(
	db: DbQueryClient,
	p: { orgId: string; projectId: string },
) {
	await requireProject(db, p.orgId, p.projectId);
	const sprints = await db
		.select()
		.from(workSprints)
		.where(
			and(
				eq(workSprints.orgId, p.orgId),
				eq(workSprints.projectId, p.projectId),
			),
		)
		.orderBy(asc(workSprints.startAt), asc(workSprints.id))
		.limit(100);
	if (!sprints.length) return [];
	const assignments = await db
		.select()
		.from(workSprintItems)
		.where(
			and(
				eq(workSprintItems.orgId, p.orgId),
				// bound-params: sprints is capped at 100 rows by the query above.
				inArray(
					workSprintItems.sprintId,
					sprints.map((sprint) => sprint.id),
				),
			),
		)
		.orderBy(asc(workSprintItems.sprintId), asc(workSprintItems.workItemId))
		.limit(10_000);
	return sprints.map((sprint) => ({
		sprint,
		workItemIds: assignments
			.filter((assignment) => assignment.sprintId === sprint.id)
			.map((assignment) => assignment.workItemId),
	}));
}

export async function assignWorkItemToSprint(
	db: DbQueryClient,
	p: { orgId: string; sprintId: string; workItemId: string; now: string },
) {
	const sprint = (
		await db
			.select()
			.from(workSprints)
			.where(
				and(eq(workSprints.orgId, p.orgId), eq(workSprints.id, p.sprintId)),
			)
			.limit(1)
	)[0];
	if (!sprint) throw new WorkControlError("NOT_FOUND", "Sprint not found");
	const item = await requireWorkItem(db, p.orgId, p.workItemId);
	if (item.projectId !== sprint.projectId)
		throw new WorkControlError(
			"CONFLICT",
			"Work Item and sprint must share a project",
		);
	return (
		(
			await db
				.insert(workSprintItems)
				.values({
					orgId: p.orgId,
					sprintId: p.sprintId,
					workItemId: p.workItemId,
					createdAt: p.now,
				})
				.onConflictDoNothing()
				.returning()
		)[0] ?? {
			orgId: p.orgId,
			sprintId: p.sprintId,
			workItemId: p.workItemId,
			createdAt: p.now,
		}
	);
}
