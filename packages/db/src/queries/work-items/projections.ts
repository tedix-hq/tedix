import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { prefixedColumns } from "../../utils/select";
import {
	type WorkAttempt,
	type WorkAttemptOutcome,
	type WorkAttemptRuntimeState,
	type WorkItemDisposition,
	type WorkItemKind,
	type WorkItemPriority,
	type WorkItemRiskLevel,
	workAttempts,
	workItems,
} from "../../schema/work-items";

export interface WorkFactoryProjectionCursor {
	at: string;
	id: string;
}

export interface WorkFactoryItemSummaryRow {
	id: string;
	title: string;
	disposition: WorkItemDisposition;
	workKind: WorkItemKind;
	riskLevel: WorkItemRiskLevel;
	priority: WorkItemPriority;
	projectId: string | null;
	accountableOwnerType: "user" | "tedi" | "team" | "system" | null;
	accountableOwnerId: string | null;
}

export interface WorkAttemptProjectionRow {
	attempt: WorkAttempt;
	workItem: WorkFactoryItemSummaryRow;
}
export type WorkRecoverySignal =
	| "dependencies_blocked"
	| "latest_attempt_failed"
	| "latest_attempt_expired"
	| "attempt_lease_elapsed";

export interface WorkRecoveryProjectionRow extends WorkFactoryItemSummaryRow {
	sortAt: string;
	signals: WorkRecoverySignal[];
	blockingDependencyCount: number;
	latestAttemptId: string | null;
	latestAttemptState: WorkAttemptRuntimeState | null;
	latestAttemptOutcome: WorkAttemptOutcome | null;
	latestAttemptFinishedAt: string | null;
	latestAttemptExpiresAt: string | null;
}

interface ProjectionPage<T> {
	data: T[];
	nextCursor: WorkFactoryProjectionCursor | null;
	hasMore: boolean;
}

function pageLimit(limit?: number): number {
	return Math.min(Math.max(1, Math.trunc(limit ?? 50)), 100);
}

function beforeCursor(
	at: Parameters<typeof eq>[0],
	id: Parameters<typeof eq>[0],
	cursor?: WorkFactoryProjectionCursor,
): SQL | undefined {
	if (!cursor) return undefined;
	return or(lt(at, cursor.at), and(eq(at, cursor.at), lt(id, cursor.id)));
}

const itemSummarySelection = {
	id: sql`${workItems.id}`.mapWith(workItems.id).as("factory_item_id"),
	title: sql`${workItems.title}`
		.mapWith(workItems.title)
		.as("factory_item_title"),
	disposition: sql`${workItems.disposition}`
		.mapWith(workItems.disposition)
		.as("factory_item_disposition"),
	workKind: sql`${workItems.workKind}`
		.mapWith(workItems.workKind)
		.as("factory_item_work_kind"),
	riskLevel: sql`${workItems.riskLevel}`
		.mapWith(workItems.riskLevel)
		.as("factory_item_risk_level"),
	priority: sql`${workItems.priority}`
		.mapWith(workItems.priority)
		.as("factory_item_priority"),
	projectId: sql`${workItems.projectId}`
		.mapWith(workItems.projectId)
		.as("factory_item_project_id"),
	accountableOwnerType: sql`${workItems.accountableOwnerType}`
		.mapWith(workItems.accountableOwnerType)
		.as("factory_item_accountable_owner_type"),
	accountableOwnerId: sql`${workItems.accountableOwnerId}`
		.mapWith(workItems.accountableOwnerId)
		.as("factory_item_accountable_owner_id"),
};

export async function listOrgWorkAttempts(
	db: DbQueryClient,
	params: {
		orgId: string;
		projectId?: string;
		workItemId?: string;
		runtimeStates?: WorkAttemptRuntimeState[];
		outcomes?: WorkAttemptOutcome[];
		executorType?: "tedi" | "external_agent";
		cursor?: WorkFactoryProjectionCursor;
		limit?: number;
	},
): Promise<ProjectionPage<WorkAttemptProjectionRow>> {
	const limit = pageLimit(params.limit);
	const rows = await db
		.select({
			attempt: prefixedColumns(workAttempts, "factory_attempt"),
			workItem: itemSummarySelection,
		})
		.from(workAttempts)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workAttempts.orgId),
				eq(workItems.id, workAttempts.workItemId),
			),
		)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				params.projectId
					? eq(workItems.projectId, params.projectId)
					: undefined,
				params.workItemId
					? eq(workAttempts.workItemId, params.workItemId)
					: undefined,
				params.runtimeStates?.length
					? // bound-params: API contract limits runtimeStates to 8 values.
						inArray(workAttempts.runtimeState, params.runtimeStates)
					: undefined,
				params.outcomes?.length
					? // bound-params: API contract limits outcomes to 4 values.
						inArray(workAttempts.outcome, params.outcomes)
					: undefined,
				params.executorType
					? eq(workAttempts.executorType, params.executorType)
					: undefined,
				beforeCursor(workAttempts.startedAt, workAttempts.id, params.cursor),
			),
		)
		.orderBy(desc(workAttempts.startedAt), desc(workAttempts.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit) as WorkAttemptProjectionRow[];
	const last = data.at(-1);
	return {
		data,
		hasMore: rows.length > limit,
		nextCursor:
			rows.length > limit && last
				? { at: last.attempt.startedAt, id: last.attempt.id }
				: null,
	};
}

function recoveryPredicate(
	signal: WorkRecoverySignal | undefined,
	now: string,
) {
	const predicates: Record<WorkRecoverySignal, SQL> = {
		dependencies_blocked: sql`COALESCE(blockers.blocking_count, 0) > 0`,
		latest_attempt_failed: sql`latest.runtime_state = 'failed'`,
		latest_attempt_expired: sql`latest.runtime_state = 'expired'`,
		attempt_lease_elapsed: sql`latest.runtime_state IN ('queued', 'running', 'waiting', 'retrying') AND latest.expires_at IS NOT NULL AND latest.expires_at <= ${now}`,
	};
	return signal
		? predicates[signal]
		: sql`(${sql.join(Object.values(predicates), sql` OR `)})`;
}

export async function listOrgWorkRecovery(
	db: DbQueryClient,
	params: {
		orgId: string;
		projectId?: string;
		workKind?: WorkItemKind;
		riskLevel?: WorkItemRiskLevel;
		priority?: WorkItemPriority;
		signal?: WorkRecoverySignal;
		observedAt: string;
		cursor?: WorkFactoryProjectionCursor;
		limit?: number;
	},
): Promise<ProjectionPage<WorkRecoveryProjectionRow>> {
	const limit = pageLimit(params.limit);
	type RawRecoveryRow = Omit<WorkRecoveryProjectionRow, "signals"> & {
		blockingDependencyCount: unknown;
	};
	const rows = await db.all<RawRecoveryRow>(sql`
		WITH ranked_attempts AS (
			SELECT attempt.*,
				ROW_NUMBER() OVER (
					PARTITION BY attempt.org_id, attempt.work_item_id
					ORDER BY attempt.attempt_number DESC
				) AS rank
			FROM ${workAttempts} AS attempt
			WHERE attempt.org_id = ${params.orgId}
		), latest AS (
			SELECT * FROM ranked_attempts WHERE rank = 1
		), blockers AS (
			SELECT relation.to_work_item_id AS work_item_id, COUNT(*) AS blocking_count
			FROM work_item_relations AS relation
			INNER JOIN work_items AS blocker
				ON blocker.org_id = relation.org_id
				AND blocker.id = relation.from_work_item_id
			WHERE relation.org_id = ${params.orgId}
				AND relation.relation_type = 'blocks'
				AND blocker.disposition NOT IN ('completed', 'cancelled')
			GROUP BY relation.to_work_item_id
		)
		SELECT item.id AS id,
			item.title AS title,
			item.disposition AS disposition,
			item.work_kind AS workKind,
			item.risk_level AS riskLevel,
			item.priority AS priority,
			item.project_id AS projectId,
			item.accountable_owner_type AS accountableOwnerType,
			item.accountable_owner_id AS accountableOwnerId,
			COALESCE(item.updated_at, item.created_at) AS sortAt,
			COALESCE(blockers.blocking_count, 0) AS blockingDependencyCount,
			latest.id AS latestAttemptId,
			latest.runtime_state AS latestAttemptState,
			latest.outcome AS latestAttemptOutcome,
			latest.finished_at AS latestAttemptFinishedAt,
			latest.expires_at AS latestAttemptExpiresAt
		FROM ${workItems} AS item
		LEFT JOIN latest ON latest.work_item_id = item.id
		LEFT JOIN blockers ON blockers.work_item_id = item.id
		WHERE item.org_id = ${params.orgId}
			AND item.disposition = 'accepted'
			${params.projectId ? sql`AND item.project_id = ${params.projectId}` : sql``}
			${params.workKind ? sql`AND item.work_kind = ${params.workKind}` : sql``}
			${params.riskLevel ? sql`AND item.risk_level = ${params.riskLevel}` : sql``}
			${params.priority ? sql`AND item.priority = ${params.priority}` : sql``}
			AND ${recoveryPredicate(params.signal, params.observedAt)}
			${
				params.cursor
					? sql`AND (COALESCE(item.updated_at, item.created_at) < ${params.cursor.at} OR (COALESCE(item.updated_at, item.created_at) = ${params.cursor.at} AND item.id < ${params.cursor.id}))`
					: sql``
			}
		ORDER BY sortAt DESC, item.id DESC
		LIMIT ${limit + 1}
	`);
	const data: WorkRecoveryProjectionRow[] = rows.slice(0, limit).map((row) => {
		const signals: WorkRecoverySignal[] = [];
		if (Number(row.blockingDependencyCount) > 0)
			signals.push("dependencies_blocked");
		if (row.latestAttemptState === "failed")
			signals.push("latest_attempt_failed");
		if (row.latestAttemptState === "expired")
			signals.push("latest_attempt_expired");
		if (
			row.latestAttemptState &&
			["queued", "running", "waiting", "retrying"].includes(
				row.latestAttemptState,
			) &&
			row.latestAttemptExpiresAt !== null &&
			row.latestAttemptExpiresAt <= params.observedAt
		)
			signals.push("attempt_lease_elapsed");
		return {
			id: row.id,
			title: row.title,
			disposition: row.disposition,
			workKind: row.workKind,
			riskLevel: row.riskLevel,
			priority: row.priority,
			projectId: row.projectId,
			accountableOwnerType: row.accountableOwnerType,
			accountableOwnerId: row.accountableOwnerId,
			sortAt: row.sortAt,
			signals,
			blockingDependencyCount: Number(row.blockingDependencyCount),
			latestAttemptId: row.latestAttemptId,
			latestAttemptState: row.latestAttemptState,
			latestAttemptOutcome: row.latestAttemptOutcome,
			latestAttemptFinishedAt: row.latestAttemptFinishedAt,
			latestAttemptExpiresAt: row.latestAttemptExpiresAt,
		};
	});
	const last = data.at(-1);
	return {
		data,
		hasMore: rows.length > limit,
		nextCursor:
			rows.length > limit && last ? { at: last.sortAt, id: last.id } : null,
	};
}
