import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";

export interface CommitmentChange {
	key: string;
	orgId: string;
	tediId: string;
	slug: string;
	kind: "work" | "approval" | "interaction" | "factory_run";
	objectId: string;
	state: string;
	changedAt: string;
}

/** Global scheduler read; each row joins its active tedi in the same tenant. */
export async function listCommitmentChanges(
	db: DbClient,
	after: string,
	through: string,
	environment: string,
): Promise<CommitmentChange[]> {
	// D1 rejects the eight-term compound scan; keep each statement to four terms.
	const statements = [
		sql`
		WITH recent_work_events AS MATERIALIZED (
			SELECT * FROM work_events
			WHERE occurred_at > ${after} AND occurred_at <= ${through}
		), resolved_work_approvals AS MATERIALIZED (
			SELECT * FROM work_approval_proposals WHERE resolved_at > ${after} AND resolved_at <= ${through}
		), resolved_tedi_approvals AS MATERIALIZED (
			SELECT * FROM tedi_approval_requests WHERE resolved_at > ${after} AND resolved_at <= ${through}
		), changes AS (
			SELECT 'work:' || e.id AS key, w.org_id AS orgId, t.id AS tediId, t.slug,
				'work' AS kind, w.id AS objectId,
				CASE WHEN e.event_type = 'attempt.settled' THEN json_extract(e.payload, '$.outcome') ELSE e.event_type END AS state,
				e.occurred_at AS changedAt
			FROM recent_work_events e JOIN work_items w ON w.id = e.work_item_id AND w.org_id = e.org_id
			JOIN tedis t ON t.organization_id = w.org_id AND t.status = 'active'
				AND ((w.accountable_owner_type = 'tedi' AND w.accountable_owner_id = t.id)
				OR (w.steward_type = 'tedi' AND w.steward_id = t.id)
				OR EXISTS (SELECT 1 FROM projects p WHERE p.org_id = w.org_id AND p.id = w.project_id AND p.lead_tedi_id = t.id)
				OR EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id = w.org_id AND a.work_item_id = w.id AND a.executor_type = 'tedi' AND a.executor_id = t.id))
			WHERE w.disposition != 'cancelled'
				AND (w.disposition != 'completed' OR (
					e.event_type = 'attempt.settled' AND e.actor_type = 'external_agent'
					AND json_extract(e.payload, '$.outcome') = 'succeeded'))
				AND NOT (e.actor_type = 'tedi' AND e.actor_id = t.id)
				AND (e.event_type IN ('work.accepted', 'work.specification_updated', 'attempt.expired', 'lane.stale')
					OR (e.event_type = 'attempt.settled' AND (
						json_extract(e.payload, '$.outcome') = 'failed'
						OR (e.actor_type = 'external_agent' AND json_extract(e.payload, '$.outcome') = 'succeeded'))))
			UNION ALL
			SELECT 'approval:' || p.id || ':' || p.version, p.org_id, t.id, t.slug,
				'approval', p.id, p.status, p.resolved_at
			FROM resolved_work_approvals p JOIN work_approval_decisions d ON d.proposal_id = p.id
			JOIN tedis t ON t.organization_id = p.org_id AND t.status = 'active' AND p.requester_type = 'tedi' AND p.requester_id = t.id
			JOIN work_items w ON w.id = p.work_item_id AND w.org_id = p.org_id
			WHERE p.resolved_at > ${after} AND p.resolved_at <= ${through} AND p.status IN ('approved', 'rejected')
				AND w.disposition NOT IN ('completed', 'cancelled') AND NOT (d.decider_type = 'tedi' AND d.decider_id = t.id)
			UNION ALL
			SELECT 'tedi-approval:' || p.id || ':' || p.status, p.org_id, t.id, t.slug,
				'approval', p.id, p.status, p.resolved_at
			FROM resolved_tedi_approvals p JOIN tedis t ON t.id = p.tedi_id AND t.organization_id = p.org_id AND t.status = 'active'
			WHERE p.resolved_at > ${after} AND p.resolved_at <= ${through} AND p.resolved_by != t.id AND p.status IN ('approved', 'rejected') AND p.workflow_id IS NULL
		)
		SELECT DISTINCT key, orgId, tediId, slug, kind, objectId, state, changedAt FROM changes
	`,
		sql`
		WITH recent_responses AS MATERIALIZED (
			SELECT * FROM work_interaction_responses WHERE responded_at > ${after} AND responded_at <= ${through}
		), overdue_interactions AS MATERIALIZED (
			SELECT * FROM work_interactions WHERE due_at > ${after} AND due_at <= ${through}
		), completed_gadgets AS MATERIALIZED (
			SELECT * FROM os_gadget_executions WHERE completed_at > ${after} AND completed_at <= ${through}
		), completed_skills AS MATERIALIZED (
			SELECT * FROM skill_runs WHERE completed_at > ${after} AND completed_at <= ${through}
		), changes AS (
			SELECT 'interaction:' || r.id AS key, i.org_id AS orgId, t.id AS tediId, t.slug,
				'interaction' AS kind, i.id AS objectId, 'answered' AS state, r.responded_at AS changedAt
			FROM recent_responses r JOIN work_interactions i ON i.id = r.interaction_id AND i.org_id = r.org_id
			JOIN tedis t ON t.organization_id = i.org_id AND t.status = 'active' AND i.creator_type = 'tedi' AND i.creator_id = t.id
			WHERE r.responded_at > ${after} AND r.responded_at <= ${through} AND r.resolves_request = 1
				AND NOT (r.responder_type = 'tedi' AND r.responder_id = t.id)
				AND (i.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.id = i.work_item_id AND w.org_id = i.org_id AND w.disposition NOT IN ('completed', 'cancelled')))
			UNION ALL
			SELECT 'interaction-overdue:' || i.id || ':' || i.due_at, i.org_id, t.id, t.slug,
				'interaction', i.id, 'overdue', i.due_at
			FROM overdue_interactions i JOIN tedis t ON t.organization_id = i.org_id AND t.status = 'active' AND i.creator_type = 'tedi' AND i.creator_id = t.id
			WHERE i.status = 'open' AND i.due_at > ${after} AND i.due_at <= ${through}
				AND (i.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.id = i.work_item_id AND w.org_id = i.org_id AND w.disposition NOT IN ('completed', 'cancelled')))
			UNION ALL
			SELECT 'factory:' || g.id || ':' || g.status, g.organization_id, t.id, t.slug,
				'factory_run', g.id, g.status, g.completed_at
			FROM completed_gadgets g JOIN tedis t ON t.id = g.tedi_id AND t.organization_id = g.organization_id AND t.status = 'active'
			WHERE g.completed_at > ${after} AND g.completed_at <= ${through} AND g.status IN ('failed', 'completed')
				AND g.runtime_environment = ${environment}
				AND (g.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.id = g.work_item_id AND w.org_id = g.organization_id AND w.disposition NOT IN ('completed', 'cancelled')))
			UNION ALL
			SELECT 'skill:' || s.id || ':' || s.execution_epoch || ':' || s.status, s.organization_id, t.id, t.slug,
				'factory_run', s.id, s.status, s.completed_at
			FROM completed_skills s JOIN tedis t ON t.id = s.tedi_id AND t.organization_id = s.organization_id AND t.status = 'active'
			WHERE s.completed_at > ${after} AND s.completed_at <= ${through} AND s.status IN ('failed', 'completed') AND s.runtime_environment = ${environment}
				AND (s.work_item_id IS NOT NULL OR s.origin_tedi_run_id IS NOT NULL)
				AND NOT EXISTS (SELECT 1 FROM os_gadget_executions g WHERE g.run_id = s.id AND g.organization_id = s.organization_id AND g.runtime_environment = s.runtime_environment)
				AND (s.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.id = s.work_item_id AND w.org_id = s.organization_id AND w.disposition NOT IN ('completed', 'cancelled')))
		)
		SELECT DISTINCT key, orgId, tediId, slug, kind, objectId, state, changedAt FROM changes
	`,
		sql`
		WITH overdue_work AS MATERIALIZED (
			SELECT * FROM work_items WHERE deadline > ${after} AND deadline <= ${through}
			UNION ALL
			-- A plain OR lets SQLite scan every NULL deadline instead of seeking due_date.
			SELECT * FROM work_items INDEXED BY idx_work_items_due_date
			WHERE due_date > ${after} AND due_date <= ${through} AND deadline IS NULL
		), changes AS (
			SELECT 'overdue:' || w.id || ':' || coalesce(w.deadline, w.due_date) AS key, w.org_id AS orgId, t.id AS tediId, t.slug,
				'work' AS kind, w.id AS objectId, 'overdue' AS state, coalesce(w.deadline, w.due_date) AS changedAt
			FROM overdue_work w JOIN tedis t ON t.organization_id = w.org_id AND t.status = 'active'
				AND w.accountable_owner_type = 'tedi' AND w.accountable_owner_id = t.id
			WHERE w.disposition NOT IN ('completed', 'cancelled')
		)
		SELECT DISTINCT key, orgId, tediId, slug, kind, objectId, state, changedAt FROM changes
		`,
	];
	const groups = await Promise.all(
		statements.map((statement) => db.all<CommitmentChange>(statement)),
	);
	return groups
		.flat()
		.sort(
			(a, b) =>
				a.changedAt.localeCompare(b.changedAt) || a.key.localeCompare(b.key),
		);
}

export async function lastCommitmentWakeCheckpoint(
	db: DbClient,
): Promise<string | null> {
	const [cursor] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, "commitment-wakes"))
		.limit(1);
	if (cursor) return cursor.through;
	const [row] = await db.all<{
		successful: string | null;
		firstFire: string | null;
	}>(
		sql`SELECT max(CASE WHEN status = 'success' THEN scheduled_at END) AS successful, min(scheduled_at) AS firstFire FROM platform_cron_executions WHERE schedule_id = 'commitment-wakes'`,
	);
	const legacy = row?.successful ?? row?.firstFire;
	if (!legacy) return null;
	// Success covered the eligible boundary; a first failed fire also owes its initial window.
	const eligible =
		Math.floor((Date.parse(legacy) - 30_000) / 120_000) * 120_000;
	return new Date(eligible - (row?.successful ? 0 : 120_000)).toISOString();
}

export async function advanceCommitmentWakeCheckpoint(
	db: DbClient,
	through: string,
): Promise<void> {
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: "commitment-wakes", through })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through },
			setWhere: sql`${platformCronCheckpoints.through} < ${through}`,
		});
}
