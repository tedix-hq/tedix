import { WorkOnboardingSchema } from "@tedix/api-contract/schemas/work-onboarding";
import type { DbQueryClient } from "../query-client";
import { getActiveSystemPolicyDefinition } from "./control-plane/system-policy";

export async function getWorkOnboarding(db: DbQueryClient) {
	const definition = await getActiveSystemPolicyDefinition(
		db,
		"work-onboarding",
	);
	return WorkOnboardingSchema.parse(definition?.workOnboarding);
}
