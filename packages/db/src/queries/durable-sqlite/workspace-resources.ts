import { and, asc, eq } from "drizzle-orm";
import { tenantOsWorkspaceResources } from "../../tenant-store/outputs-schema";
import type { TenantStoreDb } from "./tenant-store";

export function listWorkspaceResourceSummaries(
	db: TenantStoreDb,
	scope: { organizationId: string; workspaceId: string },
) {
	return db
		.select({
			id: tenantOsWorkspaceResources.id,
			name: tenantOsWorkspaceResources.name,
			kind: tenantOsWorkspaceResources.resourceType,
			status: tenantOsWorkspaceResources.status,
		})
		.from(tenantOsWorkspaceResources)
		.where(
			and(
				eq(tenantOsWorkspaceResources.organizationId, scope.organizationId),
				eq(tenantOsWorkspaceResources.workspaceId, scope.workspaceId),
				eq(tenantOsWorkspaceResources.status, "active"),
			),
		)
		.orderBy(
			asc(tenantOsWorkspaceResources.name),
			asc(tenantOsWorkspaceResources.id),
		)
		.limit(100)
		.all();
}
