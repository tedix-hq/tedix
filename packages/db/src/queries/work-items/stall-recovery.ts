import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

export interface ContinuityScope {
	key: string;
	id: string;
	orgId: string;
	kind: "project" | "objective";
	name: string;
	policy: string | null;
	createdAt: string;
	tediId: string | null;
	slug: string | null;
	hasOwner: number;
	lastActivityAt: string;
	pendingCount: number;
	failedCount: number;
}

/**
 * Materialize the bounded scope page and its Work once. Correlated history
 * scans per scope saturated D1 when Attention polling repeated this inventory.
 * All activity/ownership joins retain the scope's tenant.
 */
export async function listContinuityScopes(
	db: DbClient,
	after = "",
	orgId?: string,
	environment = "production",
): Promise<ContinuityScope[]> {
	return db.all<ContinuityScope>(sql`
 WITH scopes AS (
 SELECT 'project:' || p.id AS key, p.id, p.org_id AS orgId, 'project' AS kind, p.name,
 CASE WHEN json_type(p.metadata, '$.continuity') = 'object' THEN json_extract(p.metadata, '$.continuity') END AS policy, p.created_at AS createdAt,
 coalesce(p.lead_tedi_id, o.tedi_id) AS owner, p.objective_id AS objectiveId
 FROM projects p LEFT JOIN tedi_objectives o ON o.id = p.objective_id AND o.org_id = p.org_id AND o.status = 'active'
 WHERE p.status = 'active'
 UNION ALL
 SELECT 'objective:' || o.id, o.id, o.org_id, 'objective', o.title,
 CASE WHEN json_type(o.gate_config, '$.continuity') = 'object' THEN json_extract(o.gate_config, '$.continuity') END, o.created_at,
 o.tedi_id, o.id
 FROM tedi_objectives o WHERE o.status = 'active'
 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.org_id AND p.objective_id = o.id AND p.status = 'active')
 ), page AS MATERIALIZED (
 SELECT * FROM scopes WHERE key > ${after} AND (${orgId ?? null} IS NULL OR orgId = ${orgId ?? null}) ORDER BY key LIMIT 100
 ), scope_work AS MATERIALIZED (
 SELECT s.key, w.id AS workItemId, w.org_id AS orgId, w.disposition
 FROM page s JOIN work_items w ON w.org_id = s.orgId AND w.project_id = s.id WHERE s.kind = 'project'
 UNION ALL
 SELECT s.key, w.id, w.org_id, w.disposition
 FROM page s JOIN work_items w ON w.org_id = s.orgId AND w.objective_id = s.id WHERE s.kind = 'objective'
 ), work_counts AS (
 SELECT key, sum(disposition IN ('proposed','accepted')) AS pendingCount FROM scope_work GROUP BY key
 ), attempt_activity AS MATERIALIZED (
 SELECT w.key, max(julianday(coalesce(a.finished_at, a.heartbeat_at, a.started_at))) AS activity,
 sum(a.outcome = 'failed' AND w.disposition NOT IN ('completed','cancelled')) AS failedCount
 FROM scope_work w JOIN work_attempts a ON a.work_item_id = w.workItemId AND a.org_id = w.orgId GROUP BY w.key
 ), activity AS (
 SELECT key, activity FROM attempt_activity
 UNION ALL
 SELECT s.key, max(julianday(l.last_event_at)) FROM page s JOIN work_agent_sessions l
 ON l.organization_id = s.orgId AND l.project_id = s.id WHERE s.kind = 'project' GROUP BY s.key
 UNION ALL
 SELECT w.key, max(julianday(CASE WHEN r.status IN ('completed','failed','canceled') THEN coalesce(r.completed_at, r.started_at) ELSE coalesce(r.last_reconciled_at, r.started_at) END))
 FROM scope_work w JOIN skill_runs r ON r.work_item_id = w.workItemId AND r.organization_id = w.orgId
 WHERE r.runtime_environment = ${environment} GROUP BY w.key
 UNION ALL
 SELECT s.key, max(julianday(coalesce(g.completed_at, g.created_at)))
 FROM page s JOIN os_workspace_projects p ON p.organization_id = s.orgId AND p.project_id = s.id AND p.status = 'active'
 JOIN os_gadget_executions g ON g.organization_id = p.organization_id AND g.workspace_id = p.workspace_id
 WHERE s.kind = 'project' AND g.runtime_environment = ${environment} GROUP BY s.key
 UNION ALL
 SELECT s.key, max(julianday(coalesce(k.updated_at, k.created_at)))
 FROM page s JOIN tedi_tasks k ON k.org_id = s.orgId AND k.objective_id = s.objectiveId GROUP BY s.key
 ), latest_activity AS (
 SELECT key, max(activity) AS activity FROM activity GROUP BY key
 )
 SELECT s.key, s.id, s.orgId, s.kind, s.name, s.policy, strftime('%Y-%m-%dT%H:%M:%fZ', s.createdAt) AS createdAt,
 coalesce(t.id, c.id) AS tediId, coalesce(t.slug, c.slug) AS slug, (t.id IS NOT NULL) AS hasOwner,
 strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(s.createdAt), coalesce(l.activity, julianday(s.createdAt)))) AS lastActivityAt,
 coalesce(w.pendingCount, 0) AS pendingCount, coalesce(a.failedCount, 0) AS failedCount
 FROM page s LEFT JOIN tedis t ON t.id = s.owner AND t.organization_id = s.orgId AND t.status = 'active'
 LEFT JOIN tedis c ON c.id = json_extract(s.policy, '$.coordinatorTediId') AND c.organization_id = s.orgId AND c.status = 'active'
 LEFT JOIN latest_activity l ON l.key = s.key
 LEFT JOIN work_counts w ON w.key = s.key
 LEFT JOIN attempt_activity a ON a.key = s.key
 ORDER BY s.key
 `);
}

/** Count canonical completed Work, not model turns or heartbeat traffic. */
export async function countContinuityResults(
	db: DbClient,
	scope: ContinuityScope,
	start: string,
	end: string,
): Promise<number> {
	const [row] = await db.all<{ count: number }>(
		sql`SELECT count(*) AS count FROM work_items w WHERE w.org_id = ${scope.orgId} AND w.disposition = 'completed' AND w.completed_at >= ${start} AND w.completed_at < ${end} AND ((${scope.kind} = 'project' AND w.project_id = ${scope.id}) OR (${scope.kind} = 'objective' AND w.objective_id = ${scope.id}))`,
	);
	return Number(row?.count ?? 0);
}

export async function getStallReceipt(
	db: DbClient,
	orgId: string,
	clientEventId: string,
) {
	const [row] = await db.all<{ occurredAt: string }>(
		sql`SELECT occurred_at AS occurredAt FROM learning_interaction_events WHERE organization_id = ${orgId} AND client_event_id = ${clientEventId} AND surface = 'stall_recovery' AND event_kind = 'delivered' AND actor_type = 'service' AND actor_id = 'stall-recovery' LIMIT 1`,
	);
	return row ?? null;
}

/** Latest accepted recovery per scope, batched below D1's parameter limit. */
export async function listStallReceipts(
	db: DbClient,
	orgId: string,
	keys: string[],
	environment: string,
) {
	const rows: Array<{
		key: string;
		requestKey: string;
		tediId: string | null;
		occurredAt: string;
	}> = [];
	for (let at = 0; at < keys.length; at += 50) {
		const chunk = keys.slice(at, at + 50);
		rows.push(
			...(await db.all<{
				key: string;
				requestKey: string;
				tediId: string | null;
				occurredAt: string;
			}>(sql`
   WITH receipts AS (
    SELECT target_type || ':' || target_id AS key, client_event_id AS requestKey, tedi_id AS tediId, occurred_at AS occurredAt,
    row_number() OVER (PARTITION BY target_type, target_id ORDER BY occurred_at DESC, id DESC) AS position
    FROM learning_interaction_events
    WHERE organization_id = ${orgId} AND surface = 'stall_recovery' AND event_kind = 'delivered' AND json_extract(metadata, '$.environment') = ${environment} AND actor_type = 'service' AND actor_id = 'stall-recovery'
    AND target_type || ':' || target_id IN (${sql.join(
			chunk.map((key) => sql`${key}`),
			sql`, `,
		)})
   ) SELECT key, requestKey, tediId, occurredAt FROM receipts WHERE position = 1
  `)),
		);
	}
	return rows;
}

export async function hasContinuityFix(
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
	const [row] = await db.all(
		sql`SELECT id FROM learning_improvement_proposals WHERE organization_id = ${orgId} AND client_proposal_id = ${issueKey} LIMIT 1`,
	);
	return !!row;
}

/** Only the viewer's explicit open decisions; never another person's session capture. */
export async function listContinuityHumanAsks(
	db: DbClient,
	orgId: string,
	userId: string,
	now: string,
) {
	return db.all<{
		id: string;
		need: string;
		projectId: string | null;
		objectiveId: string | null;
		creatorId: string;
	}>(sql`
 SELECT i.id, coalesce(a.need, json_extract(i.metadata, '$.reason'), i.subject) AS need,
 coalesce(i.project_id, w.project_id) AS projectId, w.objective_id AS objectiveId, i.creator_id AS creatorId
 FROM work_interactions i LEFT JOIN work_items w ON w.id = i.work_item_id AND w.org_id = i.org_id
 LEFT JOIN work_interaction_attention a ON a.org_id = i.org_id AND a.interaction_id = i.id
 WHERE i.org_id = ${orgId} AND i.target_type = 'user' AND i.target_id = ${userId}
 AND i.status = 'open' AND (i.expires_at IS NULL OR i.expires_at > ${now})
 AND i.creator_type = 'tedi' AND a.kind IS NOT 'fyi'
 AND (i.kind <> 'coordination' OR (a.kind = 'needs_you' AND length(trim(a.need)) > 0))
 ORDER BY i.created_at, i.id LIMIT 200
 `);
}

/** Native detector incidents, independent of user/tedi feedback on the same issue. */
export async function listStallIncidents(
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
	return db.all<{ id: string }>(sql`
  SELECT id FROM learning_interaction_events
  WHERE organization_id = ${orgId} AND issue_key = ${issueKey}
   AND surface = 'stall_recovery' AND event_kind = 'retried'
   AND actor_type = 'service' AND actor_id = 'stall-recovery'
  ORDER BY occurred_at DESC, id DESC LIMIT 3
 `);
}
