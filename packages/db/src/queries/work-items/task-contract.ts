import { and, eq } from "drizzle-orm";
import { TaskContractTermsSchema } from "@tedix/api-contract/schemas/task-contract-terms";
import type { DbQueryClient } from "../../query-client";
import { workEvents, type WorkAttempt } from "../../schema/work-items";

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
	return event
		? TaskContractTermsSchema.parse(event.payload.taskContract)
		: null;
}
