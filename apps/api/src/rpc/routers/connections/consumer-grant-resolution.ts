import { getConnectionConsumerGrants } from "@tedix/db/queries/organizations";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";

export async function enforceConnectionConsumerGrants(
	context: BaseContext,
	input: {
		organizationId: string;
		providerId: string;
		connectionInstanceId?: string;
	},
) {
	const policies = [
		await getConnectionConsumerGrants(
			context.db,
			input.organizationId,
			input.providerId,
		),
	];
	if (input.connectionInstanceId)
		policies.push(
			await getConnectionConsumerGrants(
				context.db,
				input.organizationId,
				input.providerId,
				input.connectionInstanceId,
			),
		);
	if (policies.every((policy) => policy.mode === "all")) return;
	// The MCP edge strips public skill headers; only its trusted binding carries run provenance.
	const runId =
		context.authType === "service-binding" &&
		context.tediId &&
		context.headers.get("X-Tedix-Skill-Run-Id");
	const run = runId
		? await getSkillRun(
				context.db,
				runId,
				input.organizationId,
				context.env.ENVIRONMENT,
			)
		: undefined;
	const verifiedRun =
		run?.tediId === context.tediId && run?.status === "running"
			? run
			: undefined;
	for (const policy of policies) {
		if (policy.mode === "all") continue;
		if (context.tediId && policy.tediIds.includes(context.tediId)) continue;
		if (
			verifiedRun &&
			policy.skills.some(
				(skill) =>
					skill.id === verifiedRun.skillId &&
					skill.revision === verifiedRun.skillRevision,
			)
		)
			continue;
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Not granted for this connection. Request access from an administrator in /admin/connections.",
		);
	}
}
