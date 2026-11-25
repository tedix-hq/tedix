import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workItems as d1WorkItems } from "../../schema/work-items";

import { coreTable } from "../../core-store/client";
import { anyIds, coreStore } from "../../core-store/dialect";

export async function hasProjectWorkItemReference(
	db: DbQueryClient,
	params: { orgId: string; projectId: string; ids: string[] },
): Promise<boolean> {
	const workItems = coreTable(db, d1WorkItems);
	if (params.ids.length === 0) return false;
	// Discovery responses contain thousands of unrelated tool IDs. Bind the
	// candidate set once rather than serializing a D1 trip for every 50 IDs.
	// The unary `+` keeps the planner on the primary key: with plain
	// org/project equalities it scanned every Work Item of the review project
	// for each call (up to ~5k rows; 3.4M rows in 2 h on 21 Nov 2026), while a
	// key probe per candidate reads only the rows that exist.
	const rows = await db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				anyIds(db, workItems.id, params.ids),
				coreStore(db) === "d1"
					? sql`+${workItems.orgId} = ${params.orgId}`
					: eq(workItems.orgId, params.orgId),
				coreStore(db) === "d1"
					? sql`+${workItems.projectId} = ${params.projectId}`
					: eq(workItems.projectId, params.projectId),
			),
		)
		.limit(1);
	return rows.length > 0;
}
