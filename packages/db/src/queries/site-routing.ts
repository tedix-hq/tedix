import { SiteRoutingDefinitionSchema } from "@tedix/api-contract/schemas/site-routing";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicyDefinition } from "./control-plane/system-policy";

export async function getSiteRoutingPolicy(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(db, "site-routing");
	return (
		SiteRoutingDefinitionSchema.safeParse(definition).data?.siteRouting ?? null
	);
}
