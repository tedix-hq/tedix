import type { DbClient } from "@tedix/db/client";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";

/** Service-authenticated cleanup is limited to the owning tedi's marked scratch Work. */
export async function disposableCleanupApprover(
	db: DbClient,
	input: {
		orgId: string;
		tediId: string;
		actionType: string;
		payload: Record<string, unknown>;
	},
): Promise<string | null> {
	if (
		input.actionType !== "work_item.cleanup" ||
		input.payload.operation !== "cancel" ||
		typeof input.payload.workItemId !== "string"
	)
		return null;
	const work = await getWorkItemById(db, input.payload.workItemId, input.orgId);
	if (
		!work ||
		work.metadata?.disposable !== true ||
		!work.sourceSessionKey ||
		work.accountableOwnerType !== "tedi" ||
		work.accountableOwnerId !== input.tediId ||
		work.riskLevel !== "low"
	)
		return null;
	const attempts = await listWorkItemAttempts(db, {
		orgId: input.orgId,
		workItemId: work.id,
		limit: 1,
	});
	if (
		attempts.data.some(
			(attempt) =>
				!attempt.finishedAt &&
				(!attempt.expiresAt || !(Date.parse(attempt.expiresAt) <= Date.now())),
		)
	)
		return null;
	return input.tediId;
}
