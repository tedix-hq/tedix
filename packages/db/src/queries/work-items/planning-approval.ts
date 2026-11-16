import { sql } from "drizzle-orm";
import { workItems, type WorkItem } from "../../schema/work-items";
import { workApprovalProposals } from "../../schema/work-factory";

type ApprovalWork = Pick<
	WorkItem,
	"orgId" | "id" | "version" | "admissionSpecRevision"
>;

/** Only the specification writer emits this server-owned continuity receipt. */
export function planningApprovalVersion(item: ApprovalWork | typeof workItems) {
	return sql<number>`COALESCE((
		SELECT json_extract(e.payload, '$.planningApproval.fromVersion')
		FROM work_events e
		WHERE e.org_id=${item.orgId} AND e.work_item_id=${item.id}
		AND e.event_type='work.specification_updated'
		AND json_extract(e.payload, '$.planningApproval.toVersion')=${item.version}
		AND json_extract(e.payload, '$.planningApproval.admissionSpecRevision')=${item.admissionSpecRevision}
		ORDER BY e.sequence DESC LIMIT 1
	), ${item.version})`;
}

/** Exact reviewed version, or a receipt spanning only planning updates. */
export function matchesWorkApprovalVersion(
	item: ApprovalWork | typeof workItems,
) {
	return sql`(${workApprovalProposals.workItemVersion} BETWEEN ${planningApprovalVersion(item)} AND ${item.version})`;
}
