import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../client";
import { workItems } from "../../schema/work-items";
import { chunkForBoundParams } from "../../utils/batch";

export async function hasProjectWorkItemReference(
	db: DbClient,
	params: { orgId: string; projectId: string; ids: string[] },
): Promise<boolean> {
	for (const ids of chunkForBoundParams(params.ids, 50)) {
		const rows = await db
			.select({ id: workItems.id })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					eq(workItems.projectId, params.projectId),
					inArray(workItems.id, ids),
				),
			)
			.limit(1);
		if (rows.length) return true;
	}
	return false;
}
