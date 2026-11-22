import { WorkAttemptSettlementSchema } from "@tedix/api-contract/schemas/work-items";
import {
	RepositoryEventSchema,
	RepositoryObserverConfigSchema,
} from "@tedix/api-contract/schemas/repository-observer";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { withoutNegatedClauses } from "@tedix/api-contract/utils/work-instructions";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { findWorkImplementationPushes } from "@tedix/db/queries/repository-observer";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";
import { verifiedActiveWorkActor } from "../work-items-principal";
import { ownAttemptCompletionProblem } from "./policy-helpers";
import { hasRecoveredCommitCustody } from "./recovered-commit-custody";

export async function verifiedImplementationCloseout(
	context: BaseContext,
	item: WorkItem,
) {
	if (
		item.disposition !== "accepted" ||
		item.workKind !== "design" ||
		!["low", "medium"].includes(item.riskLevel) ||
		item.requiredAuthorities?.length ||
		!item.acceptanceContract?.doneLooksLike
	)
		return null;
	const scope = withoutNegatedClauses(
		`${item.title}\n${item.acceptanceContract.doneLooksLike}`,
	);
	// The only write this path performs is Work closeout. Code implementing a
	// publish feature can ship while live publication keeps its own approval.
	const implementation =
		/^(?:implement|enable|build|add|fix|ship|support)\b/i.test(
			item.title.trim(),
		);
	if (
		humanReservedActionClasses(scope).some(
			(action) => action !== "public_publish" || !implementation,
		)
	)
		return null;

	const actor = await verifiedActiveWorkActor(context, item.orgId);
	if (
		actor.type !== "external_agent" ||
		!actor.sessionId ||
		!actor.externalSessionKey
	)
		return null;
	const {
		data: [attempt],
	} = await listWorkItemAttempts(context.db, {
		orgId: item.orgId,
		workItemId: item.id,
		limit: 1,
	});
	if (
		!attempt ||
		attempt.executorType !== "external_agent" ||
		attempt.executorId !== actor.id ||
		attempt.executorSessionId !== actor.sessionId ||
		attempt.externalSessionKey !== actor.externalSessionKey ||
		attempt.runtimeState !== "finished" ||
		attempt.outcome !== "succeeded" ||
		!attempt.finishedAt
	)
		return null;

	const proof = WorkAttemptSettlementSchema.safeParse(
		attempt.metadata.settlement,
	);
	if (!proof.success || proof.data.mode !== "commit") return null;
	if (
		(await ownAttemptCompletionProblem(
			context,
			{ ...item, workKind: "coding" },
			attempt,
		)) ||
		!(await hasRecoveredCommitCustody(context, attempt))
	)
		return null;

	const observations = await findWorkImplementationPushes(context.db, {
		orgId: item.orgId,
		workItemId: item.id,
		commitShas: proof.data.commitShas,
		since: attempt.startedAt,
	});
	for (const row of observations) {
		const event = RepositoryEventSchema.safeParse(row.metadata?.event);
		if (
			!event.success ||
			event.data.kind !== "push" ||
			!row.projectId ||
			!event.data.summary
				.split("\n")
				.some(
					(line) =>
						line.trim() === `Agent-Session: ${actor.externalSessionKey}`,
				)
		)
			continue;
		const project = await getProjectByIdForOrganization(
			context.db,
			item.orgId,
			row.projectId,
		);
		const observer = RepositoryObserverConfigSchema.safeParse(
			project?.metadata?.repositoryObserver,
		);
		if (
			project?.status !== "active" ||
			!observer.success ||
			observer.data.repository !== event.data.repository ||
			observer.data.branch !== "main"
		)
			continue;
		const { observerId } =
			await import("../../../services/repository-observer");
		const identity = await observerId(
			`${item.orgId}:${row.projectId}:${event.data.repository}:${event.data.sha}:push:${event.data.surface}`,
		);
		if (row.id === identity)
			return {
				actor,
				attemptId: attempt.id,
				observationId: row.id,
				commit: event.data.sha,
			};
	}
	return null;
}
