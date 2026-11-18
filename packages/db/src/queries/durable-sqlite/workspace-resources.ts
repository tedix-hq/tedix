import { and, asc, eq } from "drizzle-orm";
import { tenantOsWorkspaceResources } from "../../tenant-store/outputs-schema";
import type { TenantStoreDb } from "./tenant-store";

/**
 * Active resources with what each one is connected through. Callers decide
 * what a reader may see: `personalOwnerUserId` is for access decisions and is
 * never shown.
 */
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
			slot: tenantOsWorkspaceResources.slot,
			providerId: tenantOsWorkspaceResources.providerId,
			connectionScope: tenantOsWorkspaceResources.connectionScope,
			personalOwnerUserId: tenantOsWorkspaceResources.personalOwnerUserId,
			connectionInstanceId: tenantOsWorkspaceResources.connectionInstanceId,
			providerAccess: tenantOsWorkspaceResources.providerAccess,
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
