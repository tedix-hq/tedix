import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItem,
	type WorkItemDisposition,
	type WorkItemAcceptanceContract,
	type WorkItemAccountabilityPrincipalType,
	type WorkItemClass,
	type WorkItemKind,
	type WorkItemPriority,
	type WorkItemProjection,
	type WorkItemProjectionDirection,
	type WorkItemProjectionStatus,
	type WorkItemRiskLevel,
	workAttempts,
	workEvents,
	workItemProjections,
	workItems,
} from "../../schema/work-items";
import { normalizeWorkItemRow } from "./normalization";

export interface CreateWorkItemParams {
	id: string;
	orgId: string;
	title: string;
	description?: string;
	workKind?: WorkItemKind;
	riskLevel?: WorkItemRiskLevel;
	requiredCapabilities?: string[];
	requiredAuthorities?: string[];
	accountableOwnerType?: WorkItemAccountabilityPrincipalType;
	accountableOwnerId?: string;
	stewardType?: WorkItemAccountabilityPrincipalType;
	stewardId?: string;
	priority?: WorkItemPriority;
	objectiveId?: string;
	workClass?: WorkItemClass;
	purposeExceptionExpiresAt?: string;
	projectId?: string;
	parentWorkItemId?: string;
	sourceSessionKey?: string;
	sourceIntentId?: string;
	dueDate?: string;
	deadline?: string;
	startAt?: string;
	durationDays?: number;
	provenance?: Record<string, JsonValue>;
	metadata?: Record<string, JsonValue>;
	createdAt: string;
}

function lifecycleEventInsert(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		disposition: WorkItemDisposition;
		expectedVersion: number;
		eventType: string;
		actor: WorkActor;
		occurredAt: string;
		payload?: Record<string, JsonValue>;
	},
) {
	const eventId = crypto.randomUUID();
	return db.insert(workEvents).select(
		db
			.select({
				id: sql<string>`${eventId}`.as("id"),
				orgId: workItems.orgId,
				workItemId: workItems.id,
				attemptId: sql<null>`NULL`.as("attempt_id"),
				eventType: sql<string>`${params.eventType}`.as("event_type"),
				actorType: sql<typeof params.actor.type>`${params.actor.type}`.as(
					"actor_type",
				),
				actorId: sql<string>`${params.actor.id}`.as("actor_id"),
				actorSessionId: sql<
					string | null
				>`${params.actor.sessionId ?? null}`.as("actor_session_id"),
				payload: sql<
					Record<string, JsonValue>
				>`${JSON.stringify(params.payload ?? {})}`.as("payload"),
				occurredAt: sql<string>`${params.occurredAt}`.as("occurred_at"),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					eq(workItems.id, params.workItemId),
					eq(workItems.disposition, params.disposition),
					eq(workItems.version, params.expectedVersion),
				),
			),
	);
}

export async function createWorkItem(
	db: DbQueryClient,
	params: CreateWorkItemParams,
): Promise<WorkItem> {
	const row = (
		await db
			.insert(workItems)
			.values({
				...params,
				disposition: "proposed",
				workKind: params.workKind ?? "other",
				riskLevel: params.riskLevel ?? "medium",
				requiredCapabilities: params.requiredCapabilities ?? [],
				requiredAuthorities: params.requiredAuthorities ?? [],
				admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
				priority: params.priority ?? "medium",
				provenance: params.provenance ?? {},
				metadata: params.metadata ?? {},
			})
			.returning()
	)[0];
	if (!row) throw new Error("Work Item insert returned no row");
	return normalizeWorkItemRow(row);
}

export async function getWorkItemById(
	db: DbQueryClient,
	workItemId: string,
	orgId?: string,
): Promise<WorkItem | null> {
	const row =
		(
			await db
				.select()
				.from(workItems)
				.where(
					and(
						eq(workItems.id, workItemId),
						orgId ? eq(workItems.orgId, orgId) : undefined,
					),
				)
				.limit(1)
		)[0] ?? null;
	return row ? normalizeWorkItemRow(row) : null;
}

/** Resolve the idempotency key used by Home and other durable producers. */
export async function getWorkItemBySourceIntentId(
	db: DbQueryClient,
	params: { orgId: string; sourceIntentId: string },
): Promise<WorkItem | null> {
	const row =
		(
			await db
				.select()
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, params.orgId),
						eq(workItems.sourceIntentId, params.sourceIntentId),
					),
				)
				.limit(1)
		)[0] ?? null;
	return row ? normalizeWorkItemRow(row) : null;
}

export interface ListWorkItemsOptions {
	orgId: string;
	projectId?: string | null;
	parentWorkItemId?: string | null;
	disposition?: WorkItem["disposition"];
	workKind?: WorkItemKind;
	limit?: number;
}

export async function listWorkItems(
	db: DbQueryClient,
	options: ListWorkItemsOptions,
): Promise<WorkItem[]> {
	const rows = await db
		.select()
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, options.orgId),
				options.projectId === undefined
					? undefined
					: options.projectId === null
						? isNull(workItems.projectId)
						: eq(workItems.projectId, options.projectId),
				options.parentWorkItemId === undefined
					? undefined
					: options.parentWorkItemId === null
						? isNull(workItems.parentWorkItemId)
						: eq(workItems.parentWorkItemId, options.parentWorkItemId),
				options.disposition
					? eq(workItems.disposition, options.disposition)
					: undefined,
				options.workKind ? eq(workItems.workKind, options.workKind) : undefined,
			),
		)
		.orderBy(desc(workItems.createdAt))
		.limit(options.limit ?? 100);
	return rows.map(normalizeWorkItemRow);
}

/** Escape LIKE metacharacters so a caller's substring stays a literal match. */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Exclusive upper bound for a BINARY-collation prefix scan: the prefix with its
 * final code unit incremented. `id >= prefix AND id < successor` is exactly
 * `id LIKE 'prefix%'` for a TEXT PRIMARY KEY, and — unlike LIKE — SQLite can
 * satisfy it from the primary-key index instead of scanning the whole org.
 */
function prefixUpperBound(prefix: string): string {
	const last = prefix.charCodeAt(prefix.length - 1);
	return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

const FULL_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ListWorkItemsPageOptions {
	orgId: string;
	projectId?: string | null;
	parentWorkItemId?: string | null;
	disposition?: WorkItem["disposition"];
	workKind?: WorkItemKind;
	objectiveId?: string;
	workClass?: WorkItemClass;
	/** Lowercase id fragment (6-36 chars of `[0-9a-f-]`), matched in SQL. */
	idPrefix?: string;
	/** Case-insensitive title substring; LIKE wildcards stay literal. */
	titleContains?: string;
	/**
	 * Exclude records with metadata.agentSession or a metadata.purposeContext
	 * beginning with `transitional_` before pagination. This coarse prefilter
	 * is not authorization or a complete customer-visibility decision.
	 */
	customerVisiblePreFilter?: boolean;
	limit?: number;
	offset?: number;
}

export interface ListWorkItemsPageResult {
	data: WorkItem[];
	/** Exact `COUNT(*)` over the filtered set — never a window size. */
	total: number;
}

/**
 * One board page with EVERY filter applied in SQL and an exact count.
 *
 * The predecessor read a fixed 1,000-row window and then filtered and paged it
 * in memory, so `total` reported the window size, `idPrefix` could not see a row
 * older than the newest 1,000 of its disposition, and every count was a
 * count-within-the-window. It lied coherently, which is why two remediation
 * cohorts were sized 9x and 13x too small before anyone noticed. Nothing here
 * may reintroduce a prefetch: the ORDER BY carries `id` as a deterministic
 * tie-break so offset pages stay stable across equal `created_at` values.
 */
export async function listWorkItemsPage(
	db: DbQueryClient,
	options: ListWorkItemsPageOptions,
): Promise<ListWorkItemsPageResult> {
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
	const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
	const idPrefix = options.idPrefix?.trim().toLowerCase();
	const titleContains = options.titleContains?.toLowerCase();
	const where = and(
		eq(workItems.orgId, options.orgId),
		options.projectId === undefined
			? undefined
			: options.projectId === null
				? isNull(workItems.projectId)
				: eq(workItems.projectId, options.projectId),
		options.parentWorkItemId === undefined
			? undefined
			: options.parentWorkItemId === null
				? isNull(workItems.parentWorkItemId)
				: eq(workItems.parentWorkItemId, options.parentWorkItemId),
		options.disposition
			? eq(workItems.disposition, options.disposition)
			: undefined,
		options.workKind ? eq(workItems.workKind, options.workKind) : undefined,
		options.objectiveId
			? eq(workItems.objectiveId, options.objectiveId)
			: undefined,
		options.workClass ? eq(workItems.workClass, options.workClass) : undefined,
		// A complete id is an exact primary-key lookup; anything shorter is an
		// index-backed range over the prefix. Neither depends on the row's age.
		idPrefix
			? FULL_UUID_PATTERN.test(idPrefix)
				? eq(workItems.id, idPrefix)
				: and(
						gte(workItems.id, idPrefix),
						lt(workItems.id, prefixUpperBound(idPrefix)),
					)
			: undefined,
		titleContains
			? sql`lower(${workItems.title}) LIKE ${`%${escapeLikePattern(titleContains)}%`} ESCAPE '\\'`
			: undefined,
		// `_` is a LIKE wildcard, so `transitional_` must be escaped or it also
		// matches `transitionalX`.
		options.customerVisiblePreFilter
			? sql`json_extract(${workItems.metadata}, '$.agentSession') IS NULL AND (json_extract(${workItems.metadata}, '$.purposeContext') IS NULL OR json_extract(${workItems.metadata}, '$.purposeContext') NOT LIKE 'transitional\\_%' ESCAPE '\\')`
			: undefined,
	);
	const rows = await db
		.select()
		.from(workItems)
		.where(where)
		.orderBy(desc(workItems.createdAt), desc(workItems.id))
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

/** Uncapped goal-loop counts with a bounded operator-facing outstanding preview. */
export async function getGoalLoopWorkItemSnapshot(
	db: DbQueryClient,
	params: {
		orgId: string;
		objectiveId: string;
		outstandingPreviewLimit?: number;
	},
): Promise<{
	total: number;
	doneCount: number;
	outstandingCount: number;
	outstandingIds: string[];
}> {
	const previewLimit = Math.max(
		0,
		Math.min(Math.trunc(params.outstandingPreviewLimit ?? 100), 500),
	);
	type SnapshotRow = {
		total: unknown;
		doneCount: unknown;
		outstandingCount: unknown;
		outstandingId: string | null;
	};
	const rows = await db.all<SnapshotRow>(sql`
		WITH scoped AS (
			SELECT id, disposition, created_at
			FROM ${workItems}
			WHERE org_id = ${params.orgId}
				AND objective_id = ${params.objectiveId}
		), counts AS (
			SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN disposition = 'completed' THEN 1 ELSE 0 END), 0) AS done_count,
				COALESCE(SUM(CASE WHEN disposition != 'completed' THEN 1 ELSE 0 END), 0) AS outstanding_count
			FROM scoped
		), outstanding_preview AS (
			SELECT id
			FROM scoped
			WHERE disposition != 'completed'
			ORDER BY created_at, id
			LIMIT ${previewLimit}
		)
		SELECT counts.total AS total,
			counts.done_count AS doneCount,
			counts.outstanding_count AS outstandingCount,
			outstanding_preview.id AS outstandingId
		FROM counts
		LEFT JOIN outstanding_preview ON 1 = 1
		ORDER BY outstanding_preview.id
	`);
	const counts = rows[0] ?? {
		total: 0,
		doneCount: 0,
		outstandingCount: 0,
		outstandingId: null,
	};
	return {
		total: Number(counts.total),
		doneCount: Number(counts.doneCount),
		outstandingCount: Number(counts.outstandingCount),
		outstandingIds: rows.flatMap((row) =>
			row.outstandingId ? [row.outstandingId] : [],
		),
	};
}

export interface UpsertWorkItemProjectionParams {
	id: string;
	workItemId: string;
	orgId: string;
	provider: string;
	direction?: WorkItemProjectionDirection;
	status?: WorkItemProjectionStatus;
	externalId?: string | null;
	externalUrl?: string | null;
	externalProjectId?: string | null;
	externalSectionId?: string | null;
	lastSyncedAt?: string | null;
	lastError?: string | null;
	syncCursor?: string | null;
	providerState?: Record<string, JsonValue>;
	createdAt: string;
	updatedAt?: string | null;
}

export async function upsertWorkItemProjection(
	db: DbQueryClient,
	params: UpsertWorkItemProjectionParams,
): Promise<WorkItemProjection> {
	return (
		await db
			.insert(workItemProjections)
			.values({
				...params,
				direction: params.direction ?? "projection",
				status: params.status ?? "pending",
			})
			.onConflictDoUpdate({
				target: [workItemProjections.workItemId, workItemProjections.provider],
				set: {
					direction: params.direction,
					status: params.status,
					externalId: params.externalId,
					externalUrl: params.externalUrl,
					externalProjectId: params.externalProjectId,
					externalSectionId: params.externalSectionId,
					lastSyncedAt: params.lastSyncedAt,
					lastError: params.lastError,
					syncCursor: params.syncCursor,
					providerState: params.providerState,
					updatedAt: params.updatedAt,
				},
			})
			.returning()
	)[0]!;
}

export async function listWorkItemProjections(
	db: DbQueryClient,
	workItemId: string,
): Promise<WorkItemProjection[]> {
	return db
		.select()
		.from(workItemProjections)
		.where(eq(workItemProjections.workItemId, workItemId));
}

export interface OrgProjectionRow {
	id: string;
	workItemId: string;
	workItemTitle: string;
	workItemStatus: WorkItem["disposition"];
	projectId: string | null;
	provider: string;
	direction: WorkItemProjectionDirection;
	syncStatus: WorkItemProjectionStatus;
	externalId: string | null;
	externalUrl: string | null;
	lastSyncedAt: string | null;
	lastError: string | null;
	createdAt: string;
}

export async function listOrgWorkItemProjections(
	db: DbQueryClient,
	params: {
		orgId: string;
		provider?: string;
		projectId?: string;
		limit?: number;
		offset?: number;
	},
): Promise<{ data: OrgProjectionRow[]; total: number }> {
	const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
	const offset = Math.max(params.offset ?? 0, 0);
	const where = and(
		eq(workItemProjections.orgId, params.orgId),
		params.provider
			? eq(workItemProjections.provider, params.provider)
			: undefined,
		params.projectId ? eq(workItems.projectId, params.projectId) : undefined,
	);
	const rows = await db
		.select({
			id: workItemProjections.id,
			workItemId: workItemProjections.workItemId,
			workItemTitle: workItems.title,
			workItemStatus: workItems.disposition,
			projectId: workItems.projectId,
			provider: workItemProjections.provider,
			direction: workItemProjections.direction,
			syncStatus: workItemProjections.status,
			externalId: workItemProjections.externalId,
			externalUrl: workItemProjections.externalUrl,
			lastSyncedAt: workItemProjections.lastSyncedAt,
			lastError: workItemProjections.lastError,
			createdAt: workItemProjections.createdAt,
		})
		.from(workItemProjections)
		.innerJoin(
			workItems,
			and(
				eq(workItems.id, workItemProjections.workItemId),
				eq(workItems.orgId, workItemProjections.orgId),
			),
		)
		.where(where)
		// `id` is a deterministic tie-break: without it two projections sharing a
		// `created_at` order arbitrarily per statement, so an OFFSET page could
		// repeat or skip rows.
		.orderBy(desc(workItemProjections.createdAt), desc(workItemProjections.id))
		.limit(limit)
		.offset(offset);
	const [counted] = await db
		.select({ total: sql<number>`count(*)` })
		.from(workItemProjections)
		.innerJoin(
			workItems,
			and(
				eq(workItems.id, workItemProjections.workItemId),
				eq(workItems.orgId, workItemProjections.orgId),
			),
		)
		.where(where);
	return { data: rows, total: Number(counted?.total ?? 0) };
}

import {
	getScopedWorkItem,
	type WorkActor,
	WorkFactoryError,
} from "./factory-state";
export async function acceptWorkItem(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		acceptanceContract: WorkItemAcceptanceContract;
		actor: WorkActor;
		acceptedAt?: string;
	},
): Promise<WorkItem> {
	const acceptedAt = params.acceptedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	// Acceptance fixes the outcome in plain language; an empty contract says
	// nothing about done.
	if (!params.acceptanceContract.doneLooksLike?.trim())
		throw new WorkFactoryError(
			"ACCEPTANCE_REQUIRED",
			"An acceptance contract must state what done looks like",
		);
	const acceptMutation = db
		.update(workItems)
		.set({
			disposition: "accepted",
			acceptanceContract: params.acceptanceContract,
			acceptedAt,
			updatedAt: acceptedAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.disposition, "proposed"),
				eq(workItems.version, prior.version),
			),
		)
		.returning();
	const acceptEvent = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: "accepted",
		expectedVersion: prior.version + 1,
		eventType: "work.accepted",
		actor: params.actor,
		occurredAt: acceptedAt,
	});
	const [acceptedRows] = await db.batch([acceptMutation, acceptEvent]);
	const item = acceptedRows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Only proposed work can be accepted",
		);
	return normalizeWorkItemRow(item);
}

export async function completeWorkItem(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		completedAt?: string;
	},
): Promise<WorkItem> {
	const completedAt = params.completedAt ?? new Date().toISOString();
	const item = await getScopedWorkItem(db, params.orgId, params.workItemId);
	// Completion is idempotent. Any peer that re-issues complete on an already
	// completed item reads the settled row back rather than failing, so a
	// double-send drains instead of deadlocking the item.
	if (item.disposition === "completed") return item;
	// Settled means done: completion carries no evidence count and no review
	// requirement (docs/decisions/minimal-gates-over-pre-proof.md). Legacy
	// contract-bearing items and contract-less items complete through one path.
	if (item.disposition !== "accepted")
		throw new WorkFactoryError(
			"ACCEPTANCE_REQUIRED",
			"Only accepted work can complete",
		);
	const completeMutation = db
		.update(workItems)
		.set({
			disposition: "completed",
			completedAt,
			updatedAt: completedAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.id, params.workItemId),
				eq(workItems.orgId, params.orgId),
				eq(workItems.version, item.version),
				eq(workItems.disposition, "accepted"),
				sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${params.orgId} AND active_attempt.work_item_id = ${params.workItemId} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${completedAt}))`,
			),
		)
		.returning();
	const completeEvent = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: "completed",
		expectedVersion: item.version + 1,
		eventType: "work.completed",
		actor: params.actor,
		occurredAt: completedAt,
	});
	const [completedRows] = await db.batch([completeMutation, completeEvent]);
	const completed = completedRows[0];
	if (!completed)
		throw new WorkFactoryError(
			"NOT_READY",
			"Work changed while completion was evaluated",
		);
	return normalizeWorkItemRow(completed);
}

export async function cancelWorkItem(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		reason?: string;
		cancelledAt?: string;
	},
): Promise<WorkItem> {
	const cancelledAt = params.cancelledAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const cancelMutation = db
		.update(workItems)
		.set({
			disposition: "cancelled",
			cancelledAt,
			updatedAt: cancelledAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.version, prior.version),
				inArray(workItems.disposition, ["proposed", "accepted"]),
				sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${params.orgId} AND active_attempt.work_item_id = ${params.workItemId} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${cancelledAt}))`,
			),
		)
		.returning();
	const cancelEvent = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: "cancelled",
		expectedVersion: prior.version + 1,
		eventType: "work.cancelled",
		actor: params.actor,
		occurredAt: cancelledAt,
		payload: { reason: params.reason ?? null },
	});
	const [cancelledRows] = await db.batch([cancelMutation, cancelEvent]);
	const item = cancelledRows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Terminal work cannot be cancelled",
		);
	return normalizeWorkItemRow(item);
}

export async function updateWorkItemSpecification(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		title?: string;
		description?: string | null;
		workKind?: WorkItemKind;
		riskLevel?: WorkItemRiskLevel;
		priority?: WorkItemPriority;
		accountableOwnerType?: WorkItemAccountabilityPrincipalType | null;
		accountableOwnerId?: string | null;
		stewardType?: WorkItemAccountabilityPrincipalType | null;
		stewardId?: string | null;
		expectedWorkItemVersion?: number;
		requiredCapabilities?: string[];
		requiredAuthorities?: string[];
		startAt?: string | null;
		durationDays?: number | null;
		updatedAt?: string;
	},
): Promise<WorkItem> {
	const updatedAt = params.updatedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const updateMutation = db
		.update(workItems)
		.set({
			title: params.title,
			description: params.description,
			workKind: params.workKind,
			riskLevel: params.riskLevel,
			priority: params.priority,
			accountableOwnerType: params.accountableOwnerType,
			accountableOwnerId: params.accountableOwnerId,
			stewardType: params.stewardType,
			stewardId: params.stewardId,
			requiredCapabilities: params.requiredCapabilities,
			requiredAuthorities: params.requiredAuthorities,
			startAt: params.startAt,
			durationDays: params.durationDays,
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			updatedAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.version, params.expectedWorkItemVersion ?? prior.version),
				ne(workItems.disposition, "completed"),
				ne(workItems.disposition, "cancelled"),
			),
		)
		.returning();
	const updateEvent = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: prior.disposition,
		expectedVersion: prior.version + 1,
		eventType: "work.specification_updated",
		actor: params.actor,
		occurredAt: updatedAt,
	});
	const [updatedRows] = await db.batch([updateMutation, updateEvent]);
	const item = updatedRows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Terminal work specifications are immutable",
		);
	return normalizeWorkItemRow(item);
}
