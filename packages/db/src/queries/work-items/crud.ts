import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	containsCardSecret,
	CARD_SECRET_MESSAGE,
} from "@tedix/api-contract/utils/card-secrets";
import type { LaneDispatchPlan } from "@tedix/api-contract/schemas/work-items";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
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
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { normalizeWorkItemRow } from "./normalization";
import { resolveWorkItemSteward } from "./stewardship";

export interface CreateWorkItemParams {
	id: string;
	orgId: string;
	/** Supplied by authenticated ingress, never from request metadata. */
	createdBy?: WorkActor;
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

function dispatchReceiptInsert(
	db: DbQueryClient,
	item: WorkItem,
	executor: string,
	at: string,
	receiptId: string,
) {
	return db.insert(workItemComments).select(
		db
			.select({
				id: sql<string>`${receiptId}`.as("id"),
				workItemId: workItems.id,
				orgId: workItems.orgId,
				authorType: sql<string>`'system'`.as("author_type"),
				authorId: sql<string>`'lane-dispatch'`.as("author_id"),
				body: sql<string>`${`Dispatched to ${executor} at ${at}`}`.as("body"),
				metadata: sql<Record<string, JsonValue>>`'{}'`.as("metadata"),
				createdAt: sql<string>`${at}`.as("created_at"),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, item.orgId),
					eq(workItems.id, item.id),
					eq(workItems.version, item.version + 1),
					eq(workItems.updatedAt, at),
					sql`json_extract(${workItems.metadata}, '$.laneDispatchReceiptId') = ${receiptId}`,
				),
			),
	);
}

export async function createWorkItem(
	db: DbQueryClient,
	params: CreateWorkItemParams,
): Promise<WorkItem> {
	const stewardship = await resolveWorkItemSteward(db, params);
	const { createdBy, ...values } = params;
	const insert = db
		.insert(workItems)
		.values({
			...values,
			...stewardship,
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
		.returning();
	const rows = createdBy
		? (
				await db.batch([
					insert,
					db.insert(workEvents).values({
						id: crypto.randomUUID(),
						orgId: params.orgId,
						workItemId: params.id,
						eventType: "work.created",
						actorType: createdBy.type,
						actorId: createdBy.id,
						actorSessionId: createdBy.sessionId,
						payload: {},
						occurredAt: params.createdAt,
					}),
				])
			)[0]
		: await insert;
	const row = rows[0];
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

/**
 * Titles for 8-character short ids quoted in text. A short id that matches
 * no Work Item, or more than one, is left out.
 */
export async function listWorkItemTitlesByShortIds(
	db: DbQueryClient,
	params: { orgId: string; shortIds: readonly string[] },
): Promise<Array<{ shortId: string; title: string }>> {
	const shortIds = [...new Set(params.shortIds.map((id) => id.toLowerCase()))]
		.filter((id) => /^[0-9a-f]{8}$/.test(id))
		.slice(0, 20);
	if (!shortIds.length) return [];
	const rows = await db
		.select({ id: workItems.id, title: workItems.title })
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				or(
					...shortIds.map((id) =>
						and(gte(workItems.id, id), lt(workItems.id, prefixUpperBound(id))),
					),
				),
			),
		)
		.limit(shortIds.length * 2);
	return shortIds.flatMap((shortId) => {
		const [match, ...others] = rows.filter((row) => row.id.startsWith(shortId));
		return match && !others.length ? [{ shortId, title: match.title }] : [];
	});
}

export interface ListWorkItemsPageOptions {
	orgId: string;
	executor?: string;
	dispatchReadyOnly?: boolean;
	projectId?: string | null;
	parentWorkItemId?: string | null;
	disposition?: WorkItem["disposition"];
	workKind?: WorkItemKind;
	objectiveId?: string;
	workClass?: WorkItemClass;
	/** Exact accountable owner identity, of any owner type. */
	accountableOwnerId?: string;
	/** true: only rows with an objective; false: only rows without one. */
	objectiveLinked?: boolean;
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
		options.executor
			? sql`json_extract(${workItems.metadata}, '$.executor') = ${options.executor}`
			: undefined,
		options.dispatchReadyOnly
			? sql`(json_type(${workItems.metadata}, '$.laneDispatch') IS NULL OR json_extract(${workItems.metadata}, '$.laneDispatch.state') = 'ready')`
			: undefined,
		options.workKind ? eq(workItems.workKind, options.workKind) : undefined,
		options.objectiveId
			? eq(workItems.objectiveId, options.objectiveId)
			: undefined,
		options.workClass ? eq(workItems.workClass, options.workClass) : undefined,
		// The org's dominant owner otherwise fills every page, so an owner's
		// items must be selected before paging, not filtered from a page.
		options.accountableOwnerId
			? eq(workItems.accountableOwnerId, options.accountableOwnerId)
			: undefined,
		options.objectiveLinked === undefined
			? undefined
			: options.objectiveLinked
				? isNotNull(workItems.objectiveId)
				: isNull(workItems.objectiveId),
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
		// `instr`, not LIKE: D1 caps a LIKE/GLOB pattern at 50 bytes, so a
		// substring of 48+ characters (every delegation title the CLI searches
		// for before creating one) made the whole page a D1_ERROR. `instr` takes
		// the bound substring at any length and needs no wildcard escaping.
		titleContains
			? sql`instr(lower(${workItems.title}), ${titleContains}) > 0`
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
	const executor = prior.metadata?.executor;
	const dispatch = ["codex", "claude-code", "tedi", "human"].includes(
		String(executor),
	);
	const receiptId = crypto.randomUUID();
	const acceptMutation = db
		.update(workItems)
		.set({
			disposition: "accepted",
			...(dispatch
				? {
						metadata: {
							...prior.metadata,
							laneDispatch: { state: "ready" as const },
							laneDispatchReceiptId: receiptId,
						},
					}
				: {}),
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
	const [acceptedRows] = await db.batch([
		acceptMutation,
		acceptEvent,
		...(dispatch
			? [
					dispatchReceiptInsert(
						db,
						prior,
						String(executor),
						acceptedAt,
						receiptId,
					),
				]
			: []),
	]);
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
		expectedWorkItemVersion?: number;
		completedAt?: string;
		closingComment?: {
			id: string;
			body: string;
			metadata?: Record<string, JsonValue>;
		};
	},
): Promise<WorkItem> {
	const completedAt = params.completedAt ?? new Date().toISOString();
	if (
		params.closingComment &&
		containsCardSecret([
			params.closingComment.body,
			params.closingComment.metadata,
		])
	)
		throw new Error(CARD_SECRET_MESSAGE);
	const item = await getScopedWorkItem(db, params.orgId, params.workItemId);
	// Completion is idempotent. Any peer that re-issues complete on an already
	// completed item reads the settled row back rather than failing, so a
	// double-send drains instead of deadlocking the item.
	if (item.disposition === "completed") return item;
	// Settled means done: completion carries no evidence count and no review
	// requirement (decisions/minimal-gates-over-pre-proof.md). Legacy
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
			...(params.closingComment
				? {
						metadata: {
							...item.metadata,
							completionCommentId: params.closingComment.id,
						},
					}
				: {}),
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.id, params.workItemId),
				eq(workItems.orgId, params.orgId),
				eq(workItems.version, params.expectedWorkItemVersion ?? item.version),
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
	const comment = params.closingComment;
	const [completedRows] = await db.batch([
		completeMutation,
		completeEvent,
		...(comment
			? [
					db.insert(workItemComments).select(
						db
							.select({
								id: sql<string>`${comment.id}`.as("id"),
								workItemId: workItems.id,
								orgId: workItems.orgId,
								authorType: sql<string>`${params.actor.type}`.as("author_type"),
								authorId: sql<string>`${params.actor.id}`.as("author_id"),
								body: sql<string>`${comment.body}`.as("body"),
								metadata: sql<
									Record<string, JsonValue>
								>`${JSON.stringify(comment.metadata ?? {})}`.as("metadata"),
								createdAt: sql<string>`${completedAt}`.as("created_at"),
							})
							.from(workItems)
							.where(
								and(
									eq(workItems.orgId, params.orgId),
									eq(workItems.id, params.workItemId),
									eq(workItems.disposition, "completed"),
									eq(
										workItems.version,
										(params.expectedWorkItemVersion ?? item.version) + 1,
									),
									eq(workItems.completedAt, completedAt),
									sql`json_extract(${workItems.metadata}, '$.completionCommentId') = ${comment.id}`,
								),
							),
					),
				]
			: []),
	]);
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
		expectedWorkItemVersion?: number;
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
				eq(workItems.version, params.expectedWorkItemVersion ?? prior.version),
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
		executor?: string;
		laneDispatch?: LaneDispatchPlan;
		title?: string;
		description?: string | null;
		workKind?: WorkItemKind;
		workClass?: WorkItemClass;
		purposeExceptionExpiresAt?: string;
		riskLevel?: WorkItemRiskLevel;
		priority?: WorkItemPriority;
		accountableOwnerType?: WorkItemAccountabilityPrincipalType | null;
		accountableOwnerId?: string | null;
		stewardType?: WorkItemAccountabilityPrincipalType | null;
		stewardId?: string | null;
		expectedWorkItemVersion?: number;
		requiredCapabilities?: string[];
		requiredAuthorities?: string[];
		dueDate?: string | null;
		deadline?: string | null;
		startAt?: string | null;
		durationDays?: number | null;
		updatedAt?: string;
	},
): Promise<WorkItem> {
	const updatedAt = params.updatedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const laneDispatch =
		params.laneDispatch ??
		(params.executor !== undefined &&
		["codex", "claude-code", "tedi", "human"].includes(params.executor)
			? { state: "ready" as const }
			: undefined);
	const dispatch =
		prior.disposition === "accepted" && laneDispatch?.state === "ready";
	const receiptId = crypto.randomUUID();
	const updateMutation = db
		.update(workItems)
		.set({
			metadata:
				params.executor === undefined && laneDispatch === undefined
					? undefined
					: {
							...prior.metadata,
							...(dispatch ? { laneDispatchReceiptId: receiptId } : {}),
							...(params.executor === undefined
								? {}
								: { executor: params.executor }),
							...(laneDispatch === undefined
								? {}
								: { laneDispatch: laneDispatch }),
						},
			title: params.title,
			description: params.description,
			workKind: params.workKind,
			workClass: params.workClass,
			purposeExceptionExpiresAt: params.purposeExceptionExpiresAt,
			riskLevel: params.riskLevel,
			priority: params.priority,
			accountableOwnerType: params.accountableOwnerType,
			accountableOwnerId: params.accountableOwnerId,
			stewardType: params.stewardType,
			stewardId: params.stewardId,
			requiredCapabilities: params.requiredCapabilities,
			requiredAuthorities: params.requiredAuthorities,
			dueDate: params.dueDate,
			deadline: params.deadline,
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
				laneDispatch === undefined
					? undefined
					: sql`NOT EXISTS (
					SELECT 1 FROM ${workAttempts}
					WHERE ${workAttempts.orgId} = ${params.orgId}
					AND ${workAttempts.workItemId} = ${params.workItemId}
					AND ${workAttempts.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')
					AND (${workAttempts.expiresAt} IS NULL OR ${workAttempts.expiresAt} > ${updatedAt})
				)`,
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
	const [updatedRows] = await db.batch([
		updateMutation,
		updateEvent,
		...(dispatch
			? [
					dispatchReceiptInsert(
						db,
						prior,
						String(params.executor ?? prior.metadata?.executor),
						updatedAt,
						receiptId,
					),
				]
			: []),
	]);
	const item = updatedRows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Terminal work specifications are immutable",
		);
	return normalizeWorkItemRow(item);
}
