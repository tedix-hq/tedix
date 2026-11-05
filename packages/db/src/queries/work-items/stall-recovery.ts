import {
	and,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import type { DbQueryClient } from "../../query-client";
import {
	learningImprovementProposals,
	learningInteractionEvents,
} from "../../schema/learning-feedback";
import { platformCronCheckpoints } from "../../schema/platform-cron-executions";
import {
	workInteractionAttention,
	workInteractions,
} from "../../schema/work-factory";
import { workItems } from "../../schema/work-items";

export const CONTINUITY_SCOPE_BATCH_SIZE = 100;

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
 * CROSS JOIN keeps the page outside indexed history lookups; SQLite must not
 * scan runtime history to build an automatic index. Joins retain tenant scope.
 */
// Raw: needs AS MATERIALIZED CTEs and CROSS JOIN join-order pinning, which Drizzle cannot emit.
export async function listContinuityScopes(
	db: DbQueryClient,
	after = "",
	orgId?: string,
	environment = "production",
): Promise<ContinuityScope[]> {
	return db.all<ContinuityScope>(sql`
 WITH project_page AS MATERIALIZED (
 SELECT 'project:' || p.id AS key, p.id, p.org_id AS orgId, 'project' AS kind, p.name,
 CASE WHEN json_type(p.metadata, '$.continuity') = 'object' THEN json_extract(p.metadata, '$.continuity') END AS policy, p.created_at AS createdAt,
 coalesce(p.lead_tedi_id, o.tedi_id) AS owner, p.objective_id AS objectiveId
 FROM projects p LEFT JOIN tedi_objectives o ON o.id = p.objective_id AND o.org_id = p.org_id AND o.status = 'active'
 WHERE p.status = 'active'
 AND p.id > ${after.startsWith("project:") ? after.slice(8) : ""}
 ${after && !after.startsWith("project:") && after > "project:" ? sql`AND p.id < ${""}` : sql``}
 ${orgId !== undefined ? sql`AND p.org_id = ${orgId}` : sql``}
 ORDER BY p.id LIMIT ${CONTINUITY_SCOPE_BATCH_SIZE}
 ), objective_page AS MATERIALIZED (
 SELECT 'objective:' || o.id, o.id, o.org_id, 'objective', o.title,
 CASE WHEN json_type(o.gate_config, '$.continuity') = 'object' THEN json_extract(o.gate_config, '$.continuity') END, o.created_at,
 o.tedi_id, o.id
 FROM tedi_objectives o WHERE o.status = 'active'
 AND o.id > ${after.startsWith("objective:") ? after.slice(10) : ""}
 ${after && !after.startsWith("objective:") && after > "objective:" ? sql`AND o.id < ${""}` : sql``}
 ${orgId !== undefined ? sql`AND o.org_id = ${orgId}` : sql``}
 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.org_id AND p.objective_id = o.id AND p.status = 'active')
 ORDER BY o.id LIMIT ${CONTINUITY_SCOPE_BATCH_SIZE}
 ), scopes AS (
 SELECT * FROM project_page UNION ALL SELECT * FROM objective_page
 ), page AS MATERIALIZED (
 SELECT * FROM scopes ORDER BY key LIMIT ${CONTINUITY_SCOPE_BATCH_SIZE}
 ), scope_work AS MATERIALIZED (
 SELECT s.key, w.id AS workItemId, w.org_id AS orgId, w.disposition
 FROM page s CROSS JOIN work_items w ON w.org_id = s.orgId AND w.project_id = s.id WHERE s.kind = 'project'
 UNION ALL
 SELECT s.key, w.id, w.org_id, w.disposition
 FROM page s CROSS JOIN work_items w ON w.org_id = s.orgId AND w.objective_id = s.id WHERE s.kind = 'objective'
 ), work_counts AS (
 SELECT key, sum(disposition IN ('proposed','accepted')) AS pendingCount FROM scope_work GROUP BY key
 ), attempt_activity AS MATERIALIZED (
 SELECT w.key, max(julianday(coalesce(a.finished_at, a.heartbeat_at, a.started_at))) AS activity,
 sum(a.outcome = 'failed' AND w.disposition NOT IN ('completed','cancelled')) AS failedCount
 FROM scope_work w CROSS JOIN work_attempts a ON a.work_item_id = w.workItemId AND a.org_id = w.orgId GROUP BY w.key
 ), activity AS (
 SELECT key, activity FROM attempt_activity
 UNION ALL
 SELECT s.key, max(julianday(l.last_event_at)) FROM page s CROSS JOIN work_agent_sessions l
 ON l.organization_id = s.orgId AND l.project_id = s.id WHERE s.kind = 'project' GROUP BY s.key
 UNION ALL
 SELECT w.key, max(julianday(CASE WHEN r.status IN ('completed','failed','canceled') THEN coalesce(r.completed_at, r.started_at) ELSE coalesce(r.last_reconciled_at, r.started_at) END))
 FROM scope_work w CROSS JOIN skill_runs r ON r.work_item_id = w.workItemId AND r.organization_id = w.orgId
 WHERE r.runtime_environment = ${environment} GROUP BY w.key
 UNION ALL
 SELECT s.key, max(julianday(coalesce(g.completed_at, g.created_at)))
 FROM page s CROSS JOIN os_workspace_projects p ON p.organization_id = s.orgId AND p.project_id = s.id AND p.status = 'active'
 CROSS JOIN os_gadget_executions g ON g.organization_id = p.organization_id AND g.workspace_id = p.workspace_id
 WHERE s.kind = 'project' AND g.runtime_environment = ${environment} GROUP BY s.key
 UNION ALL
 SELECT s.key, max(julianday(coalesce(k.updated_at, k.created_at)))
 FROM page s CROSS JOIN tedi_tasks k ON k.org_id = s.orgId AND k.objective_id = s.objectiveId GROUP BY s.key
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

/** Environment-specific progress survives isolate recycling and cron receipt retention. */
export async function getStallRecoveryCheckpoint(
	db: DbQueryClient,
	environment: string,
) {
	const [row] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(
			eq(platformCronCheckpoints.scheduleId, `stall-recovery:${environment}`),
		)
		.limit(1);
	return row?.through ?? null;
}

/** A delayed tick cannot overwrite a checkpoint advanced by another invocation. */
export async function advanceStallRecoveryCheckpoint(
	db: DbQueryClient,
	environment: string,
	previous: string | null,
	next: string,
) {
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: `stall-recovery:${environment}`, through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? sql`0`
					: eq(platformCronCheckpoints.through, previous),
		});
}

/** Count canonical completed Work, not model turns or heartbeat traffic. */
export async function countContinuityResults(
	db: DbClient,
	scope: ContinuityScope,
	start: string,
	end: string,
): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)`.as("count") })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, scope.orgId),
				eq(workItems.disposition, "completed"),
				gte(workItems.completedAt, start),
				lt(workItems.completedAt, end),
				or(
					and(
						sql`${scope.kind} = 'project'`,
						eq(workItems.projectId, scope.id),
					),
					and(
						sql`${scope.kind} = 'objective'`,
						eq(workItems.objectiveId, scope.id),
					),
				),
			),
		);
	return Number(row?.count ?? 0);
}

export async function getStallReceipt(
	db: DbClient,
	orgId: string,
	clientEventId: string,
) {
	const [row] = await db
		.select({ occurredAt: learningInteractionEvents.occurredAt })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, orgId),
				eq(learningInteractionEvents.clientEventId, clientEventId),
				eq(learningInteractionEvents.surface, "stall_recovery"),
				eq(learningInteractionEvents.eventKind, "delivered"),
				eq(learningInteractionEvents.actorType, "service"),
				eq(learningInteractionEvents.actorId, "stall-recovery"),
			),
		)
		.limit(1);
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
		const target = sql<string>`${learningInteractionEvents.targetType} || ':' || ${learningInteractionEvents.targetId}`;
		const receipts = db.$with("receipts").as(
			db
				.select({
					key: target.as("key"),
					requestKey:
						sql<string>`${learningInteractionEvents.clientEventId}`.as(
							"requestKey",
						),
					tediId: sql<string | null>`${learningInteractionEvents.tediId}`.as(
						"tediId",
					),
					occurredAt: sql<string>`${learningInteractionEvents.occurredAt}`.as(
						"occurredAt",
					),
					position:
						sql<number>`row_number() OVER (PARTITION BY ${learningInteractionEvents.targetType}, ${learningInteractionEvents.targetId} ORDER BY ${learningInteractionEvents.occurredAt} DESC, ${learningInteractionEvents.id} DESC)`.as(
							"position",
						),
				})
				.from(learningInteractionEvents)
				.where(
					and(
						eq(learningInteractionEvents.organizationId, orgId),
						eq(learningInteractionEvents.surface, "stall_recovery"),
						eq(learningInteractionEvents.eventKind, "delivered"),
						sql`json_extract(${learningInteractionEvents.metadata}, '$.environment') = ${environment}`,
						eq(learningInteractionEvents.actorType, "service"),
						eq(learningInteractionEvents.actorId, "stall-recovery"),
						inArray(target, chunk),
					),
				),
		);
		rows.push(
			...(await db
				.with(receipts)
				.select({
					key: receipts.key,
					requestKey: receipts.requestKey,
					tediId: receipts.tediId,
					occurredAt: receipts.occurredAt,
				})
				.from(receipts)
				.where(eq(receipts.position, 1))),
		);
	}
	return rows;
}

export async function hasContinuityFix(
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
	const [row] = await db
		.select({ id: learningImprovementProposals.id })
		.from(learningImprovementProposals)
		.where(
			and(
				eq(learningImprovementProposals.organizationId, orgId),
				eq(learningImprovementProposals.clientProposalId, issueKey),
			),
		)
		.limit(1);
	return !!row;
}

/** Only the viewer's explicit open decisions; never another person's session capture. */
export async function listContinuityHumanAsks(
	db: DbClient,
	orgId: string,
	userId: string,
	now: string,
) {
	const i = alias(workInteractions, "i");
	const w = alias(workItems, "w");
	const a = alias(workInteractionAttention, "a");
	return db
		.select({
			id: i.id,
			need: sql<string>`coalesce(${a.need}, json_extract(${i.metadata}, '$.reason'), ${i.subject})`.as(
				"need",
			),
			projectId: sql<
				string | null
			>`coalesce(${i.projectId}, ${w.projectId})`.as("projectId"),
			objectiveId: sql<string | null>`${w.objectiveId}`.as("objectiveId"),
			creatorId: sql<string>`${i.creatorId}`.as("creatorId"),
		})
		.from(i)
		.leftJoin(w, and(eq(w.id, i.workItemId), eq(w.orgId, i.orgId)))
		.leftJoin(a, and(eq(a.orgId, i.orgId), eq(a.interactionId, i.id)))
		.where(
			and(
				eq(i.orgId, orgId),
				eq(i.targetType, "user"),
				eq(i.targetId, userId),
				eq(i.status, "open"),
				or(isNull(i.expiresAt), gt(i.expiresAt, now)),
				eq(i.creatorType, "tedi"),
				sql`${a.kind} IS NOT 'fyi'`,
				or(
					ne(i.kind, "coordination"),
					and(eq(a.kind, "needs_you"), sql`length(trim(${a.need})) > 0`),
				),
			),
		)
		.orderBy(i.createdAt, i.id)
		.limit(200);
}

/** Native detector incidents, independent of user/tedi feedback on the same issue. */
export async function listStallIncidents(
	db: DbClient,
	orgId: string,
	issueKey: string,
) {
	return db
		.select({ id: learningInteractionEvents.id })
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, orgId),
				eq(learningInteractionEvents.issueKey, issueKey),
				eq(learningInteractionEvents.surface, "stall_recovery"),
				eq(learningInteractionEvents.eventKind, "retried"),
				eq(learningInteractionEvents.actorType, "service"),
				eq(learningInteractionEvents.actorId, "stall-recovery"),
			),
		)
		.orderBy(
			desc(learningInteractionEvents.occurredAt),
			desc(learningInteractionEvents.id),
		)
		.limit(3);
}
