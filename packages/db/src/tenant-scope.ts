/** Routing identity for tenant data; IDs are opaque and never rewritten. */
export interface TenantScope {
	organizationId: string;
	/** Omitted for organization-wide data and jobs. */
	workspaceId?: string;
}

/** Keep physical org_id / organization_id naming inside the query owner. */
export function normalizeTenantScope(scope: TenantScope): TenantScope {
	if (!scope.organizationId || !scope.organizationId.trim()) {
		throw new Error("Tenant scope requires organizationId");
	}
	if (scope.workspaceId !== undefined && !scope.workspaceId.trim()) {
		throw new Error("Tenant scope workspaceId must be non-empty when supplied");
	}
	return {
		organizationId: scope.organizationId,
		...(scope.workspaceId === undefined
			? {}
			: { workspaceId: scope.workspaceId }),
	};
}
