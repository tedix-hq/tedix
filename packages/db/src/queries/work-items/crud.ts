import { kernelRuntimeRuns } from "../../schema/cognitive-runtime";
import { runtimeSubmissions } from "../../schema/runtime-submissions";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	containsCardSecret,
	CARD_SECRET_MESSAGE,
} from "@tedix/api-contract/utils/card-secrets";
import {
	type LaneDispatchPlan,
	type WorkExecutorReference,
	isLaneReadyExecutorReference,
	workExecutorReference,
} from "@tedix/api-contract/schemas/work-items";
import { INTERNAL_WORK_PURPOSE_CONTEXTS } from "@tedix/api-contract/schemas/work-purpose-context";
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	lt,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { policyPacks } from "../../schema/control-plane";
import { workAdmissions } from "../../schema/work-factory";
import { kernelRequests } from "../../schema/kernel-requests";
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
	workItemComments,
	workItemOrgCounts,
	workItemProjections,
	workItemRelations,
	workItems,
} from "../../schema/work-items";
import { normalizeWorkItemRow } from "./normalization";
import { planningApprovalVersion } from "./planning-approval";
import { acceptanceRenewedPurposeExpiry } from "./purpose";
import { resolveWorkItemSteward } from "./stewardship";
import { retireDecisionReviews } from "./decision-review-retirement";

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
	executorType?: "human" | "tedi" | "external_agent" | "team" | "organization";
	executorId?: string;
	dispatchState?: "held" | "ready";
	delegationDepth?: number;
	maxAttempts?: number;
	rootWorkItemId?: string;
	rootGoal?: string;
	budgetShareMicros?: number;
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

export function lifecycleEventInsert(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		disposition: WorkItemDisposition;
		expectedVersion: number;
		specificationUpdateId?: string;
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
					params.specificationUpdateId === undefined
						? undefined
						: sql`json_extract(${workItems.metadata}, '$.specificationUpdateId')=${params.specificationUpdateId}`,
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
	executor?: string | string[];
	dispatchReadyOnly?: boolean;
	/** The instant `dispatchReadyOnly` compares start dates with; defaults to now. */
	now?: string;
	projectId?: string | null;
	parentWorkItemId?: string | null;
	disposition?: WorkItem["disposition"];
	/** Leave out rows with this disposition, e.g. proposals still in triage. */
	excludeDisposition?: WorkItem["disposition"];
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
	 * in `INTERNAL_WORK_PURPOSE_CONTEXTS` before pagination. This coarse prefilter
	 * is not authorization or a complete customer-visibility decision.
	 */
	customerVisiblePreFilter?: boolean;
	/** Critical or high priority, or own due date or deadline no later than this instant. */
	mattersThrough?: string;
	/** Only tasks Home started without a project that still have none. */
	needsProject?: boolean;
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
	const dispatchNow = options.now ?? new Date().toISOString();
	const titleContains = options.titleContains?.toLowerCase();
	const executors = Array.isArray(options.executor)
		? options.executor
		: options.executor
			? [options.executor]
			: undefined;
	if (executors && (executors.length < 1 || executors.length > 10))
		throw new Error("Executor filter requires between 1 and 10 values");
	const filters = [
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
		options.excludeDisposition
			? ne(workItems.disposition, options.excludeDisposition)
			: undefined,
		executors
			? or(
					...executors.map((executor) => {
						const reference = workExecutorReference(executor);
						if (executor === "human" || executor === "tedi")
							return eq(workItems.executorType, reference.type);
						return and(
							eq(workItems.executorType, reference.type),
							eq(workItems.executorId, reference.id),
						);
					}),
				)
			: undefined,
		options.dispatchReadyOnly
			? sql`${workItems.dispatchState} = 'ready'`
			: undefined,
		// Work whose start date is still ahead is not offered to a runner.
		options.dispatchReadyOnly
			? or(isNull(workItems.startAt), lte(workItems.startAt, dispatchNow))
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
		options.customerVisiblePreFilter
			? and(
					sql`json_extract(${workItems.metadata}, '$.agentSession') IS NULL`,
					or(
						sql`json_extract(${workItems.metadata}, '$.purposeContext') IS NULL`,
						notInArray(
							sql`json_extract(${workItems.metadata}, '$.purposeContext')`,
							[...INTERNAL_WORK_PURPOSE_CONTEXTS],
						),
					),
				)
			: undefined,
		options.mattersThrough
			? or(
					inArray(workItems.priority, ["critical", "high"]),
					and(
						isNotNull(workItems.deadline),
						lte(workItems.deadline, options.mattersThrough),
					),
					and(
						isNotNull(workItems.dueDate),
						lte(workItems.dueDate, options.mattersThrough),
					),
				)
			: undefined,
		options.needsProject
			? and(
					isNull(workItems.projectId),
					sql`json_extract(${workItems.metadata}, '$.needsProject') = 1`,
				)
			: undefined,
	];
	const where = and(eq(workItems.orgId, options.orgId), ...filters);
	// Runners take the most important ready task first: priority, then the
	// nearest due date (undated last), then the oldest.
	const listOrder = options.dispatchReadyOnly
		? [
				sql`CASE ${workItems.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
				sql`${workItems.dueDate} IS NULL`,
				asc(workItems.dueDate),
				asc(workItems.createdAt),
				asc(workItems.id),
			]
		: [desc(workItems.createdAt), desc(workItems.id)];
	const rows = await db
		.select()
		.from(workItems)
		.where(where)
		.orderBy(...listOrder)
		.limit(limit)
		.offset(offset);
	// With no filter the total is the organization's whole Work, which
	// database triggers keep exact in one row; counting it read every Work
	// Item of the organization (about 28,000 rows per call on 17 Nov 2026).
	const [counted] = filters.some((filter) => filter !== undefined)
		? await db
				.select({ total: sql<number>`count(*)` })
				.from(workItems)
				.where(where)
		: await db
				.select({ total: workItemOrgCounts.total })
				.from(workItemOrgCounts)
				.where(eq(workItemOrgCounts.orgId, options.orgId));
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
	const scoped = db.$with("scoped").as(
		db
			.select({
				id: workItems.id,
				disposition: workItems.disposition,
				createdAt: workItems.createdAt,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, params.orgId),
					eq(workItems.objectiveId, params.objectiveId),
				),
			),
	);
	const counts = db.$with("counts").as(
		db
			.select({
				total: sql<unknown>`COUNT(*)`.as("total"),
				doneCount:
					sql<unknown>`COALESCE(SUM(CASE WHEN ${scoped.disposition} = 'completed' THEN 1 ELSE 0 END), 0)`.as(
						"done_count",
					),
				outstandingCount:
					sql<unknown>`COALESCE(SUM(CASE WHEN ${scoped.disposition} != 'completed' THEN 1 ELSE 0 END), 0)`.as(
						"outstanding_count",
					),
			})
			.from(scoped),
	);
	const outstandingPreview = db
		.$with("outstanding_preview")
		.as(
			db
				.select({ id: scoped.id })
				.from(scoped)
				.where(ne(scoped.disposition, "completed"))
				.orderBy(scoped.createdAt, scoped.id)
				.limit(previewLimit),
		);
	const rows = await db
		.with(scoped, counts, outstandingPreview)
		.select({
			total: sql<unknown>`${counts.total}`.as("total"),
			doneCount: sql<unknown>`${counts.doneCount}`.as("doneCount"),
			outstandingCount: sql<unknown>`${counts.outstandingCount}`.as(
				"outstandingCount",
			),
			outstandingId: sql<string | null>`${outstandingPreview.id}`.as(
				"outstandingId",
			),
		})
		.from(counts)
		.leftJoin(outstandingPreview, sql`1 = 1`)
		.orderBy(outstandingPreview.id);
	const totals = rows[0] ?? {
		total: 0,
		doneCount: 0,
		outstandingCount: 0,
		outstandingId: null,
	};
	return {
		total: Number(totals.total),
		doneCount: Number(totals.doneCount),
		outstandingCount: Number(totals.outstandingCount),
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

import { acceptanceRefusal, missingForAcceptance } from "./acceptance-rule";
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
		/**
		 * Only for Home's own delegation tasks when the request points at no
		 * project: Home still starts the delegation and marks the task as
		 * needing a project. Never set this for work a person or agent proposed.
		 */
		allowMissingProject?: boolean;
	},
): Promise<WorkItem> {
	const acceptedAt = params.acceptedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	// Acceptance is the exit from triage: it fixes where the work lives, what
	// done looks like and who answers for it.
	const missing =
		prior.disposition === "proposed"
			? missingForAcceptance(prior, params.acceptanceContract, {
					allowMissingProject: params.allowMissingProject,
				})
			: [];
	if (missing.length)
		throw new WorkFactoryError(
			"ACCEPTANCE_REQUIRED",
			acceptanceRefusal(missing),
		);
	const executor = prior.executorId;
	const dispatch = isLaneReadyExecutorReference(
		prior.executorType && executor
			? { type: prior.executorType, id: executor }
			: undefined,
	);
	const receiptId = crypto.randomUUID();
	const parent =
		prior.parentWorkItemId && prior.workClass !== "objective"
			? await getScopedWorkItem(db, params.orgId, prior.parentWorkItemId)
			: null;
	const purposeExceptionExpiresAt = acceptanceRenewedPurposeExpiry(
		prior,
		parent,
		acceptedAt,
	);
	const acceptMutation = db
		.update(workItems)
		.set({
			disposition: "accepted",
			dispatchState: dispatch ? "ready" : undefined,
			...(purposeExceptionExpiresAt ? { purposeExceptionExpiresAt } : {}),
			...(dispatch
				? {
						metadata: {
							...prior.metadata,
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
				isNotNull(workItems.accountableOwnerId),
				params.allowMissingProject ? undefined : isNotNull(workItems.projectId),
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

export interface NativeStewardCloseoutFence {
	homeRunId: string;
	runId: string;
	linkedWorkItemId: string;
	coordinatorAttemptId: string;
	coordinatorAdmissionId: string;
	ownerUserId: string;
	tediId: string;
	targetWorkItemVersion: number;
	sourceAttemptId: string;
	sourceAttemptMetadata: Record<string, JsonValue>;
	sourceCommit: string;
	repositoryTargetId: string;
	policyPackId: string;
	policyDefinition: string;
	capabilityPlanJson: string;
	tediPolicyPackId: string | null;
	tediPolicyDefinition: string | null;
	autonomyLessonClasses: string[];
}

export async function completeWorkItem(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		expectedWorkItemVersion?: number;
		completedAt?: string;
		nativeStewardCloseout?: NativeStewardCloseoutFence;
		/** Internal timer closeout, fenced against a changed request, policy or Attempt. */
		verifiedDispatcherDelivery?: {
			requestId: string;
			ownerUserId: string;
			requestVersion: number;
			attemptId: string;
			policyPackId: string;
			policyDefinition: string;
		};
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
	const native = params.nativeStewardCloseout;
	const nativeCommentId = native
		? `${native.homeRunId}:steward-closeout:${item.id}:v${native.targetWorkItemVersion}`
		: null;
	if (
		native &&
		(params.actor.type !== "tedi" ||
			params.actor.id !== native.tediId ||
			params.expectedWorkItemVersion !== native.targetWorkItemVersion ||
			params.closingComment?.id !== nativeCommentId ||
			item.id === native.linkedWorkItemId)
	)
		throw new WorkFactoryError(
			"NOT_READY",
			"Native steward completion proof is mismatched",
		);
	if (item.disposition === "completed") {
		if (
			native &&
			(item.version !== native.targetWorkItemVersion + 1 ||
				item.metadata?.completionCommentId !== nativeCommentId)
		)
			throw new WorkFactoryError(
				"NOT_READY",
				"Completed Work does not match this native closeout receipt",
			);
		return item;
	}
	// Settled means done: completion carries no evidence count and no review
	// requirement (decisions/minimal-gates-over-pre-proof.md). Legacy
	// contract-bearing items and contract-less items complete through one path.
	if (item.disposition !== "accepted")
		throw new WorkFactoryError(
			"ACCEPTANCE_REQUIRED",
			"Only accepted work can complete",
		);
	const delivery = params.verifiedDispatcherDelivery;
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
				native
					? and(
							eq(workItems.stewardType, "tedi"),
							eq(workItems.stewardId, native.tediId),
							sql`EXISTS (SELECT 1 FROM ${tedis} native_tedi WHERE native_tedi.id=${native.tediId} AND native_tedi.organization_id=${params.orgId} AND native_tedi.status='active' AND native_tedi.policy_pack_id IS ${native.tediPolicyPackId})`,
							native.tediPolicyPackId === null
								? sql`1`
								: sql`EXISTS (SELECT 1 FROM ${policyPacks} native_tedi_policy WHERE native_tedi_policy.id=${native.tediPolicyPackId} AND native_tedi_policy.status='active' AND (native_tedi_policy.organization_id IS NULL OR native_tedi_policy.organization_id=${params.orgId}) AND native_tedi_policy.definition=${native.tediPolicyDefinition})`,
							sql`(SELECT count(DISTINCT json_extract(native_lesson.payload,'$.classId')) FROM ${workEvents} native_lesson WHERE native_lesson.org_id=${params.orgId} AND native_lesson.event_type='delegation.autonomy.corrected' AND native_lesson.actor_type='user' AND json_type(native_lesson.payload,'$.classId')='text')=${native.autonomyLessonClasses.length} AND NOT EXISTS (SELECT 1 FROM ${workEvents} native_lesson WHERE native_lesson.org_id=${params.orgId} AND native_lesson.event_type='delegation.autonomy.corrected' AND native_lesson.actor_type='user' AND json_type(native_lesson.payload,'$.classId')='text' AND json_extract(native_lesson.payload,'$.classId') NOT IN (SELECT value FROM json_each(${JSON.stringify(native.autonomyLessonClasses)})))`,
							sql`EXISTS (SELECT 1 FROM ${organizationMembers} native_owner WHERE native_owner.organization_id=${params.orgId} AND native_owner.descope_user_id=${native.ownerUserId} AND native_owner.status='active' AND native_owner.role IN ('owner','admin'))`,
							sql`EXISTS (SELECT 1 FROM ${kernelRuntimeRuns} native_home WHERE native_home.id=${native.homeRunId} AND native_home.organization_id=${params.orgId} AND native_home.status IN ('queued','running','waiting') AND native_home.delegated_tedi_id=${native.tediId} AND native_home.child_run_id=${native.runId} AND json_extract(native_home.metadata,'$.workItemId')=${native.linkedWorkItemId} AND json_extract(native_home.metadata,'$.redriveInput.descopeUserId')=${native.ownerUserId} AND json_extract(native_home.metadata,'$.homeDelegation.workOrder.capabilityPlan')=${native.capabilityPlanJson} AND EXISTS (SELECT 1 FROM json_each(native_home.metadata,'$.homeDelegation.workOrder.capabilityPlan.allowedToolIds') native_read_tool WHERE native_read_tool.value='read_steward_work') AND EXISTS (SELECT 1 FROM json_each(native_home.metadata,'$.homeDelegation.workOrder.capabilityPlan.allowedToolIds') native_complete_tool WHERE native_complete_tool.value='complete_steward_work') AND json_extract(native_home.metadata,'$.homeDelegation.workOrder.capabilityPlan.stewardCloseoutTargets') = json_extract(native_home.metadata,'$.redriveInput.runtimeMetadata.stewardCloseoutTargets') AND EXISTS (SELECT 1 FROM json_each(native_home.metadata,'$.homeDelegation.workOrder.capabilityPlan.stewardCloseoutTargets') native_target WHERE json_extract(native_target.value,'$.id')=${params.workItemId} AND json_extract(native_target.value,'$.expectedWorkItemVersion')=${native.targetWorkItemVersion} AND json_extract(native_target.value,'$.repositoryTargetId')=${native.repositoryTargetId}))`,
							sql`EXISTS (SELECT 1 FROM ${workAttempts} native_coordinator WHERE native_coordinator.id=${native.coordinatorAttemptId} AND native_coordinator.org_id=${params.orgId} AND native_coordinator.work_item_id=${native.linkedWorkItemId} AND native_coordinator.admission_id=${native.coordinatorAdmissionId} AND native_coordinator.executor_type='tedi' AND native_coordinator.executor_id=${native.tediId} AND native_coordinator.run_id=${native.runId} AND native_coordinator.runtime_state IN ('running','waiting','retrying') AND EXISTS (SELECT 1 FROM ${workItems} native_coordinator_work WHERE native_coordinator_work.id=native_coordinator.work_item_id AND native_coordinator_work.org_id=native_coordinator.org_id AND native_coordinator_work.disposition='accepted' AND EXISTS (SELECT 1 FROM ${workAdmissions} native_admission WHERE native_admission.id=native_coordinator.admission_id AND native_admission.org_id=native_coordinator.org_id AND native_admission.work_item_id=native_coordinator.work_item_id AND native_admission.decision='admitted' AND native_admission.work_item_version=native_coordinator_work.version AND native_admission.admission_spec_revision=native_coordinator_work.admission_spec_revision)) AND native_coordinator.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
							sql`NOT EXISTS (SELECT 1 FROM ${runtimeSubmissions} native_abort WHERE native_abort.organization_id=${params.orgId} AND native_abort.run_id=${native.homeRunId} AND native_abort.abort_requested_at IS NOT NULL)`,
							sql`EXISTS (SELECT 1 FROM ${workAttempts} native_source WHERE native_source.id=${native.sourceAttemptId} AND native_source.org_id=${params.orgId} AND native_source.work_item_id=${params.workItemId} AND native_source.runtime_state='finished' AND native_source.outcome='succeeded' AND native_source.finished_at IS NOT NULL AND native_source.metadata=${JSON.stringify(native.sourceAttemptMetadata)} AND coalesce(json_extract(native_source.metadata,'$.settlement.commitSha'),json_extract(native_source.metadata,'$.sourceCommit'))=${native.sourceCommit} AND NOT EXISTS (SELECT 1 FROM ${workAttempts} native_newer WHERE native_newer.org_id=native_source.org_id AND native_newer.work_item_id=native_source.work_item_id AND native_newer.attempt_number>native_source.attempt_number))`,
							sql`EXISTS (SELECT 1 FROM ${policyPacks} native_policy WHERE native_policy.id=${native.policyPackId} AND native_policy.organization_id=${params.orgId} AND native_policy.status='active' AND native_policy.definition=${native.policyDefinition} AND NOT EXISTS (SELECT 1 FROM ${policyPacks} native_newer_policy WHERE native_newer_policy.organization_id=native_policy.organization_id AND native_newer_policy.status='active' AND native_newer_policy.version>native_policy.version))`,
						)
					: undefined,
				delivery
					? and(
							eq(workItems.workKind, "coding"),
							sql`EXISTS (SELECT 1 FROM ${policyPacks} policy WHERE policy.id=${delivery.policyPackId} AND json(policy.definition)=json(${delivery.policyDefinition}))`,
							inArray(workItems.riskLevel, ["low", "medium"]),
							sql`EXISTS (SELECT 1 FROM ${policyPacks} p WHERE p.id=${delivery.policyPackId} AND p.organization_id=${params.orgId} AND p.status='active' AND json_extract(p.definition,'$.kernelRequestCoordinator.enabled')=1 AND EXISTS (SELECT 1 FROM json_each(p.definition,'$.kernelRequestCoordinator.workAttemptDelivery.completion.projectIds') project WHERE project.value=${workItems.projectId}) AND NOT EXISTS (SELECT 1 FROM ${policyPacks} newer WHERE newer.organization_id=p.organization_id AND newer.status='active' AND newer.version>p.version))`,
							sql`EXISTS (SELECT 1 FROM ${kernelRequests} r WHERE r.id=${delivery.requestId} AND r.organization_id=${params.orgId} AND r.owner_user_id=${delivery.ownerUserId} AND r.version=${delivery.requestVersion} AND r.source_kind='work_attempt' AND r.source_id=${delivery.attemptId} AND json_extract(r.snapshot,'$.workItemId')=${params.workItemId} AND json_extract(r.snapshot,'$.attemptId')=${delivery.attemptId} AND json_extract(r.snapshot,'$.state')='verifying' AND json_extract(r.snapshot,'$.outcome')='verified' AND json_extract(r.snapshot,'$.delivery.status')='pending')`,
							sql`EXISTS (SELECT 1 FROM ${workAttempts} a WHERE a.org_id=${params.orgId} AND a.work_item_id=${params.workItemId} AND a.id=${delivery.attemptId} AND a.outcome='succeeded' AND a.runtime_state='finished' AND a.finished_at IS NOT NULL AND json_extract(a.metadata,'$.dispatchVersion') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${workAttempts} successor WHERE successor.org_id=a.org_id AND successor.work_item_id=a.work_item_id AND successor.attempt_number>a.attempt_number))`,
						)
					: undefined,
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
	await retireDecisionReviews(db, {
		orgId: params.orgId,
		workItemId: completed.id,
		now: completedAt,
	});
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
		hygiene?: { humanQuietHours: number; noAttempts: boolean };
		cancelledAt?: string;
		/**
		 * A triage exit: the item must still be proposed. A duplicate records its
		 * `duplicates` relation in the same batch as the cancellation.
		 */
		triage?:
			| { exit: "declined" }
			| {
					exit: "duplicate";
					relationId: string;
					duplicateOfWorkItemId: string;
			  };
	},
): Promise<WorkItem> {
	const cancelledAt = params.cancelledAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const humanCutoff = params.hygiene
		? new Date(
				Date.parse(cancelledAt) -
					Math.max(48, params.hygiene.humanQuietHours) * 3600000,
			).toISOString()
		: null;
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
				params.triage
					? eq(workItems.disposition, "proposed")
					: inArray(workItems.disposition, ["proposed", "accepted"]),
				sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${params.orgId} AND active_attempt.work_item_id = ${params.workItemId} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND (active_attempt.expires_at IS NULL OR active_attempt.expires_at > ${cancelledAt}))`,
				params.hygiene
					? sql`NOT EXISTS (SELECT 1 FROM ${workItemComments} human_comment WHERE human_comment.org_id = ${params.orgId} AND human_comment.work_item_id = ${params.workItemId} AND human_comment.author_type = 'user' AND (julianday(human_comment.created_at) IS NULL OR julianday(human_comment.created_at) >= julianday(${humanCutoff})))`
					: undefined,
				params.hygiene?.noAttempts
					? sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} prior_attempt WHERE prior_attempt.org_id = ${params.orgId} AND prior_attempt.work_item_id = ${params.workItemId})`
					: undefined,
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
		payload: {
			reason: params.reason ?? null,
			...(params.triage ? { triageExit: params.triage.exit } : {}),
			...(params.triage?.exit === "duplicate"
				? { duplicateOfWorkItemId: params.triage.duplicateOfWorkItemId }
				: {}),
		},
	});
	const duplicate =
		params.triage?.exit === "duplicate" ? params.triage : undefined;
	const [cancelledRows] = await db.batch([
		cancelMutation,
		cancelEvent,
		...(duplicate
			? [
					db
						.insert(workItemRelations)
						.select(
							db
								.select({
									id: sql<string>`${duplicate.relationId}`.as("id"),
									orgId: workItems.orgId,
									fromWorkItemId: sql<string>`${workItems.id}`.as(
										"from_work_item_id",
									),
									toWorkItemId:
										sql<string>`${duplicate.duplicateOfWorkItemId}`.as(
											"to_work_item_id",
										),
									relationType: sql<"duplicates">`'duplicates'`.as(
										"relation_type",
									),
									metadata: sql<Record<string, JsonValue>>`'{}'`.as("metadata"),
									createdAt: sql<string>`${cancelledAt}`.as("created_at"),
								})
								.from(workItems)
								.where(
									and(
										eq(workItems.orgId, params.orgId),
										eq(workItems.id, params.workItemId),
										eq(workItems.version, prior.version + 1),
										eq(workItems.disposition, "cancelled"),
									),
								),
						)
						.onConflictDoNothing(),
				]
			: []),
	]);
	const item = cancelledRows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			params.triage
				? "Only proposed work can leave triage this way"
				: "Terminal work cannot be cancelled",
		);
	await retireDecisionReviews(db, {
		orgId: params.orgId,
		workItemId: item.id,
		now: cancelledAt,
	});
	return normalizeWorkItemRow(item);
}

/** Specification fields an approval was given for; any change invalidates it. */
const APPROVED_SPECIFICATION_FIELDS = [
	"projectId",
	"title",
	"description",
	"workKind",
	"objectiveId",
	"workClass",
	"purposeExceptionExpiresAt",
	"riskLevel",
	"priority",
	"accountableOwnerType",
	"accountableOwnerId",
	"stewardType",
	"stewardId",
	"requiredCapabilities",
	"requiredAuthorities",
	"dueDate",
	"deadline",
	"startAt",
	"durationDays",
	"delegationDepth",
	"maxAttempts",
	"rootWorkItemId",
	"rootGoal",
	"budgetShareMicros",
] as const;

/**
 * Lane planning (a laneDispatch state with no other change, or a repeat of
 * the current executor) is bookkeeping, not a new specification.
 */
function isPlanningOnlyUpdate(
	prior: WorkItem,
	params: Partial<
		Record<(typeof APPROVED_SPECIFICATION_FIELDS)[number], unknown>
	> & {
		executor?: string;
		executorReference?: WorkExecutorReference;
		laneDispatch?: LaneDispatchPlan;
	},
): boolean {
	const executorReference =
		params.executorReference ??
		(params.executor ? workExecutorReference(params.executor) : undefined);
	return (
		(params.laneDispatch !== undefined || executorReference !== undefined) &&
		(executorReference === undefined ||
			(executorReference.id === prior.executorId &&
				executorReference.type === prior.executorType)) &&
		APPROVED_SPECIFICATION_FIELDS.every(
			(field) =>
				params[field] === undefined ||
				JSON.stringify(params[field]) === JSON.stringify(prior[field]),
		)
	);
}

export async function updateWorkItemSpecification(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		executor?: string;
		executorReference?: WorkExecutorReference;
		laneDispatch?: LaneDispatchPlan;
		/** Validated by the caller. */
		projectId?: string;
		title?: string;
		description?: string | null;
		workKind?: WorkItemKind;
		objectiveId?: string | null;
		workClass?: WorkItemClass;
		purposeExceptionExpiresAt?: string | null;
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
		delegationDepth?: number | null;
		maxAttempts?: number | null;
		rootWorkItemId?: string | null;
		rootGoal?: string | null;
		budgetShareMicros?: number | null;
		updatedAt?: string;
	},
): Promise<WorkItem> {
	const updatedAt = params.updatedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const requestedExecutor =
		params.executorReference ??
		(params.executor ? workExecutorReference(params.executor) : undefined);
	const requestedDispatch =
		params.laneDispatch ??
		(requestedExecutor
			? {
					state: isLaneReadyExecutorReference(requestedExecutor)
						? ("ready" as const)
						: ("held" as const),
				}
			: undefined);
	// A runner's hold names its reason and lasts until the Work is revised:
	// any other specification update makes the Work ready again.
	const priorDispatch = prior.metadata?.laneDispatch as
		| LaneDispatchPlan
		| undefined;
	const laneDispatch =
		requestedDispatch ??
		(prior.dispatchState === "held" && priorDispatch?.reason
			? { state: "ready" as const }
			: undefined);
	const dispatch =
		prior.disposition === "accepted" && laneDispatch?.state === "ready";
	const projectMove =
		params.projectId !== undefined && params.projectId !== prior.projectId
			? { from: prior.projectId, to: params.projectId }
			: null;
	const receiptId = crypto.randomUUID();
	const planningOnly = isPlanningOnlyUpdate(prior, params);
	const [approvalScope] = planningOnly
		? await db
				.select({
					version: planningApprovalVersion(prior).as("approval_version"),
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, params.orgId),
						eq(workItems.id, params.workItemId),
					),
				)
				.limit(1)
		: [];
	const specificationUpdateId = crypto.randomUUID();
	// Home marks a task it started without a project; any move into a project
	// answers that, so the mark goes with it.
	const { needsProject, ...sortedMetadata } = prior.metadata ?? {};
	const clearNeedsProject = Boolean(projectMove?.to) && needsProject === true;
	const updateMutation = db
		.update(workItems)
		.set({
			metadata: {
				...(clearNeedsProject ? sortedMetadata : prior.metadata),
				specificationUpdateId,
				...(dispatch ? { laneDispatchReceiptId: receiptId } : {}),
				...(laneDispatch?.reason || laneDispatch?.note || laneDispatch?.score
					? {
							laneDispatch: {
								...(laneDispatch.score === undefined
									? {}
									: { score: laneDispatch.score }),
								...(laneDispatch.reason ? { reason: laneDispatch.reason } : {}),
								...(laneDispatch.note ? { note: laneDispatch.note } : {}),
							},
						}
					: laneDispatch
						? { laneDispatch: null }
						: {}),
			},
			executorType: requestedExecutor?.type,
			executorId: requestedExecutor?.id,
			dispatchState: laneDispatch?.state,
			delegationDepth: params.delegationDepth,
			maxAttempts: params.maxAttempts,
			rootWorkItemId: params.rootWorkItemId,
			rootGoal: params.rootGoal,
			budgetShareMicros: params.budgetShareMicros,
			projectId: projectMove?.to,
			title: params.title,
			description: params.description,
			workKind: params.workKind,
			objectiveId: params.objectiveId,
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
			admissionSpecRevision: planningOnly
				? undefined
				: sql`lower(hex(randomblob(16)))`,
			updatedAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.version, params.expectedWorkItemVersion ?? prior.version),
				eq(workItems.version, prior.version),
				requestedDispatch === undefined
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
		specificationUpdateId,
		eventType: "work.specification_updated",
		actor: params.actor,
		occurredAt: updatedAt,
		payload: {
			...(projectMove ? { projectMove } : {}),
			...(planningOnly
				? {
						planningApproval: {
							fromVersion: approvalScope?.version ?? prior.version,
							toVersion: prior.version + 1,
							admissionSpecRevision: prior.admissionSpecRevision,
						},
					}
				: {}),
		},
	});
	// Approval proposals are immutable and remain bound to their reviewed version.
	const [updatedRows] = await db.batch([
		updateMutation,
		updateEvent,
		...(dispatch
			? [
					dispatchReceiptInsert(
						db,
						prior,
						String(requestedExecutor?.id ?? prior.executorId),
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

/** The filing fields an undo restores exactly, including explicit nulls. */
export interface WorkItemFiling {
	projectId: string | null;
	objectiveId: string | null;
	workClass: WorkItemClass | null;
	purposeExceptionExpiresAt: string | null;
}

/**
 * Undo for filing changes (project move, purpose repair). Writes the supplied
 * values verbatim, nulls included, behind the exact-version fence. Refuses
 * terminal Work and Work with a live Attempt, so an admitted Attempt never
 * sees its purpose change underneath it. Rotates the admission specification
 * revision and appends a `work.filing_restored` event holding both sides.
 * The caller validates that the project and objective belong to the org.
 */
export async function restoreWorkItemFiling(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		actor: WorkActor;
		expectedWorkItemVersion: number;
		filing: WorkItemFiling;
		updatedAt?: string;
	},
): Promise<WorkItem> {
	const updatedAt = params.updatedAt ?? new Date().toISOString();
	const prior = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const specificationUpdateId = crypto.randomUUID();
	const pick = (item: WorkItemFiling) => ({
		projectId: item.projectId,
		objectiveId: item.objectiveId,
		workClass: item.workClass,
		purposeExceptionExpiresAt: item.purposeExceptionExpiresAt,
	});
	const update = db
		.update(workItems)
		.set({
			metadata: { ...prior.metadata, specificationUpdateId },
			...params.filing,
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			updatedAt,
			version: sql`${workItems.version} + 1`,
		})
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.id, params.workItemId),
				eq(workItems.version, params.expectedWorkItemVersion),
				ne(workItems.disposition, "completed"),
				ne(workItems.disposition, "cancelled"),
				sql`NOT EXISTS (
					SELECT 1 FROM ${workAttempts}
					WHERE ${workAttempts.orgId} = ${params.orgId}
					AND ${workAttempts.workItemId} = ${params.workItemId}
					AND ${workAttempts.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')
					AND (${workAttempts.expiresAt} IS NULL OR ${workAttempts.expiresAt} > ${updatedAt})
				)`,
			),
		)
		.returning();
	const event = lifecycleEventInsert(db, {
		orgId: params.orgId,
		workItemId: params.workItemId,
		disposition: prior.disposition,
		expectedVersion: params.expectedWorkItemVersion + 1,
		specificationUpdateId,
		eventType: "work.filing_restored",
		actor: params.actor,
		occurredAt: updatedAt,
		payload: { from: pick(prior), to: pick(params.filing) },
	});
	const [rows] = await db.batch([update, event]);
	const item = rows[0];
	if (!item)
		throw new WorkFactoryError(
			"NOT_READY",
			"Filing can be restored only on open Work with no live Attempt, at the expected version",
		);
	return normalizeWorkItemRow(item);
}
