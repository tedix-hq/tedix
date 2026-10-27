import { getConnectionConsumerGrants } from "@tedix/db/queries/organizations";
import { getPersonalConnectionConsumerGrants } from "@tedix/db/queries/personal-connection-grants";
import {
	createConnectionAccessRequest,
	getConnectionAccessOwner,
} from "@tedix/db/queries/connection-access-requests";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { type BaseContext, ErrorCodes, createError } from "../../orpc";

export async function enforceConnectionConsumerGrants(
	context: BaseContext,
	input: {
		organizationId: string;
		providerId: string;
		connectionInstanceId?: string;
		personalUserId?: string;
	},
) {
	// The owner's direct use does not make an agent a permitted consumer.
	if (input.personalUserId && !context.tediId && context.authType === "user")
		return;
	const ownerUserId = input.personalUserId
		? await getConnectionAccessOwner(context.db, input)
		: undefined;
	if (input.personalUserId && !ownerUserId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Personal connection owner is not active in this organization",
		);
	const readPolicy = (instanceId?: string) =>
		ownerUserId
			? getPersonalConnectionConsumerGrants(
					context.db,
					ownerUserId,
					input.organizationId,
					input.providerId,
					instanceId,
				)
			: getConnectionConsumerGrants(
					context.db,
					input.organizationId,
					input.providerId,
					instanceId,
				);
	const policies = [await readPolicy()];
	if (input.connectionInstanceId)
		policies.push(await readPolicy(input.connectionInstanceId));
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
		let requested = false;
		if (context.tediId) {
			try {
				const owner =
					ownerUserId ?? (await getConnectionAccessOwner(context.db, input));
				if (owner)
					requested = Boolean(
						await createConnectionAccessRequest(
							context.db,
							{
								organizationId: input.organizationId,
								providerId: input.providerId,
								connectionInstanceId: input.connectionInstanceId,
								scope: input.personalUserId ? "user" : "tenant",
								ownerUserId: owner,
								tediId: context.tediId,
								...(verifiedRun?.skillRevision
									? {
											skill: {
												id: verifiedRun.skillId,
												revision: verifiedRun.skillRevision,
											},
										}
									: {}),
							},
							verifiedRun?.workItemId,
						),
					);
			} catch (error) {
				console.error("[Connections] Could not record access request", {
					exception: safeExceptionTopology(error),
				});
			}
		}
		throw createError(
			ErrorCodes.FORBIDDEN,
			requested
				? "Not granted for this connection. An access request is in the connection owner's inbox."
				: "Not granted for this connection. Ask the connection owner to allow this tedi or skill.",
		);
	}
}
