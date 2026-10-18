import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestOwner } from "@tedix/db/queries/agent-session-requests";
import {
	getUserConfig,
	upsertUserConfig,
} from "@tedix/db/queries/user-configs";

export async function requestFilingSettings(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
) {
	const config = await getUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "request-auto-filing",
	});
	return {
		enabled: config?.value.enabled === true,
		intakeProjectId:
			typeof config?.value.intakeProjectId === "string"
				? config.value.intakeProjectId
				: null,
	};
}
export async function automaticFilingEnabled(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
) {
	return (await requestFilingSettings(db, owner)).enabled;
}
export async function setAutomaticFiling(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
	enabled: boolean,
	intakeProjectId?: string | null,
) {
	const current = await requestFilingSettings(db, owner);
	await upsertUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "request-auto-filing",
		value: {
			enabled,
			intakeProjectId:
				intakeProjectId === undefined
					? current.intakeProjectId
					: intakeProjectId,
		},
	});
}
