import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	notInArray,
	or,
	type SQL,
} from "drizzle-orm";
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

/**
 * The member a read is made for. A private workspace is visible only when its
 * `owner_user_id` is one of `userIds`; an empty list sees org workspaces only.
 * There is deliberately no role-based bypass.
 */
export interface OsWorkspaceViewer {
	userIds: readonly string[];
}

export function isOsWorkspaceVisibleTo(
	workspace: Pick<OsWorkspaceRow, "visibility" | "ownerUserId">,
	viewer: OsWorkspaceViewer,
): boolean {
	if (workspace.visibility !== "private") return true;
	return (
		workspace.ownerUserId !== null &&
		viewer.userIds.includes(workspace.ownerUserId)
	);
}

/** SQL twin of `isOsWorkspaceVisibleTo` over `os_workspaces`. */
export function osWorkspaceVisibleToPredicate(viewer: OsWorkspaceViewer): SQL {
	const userIds = [...new Set(viewer.userIds)];
	const org = eq(osWorkspaces.visibility, "org");
	return userIds.length === 0
		? org
		: (or(org, inArray(osWorkspaces.ownerUserId, userIds)) as SQL);
}

/**
 * Predicate on a `workspace_id` column (outputs and other workspace children):
 * true unless the row belongs to a private workspace the viewer does not own.
 * Rows without a workspace stay visible.
 */
export function osWorkspaceChildVisibleToPredicate(
	db: DbQueryClient,
	organizationId: string,
	workspaceIdColumn: Parameters<typeof isNull>[0],
	viewer: OsWorkspaceViewer,
): SQL {
	const userIds = [...new Set(viewer.userIds)];
	const hidden = db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, organizationId),
				eq(osWorkspaces.visibility, "private"),
				userIds.length === 0
					? undefined
					: or(
							isNull(osWorkspaces.ownerUserId),
							notInArray(osWorkspaces.ownerUserId, userIds),
						),
			),
		);
	return or(
		isNull(workspaceIdColumn),
		notInArray(workspaceIdColumn as never, hidden),
	) as SQL;
}

export interface ListOsWorkspacesOptions {
	status?: OsWorkspaceRow["status"];
	limit?: number;
}

export interface UpdateOsWorkspacePatch {
	name?: string;
	description?: string | null;
	status?: OsWorkspaceRow["status"];
	visibility?: OsWorkspaceRow["visibility"];
	ownerUserId?: string | null;
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
	viewer: OsWorkspaceViewer,
	options: ListOsWorkspacesOptions = {},
): Promise<OsWorkspaceRow[]> {
	const conditions = [
		eq(osWorkspaces.organizationId, organizationId),
		osWorkspaceVisibleToPredicate(viewer),
	];
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
