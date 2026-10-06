import { and, asc, eq, gt, sql } from "drizzle-orm";
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
