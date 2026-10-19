import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";

export async function getTodayProjectTotals(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		personId: string;
		since: string;
		until: string;
		excludeOutputId: string;
	},
) {
	const rows = await db.all<{
		decisions: number;
		documents: number;
		lastTouched: string | null;
		receiptsJson: string;
	}>(sql`
		WITH requests AS (
			SELECT i.* FROM work_interactions i
			LEFT JOIN work_items w ON w.id=i.work_item_id AND w.org_id=i.org_id
			WHERE i.org_id=${p.orgId} AND coalesce(i.project_id,w.project_id)=${p.projectId}
			AND i.target_type='user' AND i.target_id=${p.personId}
		), documents AS (
			SELECT DISTINCT o.id, o.title, strftime('%Y-%m-%dT%H:%M:%fZ',o.updated_at) AS updated_at FROM os_outputs o
			JOIN os_workspace_projects l ON l.workspace_id=o.workspace_id AND l.organization_id=o.organization_id
			JOIN os_workspaces s ON s.id=l.workspace_id AND s.organization_id=l.organization_id
			WHERE o.organization_id=${p.orgId} AND l.project_id=${p.projectId} AND l.status='active'
			AND o.id<>${p.excludeOutputId} AND s.visibility='org' AND s.status='active' AND o.kind='document' AND o.status='active'
		), approvals AS (
			SELECT a.* FROM work_approval_proposals a
			JOIN work_items w ON w.id=a.work_item_id AND w.org_id=a.org_id
			WHERE a.org_id=${p.orgId} AND w.project_id=${p.projectId}
			AND a.approver_type='user' AND a.approver_id=${p.personId}
		)
		SELECT
			(SELECT count(*) FROM requests WHERE status='resolved' AND kind IN ('question','input') AND julianday(resolved_at)>=julianday(${p.since}) AND julianday(resolved_at)<julianday(${p.until}))
			+ (SELECT count(*) FROM approvals WHERE status IN ('approved','rejected') AND julianday(resolved_at)>=julianday(${p.since}) AND julianday(resolved_at)<julianday(${p.until})) AS decisions,
			(SELECT count(*) FROM documents WHERE updated_at>=${p.since} AND updated_at<${p.until}) AS documents,
			(SELECT json_group_array(json_object('id',id,'title',title,'at',updated_at,'source','/outputs/'||id)) FROM documents WHERE updated_at>=${p.since} AND updated_at<${p.until}) AS receiptsJson,
			(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',max(julianday(at))) FROM (SELECT created_at AS at FROM requests UNION ALL SELECT resolved_at FROM requests UNION ALL SELECT updated_at FROM documents UNION ALL SELECT created_at FROM approvals)) AS lastTouched
	`);
	return rows[0]!;
}
