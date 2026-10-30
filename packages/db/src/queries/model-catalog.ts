import { ModelCatalogConfigSchema } from "@tedix/api-contract/schemas/model-catalog-config";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicyDefinition } from "./control-plane/system-policy";

/** Fresh trusted publication; a missing or malformed head never restores older model authority. */
export async function getModelCatalogConfig(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(db, "model-catalog");
	return ModelCatalogConfigSchema.parse(definition?.modelCatalog);
}
