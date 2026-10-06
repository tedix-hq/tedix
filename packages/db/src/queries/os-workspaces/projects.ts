import { and, asc, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsWorkspaceProjectRow,
	type OsWorkspaceProjectRow,
	osWorkspaceProjects,
} from "../../schema/os-workspaces";

export interface OsWorkspaceProjectScope {
	organizationId: string;
	workspaceId: string;
}

export async function listOsWorkspaceProjects(
	db: DbQueryClient,
	params: OsWorkspaceProjectScope & {
		status?: OsWorkspaceProjectRow["status"];
		limit?: number;
	},
): Promise<OsWorkspaceProjectRow[]> {
	const conditions = [
		eq(osWorkspaceProjects.organizationId, params.organizationId),
		eq(osWorkspaceProjects.workspaceId, params.workspaceId),
	];
	if (params.status)
		conditions.push(eq(osWorkspaceProjects.status, params.status));
	return db
		.select()
		.from(osWorkspaceProjects)
		.where(and(...conditions))
		.orderBy(asc(osWorkspaceProjects.createdAt), asc(osWorkspaceProjects.id))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
}

export async function getOsWorkspaceProject(
	db: DbQueryClient,
	params: OsWorkspaceProjectScope & { projectId: string },
): Promise<OsWorkspaceProjectRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaceProjects)
		.where(
			and(
				eq(osWorkspaceProjects.organizationId, params.organizationId),
				eq(osWorkspaceProjects.workspaceId, params.workspaceId),
				eq(osWorkspaceProjects.projectId, params.projectId),
			),
		)
		.limit(1);
	return row;
}

export async function createOsWorkspaceProject(
	db: DbQueryClient,
	row: NewOsWorkspaceProjectRow,
): Promise<OsWorkspaceProjectRow> {
	const [created] = await db
		.insert(osWorkspaceProjects)
		.values(row)
		.returning();
	if (!created) throw new Error("OS workspace project insert returned no row");
	return created;
}

export async function reactivateOsWorkspaceProject(
	db: DbQueryClient,
	params: OsWorkspaceProjectScope & { projectId: string; now: string },
): Promise<OsWorkspaceProjectRow | undefined> {
	const [row] = await db
		.update(osWorkspaceProjects)
		.set({ status: "active", removedAt: null, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceProjects.organizationId, params.organizationId),
				eq(osWorkspaceProjects.workspaceId, params.workspaceId),
				eq(osWorkspaceProjects.projectId, params.projectId),
				eq(osWorkspaceProjects.status, "removed"),
			),
		)
		.returning();
	return row;
}

export async function removeOsWorkspaceProject(
	db: DbQueryClient,
	params: OsWorkspaceProjectScope & {
		projectId: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceProjectRow | undefined> {
	const [row] = await db
		.update(osWorkspaceProjects)
		.set({ status: "removed", removedAt: params.now, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceProjects.organizationId, params.organizationId),
				eq(osWorkspaceProjects.workspaceId, params.workspaceId),
				eq(osWorkspaceProjects.projectId, params.projectId),
				eq(osWorkspaceProjects.status, "active"),
				eq(osWorkspaceProjects.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}
