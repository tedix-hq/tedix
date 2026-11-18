/**
 * Sends a push for changes that started waiting for approval in a workspace
 * since the last run. Who is told and what the message says is decided in
 * `../services/workspace-approval-push`.
 */
export async function pushWaitingWorkspaceApprovalsTick(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const { createDbClient } = await import("@tedix/db/client");
	const { createDbQueryClient } = await import("@tedix/db/query-client");
	const { pushWaitingWorkspaceApprovals } =
		await import("../services/workspace-approval-push");
	return pushWaitingWorkspaceApprovals(
		{ db: createDbClient(env.DB), env },
		createDbQueryClient(env.DB),
		scheduledTime,
	);
}
