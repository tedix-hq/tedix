import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workItems } from "../../schema/work-items";

export async function hasProjectWorkItemReference(
	db: DbQueryClient,
	params: { orgId: string; projectId: string; ids: string[] },
): Promise<boolean> {
	if (params.ids.length === 0) return false;
	// Discovery responses contain thousands of unrelated tool IDs. Bind the
	// candidate set once rather than serializing a D1 trip for every 50 IDs.
	const rows = await db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.projectId, params.projectId),
				sql`${workItems.id} IN (SELECT value FROM json_each(${JSON.stringify(params.ids)}))`,
			),
		)
		.limit(1);
	return rows.length > 0;
}
