import { and, asc, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsWorkspaceRow,
	type OsWorkspaceRow,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { userConfigs } from "../../schema/user-configs";

export interface OsWorkspaceScopeParams {
	organizationId: string;
	workspaceId: string;
}

export interface ListOsWorkspacesOptions {
	status?: OsWorkspaceRow["status"];
	limit?: number;
}

export interface UpdateOsWorkspacePatch {
	name?: string;
	description?: string | null;
	status?: OsWorkspaceRow["status"];
}

export async function createOsWorkspace(
	db: DbQueryClient,
	workspace: NewOsWorkspaceRow,
): Promise<OsWorkspaceRow> {
	const [row] = await db.insert(osWorkspaces).values(workspace).returning();
	if (!row) {
		throw new Error("OS workspace insert returned no row");
	}
	return row;
}

export async function getOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams,
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsWorkspaces(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsWorkspacesOptions = {},
): Promise<OsWorkspaceRow[]> {
	const conditions = [eq(osWorkspaces.organizationId, organizationId)];
	if (options.status) {
		conditions.push(eq(osWorkspaces.status, options.status));
	}
	return db
		.select()
		.from(osWorkspaces)
		.where(and(...conditions))
		.orderBy(asc(osWorkspaces.name))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

export async function updateOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams,
	patch: UpdateOsWorkspacePatch,
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.update(osWorkspaces)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsWorkspace(
	db: DbQueryClient,
	params: OsWorkspaceScopeParams & { preferenceNamespace?: string },
): Promise<boolean> {
	const deleteWorkspace = db
		.delete(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, params.organizationId),
				eq(osWorkspaces.id, params.workspaceId),
			),
		)
		.returning({ id: osWorkspaces.id });
	if (!params.preferenceNamespace) {
		return (await deleteWorkspace).length > 0;
	}
	const [result] = await db.batch([
		deleteWorkspace,
		db
			.delete(userConfigs)
			.where(
				and(
					eq(userConfigs.namespace, params.preferenceNamespace),
					eq(userConfigs.key, params.workspaceId),
				),
			),
	]);
	return result.length > 0;
}
