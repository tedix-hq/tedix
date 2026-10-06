import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { osApi } from "@/lib/api";

/**
 * Contract-generated query definitions for the tenant-neutral account zone.
 * Account code cannot import product-owned `@/lib/os-query-options`; deriving
 * keys from the same typed client keeps both zones in the canonical endpoint
 * namespace without crossing that boundary.
 */
const accountQuery = createTanstackQueryUtils(osApi);

export const osOrganizationsQueryOptions = () =>
	accountQuery.organizations.listOsMine.queryOptions({
		input: { limit: 50, offset: 0 },
	});

export const myOrganizationBootstrapQueryOptions = () =>
	accountQuery.organizations.getMyOrganization.queryOptions({ input: {} });

export const allMyOrganizationsQueryOptions = () =>
	accountQuery.organizations.listAllMine.queryOptions({
		input: { activeOnly: true, limit: 50, offset: 0 },
	});

export const cliWorkspacesDirectoryQueryOptions = () =>
	accountQuery.directory.listMyWorkspaces.queryOptions({
		input: { limit: 100, offset: 0 },
	});
