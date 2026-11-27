import { coreQueryDb } from "@tedix/db/core-store/scope";
import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import {
	validateCatalogFallback,
	type ModelCatalogConfig,
} from "@tedix/api-contract/schemas/model-catalog-config";
import { getTediRuntimeGovernance } from "@tedix/db/queries/tedi-runtime-bootstrap";

export async function loadTediModelFallback(
	env: CoreStoreEnv & { DB: D1Database },
	tediId: string | undefined,
	catalog?: ModelCatalogConfig,
) {
	if (!tediId) throw new Error("Model fallback requires a tedi identity");
	const row = await getTediRuntimeGovernance(coreQueryDb(env), tediId);
	if (!row) throw new Error("Model fallback organization is unavailable");
	const metadata =
		typeof row.organizationMetadata === "string"
			? JSON.parse(row.organizationMetadata)
			: row.organizationMetadata;
	const config =
		catalog ??
		(await getModelCatalogConfig(
			(await import("@tedix/db/core-store/scope")).coreDb(env),
		));
	return validateCatalogFallback(
		metadata?.modelFallback ?? config.fallback,
		config.entries,
	);
}
