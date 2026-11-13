import {
	and,
	eq,
	exists,
	gt,
	isNull,
	lte,
	notExists,
	notInArray,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { memoryFacts } from "../../schema/memory-graph";
import { organizationMembers } from "../../schema/organization-members";
import {
	platformCronCheckpoints,
	platformCronExecutions,
} from "../../schema/platform-cron-executions";
import { tedis } from "../../schema/tedis";
import { workInteractions } from "../../schema/work-factory";
import { workAttempts, workItems } from "../../schema/work-items";

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
	targetType: "user" | "tedi";
	openInteractionId: string | null;
} | null> {
	if (!["overdue", "idle"].includes(change.state)) return null;
	if (change.kind === "interaction") {
		const i = alias(workInteractions, "i");
		const m = alias(organizationMembers, "m");
		const t = alias(tedis, "t");
		const w = alias(workItems, "w");
		const [interaction] = await db
			.select({
				id: sql<string>`coalesce(${i.workItemId},${i.id})`.as("id"),
				title: sql<string>`${i.subject}`.as("title"),
				personId: sql<string>`${i.targetId}`.as("personId"),
				openInteractionId: sql<string>`${i.id}`.as("openInteractionId"),
			})
			.from(i)
			.innerJoin(
				m,
				and(
					eq(m.organizationId, i.orgId),
					eq(m.userId, i.targetId),
					eq(m.status, "active"),
				),
			)
			.innerJoin(
				t,
				and(
					eq(t.id, change.tediId),
					eq(t.organizationId, i.orgId),
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					eq(t.ownerUserId, m.descopeUserId),
				),
			)
			.where(
				and(
					eq(i.orgId, change.orgId),
					eq(i.id, change.objectId),
					eq(i.targetType, "user"),
					eq(i.status, "open"),
					or(isNull(i.expiresAt), gt(i.expiresAt, now)),
					or(
						lte(i.dueAt, now),
						and(
							isNull(i.dueAt),
							lte(
								i.createdAt,
								new Date(Date.parse(now) - 172_800_000).toISOString(),
							),
						),
					),
					or(
						isNull(i.workItemId),
						exists(
							db
								.select({ one: sql`1` })
								.from(w)
								.where(
									and(
										eq(w.orgId, i.orgId),
										eq(w.id, i.workItemId),
										notInArray(w.disposition, ["completed", "cancelled"]),
									),
								),
						),
					),
				),
			)
			.limit(1);
		return interaction ? { ...interaction, targetType: "user" } : null;
	}
	if (change.kind !== "work") return null;
	const w = alias(workItems, "w");
	const m = alias(organizationMembers, "m");
	const t = alias(tedis, "t");
	const a = alias(workAttempts, "a");
	const [work] = await db
		.select({
			id: w.id,
			title: w.title,
			personId: sql<string>`case when ${w.workKind} = 'coding' then coalesce(
				(select id from tedis where organization_id = ${w.orgId} and id = ${w.stewardId}
				 and ${w.stewardType} = 'tedi' and status = 'active'), ${t.id}) else ${m.userId} end`.as(
				"personId",
			),
			targetType: sql<
				"user" | "tedi"
			>`case when ${w.workKind} = 'coding' then 'tedi' else 'user' end`.as(
				"targetType",
			),
		})
		.from(w)
		.innerJoin(
			m,
			and(
				eq(m.organizationId, w.orgId),
				eq(m.userId, w.accountableOwnerId),
				eq(m.status, "active"),
			),
		)
		.innerJoin(
			t,
			and(
				eq(t.id, change.tediId),
				eq(t.organizationId, w.orgId),
				eq(t.status, "active"),
				eq(t.scope, "personal"),
				eq(t.ownerUserId, m.descopeUserId),
			),
		)
		.where(
			and(
				eq(w.orgId, change.orgId),
				eq(w.id, change.objectId),
				eq(w.accountableOwnerType, "user"),
				notInArray(w.disposition, ["completed", "cancelled"]),
				or(
					sql`coalesce(${w.deadline}, ${w.dueDate}) <= ${now}`,
					and(
						eq(w.disposition, "accepted"),
						sql`coalesce(${w.updatedAt}, ${w.acceptedAt}, ${w.createdAt}) <= ${new Date(Date.parse(now) - 172_800_000).toISOString()}`,
						notExists(
							db
								.select({ one: sql`1` })
								.from(a)
								.where(
									and(
										eq(a.orgId, w.orgId),
										eq(a.workItemId, w.id),
										eq(a.runtimeState, "running"),
										gt(a.expiresAt, now),
									),
								),
						),
					),
				),
			),
		)
		.limit(1);
	if (!work) return null;
	const [open] = await db
		.select({ id: workInteractions.id })
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, change.orgId),
				eq(workInteractions.workItemId, work.id),
				eq(workInteractions.targetType, work.targetType),
				eq(workInteractions.targetId, work.personId),
				eq(workInteractions.status, "open"),
				or(
					eq(workInteractions.kind, "question"),
					and(
						eq(workInteractions.kind, "coordination"),
						sql`json_extract(${workInteractions.metadata},'$.commitmentKey') = ${`work:${work.id}`}`,
					),
				),
				or(
					isNull(workInteractions.expiresAt),
					gt(workInteractions.expiresAt, now),
				),
			),
		)
		.limit(1);
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
	// Raw: these compound scans need AS MATERIALIZED windows and CROSS JOIN order, which Drizzle cannot emit.
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
	];
	const t = tedis;
	const m = organizationMembers;
	const personalMembers = and(
		eq(m.organizationId, t.organizationId),
		eq(m.descopeUserId, t.ownerUserId),
		eq(m.status, "active"),
	);
	const memberWork = sql`${workItems} INDEXED BY idx_work_items_accountable_owner`;
	const memberOwnsWork = and(
		eq(workItems.orgId, m.organizationId),
		eq(workItems.accountableOwnerType, "user"),
		eq(workItems.accountableOwnerId, m.userId),
	);
	const workDue = sql`coalesce(${workItems.deadline}, ${workItems.dueDate})`;
	const workTouched = sql`coalesce(${workItems.updatedAt}, ${workItems.acceptedAt}, ${workItems.createdAt})`;
	const idleAfter = new Date(Date.parse(after) - 172_800_000).toISOString();
	const idleThrough = new Date(Date.parse(through) - 172_800_000).toISOString();
	const change = (
		key: SQL,
		orgId: SQLWrapper,
		kind: CommitmentChange["kind"],
		objectId: SQLWrapper,
		state: SQL,
		changedAt: SQL,
	) => ({
		key: sql<string>`${key}`.as("key"),
		orgId: sql<string>`${orgId}`.as("orgId"),
		tediId: sql<string>`${t.id}`.as("tediId"),
		slug: sql<string>`${t.slug}`.as("slug"),
		kind: sql<CommitmentChange["kind"]>`${kind}`.as("kind"),
		objectId: sql<string>`${objectId}`.as("objectId"),
		state: sql<string>`${state}`.as("state"),
		changedAt: sql<string>`${changedAt}`.as("changedAt"),
	});
	const builders = [
		db
			.select(
				change(
					sql`'member-overdue:' || ${workItems.id}`,
					workItems.orgId,
					"work",
					workItems.id,
					sql`'overdue'`,
					workDue,
				),
			)
			.from(t)
			.innerJoin(m, personalMembers)
			.innerJoin(memberWork, memberOwnsWork)
			.where(
				and(
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					notInArray(workItems.disposition, ["completed", "cancelled"]),
					sql`${workDue} > ${after}`,
					sql`${workDue} <= ${through}`,
				),
			),
		db
			.select(
				change(
					sql`'idle:' || ${workItems.id}`,
					workItems.orgId,
					"work",
					workItems.id,
					sql`'idle'`,
					sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${workTouched}, '+2 days')`,
				),
			)
			.from(t)
			.innerJoin(m, personalMembers)
			.innerJoin(memberWork, memberOwnsWork)
			.where(
				and(
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					eq(workItems.disposition, "accepted"),
					sql`${workTouched} > ${idleAfter}`,
					sql`${workTouched} <= ${idleThrough}`,
					notExists(
						db
							.select({ one: sql`1` })
							.from(sql`${workAttempts} INDEXED BY uniq_work_attempt_number`)
							.where(
								and(
									eq(workAttempts.orgId, workItems.orgId),
									eq(workAttempts.workItemId, workItems.id),
									eq(workAttempts.runtimeState, "running"),
									gt(workAttempts.expiresAt, through),
								),
							),
					),
				),
			),
		db
			.select(
				change(
					sql`'interaction-idle:' || ${workInteractions.id}`,
					workInteractions.orgId,
					"interaction",
					workInteractions.id,
					sql`'idle'`,
					sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${workInteractions.createdAt}, '+2 days')`,
				),
			)
			.from(t)
			.innerJoin(m, personalMembers)
			.innerJoin(
				sql`${workInteractions} INDEXED BY idx_work_interactions_target_status`,
				and(
					eq(workInteractions.orgId, m.organizationId),
					eq(workInteractions.targetType, "user"),
					eq(workInteractions.targetId, m.userId),
					eq(workInteractions.status, "open"),
				),
			)
			.where(
				and(
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					isNull(workInteractions.dueAt),
					gt(workInteractions.createdAt, idleAfter),
					lte(workInteractions.createdAt, idleThrough),
					or(
						isNull(workInteractions.expiresAt),
						gt(workInteractions.expiresAt, through),
					),
					or(
						isNull(workInteractions.workItemId),
						exists(
							db
								.select({ one: sql`1` })
								.from(workItems)
								.where(
									and(
										eq(workItems.orgId, workInteractions.orgId),
										eq(workItems.id, workInteractions.workItemId),
										notInArray(workItems.disposition, [
											"completed",
											"cancelled",
										]),
									),
								),
						),
					),
				),
			),
		db
			.select(
				change(
					sql`'memory:' || ${memoryFacts.id}`,
					memoryFacts.organizationId,
					"memory",
					memoryFacts.id,
					sql`'overdue'`,
					sql`json_extract(${memoryFacts.metadata}, '$.dueAt')`,
				),
			)
			.from(sql`${memoryFacts} INDEXED BY idx_memory_facts_type`)
			.innerJoin(
				t,
				and(
					eq(t.id, memoryFacts.tediId),
					eq(t.organizationId, memoryFacts.organizationId),
					eq(t.status, "active"),
				),
			)
			.where(
				and(
					// Not in the typed fact-type enum, but stored by commitment capture.
					sql`${memoryFacts.factType} = 'commitment'`,
					isNull(memoryFacts.archivedAt),
					isNull(memoryFacts.validTo),
					notInArray(memoryFacts.reviewStatus, [
						"rejected",
						"superseded",
						"disputed",
					]),
					sql`json_extract(${memoryFacts.metadata}, '$.dueAt') > ${after}`,
					sql`json_extract(${memoryFacts.metadata}, '$.dueAt') <= ${through}`,
				),
			),
	];
	const groups: CommitmentChange[][] = [];
	for (const statement of statements)
		groups.push(
			await db.all<CommitmentChange>(
				sql`SELECT * FROM (${statement}) ${pageFilter} ORDER BY changedAt COLLATE BINARY, key COLLATE BINARY, tediId COLLATE BINARY LIMIT ${limit}`,
			),
		);
	for (const builder of builders) {
		const changes = builder.as("changes");
		groups.push(
			await db
				.select()
				.from(changes)
				.where(
					cursor
						? sql`(${changes.changedAt}, ${changes.key}, ${changes.tediId}) > (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId})`
						: undefined,
				)
				.orderBy(
					sql`${changes.changedAt} COLLATE BINARY`,
					sql`${changes.key} COLLATE BINARY`,
					sql`${changes.tediId} COLLATE BINARY`,
				)
				.limit(limit),
		);
	}
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

const RETRY_PREFIX = "commitment-wakes:retry:";

/** Retry pointers reuse the scan checkpoint store; the events remain canonical. */
export async function retainCommitmentWakePage(
	db: DbClient,
	through: string,
	cursor: CommitmentWakeCursor | null,
): Promise<void> {
	await db
		.insert(platformCronCheckpoints)
		.values({
			scheduleId: `${RETRY_PREFIX}${through}:${JSON.stringify(cursor)}`,
			through,
			cursor,
		})
		.onConflictDoNothing();
}

export async function listCommitmentWakeRetryPages(db: DbClient) {
	return db
		.select()
		.from(platformCronCheckpoints)
		.where(
			sql`${platformCronCheckpoints.scheduleId} >= ${RETRY_PREFIX} AND ${platformCronCheckpoints.scheduleId} < ${RETRY_PREFIX + "~"}`,
		)
		.orderBy(platformCronCheckpoints.scheduleId)
		.limit(10);
}

export async function removeCommitmentWakeRetryPage(
	db: DbClient,
	scheduleId: string,
) {
	await db
		.delete(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, scheduleId));
}

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
	const [row] = await db
		.select({
			successful: sql<
				string | null
			>`max(CASE WHEN ${platformCronExecutions.status} = 'success' THEN ${platformCronExecutions.scheduledAt} END)`.as(
				"successful",
			),
			firstFire: sql<
				string | null
			>`min(${platformCronExecutions.scheduledAt})`.as("firstFire"),
		})
		.from(platformCronExecutions)
		.where(eq(platformCronExecutions.scheduleId, "commitment-wakes"));
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
