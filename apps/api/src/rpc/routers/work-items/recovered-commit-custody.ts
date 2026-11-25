import { createCommitResolver } from "@tedix/db/queries/git-commit-aliases";
import {
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
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
	const settlementCommits = workSettlementCommits(
		WorkAttemptSettlementSchema.safeParse(metadata.settlement).data,
	);
	if (!settlementCommits.length) return false;
	const rows: { commitSha: string; attemptId: string; session: string }[] = [];
	for (const row of recovered) {
		if (
			!row ||
			typeof row !== "object" ||
			Array.isArray(row) ||
			typeof row.commitSha !== "string" ||
			!/^[a-f\d]{40}$/i.test(row.commitSha) ||
			typeof row.attemptId !== "string" ||
			typeof row.session !== "string"
		)
			return false;
		rows.push({
			commitSha: row.commitSha,
			attemptId: row.attemptId,
			session: row.session,
		});
	}
	const resolved = await createCommitResolver(context.db).resolveMany([
		...settlementCommits,
		...rows.map((row) => row.commitSha),
	]);
	const commits = new Set(resolved.slice(0, settlementCommits.length));
	for (const [index, row] of rows.entries()) {
		if (!commits.has(resolved[settlementCommits.length + index]!)) return false;
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
