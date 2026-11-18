import type { TenantStoreDb } from "./tenant-store";
import type { OsWorkspaceScopeParams } from "../os-workspaces/workspaces";
import * as resources from "../os-workspaces/resources";

const operations = {
	ensure: resources.ensureOsWorkspaceResource,
	create: resources.createOsWorkspaceResource,
	get: resources.getOsWorkspaceResource,
	find: resources.findOsWorkspaceTenantResource,
	rename: resources.renameOsWorkspaceResource,
	rebind: resources.rebindOsWorkspaceResource,
	remove: resources.removeOsWorkspaceResource,
	restore: resources.restoreOsWorkspaceResource,
	metadata: resources.updateOsWorkspaceResourceMetadata,
};
type ResourceOperation = keyof typeof operations;
export type ResourceQuery = {
	[K in ResourceOperation]: {
		operation: K;
		params: Parameters<(typeof operations)[K]>[1];
	};
}[ResourceOperation];
export type ResourceQueryResult = Awaited<
	ReturnType<(typeof operations)[ResourceOperation]>
>;

export async function executeWorkspaceResourceQuery(
	db: TenantStoreDb,
	scope: OsWorkspaceScopeParams,
	query: ResourceQuery,
): Promise<ResourceQueryResult> {
	if (
		query.params.organizationId !== scope.organizationId ||
		query.params.workspaceId !== scope.workspaceId
	)
		throw new Error("Resource is outside this workspace");
	switch (query.operation) {
		case "ensure":
			return resources.ensureOsWorkspaceResource(db, query.params);
		case "create":
			return resources.createOsWorkspaceResource(db, query.params);
		case "get":
			return resources.getOsWorkspaceResource(db, query.params);
		case "find":
			return resources.findOsWorkspaceTenantResource(db, query.params);
		case "rename":
			return resources.renameOsWorkspaceResource(db, query.params);
		case "rebind":
			return resources.rebindOsWorkspaceResource(db, query.params);
		case "remove":
			return resources.removeOsWorkspaceResource(db, query.params);
		case "restore":
			return resources.restoreOsWorkspaceResource(db, query.params);
		case "metadata":
			return resources.updateOsWorkspaceResourceMetadata(db, query.params);
	}
}
