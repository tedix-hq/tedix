import {
	and,
	desc,
	eq,
	inArray,
	lt,
	notInArray,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgQueryClient } from "../../client";
import { personalWorkFeedPredicate } from "./personal-feed";
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
	workItemRelations,
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
	db: PgQueryClient,
	params: {
		orgId: string;
		viewerUserId?: string;
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
				params.viewerUserId
					? personalWorkFeedPredicate(params.viewerUserId)
					: undefined,
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
	latest: { runtimeState: SQLWrapper; expiresAt: SQLWrapper },
	blockingCount: SQLWrapper,
) {
	const predicates: Record<WorkRecoverySignal, SQL> = {
		dependencies_blocked: sql`COALESCE(${blockingCount}, 0) > 0`,
		latest_attempt_failed: sql`${latest.runtimeState} = 'failed'`,
		latest_attempt_expired: sql`${latest.runtimeState} = 'expired'`,
		attempt_lease_elapsed: sql`${latest.runtimeState} IN ('queued', 'running', 'waiting', 'retrying') AND ${latest.expiresAt} IS NOT NULL AND ${latest.expiresAt} <= ${now}`,
	};
	return signal
		? predicates[signal]
		: sql`(${sql.join(Object.values(predicates), sql` OR `)})`;
}

export async function listOrgWorkRecovery(
	db: PgQueryClient,
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
	const rankedAttempts = db.$with("ranked_attempts").as(
		db
			.select({
				id: workAttempts.id,
				workItemId: workAttempts.workItemId,
				runtimeState: workAttempts.runtimeState,
				outcome: workAttempts.outcome,
				finishedAt: workAttempts.finishedAt,
				expiresAt: workAttempts.expiresAt,
				rank: sql<number>`ROW_NUMBER() OVER (
					PARTITION BY ${workAttempts.orgId}, ${workAttempts.workItemId}
					ORDER BY ${workAttempts.attemptNumber} DESC
				)`.as("rank"),
			})
			.from(workAttempts)
			.where(eq(workAttempts.orgId, params.orgId)),
	);
	const latest = db.$with("latest").as(
		db
			.select({
				id: rankedAttempts.id,
				workItemId: rankedAttempts.workItemId,
				runtimeState: rankedAttempts.runtimeState,
				outcome: rankedAttempts.outcome,
				finishedAt: rankedAttempts.finishedAt,
				expiresAt: rankedAttempts.expiresAt,
			})
			.from(rankedAttempts)
			.where(eq(rankedAttempts.rank, 1)),
	);
	const blocker = alias(workItems, "blocker");
	const blockers = db.$with("blockers").as(
		db
			.select({
				workItemId: sql<string>`${workItemRelations.toWorkItemId}`.as(
					"work_item_id",
				),
				blockingCount: sql<number>`COUNT(*)`.as("blocking_count"),
			})
			.from(workItemRelations)
			.innerJoin(
				blocker,
				and(
					eq(blocker.orgId, workItemRelations.orgId),
					eq(blocker.id, workItemRelations.fromWorkItemId),
				),
			)
			.where(
				and(
					eq(workItemRelations.orgId, params.orgId),
					eq(workItemRelations.relationType, "blocks"),
					notInArray(blocker.disposition, ["completed", "cancelled"]),
				),
			)
			.groupBy(workItemRelations.toWorkItemId),
	);
	const sortAt = sql<string>`COALESCE(${workItems.updatedAt}, ${workItems.createdAt})`;
	const rows = await db
		.with(rankedAttempts, latest, blockers)
		.select({
			id: workItems.id,
			title: workItems.title,
			disposition: workItems.disposition,
			workKind: workItems.workKind,
			riskLevel: workItems.riskLevel,
			priority: workItems.priority,
			projectId: workItems.projectId,
			accountableOwnerType: workItems.accountableOwnerType,
			accountableOwnerId: workItems.accountableOwnerId,
			sortAt: sortAt.as("sortAt"),
			blockingDependencyCount:
				sql<unknown>`COALESCE(${blockers.blockingCount}, 0)`.as(
					"blockingDependencyCount",
				),
			latestAttemptId: sql<string | null>`${latest.id}`.as("latestAttemptId"),
			latestAttemptState:
				sql<WorkAttemptRuntimeState | null>`${latest.runtimeState}`.as(
					"latestAttemptState",
				),
			latestAttemptOutcome:
				sql<WorkAttemptOutcome | null>`${latest.outcome}`.as(
					"latestAttemptOutcome",
				),
			latestAttemptFinishedAt: sql<string | null>`${latest.finishedAt}`.as(
				"latestAttemptFinishedAt",
			),
			latestAttemptExpiresAt: sql<string | null>`${latest.expiresAt}`.as(
				"latestAttemptExpiresAt",
			),
		})
		.from(workItems)
		.leftJoin(latest, eq(latest.workItemId, workItems.id))
		.leftJoin(blockers, eq(blockers.workItemId, workItems.id))
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.disposition, "accepted"),
				params.projectId
					? eq(workItems.projectId, params.projectId)
					: undefined,
				params.workKind ? eq(workItems.workKind, params.workKind) : undefined,
				params.riskLevel
					? eq(workItems.riskLevel, params.riskLevel)
					: undefined,
				params.priority ? eq(workItems.priority, params.priority) : undefined,
				recoveryPredicate(
					params.signal,
					params.observedAt,
					latest,
					blockers.blockingCount,
				),
				params.cursor
					? or(
							lt(sortAt, params.cursor.at),
							and(
								eq(sortAt, params.cursor.at),
								lt(workItems.id, params.cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(sortAt), desc(workItems.id))
		.limit(limit + 1);
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
