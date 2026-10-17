import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestOwner } from "@tedix/db/queries/agent-session-requests";
import {
	getUserConfig,
	upsertUserConfig,
} from "@tedix/db/queries/user-configs";

export async function automaticFilingEnabled(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
) {
	const config = await getUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "request-auto-filing",
	});
	return config?.value.enabled === true;
}
export async function setAutomaticFiling(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
	enabled: boolean,
) {
	await upsertUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "request-auto-filing",
		value: { enabled },
	});
}
