import { and, eq, exists, gt, inArray } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "../schema/external-agent-identity";
import { workAttempts, workItems } from "../schema/work-items";
import { osOutputs, osWorkspaceProjects } from "../schema/os-workspaces";

/** Admission covers only the holder's bounded lifecycle and project artifacts. */
export async function resolveAgentLifecycleAuthorization(
	db: DbQueryClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		endpoint: string;
		args: Record<string, unknown>;
	},
): Promise<boolean> {
	const { args, endpoint } = params;
	const comment = endpoint === "workItems/addComment";
	const attempt =
		endpoint === "workItems/heartbeatAttempt" ||
		endpoint === "workItems/settleAttempt";
	const checkpoint =
		endpoint === "externalAgentIdentity/recordKnowledgeCheckpoint";
	const createOutput = endpoint === "osWorkspaces/outputs/create";
	const reviseOutput = endpoint === "osWorkspaces/outputs/revise";
	if (!comment && !attempt && !checkpoint && !createOutput && !reviseOutput)
		return false;
	if (comment && args.requestDelegation === true) return false;
	if (
		checkpoint &&
		(args.principalId !== params.principalId ||
			args.sessionId !== params.sessionId ||
			args.organizationId !== params.organizationId)
	)
		return false;
	const workItemId = checkpoint ? args.workItemId : args.id;
	if ((comment || attempt || checkpoint) && typeof workItemId !== "string")
		return false;
	if (attempt && typeof args.attemptId !== "string") return false;
	let workspaceId = args.workspaceId;
	if (reviseOutput) {
		if (typeof args.outputId !== "string") return false;
		const [output] = await db
			.select({ workspaceId: osOutputs.workspaceId })
			.from(osOutputs)
			.where(
				and(
					eq(osOutputs.organizationId, params.organizationId),
					eq(osOutputs.id, args.outputId),
					eq(osOutputs.status, "active"),
				),
			)
			.limit(1);
		workspaceId = output?.workspaceId;
	}
	if ((createOutput || reviseOutput) && typeof workspaceId !== "string")
		return false;
	const rows = await db
		.select({ id: workAttempts.id })
		.from(workAttempts)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workAttempts.orgId),
				eq(workItems.id, workAttempts.workItemId),
			),
		)
		.innerJoin(
			externalAgentSessions,
			and(
				eq(externalAgentSessions.organizationId, workAttempts.orgId),
				eq(externalAgentSessions.principalId, workAttempts.executorId),
				eq(externalAgentSessions.id, workAttempts.executorSessionId),
				eq(
					externalAgentSessions.externalSessionKey,
					workAttempts.externalSessionKey,
				),
			),
		)
		.innerJoin(
			externalAgentPrincipals,
			and(
				eq(
					externalAgentPrincipals.organizationId,
					externalAgentSessions.organizationId,
				),
				eq(externalAgentPrincipals.id, externalAgentSessions.principalId),
			),
		)
		.where(
			and(
				eq(workAttempts.orgId, params.organizationId),
				eq(workAttempts.executorType, "external_agent"),
				eq(workAttempts.executorId, params.principalId),
				eq(workAttempts.executorSessionId, params.sessionId),
				inArray(workAttempts.runtimeState, [
					"queued",
					"running",
					"waiting",
					"retrying",
				]),
				gt(workAttempts.expiresAt, new Date().toISOString()),
				eq(workItems.disposition, "accepted"),
				eq(externalAgentSessions.status, "active"),
				eq(externalAgentPrincipals.status, "active"),
				comment || attempt || checkpoint
					? eq(workItems.id, workItemId as string)
					: undefined,
				attempt ? eq(workAttempts.id, args.attemptId as string) : undefined,
				createOutput || reviseOutput
					? exists(
							db
								.select({ projectId: osWorkspaceProjects.projectId })
								.from(osWorkspaceProjects)
								.where(
									and(
										eq(
											osWorkspaceProjects.organizationId,
											params.organizationId,
										),
										eq(osWorkspaceProjects.workspaceId, workspaceId as string),
										eq(osWorkspaceProjects.status, "active"),
										eq(osWorkspaceProjects.projectId, workItems.projectId),
									),
								),
						)
					: undefined,
			),
		)
		.limit(1);
	return rows.length > 0;
}
