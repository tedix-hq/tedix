import { and, eq } from "drizzle-orm";
import { assertChildTaskContract } from "@tedix/api-contract/utils/task-contract-terms";
import { TaskContractTermsSchema } from "@tedix/api-contract/schemas/task-contract-terms";
import type { DbQueryClient } from "../../query-client";
import {
	workEvents,
	workAttempts,
	type WorkItem,
	type WorkAttempt,
} from "../../schema/work-items";

/** Admission evidence is the source of truth, never caller-supplied Attempt metadata. */
export async function getAdmittedTaskContract(
	db: DbQueryClient,
	attempt: Pick<WorkAttempt, "orgId" | "workItemId" | "admissionId">,
) {
	if (!attempt.admissionId) return null;
	const [event] = await db
		.select({ payload: workEvents.payload })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.id, attempt.admissionId),
				eq(workEvents.orgId, attempt.orgId),
				eq(workEvents.workItemId, attempt.workItemId),
				eq(workEvents.eventType, "admission.task_contract"),
			),
		)
		.limit(1);
	const parsed = TaskContractTermsSchema.safeParse(event?.payload.taskContract);
	return parsed.success ? parsed.data : null;
}

/** Shared by admission and both readiness projections; reads never repair authority. */
export async function taskContractRefusal(
	db: DbQueryClient,
	item: WorkItem,
	now: string,
): Promise<string | undefined> {
	if (!item.metadata?.childDelegation && !item.acceptanceContract?.taskContract)
		return;
	const terms = TaskContractTermsSchema.safeParse(
		item.acceptanceContract?.taskContract,
	);
	if (!terms.success) return "Delegated Work requires a complete task contract";
	if (Date.parse(terms.data.deadline) <= Date.parse(now))
		return "Task deadline elapsed";
	if (!item.metadata?.childDelegation) return;
	const grant = item.metadata.childDelegation as { parentAttemptId?: string };
	const [attempt] = await db
		.select()
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.id, grant.parentAttemptId ?? ""),
				eq(workAttempts.orgId, item.orgId),
				eq(workAttempts.workItemId, item.parentWorkItemId ?? ""),
			),
		)
		.limit(1);
	const parent = attempt && (await getAdmittedTaskContract(db, attempt));
	if (!parent) return "Parent has no admitted task contract";
	try {
		assertChildTaskContract(parent, terms.data);
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid task contract";
	}
	const [allocation] = await db
		.select({ payload: workEvents.payload })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.id, item.id),
				eq(workEvents.orgId, item.orgId),
				eq(workEvents.workItemId, item.id),
			),
		)
		.limit(1);
	const allocated = TaskContractTermsSchema.safeParse(
		allocation?.payload.taskContract,
	);
	if (!allocated.success)
		return "Child has no task contract allocation; recreate it under an admitted parent";
	if (
		terms.data.budget.maxTokens > allocated.data.budget.maxTokens ||
		terms.data.budget.maxCostUsd > allocated.data.budget.maxCostUsd
	)
		return "Child task budget exceeds its delegation allocation";
}
