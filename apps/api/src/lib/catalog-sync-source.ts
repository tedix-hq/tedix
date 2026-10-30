import {
	CATALOG_MAINTENANCE_POLICY_SLUG,
	CatalogMaintenancePolicySchema,
	type CatalogMaintenancePolicy,
} from "@tedix/api-contract/schemas/catalog-maintenance-policy";
import { getActiveSystemPolicyDefinition } from "@tedix/db/queries/control-plane/system-policy";
import type { DbQueryClient } from "@tedix/db/query-client";

export async function loadCatalogMaintenancePolicy(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(
		db,
		CATALOG_MAINTENANCE_POLICY_SLUG,
	);
	if (!definition?.catalogPolicy)
		throw new Error(
			"Published system catalog maintenance policy is not configured",
		);
	return CatalogMaintenancePolicySchema.parse(definition.catalogPolicy);
}

export function catalogSourceForR2Path(
	path: string,
	policy: CatalogMaintenancePolicy,
) {
	if (
		path.split("/").some((part) => part === "." || part === "..") ||
		path.includes("\\")
	)
		return undefined;
	return policy.sources.find(
		({ r2Prefix }) => path === r2Prefix || path.startsWith(`${r2Prefix}/`),
	);
}

export function isSupportedCatalogR2Path(
	path: string,
	policy: CatalogMaintenancePolicy,
): boolean {
	return !!catalogSourceForR2Path(path, policy);
}
