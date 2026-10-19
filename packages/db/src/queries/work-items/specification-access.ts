import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workEvents } from "../../schema/work-items";

/** Creation authority comes from the append-only server ledger, not provenance. */
export async function isWorkItemCreator(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		userId: string;
	},
): Promise<boolean> {
	const rows = await db
		.select({ id: workEvents.id })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, input.orgId),
				eq(workEvents.workItemId, input.workItemId),
				eq(workEvents.eventType, "work.created"),
				eq(workEvents.actorType, "user"),
				eq(workEvents.actorId, input.userId),
			),
		)
		.limit(1);
	return rows.length === 1;
}
