import { and, asc, eq, gt, inArray, max, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { type WorkEvent, workEvents } from "../../schema/work-items";
export async function listWorkItemEvents(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		afterSequence?: number;
		limit?: number;
	},
): Promise<WorkEvent[]> {
	return db
		.select()
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, params.orgId),
				eq(workEvents.workItemId, params.workItemId),
				params.afterSequence === undefined
					? sql`1`
					: gt(workEvents.sequence, params.afterSequence),
			),
		)
		.orderBy(asc(workEvents.sequence))
		.limit(params.limit ?? 100);
}

/** Ledger rows projected as the `work.item.state_changed` MCP event. */
export const WORK_STATE_CHANGE_EVENT_TYPES = [
	"work.accepted",
	"work.completed",
	"work.cancelled",
	"attempt.settled",
] as const;

export type WorkStateChangeEventRow = Pick<
	WorkEvent,
	"sequence" | "id" | "workItemId" | "attemptId" | "eventType" | "occurredAt"
> & { outcome: string | null };

/**
 * Org-scoped keyset read of Work state changes after a ledger sequence. The
 * caller exposes `sequence` as an opaque cursor; payload text (summaries,
 * cancel reasons) never leaves this query.
 */
export async function listWorkStateChangeEvents(
	db: DbQueryClient,
	params: {
		orgId: string;
		afterSequence: number;
		workItemId?: string;
		limit: number;
	},
): Promise<WorkStateChangeEventRow[]> {
	return db
		.select({
			sequence: workEvents.sequence,
			id: workEvents.id,
			workItemId: workEvents.workItemId,
			attemptId: workEvents.attemptId,
			eventType: workEvents.eventType,
			occurredAt: workEvents.occurredAt,
			outcome: sql<
				string | null
			>`json_extract(${workEvents.payload}, '$.outcome')`.as("outcome"),
		})
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, params.orgId),
				gt(workEvents.sequence, params.afterSequence),
				inArray(workEvents.eventType, [...WORK_STATE_CHANGE_EVENT_TYPES]),
				params.workItemId
					? eq(workEvents.workItemId, params.workItemId)
					: undefined,
			),
		)
		.orderBy(asc(workEvents.sequence))
		.limit(params.limit);
}

/** The org's current ledger head, used to start a poll "from now". */
export async function getWorkEventHeadSequence(
	db: DbQueryClient,
	orgId: string,
): Promise<number> {
	const [row] = await db
		.select({ head: max(workEvents.sequence) })
		.from(workEvents)
		.where(eq(workEvents.orgId, orgId));
	return row?.head ?? 0;
}
