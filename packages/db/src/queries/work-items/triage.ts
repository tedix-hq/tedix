/**
 * Triage: a proposed Work Item is in triage, with or without a project. It
 * leaves by being accepted (`acceptWorkItem`), declined, marked a duplicate of
 * other Work, or snoozed until a wake time. The queues list what still needs
 * that decision.
 */
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, getColumns, isNull, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonWrite } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItem,
	workItems as d1WorkItems,
	workItemStoredColumns,
} from "../../schema/work-items";
import { cancelWorkItem, lifecycleEventInsert } from "./crud";
import {
	getScopedWorkItem,
	type WorkActor,
	WorkFactoryError,
} from "./factory-state";
import { normalizeWorkItemRow } from "./normalization";

function snoozedUntil(db: DbQueryClient) {
	return jsonRead(db, coreTable(db, d1WorkItems).metadata, [
		"triageSnoozedUntil",
	]);
}

/** Stored columns of the selected store's table; generated columns stay out. */
function storedColumns(db: DbQueryClient): typeof workItemStoredColumns {
	const columns = getColumns(coreTable(db, d1WorkItems));
	return Object.fromEntries(
		Object.keys(workItemStoredColumns).map((key) => [
			key,
			columns[key as keyof typeof columns],
		]),
	) as typeof workItemStoredColumns;
}

/** Proposed work whose snooze, if any, has ended: what a triage queue shows. */
function inTriageQueue(db: DbQueryClient, now: string) {
	const workItems = coreTable(db, d1WorkItems);
	return and(
		eq(workItems.disposition, "proposed"),
		sql`(${snoozedUntil(db)} IS NULL OR ${snoozedUntil(db)} <= ${now})`,
	)!;
}

function requireReason(reason: string): string {
	const trimmed = reason.trim();
	if (!trimmed)
		throw new WorkFactoryError(
			"ACCEPTANCE_REQUIRED",
			"Declining a proposal needs a reason",
		);
	return trimmed;
}

export interface TriageExitParams {
	orgId: string;
	workItemId: string;
	actor: WorkActor;
	expectedWorkItemVersion?: number;
	at?: string;
}

/** Decline: cancel a proposal, saying why. */
export async function declineProposedWorkItem(
	db: DbQueryClient,
	params: TriageExitParams & { reason: string },
): Promise<WorkItem> {
	return cancelWorkItem(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		actor: params.actor,
		reason: requireReason(params.reason),
		expectedWorkItemVersion: params.expectedWorkItemVersion,
		cancelledAt: params.at,
		triage: { exit: "declined" },
	});
}

/**
 * Duplicate: record that this proposal duplicates other Work and cancel it in
 * the same batch, so neither half can land without the other.
 */
export async function markWorkItemDuplicate(
	db: DbQueryClient,
	params: TriageExitParams & {
		relationId: string;
		duplicateOfWorkItemId: string;
		reason?: string;
	},
): Promise<WorkItem> {
	if (params.duplicateOfWorkItemId === params.workItemId)
		throw new WorkFactoryError(
			"NOT_READY",
			"A Work Item cannot duplicate itself",
		);
	const original = await getScopedWorkItem(
		db,
		params.orgId,
		params.duplicateOfWorkItemId,
	);
	return cancelWorkItem(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		actor: params.actor,
		reason: params.reason?.trim() || `Duplicate of "${original.title}"`,
		expectedWorkItemVersion: params.expectedWorkItemVersion,
		cancelledAt: params.at,
		triage: {
			exit: "duplicate",
			relationId: params.relationId,
			duplicateOfWorkItemId: original.id,
		},
	});
}

/**
 * Snooze: hide a proposal from the triage queues until `until`. A null `until`
 * wakes it now. The proposal stays proposed.
 */
export async function snoozeProposedWorkItem(
	db: DbQueryClient,
	params: TriageExitParams & { until: string | null },
): Promise<WorkItem> {
	const at = params.at ?? new Date().toISOString();
	const untilMs = params.until === null ? null : Date.parse(params.until);
	if (
		untilMs !== null &&
		(!Number.isFinite(untilMs) || untilMs <= Date.parse(at))
	)
		throw new WorkFactoryError(
			"NOT_READY",
			"A snooze must end at a future time",
		);
	// Canonical UTC text, so the queue can compare wake times as strings.
	const until = untilMs === null ? null : new Date(untilMs).toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const workItems = coreTable(db, d1WorkItems);
	const metadata = (
		until
			? jsonWrite(db, workItems.metadata, ["triageSnoozedUntil"], until)
			: coreStore(db) === "postgres"
				? sql`coalesce(${workItems.metadata}, '{}'::jsonb) - 'triageSnoozedUntil'`
				: sql`json_remove(coalesce(${workItems.metadata}, '{}'), '$.triageSnoozedUntil')`
	) as ReturnType<typeof sql<Record<string, JsonValue>>>;
	const update = db
		.update(workItems)
		.set({
			metadata,
			updatedAt: at,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.version, params.expectedWorkItemVersion ?? prior.version),
				eq(workItems.disposition, "proposed"),
			),
		)
		.returning(storedColumns(db));
	const event = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: "proposed",
		expectedVersion: prior.version + 1,
		eventType: until ? "work.snoozed" : "work.woken",
		actor: params.actor,
		occurredAt: at,
		payload: { until },
	});
	const [rows] = await db.batch([update, event]);
	const item = rows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Only proposed work can be snoozed",
		);
	return normalizeWorkItemRow(item);
}

export interface TriageQueueParams {
	orgId: string;
	/** A project's queue, or null for proposals that have no project yet. */
	projectId: string | null;
	now: string;
	limit?: number;
	offset?: number;
}

/** One triage queue, most urgent first and then oldest first. */
export async function listTriageQueue(
	db: DbQueryClient,
	params: TriageQueueParams,
): Promise<{ data: WorkItem[]; total: number }> {
	const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50), 1), 100);
	const offset = Math.max(Math.trunc(params.offset ?? 0), 0);
	const workItems = coreTable(db, d1WorkItems);
	const where = and(
		eq(workItems.orgId, params.orgId),
		params.projectId === null
			? isNull(workItems.projectId)
			: eq(workItems.projectId, params.projectId),
		inTriageQueue(db, params.now),
	);
	const rows = await db
		.select(storedColumns(db))
		.from(workItems)
		.where(where)
		.orderBy(
			sql`CASE ${workItems.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
			asc(workItems.createdAt),
			asc(workItems.id),
		)
		.limit(limit)
		.offset(offset);
	const [counted] = await db
		.select({ total: sql<number>`count(*)` })
		.from(workItems)
		.where(where);
	return {
		data: rows.map(normalizeWorkItemRow),
		total: Number(counted?.total ?? 0),
	};
}

/**
 * How much waits in each triage queue: one row per project that has waiting
 * proposals, a null project for proposals with none, and how many proposals
 * are snoozed out of every queue.
 */
export async function countTriageQueues(
	db: DbQueryClient,
	params: { orgId: string; now: string },
): Promise<{
	queues: { projectId: string | null; count: number }[];
	snoozed: number;
}> {
	const workItems = coreTable(db, d1WorkItems);
	const queues = await db
		.select({
			projectId: workItems.projectId,
			count: sql<number>`count(*)`.as("waiting"),
		})
		.from(workItems)
		.where(
			and(eq(workItems.orgId, params.orgId), inTriageQueue(db, params.now)),
		)
		.groupBy(workItems.projectId);
	const [snoozed] = await db
		.select({ total: sql<number>`count(*)` })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.disposition, "proposed"),
				sql`${snoozedUntil(db)} > ${params.now}`,
			),
		);
	return {
		queues: queues.map((row) => ({
			projectId: row.projectId,
			count: Number(row.count),
		})),
		snoozed: Number(snoozed?.total ?? 0),
	};
}
