import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import { workInteractions } from "../../schema/work-factory";

export interface CommitmentChange {
	key: string;
	orgId: string;
	tediId: string;
	slug: string;
	kind: "work" | "approval" | "interaction" | "factory_run" | "memory";
	objectId: string;
	state: string;
	changedAt: string;
}

/** Recheck canonical ownership/state before creating an operator-visible ask. */
export async function getCommitmentFollowupTarget(
	db: DbClient,
	change: CommitmentChange,
	now: string,
): Promise<{
	id: string;
	title: string;
	personId: string;
	openInteractionId: string | null;
} | null> {
	if (!["overdue", "idle"].includes(change.state)) return null;
	if (change.kind === "interaction") {
		const [interaction] = await db.all<{
			id: string;
			title: string;
			personId: string;
			openInteractionId: string;
		}>(sql`
			SELECT coalesce(i.work_item_id,i.id) AS id, i.subject AS title, i.target_id AS personId, i.id AS openInteractionId
			FROM work_interactions i JOIN organization_members m ON m.organization_id=i.org_id AND m.user_id=i.target_id AND m.status='active'
			JOIN tedis t ON t.id=${change.tediId} AND t.organization_id=i.org_id AND t.scope='personal' AND t.status='active' AND t.owner_user_id=m.descope_user_id
			WHERE i.org_id=${change.orgId} AND i.id=${change.objectId} AND i.target_type='user' AND i.status='open'
				AND (i.expires_at IS NULL OR i.expires_at>${now})
				AND (i.due_at<=${now} OR (i.due_at IS NULL AND i.created_at<=${new Date(Date.parse(now) - 172_800_000).toISOString()}))
				AND (i.work_item_id IS NULL OR EXISTS(SELECT 1 FROM work_items w WHERE w.org_id=i.org_id AND w.id=i.work_item_id AND w.disposition NOT IN ('completed','cancelled')))
			LIMIT 1
		`);
		return interaction ?? null;
	}
	if (change.kind !== "work") return null;
	const [work] = await db.all<{
		id: string;
		title: string;
		personId: string;
	}>(sql`
		SELECT w.id, w.title, m.user_id AS personId FROM work_items w
		JOIN organization_members m ON m.organization_id = w.org_id
			AND m.user_id = w.accountable_owner_id AND m.status = 'active'
		JOIN tedis t ON t.id = ${change.tediId} AND t.organization_id = w.org_id
			AND t.status = 'active' AND t.scope = 'personal' AND t.owner_user_id = m.descope_user_id
		WHERE w.org_id = ${change.orgId} AND w.id = ${change.objectId}
			AND w.accountable_owner_type = 'user' AND w.disposition NOT IN ('completed', 'cancelled')
			AND ((coalesce(w.deadline, w.due_date) <= ${now}) OR
				(w.disposition = 'accepted' AND coalesce(w.updated_at, w.accepted_at, w.created_at) <= ${new Date(Date.parse(now) - 172_800_000).toISOString()}
				AND NOT EXISTS (SELECT 1 FROM work_attempts a WHERE a.org_id = w.org_id
					AND a.work_item_id = w.id AND a.runtime_state = 'running' AND a.expires_at > ${now})))
		LIMIT 1
	`);
	if (!work) return null;
	const [open] = await db.all<{ id: string }>(sql`
		SELECT id FROM work_interactions WHERE org_id = ${change.orgId} AND work_item_id = ${work.id}
			AND target_type = 'user' AND target_id = ${work.personId} AND status = 'open'
			AND (kind = 'question' OR (kind = 'coordination' AND json_extract(metadata,'$.commitmentKey') = ${`work:${work.id}`}))
			AND (expires_at IS NULL OR expires_at > ${now})
		LIMIT 1
	`);
	return { ...work, openInteractionId: open?.id ?? null };
}

export async function recordCommitmentFollowupAttention(
	db: DbClient,
	p: {
		orgId: string;
		interactionId: string;
		commitmentKey: string;
		dedupeKey: string;
		decisionClass: string;
	},
): Promise<void> {
	await db.update(workInteractions).set({
		metadata: sql`json_set(${workInteractions.metadata}, '$.commitmentKey', ${p.commitmentKey}, '$.dedupeKey', ${p.dedupeKey}, '$.decisionClass', ${p.decisionClass})`,
		version: sql`${workInteractions.version} + 1`,
	})
		.where(sql`${workInteractions.orgId} = ${p.orgId} AND ${workInteractions.id} = ${p.interactionId}
		AND ${workInteractions.status} = 'open' AND json_extract(${workInteractions.metadata}, '$.dedupeKey') IS NOT ${p.dedupeKey}
		AND json_extract(${workInteractions.metadata}, '$.decisionDeck.kind') IS NOT 'approval'
		AND json_extract(${workInteractions.metadata}, '$.approvalOperation') IS NULL`);
}

/** Global scheduler read; each row joins its active tedi in the same tenant. */
export async function listCommitmentChanges(
	db: DbClient,
	after: string,
	through: string,
	environment: string,
	page?: { limit: number; cursor: CommitmentWakeCursor | null },
): Promise<CommitmentChange[]> {
	const limit = page ? Math.max(1, Math.min(100, Math.floor(page.limit))) : 100;
	const cursor = page?.cursor;
	const pageFilter = cursor
		? sql`WHERE (changedAt, key, tediId) > (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId})`
		: sql``;
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
			-- CROSS JOIN fixes the loop order: the two-minute event window drives
			-- the Work Item seek, then the tenant's tedis. A plain JOIN let SQLite
			-- start from every tedi of every tenant and walk each tenant's whole
			-- work_items index per tedi (273k rows read per window on 23 Oct 2026).
			FROM recent_work_events e CROSS JOIN work_items w ON w.id = e.work_item_id AND w.org_id = e.org_id
			CROSS JOIN tedis t ON t.organization_id = w.org_id AND t.status = 'active'
				AND ((w.accountable_owner_type = 'tedi' AND w.accountable_owner_id = t.id)
				OR (w.steward_type = 'tedi' AND w.steward_id = t.id)
				OR EXISTS (SELECT 1 FROM projects p WHERE p.org_id = w.org_id AND p.id = w.project_id AND p.lead_tedi_id = t.id)
				OR EXISTS (SELECT 1 FROM work_attempts a INDEXED BY uniq_work_attempt_number WHERE a.org_id = w.org_id AND a.work_item_id = w.id AND a.executor_type = 'tedi' AND a.executor_id = t.id))
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
			FROM overdue_interactions i JOIN tedis t ON t.organization_id = i.org_id AND t.status = 'active'
				AND ((i.creator_type = 'tedi' AND i.creator_id = t.id) OR
					(t.scope = 'personal' AND i.target_type = 'user' AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=i.org_id AND m.user_id=i.target_id AND m.status='active' AND m.descope_user_id=t.owner_user_id)))
			WHERE i.status = 'open' AND i.due_at > ${after} AND i.due_at <= ${through}
				AND (i.expires_at IS NULL OR i.expires_at > ${through})
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
		sql`
		SELECT 'member-overdue:' || w.id AS key, w.org_id AS orgId, t.id AS tediId, t.slug,
			'work' AS kind, w.id AS objectId, 'overdue' AS state,
			coalesce(w.deadline, w.due_date) AS changedAt
		FROM tedis t
		JOIN organization_members m ON m.organization_id = t.organization_id
			AND m.descope_user_id = t.owner_user_id AND m.status = 'active'
		JOIN work_items w INDEXED BY idx_work_items_accountable_owner
			ON w.org_id = m.organization_id AND w.accountable_owner_type = 'user'
			AND w.accountable_owner_id = m.user_id
		WHERE t.scope = 'personal' AND t.status = 'active'
			AND w.disposition NOT IN ('completed', 'cancelled')
			AND coalesce(w.deadline, w.due_date) > ${after}
			AND coalesce(w.deadline, w.due_date) <= ${through}
		`,
		sql`
		SELECT 'idle:' || w.id AS key, w.org_id AS orgId, t.id AS tediId, t.slug,
			'work' AS kind, w.id AS objectId, 'idle' AS state,
			strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(w.updated_at, w.accepted_at, w.created_at), '+2 days') AS changedAt
		FROM tedis t
		JOIN organization_members m ON m.organization_id = t.organization_id
			AND m.descope_user_id = t.owner_user_id AND m.status = 'active'
		JOIN work_items w INDEXED BY idx_work_items_accountable_owner
			ON w.org_id = m.organization_id AND w.accountable_owner_type = 'user'
			AND w.accountable_owner_id = m.user_id
		WHERE t.scope = 'personal' AND t.status = 'active' AND w.disposition = 'accepted'
			AND coalesce(w.updated_at, w.accepted_at, w.created_at) > ${new Date(Date.parse(after) - 172_800_000).toISOString()}
			AND coalesce(w.updated_at, w.accepted_at, w.created_at) <= ${new Date(Date.parse(through) - 172_800_000).toISOString()}
			AND NOT EXISTS (SELECT 1 FROM work_attempts a INDEXED BY uniq_work_attempt_number
				WHERE a.org_id = w.org_id AND a.work_item_id = w.id AND a.runtime_state = 'running' AND a.expires_at > ${through})
		`,
		sql`
		SELECT 'interaction-idle:' || i.id AS key, i.org_id AS orgId, t.id AS tediId, t.slug,
			'interaction' AS kind, i.id AS objectId, 'idle' AS state,
			strftime('%Y-%m-%dT%H:%M:%fZ', i.created_at, '+2 days') AS changedAt
		FROM tedis t JOIN organization_members m ON m.organization_id = t.organization_id
			AND m.descope_user_id = t.owner_user_id AND m.status = 'active'
		JOIN work_interactions i INDEXED BY idx_work_interactions_target_status
			ON i.org_id = m.organization_id AND i.target_type = 'user' AND i.target_id = m.user_id AND i.status = 'open'
		WHERE t.scope = 'personal' AND t.status = 'active' AND i.due_at IS NULL
			AND i.created_at > ${new Date(Date.parse(after) - 172_800_000).toISOString()}
			AND i.created_at <= ${new Date(Date.parse(through) - 172_800_000).toISOString()}
			AND (i.expires_at IS NULL OR i.expires_at > ${through})
			AND (i.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=i.org_id AND w.id=i.work_item_id AND w.disposition NOT IN ('completed','cancelled')))
		`,
		sql`
		SELECT 'memory:' || f.id AS key, f.organization_id AS orgId, t.id AS tediId, t.slug,
			'memory' AS kind, f.id AS objectId, 'overdue' AS state,
			json_extract(f.metadata, '$.dueAt') AS changedAt
		FROM memory_facts f INDEXED BY idx_memory_facts_type
		JOIN tedis t ON t.id = f.tedi_id AND t.organization_id = f.organization_id AND t.status = 'active'
		WHERE f.fact_type = 'commitment' AND f.archived_at IS NULL AND f.valid_to IS NULL
			AND f.review_status NOT IN ('rejected', 'superseded', 'disputed')
			AND json_extract(f.metadata, '$.dueAt') > ${after}
			AND json_extract(f.metadata, '$.dueAt') <= ${through}
		`,
	];
	const groups: CommitmentChange[][] = [];
	for (const statement of statements)
		groups.push(
			await db.all<CommitmentChange>(
				sql`SELECT * FROM (${statement}) ${pageFilter} ORDER BY changedAt COLLATE BINARY, key COLLATE BINARY, tediId COLLATE BINARY LIMIT ${limit}`,
			),
		);
	return groups
		.flat()
		.sort((a, b) => {
			for (const field of ["changedAt", "key", "tediId"] as const) {
				if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
			}
			return 0;
		})
		.slice(0, limit);
}

export type CommitmentWakeCursor = NonNullable<
	typeof platformCronCheckpoints.$inferSelect.cursor
>;

export async function getCommitmentWakeCursor(
	db: DbClient,
	after: string,
): Promise<CommitmentWakeCursor | null> {
	const [row] = await db
		.select({ cursor: platformCronCheckpoints.cursor })
		.from(platformCronCheckpoints)
		.where(
			sql`${platformCronCheckpoints.scheduleId} = 'commitment-wakes' AND ${platformCronCheckpoints.through} = ${after}`,
		)
		.limit(1);
	return row?.cursor ?? null;
}

export async function advanceCommitmentWakeCursor(
	db: DbClient,
	after: string,
	cursor: CommitmentWakeCursor,
): Promise<void> {
	await db.update(platformCronCheckpoints).set({ cursor }).where(sql`
		${platformCronCheckpoints.scheduleId} = 'commitment-wakes' AND ${platformCronCheckpoints.through} = ${after}
		AND (${platformCronCheckpoints.cursor} IS NULL OR
			(json_extract(${platformCronCheckpoints.cursor}, '$.changedAt'), json_extract(${platformCronCheckpoints.cursor}, '$.key'), json_extract(${platformCronCheckpoints.cursor}, '$.tediId')) < (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId}))`);
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
			set: { through, cursor: null },
			setWhere: sql`${platformCronCheckpoints.through} < ${through}`,
		});
}
