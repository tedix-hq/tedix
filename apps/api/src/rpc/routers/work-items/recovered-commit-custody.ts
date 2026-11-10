import { getRecordedWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import type { WorkAttempt } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

/** Recovery receipts name custody; the recorded Attempt must actually hold it. */
export async function hasRecoveredCommitCustody(
	context: BaseContext,
	attempt: WorkAttempt,
	metadata = attempt.metadata,
): Promise<boolean> {
	const recovered = metadata.recoveredCommits;
	if (recovered === undefined) return true;
	if (!Array.isArray(recovered) || recovered.length === 0) return false;
	const settlement = metadata.settlement;
	if (
		!settlement ||
		typeof settlement !== "object" ||
		Array.isArray(settlement)
	)
		return false;
	for (const row of recovered) {
		if (
			!row ||
			typeof row !== "object" ||
			Array.isArray(row) ||
			typeof row.commitSha !== "string" ||
			!/^[a-f\d]{40}$/i.test(row.commitSha) ||
			typeof row.attemptId !== "string" ||
			typeof row.session !== "string" ||
			(settlement.commitSha !== row.commitSha &&
				!(
					Array.isArray(settlement.commitShas) &&
					settlement.commitShas.includes(row.commitSha)
				))
		)
			return false;
		const original = await getRecordedWorkItemAttempt(context.db, {
			orgId: attempt.orgId,
			workItemId: attempt.workItemId,
			attemptId: row.attemptId,
		});
		if (
			!original ||
			!original.admissionId ||
			original.executorType !== "external_agent" ||
			original.externalSessionKey !== row.session ||
			!(Date.parse(original.startedAt) <= Date.parse(attempt.startedAt)) ||
			(original.id !== attempt.id &&
				!["failed", "expired", "succeeded"].includes(original.outcome ?? ""))
		)
			return false;
	}
	return true;
}
