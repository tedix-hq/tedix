import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workItems } from "../../schema/work-items";
import {
	workCaseDependencies,
	workCaseItems,
	workCases,
	type WorkCase,
	type WorkCaseStage,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireActivePrincipal,
	requireProject,
	requireWorkCase,
	requireWorkItem,
} from "./factory-validation";

export interface CreateWorkCaseParams {
	id: string;
	orgId: string;
	projectId?: string | null;
	objectiveId?: string | null;
	title: string;
	description?: string | null;
	kind: string;
	stage?: WorkCaseStage;
	accountableOwnerType: "user" | "tedi" | "system";
	accountableOwnerId: string;
	openedAt: string;
	targetResolutionAt?: string | null;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function createWorkCase(
	db: DbQueryClient,
	p: CreateWorkCaseParams,
): Promise<WorkCase> {
	if (p.projectId) await requireProject(db, p.orgId, p.projectId);
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: p.accountableOwnerType,
		id: p.accountableOwnerId,
	});
	return (
		await db
			.insert(workCases)
			.values({
				id: p.id,
				orgId: p.orgId,
				projectId: p.projectId,
				objectiveId: p.objectiveId,
				title: p.title,
				description: p.description,
				kind: p.kind,
				stage: p.stage ?? "investigating",
				accountableOwnerType: p.accountableOwnerType,
				accountableOwnerId: p.accountableOwnerId,
				openedAt: p.openedAt,
				targetResolutionAt: p.targetResolutionAt,
				metadata: p.metadata ?? {},
				createdAt: p.now,
				updatedAt: null,
			})
			.returning()
	)[0]!;
}

export interface UpdateWorkCaseParams {
	orgId: string;
	caseId: string;
	expectedVersion: number;
	title?: string;
	description?: string | null;
	kind?: string;
	accountableOwnerType?: "user" | "tedi" | "system";
	accountableOwnerId?: string;
	targetResolutionAt?: string | null;
	stage?: WorkCaseStage;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function updateWorkCase(
	db: DbQueryClient,
	p: UpdateWorkCaseParams,
): Promise<WorkCase> {
	const prior = await requireWorkCase(db, p.orgId, p.caseId);
	const ownerType = p.accountableOwnerType ?? prior.accountableOwnerType;
	const ownerId = p.accountableOwnerId ?? prior.accountableOwnerId;
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: ownerType,
		id: ownerId,
	});
	if (prior.stage === "closed" && p.stage !== "closed" && p.stage !== undefined)
		throw new WorkControlError(
			"INVALID_TRANSITION",
			"Closed cases cannot transition",
		);
	const stage = p.stage ?? prior.stage;
	if (stage === "closed") {
		const openItems = await db
			.select({ id: workCaseItems.workItemId })
			.from(workCaseItems)
			.innerJoin(workItems, eq(workItems.id, workCaseItems.workItemId))
			.where(
				and(
					eq(workCaseItems.orgId, p.orgId),
					eq(workCaseItems.caseId, p.caseId),
					inArray(workItems.disposition, ["proposed", "accepted"]),
				),
			)
			.limit(1);
		if (openItems[0])
			throw new WorkControlError(
				"INVALID_TRANSITION",
				"Case has non-terminal Work Items",
			);
	}
	const row = (
		await db
			.update(workCases)
			.set({
				title: p.title,
				description: p.description,
				kind: p.kind,
				accountableOwnerType: ownerType,
				accountableOwnerId: ownerId,
				targetResolutionAt: p.targetResolutionAt,
				stage,
				metadata: p.metadata,
				closedAt: stage === "closed" ? p.now : prior.closedAt,
				updatedAt: p.now,
				version: sql`${workCases.version} + 1`,
			})
			.where(
				and(
					eq(workCases.orgId, p.orgId),
					eq(workCases.id, p.caseId),
					eq(workCases.version, p.expectedVersion),
				),
			)
			.returning()
	)[0];
	if (!row) throw new WorkControlError("CONFLICT", "Case version changed");
	return row;
}

export async function getWorkCase(
	db: DbQueryClient,
	p: { orgId: string; caseId: string },
) {
	return requireWorkCase(db, p.orgId, p.caseId);
}
export async function listWorkCases(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId?: string;
		stages?: WorkCaseStage[];
		cursor?: { createdAt: string; id: string };
		limit?: number;
	},
) {
	const limit = Math.min(Math.max(1, Math.trunc(p.limit ?? 50)), 100);
	const rows = await db
		.select()
		.from(workCases)
		.where(
			and(
				eq(workCases.orgId, p.orgId),
				p.projectId ? eq(workCases.projectId, p.projectId) : undefined,
				// bound-params: stages is a closed five-value Work Case stage enum
				p.stages?.length ? inArray(workCases.stage, p.stages) : undefined,
				p.cursor
					? or(
							lt(workCases.createdAt, p.cursor.createdAt),
							and(
								eq(workCases.createdAt, p.cursor.createdAt),
								lt(workCases.id, p.cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(workCases.createdAt), desc(workCases.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit),
		last = data.at(-1);
	return {
		data,
		nextCursor:
			rows.length > limit && last
				? { createdAt: last.createdAt, id: last.id }
				: null,
	};
}

export async function addWorkCaseDependency(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		prerequisiteCaseId: string;
		dependentCaseId: string;
		now: string;
	},
) {
	if (p.prerequisiteCaseId === p.dependentCaseId)
		throw new WorkControlError("CONFLICT", "Case cannot depend on itself");
	await Promise.all([
		requireWorkCase(db, p.orgId, p.prerequisiteCaseId),
		requireWorkCase(db, p.orgId, p.dependentCaseId),
	]);
	const edges = await db
		.select({
			from: workCaseDependencies.prerequisiteCaseId,
			to: workCaseDependencies.dependentCaseId,
		})
		.from(workCaseDependencies)
		.where(eq(workCaseDependencies.orgId, p.orgId))
		.limit(10_000);
	const seen = new Set([p.dependentCaseId]);
	const queue = [p.dependentCaseId];
	while (queue.length) {
		const node = queue.shift()!;
		for (const edge of edges)
			if (edge.from === node && !seen.has(edge.to)) {
				if (edge.to === p.prerequisiteCaseId)
					throw new WorkControlError(
						"CONFLICT",
						"Case dependency would create a cycle",
					);
				seen.add(edge.to);
				queue.push(edge.to);
			}
	}
	return (
		await db
			.insert(workCaseDependencies)
			.values({ ...p, createdAt: p.now })
			.returning()
	)[0]!;
}
export async function listWorkCaseDependencies(
	db: DbQueryClient,
	p: { orgId: string; caseId: string; cursor?: string; limit?: number },
) {
	const limit = Math.min(p.limit ?? 100, 500);
	const rows = await db
		.select()
		.from(workCaseDependencies)
		.where(
			and(
				eq(workCaseDependencies.orgId, p.orgId),
				sql`(${workCaseDependencies.prerequisiteCaseId}=${p.caseId} OR ${workCaseDependencies.dependentCaseId}=${p.caseId})`,
				p.cursor ? gt(workCaseDependencies.id, p.cursor) : undefined,
			),
		)
		.orderBy(asc(workCaseDependencies.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit);
	return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
}
export async function linkWorkItemToCase(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		caseId: string;
		workItemId: string;
		rationale?: string | null;
		discoveredAt: string;
	},
) {
	await Promise.all([
		requireWorkCase(db, p.orgId, p.caseId),
		requireWorkItem(db, p.orgId, p.workItemId),
	]);
	return (await db.insert(workCaseItems).values(p).returning())[0]!;
}
export async function listWorkCaseItems(
	db: DbQueryClient,
	p: { orgId: string; caseId: string; cursor?: string; limit?: number },
) {
	const limit = Math.min(p.limit ?? 100, 500);
	const rows = await db
		.select()
		.from(workCaseItems)
		.where(
			and(
				eq(workCaseItems.orgId, p.orgId),
				eq(workCaseItems.caseId, p.caseId),
				p.cursor ? gt(workCaseItems.id, p.cursor) : undefined,
			),
		)
		.orderBy(asc(workCaseItems.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit);
	return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
}
