import { eq, isNull, ne, or, sql } from "drizzle-orm";
import { workItems } from "../../schema/work-items";

/** Person-owned work belongs to its owner or a requested recipient; team work is shared. */
export function personalWorkFeedPredicate(personId: string) {
	return or(
		isNull(workItems.accountableOwnerType),
		ne(workItems.accountableOwnerType, "user"),
		eq(workItems.accountableOwnerId, personId),
		sql`EXISTS (SELECT 1 FROM work_interactions AS needed WHERE needed.org_id = ${workItems.orgId} AND needed.work_item_id = ${workItems.id} AND needed.target_type = 'user' AND needed.target_id = ${personId})`,
	);
}
