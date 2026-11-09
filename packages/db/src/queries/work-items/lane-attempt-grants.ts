import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import { WorkControlError } from "./factory-validation";

/** Admission adds one Attempt to the lane budget for each of these events. */
export const LANE_ATTEMPT_GRANTED = "lane.attempt_granted";

/**
 * Record an owner's grant of one extra lane Attempt, replacing one failed or
 * expired Attempt of the same open Work. The event row is the audit record:
 * who granted it, why, and which Attempt it replaces. Each Attempt can be
 * replaced once, so a grant never raises the budget by more than one.
 */
export async function grantLaneAttempt(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		workItemId: string;
		attemptId: string;
		userId: string;
		reason: string;
		now: string;
	},
) {
	const [grant] = await db
		.insert(workEvents)
		.select(
			db
				.select({
					id: sql<string>`${p.id}`.as("id"),
					orgId: workAttempts.orgId,
					workItemId: workAttempts.workItemId,
					attemptId: sql<string>`${workAttempts.id}`.as("attempt_id"),
					eventType: sql<string>`${LANE_ATTEMPT_GRANTED}`.as("event_type"),
					actorType: sql<string>`'user'`.as("actor_type"),
					actorId: sql<string>`${p.userId}`.as("actor_id"),
					payload:
						sql<string>`json_object('reason', ${p.reason}, 'workItemVersion', ${workItems.version})`.as(
							"payload",
						),
					occurredAt: sql<string>`${p.now}`.as("occurred_at"),
				})
				.from(workAttempts)
				.innerJoin(
					workItems,
					and(
						eq(workItems.orgId, workAttempts.orgId),
						eq(workItems.id, workAttempts.workItemId),
					),
				)
				.where(
					and(
						eq(workAttempts.orgId, p.orgId),
						eq(workAttempts.workItemId, p.workItemId),
						eq(workAttempts.id, p.attemptId),
						sql`${workAttempts.outcome} IN ('failed','expired')`,
						sql`${workItems.disposition} NOT IN ('completed','cancelled')`,
						sql`NOT EXISTS (SELECT 1 FROM work_events e WHERE e.org_id = ${p.orgId} AND e.attempt_id = ${p.attemptId} AND e.event_type = ${LANE_ATTEMPT_GRANTED})`,
					),
				),
		)
		.returning({
			id: workEvents.id,
			attemptId: workEvents.attemptId,
			occurredAt: workEvents.occurredAt,
		});
	if (!grant)
		throw new WorkControlError(
			"CONFLICT",
			"Only a failed or expired Attempt of open Work can be replaced, and only once",
		);
	return { ...grant, workItemId: p.workItemId, reason: p.reason };
}
