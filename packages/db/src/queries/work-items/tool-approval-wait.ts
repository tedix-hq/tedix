import { and, eq, gt, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonType } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { tediApprovalRequests as d1TediApprovalRequests } from "../../schema/approvals";
import { workAttempts as d1WorkAttempts } from "../../schema/work-items";

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
	const workAttempts = coreTable(db, d1WorkAttempts);
	const tediApprovalRequests = coreTable(db, d1TediApprovalRequests);
	if (!p.attemptId) {
		const [suspended] = await db
			.select({ id: workAttempts.id })
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, p.orgId),
					eq(workAttempts.workItemId, p.workItemId),
					eq(workAttempts.outcome, "cancelled"),
					sql`${jsonRead(db, workAttempts.metadata, ["dispatchVersion"], "number")} = ${p.workVersion}`,
					sql`${jsonType(db, workAttempts.metadata, ["approvalWait", "id"])} = 'string'`,
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
				coreStore(db) === "postgres"
					? sql`${jsonType(db, tediApprovalRequests.payload, ["workItemId"])} = 'string' AND ${jsonRead(db, tediApprovalRequests.payload, ["workItemId"])} = ${p.workItemId}`
					: eq(tediApprovalRequests.workItemId, p.workItemId),
				sql`${jsonRead(db, tediApprovalRequests.payload, ["requestingWorkVersion"], "number")} = ${p.workVersion}`,
				sql`${jsonType(db, tediApprovalRequests.payload, ["requestingAgent", "principalId"])} = 'string'`,
				sql`${jsonType(db, tediApprovalRequests.payload, ["requestingAttemptId"])} = 'string'`,
				p.attemptId
					? sql`${jsonRead(db, tediApprovalRequests.payload, ["requestingAttemptId"])} = ${p.attemptId}`
					: undefined,
				sql`(${tediApprovalRequests.status} = 'pending' OR (${tediApprovalRequests.status} = 'approved' AND coalesce(${jsonRead(db, tediApprovalRequests.payload, ["execution", "status"])}, '') NOT IN ('executed', 'failed')))`,
			),
		)
		.limit(1);
	return request;
}
