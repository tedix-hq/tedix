import { createDbClient } from "@tedix/db/client";
import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import {
	validateCatalogFallback,
	type ModelCatalogConfig,
} from "@tedix/api-contract/schemas/model-catalog-config";
import { getTediRuntimeGovernance } from "@tedix/db/queries/tedi-runtime-bootstrap";

export async function loadTediModelFallback(
	db: D1Database,
	tediId: string | undefined,
	catalog?: ModelCatalogConfig,
) {
	if (!tediId) throw new Error("Model fallback requires a tedi identity");
	const row = await getTediRuntimeGovernance(db, tediId);
	if (!row) throw new Error("Model fallback organization is unavailable");
	const metadata =
		typeof row.organizationMetadata === "string"
			? JSON.parse(row.organizationMetadata)
			: row.organizationMetadata;
	const config = catalog ?? (await getModelCatalogConfig(createDbClient(db)));
	return validateCatalogFallback(
		metadata?.modelFallback ?? config.fallback,
		config.entries,
	);
}
