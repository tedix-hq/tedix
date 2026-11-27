import {
	and,
	eq,
	exists,
	gt,
	inArray,
	isNull,
	lte,
	notExists,
	notInArray,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { alias, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonParameter,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import { chunkForBoundParams } from "../../utils/batch";
import { memoryFacts } from "../../schema/memory-graph";
import { organizationMembers } from "../../schema/organization-members";
import {
	platformCronCheckpoints,
	platformCronExecutions,
} from "../../schema/platform-cron-executions";
import { tedis } from "../../schema/tedis";
import { workInteractions } from "../../schema/work-factory";
import {
	workAttempts,
	workItems,
	commitmentWakeOutbox,
	type CommitmentWakeSource,
} from "../../schema/work-items";

/** Byte order on both stores; SQLite has no "C" collation and Postgres no BINARY. */
function binary(db: object, value: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`(${value}) COLLATE "C"`
		: sql`(${value}) COLLATE BINARY`;
}

/** SQLite index hints; Postgres has no INDEXED BY and plans on its own statistics. */
function indexedBy(db: object, index: string): SQL {
	return coreStore(db) === "postgres"
		? sql``
		: sql` INDEXED BY ${sql.identifier(index)}`;
}

/** ISO-8601 text two days after a stored ISO-8601 timestamp, read as UTC on both stores. */
function twoDaysAfter(db: object, value: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`to_char((${value})::timestamp + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${value}, '+2 days')`;
}

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
		const i = alias(coreTable(db, workInteractions), "i");
		const m = alias(coreTable(db, organizationMembers), "m");
		const t = alias(coreTable(db, tedis), "t");
		const w = alias(coreTable(db, workItems), "w");
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
					eq(t.ownerUserId, m.userId),
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
	const w = alias(coreTable(db, workItems), "w");
	const m = alias(coreTable(db, organizationMembers), "m");
	const t = alias(coreTable(db, tedis), "t");
	const a = alias(coreTable(db, workAttempts), "a");
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
				eq(t.ownerUserId, m.userId),
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
	const interactions = coreTable(db, workInteractions);
	const [open] = await db
		.select({ id: interactions.id })
		.from(interactions)
		.where(
			and(
				eq(interactions.orgId, change.orgId),
				eq(interactions.workItemId, work.id),
				eq(interactions.status, "open"),
				or(isNull(interactions.expiresAt), gt(interactions.expiresAt, now)),
			),
		)
		.orderBy(sql`${interactions.createdAt} DESC`, interactions.id)
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
		decisionClass: "deadline.owner.commitment" | "personal.proposal.commitment";
	},
): Promise<void> {
	const i = coreTable(db, workInteractions);
	const metadata = [
		["commitmentKey", p.commitmentKey],
		["dedupeKey", p.dedupeKey],
		["decisionClass", p.decisionClass],
	].reduce<SQL>(
		(document, [key, value]) => jsonWrite(db, document, [key!], value),
		sql`${i.metadata}`,
	);
	await db.update(i).set({ metadata, version: sql`${i.version} + 1` })
		.where(sql`${i.orgId} = ${p.orgId} AND ${i.id} = ${p.interactionId}
		AND ${i.status} = 'open' AND coalesce(${jsonRead(db, i.metadata, ["dedupeKey"])}, '') <> ${p.dedupeKey}
		AND ${i.kind} = 'question'
		AND (${p.commitmentKey} LIKE 'interaction:%' OR ${i.subject} LIKE 'Follow up:%'
		 OR ${jsonRead(db, i.metadata, ["commitmentKey"])} IS NOT NULL)
		AND coalesce(${jsonRead(db, i.metadata, ["decisionDeck", "kind"])}, '') <> 'approval'
		AND ${jsonRead(db, i.metadata, ["approvalOperation"])} IS NULL`);
}

/** Queue reads seek one canonical source; catch-up reads indexed time windows. */
export async function listCommitmentChanges(
	db: DbClient,
	after: string,
	through: string,
	environment: string,
	page?: {
		limit: number;
		cursor: CommitmentWakeCursor | null;
		source?: Pick<
			CommitmentWakeDueRow,
			"orgId" | "sourceKind" | "sourceId" | "changeKey"
		>;
	},
): Promise<CommitmentChange[]> {
	const limit = page ? Math.max(1, Math.min(100, Math.floor(page.limit))) : 100;
	const cursor = page?.cursor;
	const source = page?.source;
	const sourceFilter = (kind: CommitmentWakeSource, orgColumn: string) =>
		!source
			? sql`TRUE`
			: source.sourceKind !== kind
				? sql`FALSE`
				: sql`${sql.identifier(orgColumn)} = ${source.orgId} AND id = ${source.sourceId}`;
	const columns = {
		key: sql.identifier("key"),
		changedAt: sql.identifier("changedAt"),
		tediId: sql.identifier("tediId"),
	};
	const pageFilter = sql`WHERE ${source?.changeKey ? sql`${columns.key} = ${source.changeKey}` : sql`TRUE`}
		AND ${cursor ? sql`(${binary(db, columns.changedAt)}, ${binary(db, columns.key)}, ${binary(db, columns.tediId)}) > (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId})` : sql`TRUE`}`;
	const outcome = jsonRead(db, sql`e.payload`, ["outcome"]);
	// SQLite needs CROSS JOIN to fix the loop order; Postgres rejects CROSS JOIN ... ON.
	const orderedJoin =
		coreStore(db) === "postgres" ? sql`JOIN` : sql`CROSS JOIN`;
	const attemptNumberIndex = indexedBy(db, "uniq_work_attempt_number");
	const resolved = sql`r.resolves_request = ${booleanValue(db, true)}`;
	// D1 rejects the eight-term compound scan; keep each statement to four terms.
	// Raw: these compound scans need AS MATERIALIZED windows and a fixed join order, which Drizzle cannot emit.
	const statements = [
		sql`
		WITH recent_work_events AS MATERIALIZED (
			SELECT * FROM work_events
			WHERE occurred_at > ${after} AND occurred_at <= ${through} AND ${sourceFilter("work_event", "org_id")}
		), resolved_work_approvals AS MATERIALIZED (
			SELECT * FROM work_approval_proposals WHERE resolved_at > ${after} AND resolved_at <= ${through} AND ${sourceFilter("work_approval", "org_id")}
		), resolved_tedi_approvals AS MATERIALIZED (
			SELECT * FROM tedi_approval_requests WHERE resolved_at > ${after} AND resolved_at <= ${through} AND ${sourceFilter("tedi_approval", "org_id")}
		), changes AS (
			SELECT 'work:' || e.id AS key, w.org_id AS "orgId", t.id AS "tediId", t.slug,
				'work' AS kind, w.id AS "objectId",
				CASE WHEN e.event_type = 'attempt.settled' THEN ${outcome} ELSE e.event_type END AS state,
				e.occurred_at AS "changedAt"
			-- CROSS JOIN fixes the loop order: the two-minute event window drives
			-- the Work Item seek, then the tenant's tedis. A plain JOIN let SQLite
			-- start from every tedi of every tenant and walk each tenant's whole
			-- work_items index per tedi (273k rows read per window on 23 Oct 2026).
			FROM recent_work_events e ${orderedJoin} work_items w ON w.id = e.work_item_id AND w.org_id = e.org_id
			${orderedJoin} tedis t ON t.organization_id = w.org_id AND t.status = 'active'
				AND ((w.accountable_owner_type = 'tedi' AND w.accountable_owner_id = t.id)
				OR (w.steward_type = 'tedi' AND w.steward_id = t.id)
				OR EXISTS (SELECT 1 FROM projects p WHERE p.org_id = w.org_id AND p.id = w.project_id AND p.lead_tedi_id = t.id)
				OR EXISTS (SELECT 1 FROM work_attempts a${attemptNumberIndex} WHERE a.org_id = w.org_id AND a.work_item_id = w.id AND a.executor_type = 'tedi' AND a.executor_id = t.id))
			WHERE w.disposition != 'cancelled'
				AND (w.disposition != 'completed' OR (
					e.event_type = 'attempt.settled' AND e.actor_type = 'external_agent'
					AND ${outcome} = 'succeeded'))
				AND NOT (e.actor_type = 'tedi' AND e.actor_id = t.id)
				AND (e.event_type NOT IN ('lane.stale', 'attempt.expired') OR NOT EXISTS (
					SELECT 1 FROM work_attempts a${attemptNumberIndex}
					WHERE a.org_id = w.org_id AND a.work_item_id = w.id
						AND a.runtime_state = 'running' AND a.expires_at > ${through}
						AND a.heartbeat_at > e.occurred_at))
				AND (e.event_type IN ('work.accepted', 'work.specification_updated', 'attempt.expired', 'lane.stale')
					OR (e.event_type = 'attempt.settled' AND (
						${outcome} = 'failed'
						OR (e.actor_type = 'external_agent' AND ${outcome} = 'succeeded'))))
			UNION ALL
			SELECT 'approval:' || p.id || ':' || p.version, p.org_id, t.id, t.slug,
				'approval', p.id, p.status, p.resolved_at
			FROM resolved_work_approvals p JOIN work_approval_decisions d ON d.proposal_id = p.id
			JOIN tedis t ON t.organization_id = p.org_id AND t.status = 'active' AND p.requester_type = 'tedi' AND p.requester_id = t.id
			JOIN work_items w${indexedBy(db, "uniq_work_items_org_id")} ON w.id = p.work_item_id AND w.org_id = p.org_id
			WHERE p.resolved_at > ${after} AND p.resolved_at <= ${through} AND p.status IN ('approved', 'rejected')
				AND w.disposition NOT IN ('completed', 'cancelled') AND NOT (d.decider_type = 'tedi' AND d.decider_id = t.id)
			UNION ALL
			SELECT 'tedi-approval:' || p.id || ':' || p.status, p.org_id, t.id, t.slug,
				'approval', p.id, p.status, p.resolved_at
			FROM resolved_tedi_approvals p JOIN tedis t ON t.id = p.tedi_id AND t.organization_id = p.org_id AND t.status = 'active'
			-- A policy decision is recorded already resolved; nothing waited on it.
			-- Waking for those sent builder about 580 empty turns a day (22 Nov 2026).
			WHERE p.resolved_at > ${after} AND p.resolved_at <= ${through} AND p.resolved_by NOT IN (t.id, 'policy') AND p.status IN ('approved', 'rejected') AND p.workflow_id IS NULL
		)
		SELECT DISTINCT key, "orgId", "tediId", slug, kind, "objectId", state, "changedAt" FROM changes
	`,
		sql`
		WITH recent_responses AS MATERIALIZED (
			SELECT * FROM work_interaction_responses WHERE responded_at > ${after} AND responded_at <= ${through} AND ${sourceFilter("interaction_response", "org_id")}
		), overdue_interactions AS MATERIALIZED (
			SELECT * FROM work_interactions WHERE due_at > ${after} AND due_at <= ${through} AND ${sourceFilter("interaction", "org_id")}
		), completed_gadgets AS MATERIALIZED (
			SELECT * FROM os_gadget_executions WHERE completed_at > ${after} AND completed_at <= ${through} AND ${sourceFilter("gadget", "organization_id")}
		), completed_skills AS MATERIALIZED (
			SELECT * FROM skill_runs WHERE completed_at > ${after} AND completed_at <= ${through} AND ${sourceFilter("skill", "organization_id")}
		), changes AS (
			SELECT 'interaction:' || r.id AS key, i.org_id AS "orgId", t.id AS "tediId", t.slug,
				'interaction' AS kind, i.id AS "objectId", 'answered' AS state, r.responded_at AS "changedAt"
			FROM recent_responses r JOIN work_interactions i ON i.id = r.interaction_id AND i.org_id = r.org_id
			JOIN tedis t ON t.organization_id = i.org_id AND t.status = 'active' AND i.creator_type = 'tedi' AND i.creator_id = t.id
			WHERE r.responded_at > ${after} AND r.responded_at <= ${through} AND ${resolved}
				AND NOT (r.responder_type = 'tedi' AND r.responder_id = t.id)
				AND (i.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_items w WHERE w.id = i.work_item_id AND w.org_id = i.org_id AND w.disposition NOT IN ('completed', 'cancelled')))
			UNION ALL
			SELECT 'interaction-overdue:' || i.id || ':' || i.due_at, i.org_id, t.id, t.slug,
				'interaction', i.id, 'overdue', i.due_at
			FROM overdue_interactions i JOIN tedis t ON t.organization_id = i.org_id AND t.status = 'active'
				AND ((i.creator_type = 'tedi' AND i.creator_id = t.id) OR
					(t.scope = 'personal' AND i.target_type = 'user' AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=i.org_id AND m.user_id=i.target_id AND m.status='active' AND m.user_id=t.owner_user_id)))
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
		SELECT DISTINCT key, "orgId", "tediId", slug, kind, "objectId", state, "changedAt" FROM changes
	`,
		sql`
		WITH overdue_work AS MATERIALIZED (
			SELECT * FROM work_items WHERE deadline > ${after} AND deadline <= ${through} AND ${sourceFilter("work_item", "org_id")}
			UNION ALL
			-- A plain OR lets SQLite scan every NULL deadline instead of seeking due_date.
			SELECT * FROM work_items${indexedBy(db, "idx_work_items_due_date")}
			WHERE due_date > ${after} AND due_date <= ${through} AND deadline IS NULL AND ${sourceFilter("work_item", "org_id")}
		), changes AS (
			SELECT 'overdue:' || w.id || ':' || coalesce(w.deadline, w.due_date) AS key, w.org_id AS "orgId", t.id AS "tediId", t.slug,
				'work' AS kind, w.id AS "objectId", 'overdue' AS state, coalesce(w.deadline, w.due_date) AS "changedAt"
			FROM overdue_work w JOIN tedis t ON t.organization_id = w.org_id AND t.status = 'active'
				AND w.accountable_owner_type = 'tedi' AND w.accountable_owner_id = t.id
			WHERE w.disposition NOT IN ('completed', 'cancelled')
		)
		SELECT DISTINCT key, "orgId", "tediId", slug, kind, "objectId", state, "changedAt" FROM changes
		`,
	];
	const t = coreTable(db, tedis);
	const m = coreTable(db, organizationMembers);
	const w = coreTable(db, workItems);
	const a = coreTable(db, workAttempts);
	const wi = coreTable(db, workInteractions);
	const mf = coreTable(db, memoryFacts);
	const hinted = <T extends SQLiteTable>(table: T, index: string): T | SQL =>
		source || coreStore(db) === "postgres"
			? table
			: sql`${table}${indexedBy(db, index)}`;
	const personalMembers = and(
		eq(m.organizationId, t.organizationId),
		eq(m.userId, t.ownerUserId),
		eq(m.status, "active"),
	);
	const memberWork = hinted(w, "idx_work_items_accountable_owner");
	const memberOwnsWork = and(
		eq(w.orgId, m.organizationId),
		eq(w.accountableOwnerType, "user"),
		eq(w.accountableOwnerId, m.userId),
	);
	const workDue = sql`coalesce(${w.deadline}, ${w.dueDate})`;
	const workTouched = sql`coalesce(${w.updatedAt}, ${w.acceptedAt}, ${w.createdAt})`;
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
					sql`'member-overdue:' || ${w.id}`,
					w.orgId,
					"work",
					w.id,
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
					notInArray(w.disposition, ["completed", "cancelled"]),
					source
						? source.sourceKind === "work_item"
							? and(eq(w.orgId, source.orgId), eq(w.id, source.sourceId))
							: sql`FALSE`
						: undefined,
					sql`${workDue} > ${after}`,
					sql`${workDue} <= ${through}`,
				),
			),
		db
			.select(
				change(
					sql`'idle:' || ${w.id}`,
					w.orgId,
					"work",
					w.id,
					sql`'idle'`,
					twoDaysAfter(db, workTouched),
				),
			)
			.from(t)
			.innerJoin(m, personalMembers)
			.innerJoin(memberWork, memberOwnsWork)
			.where(
				and(
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					eq(w.disposition, "accepted"),
					source
						? source.sourceKind === "work_item"
							? and(eq(w.orgId, source.orgId), eq(w.id, source.sourceId))
							: sql`FALSE`
						: undefined,
					sql`${workTouched} > ${idleAfter}`,
					sql`${workTouched} <= ${idleThrough}`,
					notExists(
						db
							.select({ one: sql`1` })
							.from(hinted(a, "uniq_work_attempt_number"))
							.where(
								and(
									eq(a.orgId, w.orgId),
									eq(a.workItemId, w.id),
									eq(a.runtimeState, "running"),
									gt(a.expiresAt, through),
								),
							),
					),
				),
			),
		db
			.select(
				change(
					sql`'interaction-idle:' || ${wi.id}`,
					wi.orgId,
					"interaction",
					wi.id,
					sql`'idle'`,
					twoDaysAfter(db, wi.createdAt),
				),
			)
			.from(t)
			.innerJoin(m, personalMembers)
			.innerJoin(
				hinted(wi, "idx_work_interactions_target_status"),
				and(
					eq(wi.orgId, m.organizationId),
					eq(wi.targetType, "user"),
					eq(wi.targetId, m.userId),
					eq(wi.status, "open"),
				),
			)
			.where(
				and(
					eq(t.scope, "personal"),
					eq(t.status, "active"),
					source
						? source.sourceKind === "interaction"
							? and(eq(wi.orgId, source.orgId), eq(wi.id, source.sourceId))
							: sql`FALSE`
						: undefined,
					isNull(wi.dueAt),
					gt(wi.createdAt, idleAfter),
					lte(wi.createdAt, idleThrough),
					or(isNull(wi.expiresAt), gt(wi.expiresAt, through)),
					or(
						isNull(wi.workItemId),
						exists(
							db
								.select({ one: sql`1` })
								.from(w)
								.where(
									and(
										eq(w.orgId, wi.orgId),
										eq(w.id, wi.workItemId),
										notInArray(w.disposition, ["completed", "cancelled"]),
									),
								),
						),
					),
				),
			),
		db
			.select(
				change(
					sql`'memory:' || ${mf.id}`,
					mf.organizationId,
					"memory",
					mf.id,
					sql`'overdue'`,
					jsonRead(db, mf.metadata, ["dueAt"]),
				),
			)
			.from(hinted(mf, "idx_memory_facts_type"))
			.innerJoin(
				t,
				and(
					eq(t.id, mf.tediId),
					eq(t.organizationId, mf.organizationId),
					eq(t.status, "active"),
				),
			)
			.where(
				and(
					// Not in the typed fact-type enum, but stored by commitment capture.
					source
						? source.sourceKind === "memory"
							? and(
									eq(mf.organizationId, source.orgId),
									eq(mf.id, source.sourceId),
								)
							: sql`FALSE`
						: undefined,
					sql`${mf.factType} = 'commitment'`,
					isNull(mf.archivedAt),
					isNull(mf.validTo),
					notInArray(mf.reviewStatus, ["rejected", "superseded", "disputed"]),
					sql`${jsonRead(db, mf.metadata, ["dueAt"])} > ${after}`,
					sql`${jsonRead(db, mf.metadata, ["dueAt"])} <= ${through}`,
				),
			),
	];
	const groups: CommitmentChange[][] = [];
	for (const [index, statement] of statements.entries()) {
		if (
			source &&
			![
				["work_event", "work_approval", "tedi_approval"],
				["interaction_response", "interaction", "gadget", "skill"],
				["work_item"],
			][index]!.includes(source.sourceKind)
		)
			continue;
		groups.push(
			await db.all<CommitmentChange>(
				sql`SELECT * FROM (${statement}) AS page ${pageFilter} ORDER BY ${binary(db, columns.changedAt)}, ${binary(db, columns.key)}, ${binary(db, columns.tediId)} LIMIT ${limit}`,
			),
		);
	}
	for (const [index, builder] of builders.entries()) {
		if (
			source &&
			["work_item", "work_item", "interaction", "memory"][index] !==
				source.sourceKind
		)
			continue;
		const changes = builder.as("changes");
		groups.push(
			await db
				.select()
				.from(changes)
				.where(
					and(
						source?.changeKey ? eq(changes.key, source.changeKey) : undefined,
						cursor
							? sql`(${changes.changedAt}, ${changes.key}, ${changes.tediId}) > (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId})`
							: undefined,
					),
				)
				.orderBy(
					binary(db, changes.changedAt),
					binary(db, changes.key),
					binary(db, changes.tediId),
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

/** A stored page cursor that is absent or strictly before the next one. */
function cursorBefore(
	db: object,
	column: SQLWrapper,
	cursor: CommitmentWakeCursor,
): SQL {
	const field = (name: string) => binary(db, jsonRead(db, column, [name]));
	return sql`(${column} IS NULL OR (${field("changedAt")}, ${field("key")}, ${field("tediId")}) < (${cursor.changedAt}, ${cursor.key}, ${cursor.tediId}))`;
}

/** Retry pointers reuse the scan checkpoint store; the events remain canonical. */
export async function retainCommitmentWakePage(
	db: DbClient,
	through: string,
	cursor: CommitmentWakeCursor | null,
): Promise<void> {
	await db
		.insert(coreTable(db, platformCronCheckpoints))
		.values({
			scheduleId: `${RETRY_PREFIX}${through}:${JSON.stringify(cursor)}`,
			through,
			cursor,
		})
		.onConflictDoNothing();
}

export async function listCommitmentWakeRetryPages(db: DbClient) {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	return db
		.select()
		.from(checkpoints)
		.where(
			sql`${binary(db, checkpoints.scheduleId)} >= ${RETRY_PREFIX} AND ${binary(db, checkpoints.scheduleId)} < ${RETRY_PREFIX + "~"}`,
		)
		.orderBy(binary(db, checkpoints.scheduleId))
		.limit(10);
}

export async function removeCommitmentWakeRetryPage(
	db: DbClient,
	scheduleId: string,
) {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	await db.delete(checkpoints).where(eq(checkpoints.scheduleId, scheduleId));
}

export async function getCommitmentWakeCursor(
	db: DbClient,
	after: string,
): Promise<CommitmentWakeCursor | null> {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	const [row] = await db
		.select({ cursor: checkpoints.cursor })
		.from(checkpoints)
		.where(
			sql`${checkpoints.scheduleId} = 'commitment-wakes' AND ${checkpoints.through} = ${after}`,
		)
		.limit(1);
	return row?.cursor ?? null;
}

export async function advanceCommitmentWakeCursor(
	db: DbClient,
	after: string,
	cursor: CommitmentWakeCursor,
): Promise<void> {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	await db.update(checkpoints).set({ cursor }).where(sql`
		${checkpoints.scheduleId} = 'commitment-wakes' AND ${checkpoints.through} = ${after}
		AND ${cursorBefore(db, checkpoints.cursor, cursor)}`);
}

export async function lastCommitmentWakeCheckpoint(
	db: DbClient,
): Promise<string | null> {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	const executions = coreTable(db, platformCronExecutions);
	const [cursor] = await db
		.select()
		.from(checkpoints)
		.where(eq(checkpoints.scheduleId, "commitment-wakes"))
		.limit(1);
	if (cursor) return cursor.through;
	const [row] = await db
		.select({
			successful: sql<
				string | null
			>`max(CASE WHEN ${executions.status} = 'success' THEN ${executions.scheduledAt} END)`.as(
				"successful",
			),
			firstFire: sql<string | null>`min(${executions.scheduledAt})`.as(
				"firstFire",
			),
		})
		.from(executions)
		.where(eq(executions.scheduleId, "commitment-wakes"));
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
	const checkpoints = coreTable(db, platformCronCheckpoints);
	await db
		.insert(checkpoints)
		.values({ scheduleId: "commitment-wakes", through })
		.onConflictDoUpdate({
			target: checkpoints.scheduleId,
			set: { through, cursor: null },
			setWhere: sql`${checkpoints.through} < ${through}`,
		});
}

export type CommitmentWakeDueRow = typeof commitmentWakeOutbox.$inferSelect;

function commitmentWakeSource(change: CommitmentChange): {
	sourceKind: CommitmentWakeSource;
	sourceId: string;
} {
	const prefix = change.key.slice(0, change.key.indexOf(":"));
	const kinds: Record<string, CommitmentWakeSource> = {
		work: "work_event",
		approval: "work_approval",
		"tedi-approval": "tedi_approval",
		interaction: "interaction_response",
		"interaction-overdue": "interaction",
		"interaction-idle": "interaction",
		factory: "gadget",
		skill: "skill",
		memory: "memory",
	};
	const sourceKind = kinds[prefix] ?? "work_item";
	return {
		sourceKind,
		sourceId:
			sourceKind === "work_event" || sourceKind === "interaction_response"
				? change.key.slice(prefix.length + 1)
				: change.objectId,
	};
}

/** Same identity as the atomic writer triggers, including overdue/idle crossings. */
export async function retainCommitmentWakeChanges(
	db: DbClient,
	changes: CommitmentChange[],
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	const rows = changes.map((change) => {
		const source = commitmentWakeSource(change);
		const changeKey =
			source.sourceKind === "gadget" || source.sourceKind === "skill"
				? change.key
				: null;
		return {
			id: `${source.sourceKind}:${source.sourceId}:${change.changedAt}${changeKey ? `:${changeKey}` : ""}`,
			changeKey,
			kind: "commitment_wake" as const,
			orgId: change.orgId,
			...source,
			dueAt: change.changedAt,
			nextSendAt: new Date(Date.parse(change.changedAt) + 30_000).toISOString(),
		};
	});
	// Stay below D1's 100-parameter limit, including the revision key.
	for (let at = 0; at < rows.length; at += 10)
		await db
			.insert(outbox)
			.values(rows.slice(at, at + 10))
			.onConflictDoNothing();
}

function commitmentWakeEnvironment(
	outbox: typeof commitmentWakeOutbox,
	environment: string,
) {
	return sql`(${outbox.sourceKind} NOT IN ('gadget', 'skill')
		OR (${outbox.sourceKind} = 'gadget' AND EXISTS (SELECT 1 FROM os_gadget_executions g WHERE g.id = ${outbox.sourceId} AND g.organization_id = ${outbox.orgId} AND g.runtime_environment = ${environment}))
		OR (${outbox.sourceKind} = 'skill' AND EXISTS (SELECT 1 FROM skill_runs s WHERE s.id = ${outbox.sourceId} AND s.organization_id = ${outbox.orgId} AND s.runtime_environment = ${environment})))`;
}

export async function listDueCommitmentWakes(
	db: DbClient,
	now: string,
	environment: string,
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	return db
		.select()
		.from(outbox)
		.where(
			and(
				isNull(outbox.completedAt),
				lte(outbox.nextSendAt, now),
				commitmentWakeEnvironment(outbox, environment),
			),
		)
		.orderBy(outbox.nextSendAt, outbox.id)
		.limit(25);
}

export async function getDueCommitmentWake(
	db: DbClient,
	id: string,
	environment: string,
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	const [row] = await db
		.select()
		.from(outbox)
		.where(
			and(
				eq(outbox.id, id),
				isNull(outbox.completedAt),
				commitmentWakeEnvironment(outbox, environment),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function recordCommitmentWakesQueued(
	db: DbClient,
	ids: string[],
	now: string,
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	for (const chunk of chunkForBoundParams(ids, 50))
		await db
			.update(outbox)
			.set({ nextSendAt: new Date(Date.parse(now) + 600_000).toISOString() })
			.where(and(isNull(outbox.completedAt), inArray(outbox.id, chunk)));
}

export async function recordCommitmentWakeProgress(
	db: DbClient,
	row: CommitmentWakeDueRow,
	cursor: CommitmentWakeCursor | null,
	now: string,
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	await db
		.update(outbox)
		.set(cursor ? { cursor } : { completedAt: now })
		.where(
			and(
				eq(outbox.id, row.id),
				isNull(outbox.completedAt),
				// A duplicate queue delivery cannot move the page cursor backwards.
				cursor
					? cursorBefore(db, outbox.cursor, cursor)
					: row.cursor
						? sql`${outbox.cursor} = ${jsonParameter(db, row.cursor)}`
						: isNull(outbox.cursor),
			),
		);
}

export async function pruneCommitmentWakeReceipts(
	db: DbClient,
	before: string,
) {
	const outbox = coreTable(db, commitmentWakeOutbox);
	await db.delete(outbox).where(sql`${outbox.id} IN (
		SELECT id FROM commitment_wake_outbox WHERE completed_at IS NOT NULL AND completed_at < ${before}
		ORDER BY completed_at LIMIT 100)`);
}
