import { and, asc, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsWorkspaceResourceRow,
	type OsWorkspaceResourceRow,
	osWorkspaceResources,
} from "../../schema/os-workspaces";

export interface OsWorkspaceResourceScope {
	organizationId: string;
	workspaceId: string;
}

export interface OsWorkspaceResourceIdentity extends OsWorkspaceResourceScope {
	resourceId: string;
}

export async function createOsWorkspaceResource(
	db: DbQueryClient,
	resource: NewOsWorkspaceResourceRow,
): Promise<OsWorkspaceResourceRow> {
	const [row] = await db
		.insert(osWorkspaceResources)
		.values(resource)
		.returning();
	if (!row) throw new Error("OS workspace resource insert returned no row");
	return row;
}

export async function getOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity,
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaceResources)
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsWorkspaceResources(
	db: DbQueryClient,
	params: OsWorkspaceResourceScope & {
		status?: OsWorkspaceResourceRow["status"];
		limit?: number;
	},
): Promise<OsWorkspaceResourceRow[]> {
	const conditions = [
		eq(osWorkspaceResources.organizationId, params.organizationId),
		eq(osWorkspaceResources.workspaceId, params.workspaceId),
	];
	if (params.status) {
		conditions.push(eq(osWorkspaceResources.status, params.status));
	}
	return db
		.select()
		.from(osWorkspaceResources)
		.where(and(...conditions))
		.orderBy(asc(osWorkspaceResources.name), asc(osWorkspaceResources.id))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
}

export async function renameOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		name: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ name: params.name, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

/** Change only the credential requirement for one active, exact provider object. */
export async function rebindOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		connectionScope: OsWorkspaceResourceRow["connectionScope"];
		personalOwnerUserId?: string | null;
		connectionInstanceId?: string | null;
		providerAccess?: { canRead: boolean; canWrite: boolean } | null;
		requiredScopes?: string;
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({
			connectionScope: params.connectionScope,
			personalOwnerUserId: params.personalOwnerUserId ?? null,
			connectionInstanceId: params.connectionInstanceId ?? null,
			providerAccess: params.providerAccess ?? null,
			...(params.requiredScopes === undefined
				? {}
				: { requiredScopes: params.requiredScopes }),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}

export async function removeOsWorkspaceResource(
	db: DbQueryClient,
	params: OsWorkspaceResourceIdentity & {
		expectedUpdatedAt: string;
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	const [row] = await db
		.update(osWorkspaceResources)
		.set({ status: "removed", removedAt: params.now, updatedAt: params.now })
		.where(
			and(
				eq(osWorkspaceResources.organizationId, params.organizationId),
				eq(osWorkspaceResources.workspaceId, params.workspaceId),
				eq(osWorkspaceResources.id, params.resourceId),
				eq(osWorkspaceResources.status, "active"),
				eq(osWorkspaceResources.updatedAt, params.expectedUpdatedAt),
			),
		)
		.returning();
	return row;
}
