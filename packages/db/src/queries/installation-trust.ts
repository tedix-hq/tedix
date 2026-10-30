import { InstallationTrustDefinitionSchema } from "@tedix/api-contract/schemas/installation-trust";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicyDefinition } from "./control-plane/system-policy";

export async function getInstallationTrustPolicy(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(
		db,
		"installation-trust",
	);
	// A malformed head must not revive an older authority grant.
	return (
		InstallationTrustDefinitionSchema.safeParse(definition).data
			?.installationTrust ?? null
	);
}
