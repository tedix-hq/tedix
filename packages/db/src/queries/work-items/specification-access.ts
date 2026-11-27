import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import {
	type WorkActorType,
	workEvents as d1WorkEvents,
} from "../../schema/work-items";

/** Creation authority comes from the append-only server ledger, not provenance. */
export async function workItemCreatedByActor(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		actor: { type: WorkActorType; id: string };
	},
): Promise<boolean> {
	const workEvents = coreTable(db, d1WorkEvents);
	const rows = await db
		.select({ id: workEvents.id })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, input.orgId),
				eq(workEvents.workItemId, input.workItemId),
				eq(workEvents.eventType, "work.created"),
				eq(workEvents.actorType, input.actor.type),
				eq(workEvents.actorId, input.actor.id),
			),
		)
		.limit(1);
	return rows.length === 1;
}

export async function isWorkItemCreator(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		userId: string;
	},
): Promise<boolean> {
	return workItemCreatedByActor(db, {
		orgId: input.orgId,
		workItemId: input.workItemId,
		actor: { type: "user", id: input.userId },
	});
}
