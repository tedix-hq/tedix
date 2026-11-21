import { and, eq, gt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { tediApprovalRequests } from "../../schema/approvals";
import { workAttempts } from "../../schema/work-items";

/** Only the gateway's exact-call request for this Work revision can park a run. */
export async function findWorkToolApprovalWait(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		workVersion: number;
		attemptId?: string;
		now: string;
	},
) {
	if (!p.attemptId) {
		const [suspended] = await db
			.select({ id: workAttempts.id })
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, p.orgId),
					eq(workAttempts.workItemId, p.workItemId),
					eq(workAttempts.outcome, "cancelled"),
					sql`json_extract(${workAttempts.metadata}, '$.dispatchVersion') = ${p.workVersion}`,
					sql`json_type(${workAttempts.metadata}, '$.approvalWait.id') = 'text'`,
				),
			)
			.limit(1);
		// Before suspension the live Attempt already prevents admission.
		if (!suspended) return undefined;
	}
	const [request] = await db
		.select({
			id: tediApprovalRequests.id,
			expiresAt: tediApprovalRequests.expiresAt,
		})
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, p.orgId),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				gt(tediApprovalRequests.expiresAt, p.now),
				sql`json_extract(${tediApprovalRequests.payload}, '$.workItemId') = ${p.workItemId}`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.requestingWorkVersion') = ${p.workVersion}`,
				sql`json_type(${tediApprovalRequests.payload}, '$.requestingAgent.principalId') = 'text'`,
				sql`json_type(${tediApprovalRequests.payload}, '$.requestingAttemptId') = 'text'`,
				p.attemptId
					? sql`json_extract(${tediApprovalRequests.payload}, '$.requestingAttemptId') = ${p.attemptId}`
					: undefined,
				sql`(${tediApprovalRequests.status} = 'pending' OR (${tediApprovalRequests.status} = 'approved' AND coalesce(json_extract(${tediApprovalRequests.payload}, '$.execution.status'), '') NOT IN ('executed', 'failed')))`,
			),
		)
		.limit(1);
	return request;
}
