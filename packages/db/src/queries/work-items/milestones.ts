import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import { workItems } from "../../schema/work-items";
import {
	workMilestoneDependencies,
	workMilestoneItems,
	workMilestones,
	type WorkMilestone,
	type WorkMilestoneStatus,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireActivePrincipal,
	requireMilestone,
	requireProject,
	requireWorkItem,
} from "./factory-validation";

export interface CreateWorkMilestoneParams {
	id: string;
	orgId: string;
	projectId: string;
	title: string;
	description?: string | null;
	status?: "proposed" | "planned" | "active";
	accountableOwnerType: "user" | "tedi" | "system";
	accountableOwnerId: string;
	sortOrder?: number;
	targetAt?: string | null;
	proofRef?: string | null;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function createWorkMilestone(
	db: DbQueryClient,
	p: CreateWorkMilestoneParams,
): Promise<WorkMilestone> {
	await Promise.all([
		requireProject(db, p.orgId, p.projectId),
		requireActivePrincipal(db, {
			orgId: p.orgId,
			type: p.accountableOwnerType,
			id: p.accountableOwnerId,
		}),
	]);
	return (
		await db
			.insert(workMilestones)
			.values({
				...p,
				status: p.status ?? "proposed",
				sortOrder: p.sortOrder ?? 0,
				metadata: p.metadata ?? {},
				createdAt: p.now,
				updatedAt: null,
			})
			.returning()
	)[0]!;
}

export interface UpdateWorkMilestoneParams {
	orgId: string;
	milestoneId: string;
	expectedVersion: number;
	title?: string;
	description?: string | null;
	accountableOwnerType?: "user" | "tedi" | "system";
	accountableOwnerId?: string;
	sortOrder?: number;
	targetAt?: string | null;
	status?: WorkMilestoneStatus;
	proofRef?: string | null;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function updateWorkMilestone(
	db: DbQueryClient,
	p: UpdateWorkMilestoneParams,
): Promise<WorkMilestone> {
	const prior = await requireMilestone(db, p.orgId, p.milestoneId);
	const ownerType = p.accountableOwnerType ?? prior.accountableOwnerType;
	const ownerId = p.accountableOwnerId ?? prior.accountableOwnerId;
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: ownerType,
		id: ownerId,
	});
	const status = p.status ?? prior.status;
	if (
		(prior.status === "done" || prior.status === "cancelled") &&
		status !== prior.status
	)
		throw new WorkControlError(
			"INVALID_TRANSITION",
			"Terminal milestone cannot transition",
		);
	if (status === "done") {
		if (!(p.proofRef ?? prior.proofRef))
			throw new WorkControlError(
				"INVALID_TRANSITION",
				"Done milestone requires proofRef",
			);
		const links = await db
			.select({
				id: workMilestoneItems.workItemId,
				disposition: workItems.disposition,
			})
			.from(workMilestoneItems)
			.innerJoin(workItems, eq(workItems.id, workMilestoneItems.workItemId))
			.where(
				and(
					eq(workMilestoneItems.orgId, p.orgId),
					eq(workMilestoneItems.milestoneId, p.milestoneId),
				),
			)
			.limit(10_000);
		if (!links.length || links.some((x) => x.disposition !== "completed"))
			throw new WorkControlError(
				"INVALID_TRANSITION",
				"Every linked Work Item must be completed",
			);
		const blockers = await db
			.select({ status: workMilestones.status })
			.from(workMilestoneDependencies)
			.innerJoin(
				workMilestones,
				eq(
					workMilestones.id,
					workMilestoneDependencies.prerequisiteMilestoneId,
				),
			)
			.where(
				and(
					eq(workMilestoneDependencies.orgId, p.orgId),
					eq(workMilestoneDependencies.dependentMilestoneId, p.milestoneId),
					ne(workMilestones.status, "done"),
				),
			)
			.limit(1);
		if (blockers[0])
			throw new WorkControlError(
				"INVALID_TRANSITION",
				"Prerequisite milestone is not done",
			);
	}
	const row = (
		await db
			.update(workMilestones)
			.set({
				title: p.title,
				description: p.description,
				accountableOwnerType: ownerType,
				accountableOwnerId: ownerId,
				sortOrder: p.sortOrder,
				targetAt: p.targetAt,
				status,
				proofRef: p.proofRef,
				metadata: p.metadata,
				updatedAt: p.now,
				doneAt: status === "done" ? p.now : prior.doneAt,
				cancelledAt: status === "cancelled" ? p.now : prior.cancelledAt,
				version: sql`${workMilestones.version}+1`,
			})
			.where(
				and(
					eq(workMilestones.orgId, p.orgId),
					eq(workMilestones.id, p.milestoneId),
					eq(workMilestones.version, p.expectedVersion),
				),
			)
			.returning()
	)[0];
	if (!row) throw new WorkControlError("CONFLICT", "Milestone version changed");
	return row;
}
export async function getWorkMilestone(
	db: DbQueryClient,
	p: { orgId: string; milestoneId: string },
) {
	return requireMilestone(db, p.orgId, p.milestoneId);
}
export async function addWorkMilestoneDependency(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		prerequisiteMilestoneId: string;
		dependentMilestoneId: string;
		now: string;
	},
) {
	if (p.prerequisiteMilestoneId === p.dependentMilestoneId)
		throw new WorkControlError("CONFLICT", "Milestone cannot depend on itself");
	await Promise.all([
		requireMilestone(db, p.orgId, p.prerequisiteMilestoneId),
		requireMilestone(db, p.orgId, p.dependentMilestoneId),
	]);
	const edges = await db
		.select({
			from: workMilestoneDependencies.prerequisiteMilestoneId,
			to: workMilestoneDependencies.dependentMilestoneId,
		})
		.from(workMilestoneDependencies)
		.where(eq(workMilestoneDependencies.orgId, p.orgId))
		.limit(10_000);
	const seen = new Set([p.dependentMilestoneId]),
		queue = [p.dependentMilestoneId];
	while (queue.length) {
		const n = queue.shift()!;
		for (const e of edges)
			if (e.from === n && !seen.has(e.to)) {
				if (e.to === p.prerequisiteMilestoneId)
					throw new WorkControlError(
						"CONFLICT",
						"Milestone dependency would create a cycle",
					);
				seen.add(e.to);
				queue.push(e.to);
			}
	}
	return (
		await db
			.insert(workMilestoneDependencies)
			.values({ ...p, createdAt: p.now })
			.returning()
	)[0]!;
}
export async function linkWorkItemToMilestone(
	db: DbQueryClient,
	p: { orgId: string; milestoneId: string; workItemId: string; now: string },
) {
	await Promise.all([
		requireMilestone(db, p.orgId, p.milestoneId),
		requireWorkItem(db, p.orgId, p.workItemId),
	]);
	return (
		await db
			.insert(workMilestoneItems)
			.values({
				orgId: p.orgId,
				milestoneId: p.milestoneId,
				workItemId: p.workItemId,
				createdAt: p.now,
			})
			.returning()
	)[0]!;
}
export async function listWorkMilestoneViews(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		status?: WorkMilestoneStatus;
		cursor?: string;
		limit?: number;
		workItemPreviewLimit?: number;
		dependencyPreviewLimit?: number;
	},
) {
	const limit = Math.min(p.limit ?? 50, 200),
		itemLimit = Math.min(p.workItemPreviewLimit ?? 20, 100),
		dependencyLimit = Math.min(p.dependencyPreviewLimit ?? 20, 100);
	const cursor = p.cursor
		? (
				await db
					.select({
						sortOrder: workMilestones.sortOrder,
						targetAt: workMilestones.targetAt,
						id: workMilestones.id,
					})
					.from(workMilestones)
					.where(
						and(
							eq(workMilestones.orgId, p.orgId),
							eq(workMilestones.projectId, p.projectId),
							eq(workMilestones.id, p.cursor),
							p.status ? eq(workMilestones.status, p.status) : undefined,
						),
					)
					.limit(1)
			)[0]
		: undefined;
	if (p.cursor && !cursor)
		throw new WorkControlError(
			"NOT_FOUND",
			"Milestone cursor is outside the scoped timeline",
		);
	const cursorTail = cursor
		? cursor.targetAt === null
			? and(
					sql`${workMilestones.targetAt} IS NULL`,
					gt(workMilestones.id, cursor.id),
				)
			: or(
					sql`${workMilestones.targetAt} IS NULL`,
					gt(workMilestones.targetAt, cursor.targetAt),
					and(
						eq(workMilestones.targetAt, cursor.targetAt),
						gt(workMilestones.id, cursor.id),
					),
				)
		: undefined;
	const milestones = await db
		.select()
		.from(workMilestones)
		.where(
			and(
				eq(workMilestones.orgId, p.orgId),
				eq(workMilestones.projectId, p.projectId),
				p.status ? eq(workMilestones.status, p.status) : undefined,
				cursor
					? or(
							gt(workMilestones.sortOrder, cursor.sortOrder),
							and(eq(workMilestones.sortOrder, cursor.sortOrder), cursorTail),
						)
					: undefined,
			),
		)
		.orderBy(
			asc(workMilestones.sortOrder),
			asc(sql`${workMilestones.targetAt} IS NULL`),
			asc(workMilestones.targetAt),
			asc(workMilestones.id),
		)
		.limit(limit + 1);
	const page = milestones.slice(0, limit),
		ids = page.map((x) => x.id);
	if (!ids.length) return { data: [], nextCursor: null };
	const idChunks = chunkForBoundParams(ids, 40);
	const [itemPages, dependencyPages] = await Promise.all([
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						milestoneId: workMilestoneItems.milestoneId,
						id: workItems.id,
						title: workItems.title,
						disposition: workItems.disposition,
					})
					.from(workMilestoneItems)
					.innerJoin(
						workItems,
						and(
							eq(workItems.orgId, workMilestoneItems.orgId),
							eq(workItems.id, workMilestoneItems.workItemId),
						),
					)
					.where(
						and(
							eq(workMilestoneItems.orgId, p.orgId),
							inArray(workMilestoneItems.milestoneId, idsChunk),
						),
					)
					.orderBy(asc(workMilestoneItems.workItemId))
					.limit(idsChunk.length * (itemLimit + 1)),
			),
		),
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select()
					.from(workMilestoneDependencies)
					.where(
						and(
							eq(workMilestoneDependencies.orgId, p.orgId),
							or(
								inArray(
									workMilestoneDependencies.prerequisiteMilestoneId,
									idsChunk,
								),
								inArray(
									workMilestoneDependencies.dependentMilestoneId,
									idsChunk,
								),
							),
						),
					)
					.orderBy(asc(workMilestoneDependencies.id))
					.limit(idsChunk.length * (dependencyLimit + 1)),
			),
		),
	]);
	const items = itemPages.flat(),
		dependencies = [
			...new Map(dependencyPages.flat().map((row) => [row.id, row])).values(),
		].sort((a, b) => a.id.localeCompare(b.id));
	const last = page.at(-1);
	return {
		data: page.map((milestone) => {
			const milestoneItems = items.filter(
					(x) => x.milestoneId === milestone.id,
				),
				milestoneDependencies = dependencies.filter(
					(x) =>
						x.prerequisiteMilestoneId === milestone.id ||
						x.dependentMilestoneId === milestone.id,
				);
			return {
				milestone,
				workItems: milestoneItems
					.slice(0, itemLimit)
					.map(({ milestoneId: _, ...item }) => item),
				dependencies: milestoneDependencies.slice(0, dependencyLimit),
				workItemsTruncated: milestoneItems.length > itemLimit,
				dependenciesTruncated: milestoneDependencies.length > dependencyLimit,
			};
		}),
		nextCursor: milestones.length > limit && last ? last.id : null,
	};
}
