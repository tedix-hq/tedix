import { type TenantScope, normalizeTenantScope } from "../tenant-scope";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { type AnySQLiteColumn, alias } from "drizzle-orm/sqlite-core";
import { getLogStores, type DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { tediApprovalRequests } from "../schema/approvals";
import {
	chatDispatchIdempotency,
	kernelRuntimeRuns,
	kernelWakeQueue,
	tediArtifacts,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { tediSessionStates } from "../schema/tedi-sessions";
import { tedis } from "../schema/tedis";
import {
	compareCreatedAtId,
	mergeLogStoreRows,
	readLogStores,
} from "../utils/log-store";
import {
	unindexedKind,
	unindexedKindIn,
	unindexedOrganizationId,
} from "../utils/tedi-runtime-event-predicates";
import { searchAuditEvents } from "./audit";

export type TediRuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
export type TediRuntimeEventInsert = typeof tediRuntimeEvents.$inferInsert;
export type TediRuntimeEventKind = TediRuntimeEventInsert["kind"];
export type TediRuntimeEventCursor = Pick<
	TediRuntimeEventRow,
	"createdAt" | "id"
>;
export type TediConversationCompactionEventRow = Pick<
	TediRuntimeEventRow,
	"payload" | "createdAt"
>;
export type TediArtifactRow = typeof tediArtifacts.$inferSelect;
export type TediArtifactInsert = typeof tediArtifacts.$inferInsert;
export class TediArtifactOwnershipConflictError extends Error {
	constructor(readonly artifactId: string) {
		super(`Artifact ${artifactId} is owned by another tedi`);
		this.name = "TediArtifactOwnershipConflictError";
	}
}
export type TediApprovalRequestRow = typeof tediApprovalRequests.$inferSelect;
export type KernelRuntimeRunRow = typeof kernelRuntimeRuns.$inferSelect;

export type TediObservabilityRuntimeRow = Pick<
	TediRuntimeEventRow,
	"id" | "kind" | "runId" | "traceId" | "payload" | "createdAt"
>;

export interface TediObservabilityAuditRow {
	id: string;
	action: string;
	resourceType: string;
	resourceId: string | null;
	timestamp: Date;
}

export async function listTediObservabilityRows(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		from: string;
		to: string;
		limit: number;
	} & TenantScope,
): Promise<{
	runtimeEvents: TediObservabilityRuntimeRow[];
	auditEvents: TediObservabilityAuditRow[];
	runtimeTruncated: boolean;
	auditTruncated: boolean;
}> {
	input = { ...input, ...normalizeTenantScope(input) };
	const rowLimit = input.limit + 1;
	const stores = getLogStores(db);
	const readRuntimeRows = (store: DbClient) =>
		store
			.select({
				id: tediRuntimeEvents.id,
				kind: tediRuntimeEvents.kind,
				runId: tediRuntimeEvents.runId,
				traceId: tediRuntimeEvents.traceId,
				payload: tediRuntimeEvents.payload,
				createdAt: tediRuntimeEvents.createdAt,
			})
			.from(tediRuntimeEvents)
			.where(
				and(
					eq(tediRuntimeEvents.organizationId, input.organizationId),
					eq(tediRuntimeEvents.tediId, input.tediId),
					gte(tediRuntimeEvents.createdAt, input.from),
					lte(tediRuntimeEvents.createdAt, input.to),
				),
			)
			.orderBy(desc(tediRuntimeEvents.createdAt), desc(tediRuntimeEvents.id))
			.limit(rowLimit);
	const [runtimePages, auditRows] = await Promise.all([
		readLogStores(
			db,
			async (store) => await readRuntimeRows(store),
			input,
		).then((pages) => pages ?? readRuntimeRows(db).then((rows) => [rows])),
		db
			.select({
				id: auditEvents.id,
				action: auditEvents.action,
				resourceType: auditEvents.resourceType,
				resourceId: auditEvents.resourceId,
				timestamp: auditEvents.timestamp,
			})
			.from(auditEvents)
			.innerJoin(
				tedis,
				and(
					eq(tedis.id, input.tediId),
					eq(tedis.organizationId, input.organizationId),
				),
			)
			.where(
				and(
					eq(auditEvents.organizationId, input.organizationId),
					eq(auditEvents.actorType, "tedi"),
					eq(auditEvents.actorId, input.tediId),
					gte(auditEvents.timestamp, new Date(input.from)),
					lte(auditEvents.timestamp, new Date(input.to)),
				),
			)
			.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
			.limit(rowLimit),
	]);
	const runtimeRows = mergeLogStoreRows(runtimePages, {
		compare: compareCreatedAtId("desc"),
		limit: rowLimit,
	});
	if (stores) {
		// Only main holds `tedis`; establish ownership before reading audit partitions.
		const [owner] = await db
			.select({ id: tedis.id })
			.from(tedis)
			.where(
				and(
					eq(tedis.id, input.tediId),
					eq(tedis.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (owner) {
			const page = await searchAuditEvents(db, {
				organizationId: input.organizationId,
				actorId: input.tediId,
				actorType: "tedi",
				startDate: input.from,
				endDate: input.to,
				limit: rowLimit,
			});
			auditRows.splice(0, auditRows.length, ...page.data);
		}
	}
	return {
		runtimeEvents: runtimeRows.slice(0, input.limit),
		auditEvents: auditRows.slice(0, input.limit),
		runtimeTruncated: runtimeRows.length > input.limit,
		auditTruncated: auditRows.length > input.limit,
	};
}

export async function enqueueKernelChildWake(
	db: DbClient,
	input: typeof kernelWakeQueue.$inferInsert,
): Promise<void> {
	await db
		.insert(kernelWakeQueue)
		.values(input)
		.onConflictDoNothing({ target: kernelWakeQueue.id });
}

export async function getMappedDispatchRunId(
	db: DbClient,
	input: { tediId: string; idempotencyKey: string },
): Promise<string | null> {
	const [mapping] = await db
		.select({ runId: chatDispatchIdempotency.runId })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				eq(chatDispatchIdempotency.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	return mapping?.runId ?? null;
}

export async function insertTediRuntimeEvent(
	db: DbClient,
	input: TediRuntimeEventInsert & TenantScope,
): Promise<TediRuntimeEventRow | null> {
	input = { ...input, ...normalizeTenantScope(input) };
	const metadataTraceId = input.runtimeMetadata?.traceId;
	const [row] = await db
		.insert(tediRuntimeEvents)
		.values({
			...input,
			traceId:
				input.traceId ??
				(typeof metadataTraceId === "string" ? metadataTraceId : undefined),
		})
		.onConflictDoNothing({ target: tediRuntimeEvents.id })
		.returning();
	return row ?? null;
}

export async function getTediRuntimeEventById(
	db: DbClient,
	scope: TenantScope & { tediId?: string },
	id: string,
): Promise<TediRuntimeEventRow | null> {
	scope = { ...scope, ...normalizeTenantScope(scope) };
	const pages = await readLogStores(db, async (store) => {
		const row = await getTediRuntimeEventById(store, scope, id);
		return row ? [row] : [];
	});
	if (pages) return mergeLogStoreRows(pages, { limit: 1 })[0] ?? null;
	const [row] = await db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.id, id),
				eq(tediRuntimeEvents.organizationId, scope.organizationId),
				scope.tediId ? eq(tediRuntimeEvents.tediId, scope.tediId) : undefined,
			),
		)
		.limit(1);
	return row ?? null;
}

export async function updateTediRuntimeEventPayload(
	db: DbClient,
	input: {
		id: string;
		payload: TediRuntimeEventInsert["payload"];
	} & TenantScope,
): Promise<TediRuntimeEventRow | null> {
	input = { ...input, ...normalizeTenantScope(input) };
	const [row] = await db
		.update(tediRuntimeEvents)
		.set({ payload: input.payload })
		.where(
			and(
				eq(tediRuntimeEvents.id, input.id),
				eq(tediRuntimeEvents.organizationId, input.organizationId),
			),
		)
		.returning();
	return row ?? null;
}

export async function listTediRuntimeEventsForRouter(
	db: DbClient,
	input: {
		tediId: string;
		conversationId?: string;
		runId?: string;
		runIds?: string[];
		kind?: TediRuntimeEventKind;
		kinds?: TediRuntimeEventKind[];
		before?: TediRuntimeEventCursor;
		order?: "asc" | "desc";
		limit?: number;
	} & TenantScope,
): Promise<TediRuntimeEventRow[]> {
	input = { ...input, ...normalizeTenantScope(input) };
	if (input.runIds?.length === 0 || input.kinds?.length === 0) return [];
	// Both stores apply the same `before` cursor; the merged set is re-limited.
	const pages = await readLogStores(
		db,
		(store) => listTediRuntimeEventsForRouter(store, input),
		{ to: input.before?.createdAt },
	);
	if (pages)
		return mergeLogStoreRows(pages, {
			compare: input.order ? compareCreatedAtId(input.order) : undefined,
			limit: input.limit,
		});
	// One statement per run id (one runId plus its dispatch-alias mappings; the
	// sole caller builds [input.runId, ...mappedRunIds] for a single run): a
	// `run_id IN (...)` list sends the planner to the tedi-only index under
	// production statistics. The merged set is re-ordered and re-limited.
	if (input.runIds) {
		const { runIds, ...rest } = input;
		const uniqueRunIds = [...new Set(runIds)];
		if (uniqueRunIds.length === 1)
			return listTediRuntimeEventsForRouter(db, {
				...rest,
				runId: uniqueRunIds[0],
			});
		return mergeLogStoreRows(
			await Promise.all(
				uniqueRunIds.map((runId) =>
					listTediRuntimeEventsForRouter(db, { ...rest, runId }),
				),
			),
			{
				compare: input.order ? compareCreatedAtId(input.order) : undefined,
				limit: input.limit,
			},
		);
	}
	const runScoped = Boolean(input.runId);
	const conditions = [
		runScoped
			? unindexedOrganizationId(input.organizationId)
			: eq(tediRuntimeEvents.organizationId, input.organizationId),
		eq(tediRuntimeEvents.tediId, input.tediId),
		...(input.conversationId
			? [eq(tediRuntimeEvents.conversationId, input.conversationId)]
			: []),
		...(input.runId ? [eq(tediRuntimeEvents.runId, input.runId)] : []),
		// A run read keeps kind out of index selection (see the predicate owner).
		...(input.kind
			? [
					runScoped
						? unindexedKind(input.kind)
						: eq(tediRuntimeEvents.kind, input.kind),
				]
			: []),
		...(input.kinds
			? [
					runScoped
						? unindexedKindIn(input.kinds)
						: // bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
							inArray(tediRuntimeEvents.kind, input.kinds),
				]
			: []),
		...(input.before
			? [
					or(
						lt(tediRuntimeEvents.createdAt, input.before.createdAt),
						and(
							eq(tediRuntimeEvents.createdAt, input.before.createdAt),
							lt(tediRuntimeEvents.id, input.before.id),
						),
					)!,
				]
			: []),
	];
	const base = db
		.select()
		.from(tediRuntimeEvents)
		.where(and(...conditions));
	const ordered =
		input.order === "asc"
			? base.orderBy(
					asc(tediRuntimeEvents.createdAt),
					asc(tediRuntimeEvents.id),
				)
			: input.order === "desc"
				? base.orderBy(
						desc(tediRuntimeEvents.createdAt),
						desc(tediRuntimeEvents.id),
					)
				: base;
	return input.limit === undefined ? ordered : ordered.limit(input.limit);
}

export async function listTediRunConversationHints(
	db: DbClient,
	input: { tediId: string; runId: string; limit: number } & TenantScope,
): Promise<Array<Pick<TediRuntimeEventRow, "conversationId" | "kind">>> {
	input = { ...input, ...normalizeTenantScope(input) };
	return db
		.select({
			conversationId: tediRuntimeEvents.conversationId,
			kind: tediRuntimeEvents.kind,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.runId, input.runId),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(input.limit);
}

export async function listTediConversationIndexRows(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		before?: string;
		limit: number;
	} & TenantScope,
): Promise<TediRuntimeEventRow[]> {
	input = { ...input, ...normalizeTenantScope(input) };
	return db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				notExists(
					db
						.select({ one: sql`1` })
						.from(tediSessionStates)
						.where(
							and(
								eq(tediSessionStates.organizationId, input.organizationId),
								eq(tediSessionStates.tediId, input.tediId),
								eq(
									tediSessionStates.sessionKey,
									tediRuntimeEvents.conversationId,
								),
								isNotNull(tediSessionStates.deletedAt),
							),
						),
				),
				input.before
					? lt(tediRuntimeEvents.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt), desc(tediRuntimeEvents.id))
		.limit(input.limit);
}

export async function isTediConversationDeleted(
	db: DbClient,
	input: { organizationId: string; tediId: string; conversationId: string },
): Promise<boolean> {
	const rows = await db
		.select({ one: sql`1` })
		.from(tediSessionStates)
		.where(
			and(
				eq(tediSessionStates.organizationId, input.organizationId),
				eq(tediSessionStates.tediId, input.tediId),
				eq(tediSessionStates.sessionKey, input.conversationId),
				isNotNull(tediSessionStates.deletedAt),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export async function listTediConversationTranscriptRows(
	db: DbClient,
	input: {
		tediId: string;
		conversationId: string;
		before?: string;
		limit: number;
	} & TenantScope,
): Promise<TediRuntimeEventRow[]> {
	input = { ...input, ...normalizeTenantScope(input) };
	const pages = await readLogStores(
		db,
		(store) => listTediConversationTranscriptRows(store, input),
		{ to: input.before },
	);
	if (pages)
		return mergeLogStoreRows(pages, {
			compare: compareCreatedAtId("desc"),
			limit: input.limit,
		});
	return db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.conversationId, input.conversationId),
				or(
					eq(tediRuntimeEvents.kind, "message.received"),
					eq(tediRuntimeEvents.kind, "message.delta"),
					eq(tediRuntimeEvents.kind, "message.completed"),
					eq(tediRuntimeEvents.kind, "run.completed"),
				),
				input.before
					? lt(tediRuntimeEvents.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt))
		.limit(input.limit);
}

export async function getLatestTediConversationCompactionEvent(
	db: DbClient,
	input: { tediId: string; conversationId: string } & TenantScope,
): Promise<TediConversationCompactionEventRow | null> {
	input = { ...input, ...normalizeTenantScope(input) };
	const [row] = await db
		.select({
			payload: tediRuntimeEvents.payload,
			createdAt: tediRuntimeEvents.createdAt,
		})
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.tediId, input.tediId),
				eq(tediRuntimeEvents.conversationId, input.conversationId),
				eq(tediRuntimeEvents.kind, "context.compacted"),
			),
		)
		.orderBy(desc(tediRuntimeEvents.createdAt), desc(tediRuntimeEvents.id))
		.limit(1);
	return row ?? null;
}

export async function upsertChatDispatchIdempotency(
	db: DbClient,
	input: typeof chatDispatchIdempotency.$inferInsert,
): Promise<void> {
	await db
		.insert(chatDispatchIdempotency)
		.values(input)
		.onConflictDoNothing({ target: chatDispatchIdempotency.idempotencyKey });
}

export async function updateChatDispatchRunId(
	db: DbClient,
	input: { idempotencyKey: string; runId: string; mappedAt: string },
): Promise<void> {
	await db
		.update(chatDispatchIdempotency)
		.set({ runId: input.runId, mappedAt: input.mappedAt })
		.where(eq(chatDispatchIdempotency.idempotencyKey, input.idempotencyKey));
}

export async function listTediApprovalRequests(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		status: TediApprovalRequestRow["status"];
		before?: string;
		limit: number;
	},
): Promise<TediApprovalRequestRow[]> {
	return db
		.select()
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.tediId, input.tediId),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, input.status),
				input.before
					? lt(tediApprovalRequests.createdAt, input.before)
					: undefined,
			),
		)
		.orderBy(desc(tediApprovalRequests.createdAt))
		.limit(input.limit);
}

export async function findDirectKernelParentRun(
	db: DbClient,
	input: { organizationId: string; childRunId: string },
): Promise<KernelRuntimeRunRow | null> {
	const rows = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return rows.find((row) => row.childRunId === input.childRunId) ?? null;
}

export async function listRecentKernelRunsForOrganization(
	db: DbClient,
	input: { organizationId: string; limit: number },
): Promise<KernelRuntimeRunRow[]> {
	return db
		.select()
		.from(kernelRuntimeRuns)
		.where(eq(kernelRuntimeRuns.organizationId, input.organizationId))
		.orderBy(desc(kernelRuntimeRuns.updatedAt))
		.limit(input.limit);
}

export async function listTediArtifacts(
	db: DbClient,
	input: {
		tediId: string;
		conversationId?: string;
		runId?: string;
		messageId?: string;
		kind?: TediArtifactRow["kind"];
		name?: string;
		before?: string;
		limit: number;
	} & TenantScope,
): Promise<TediArtifactRow[]> {
	input = { ...input, ...normalizeTenantScope(input) };
	const conditions = [
		eq(tediArtifacts.organizationId, input.organizationId),
		eq(tediArtifacts.tediId, input.tediId),
		...(input.name ? [eq(tediArtifacts.name, input.name)] : []),
		...(input.conversationId
			? [eq(tediArtifacts.conversationId, input.conversationId)]
			: []),
		...(input.runId ? [eq(tediArtifacts.runId, input.runId)] : []),
		...(input.messageId ? [eq(tediArtifacts.messageId, input.messageId)] : []),
		...(input.kind ? [eq(tediArtifacts.kind, input.kind)] : []),
		...(input.before ? [lt(tediArtifacts.createdAt, input.before)] : []),
	];
	return db
		.select()
		.from(tediArtifacts)
		.where(and(...conditions))
		.orderBy(desc(tediArtifacts.createdAt))
		.limit(input.limit);
}

export async function upsertTediArtifact(
	db: DbClient,
	input: TediArtifactInsert & TenantScope,
): Promise<TediArtifactRow> {
	input = { ...input, ...normalizeTenantScope(input) };
	const [row] = await db
		.insert(tediArtifacts)
		.values(input)
		.onConflictDoUpdate({
			target: tediArtifacts.id,
			set: {
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
				kind: input.kind,
				name: input.name,
				mimeType: input.mimeType,
				uri: input.uri,
				sizeBytes: input.sizeBytes,
				metadata: input.metadata,
			},
			setWhere: and(
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				isNull(tediArtifacts.accessClassification),
			),
		})
		.returning();
	if (!row) throw new TediArtifactOwnershipConflictError(input.id);
	return row;
}

/**
 * Create the immutable identity/content/provenance claim before publishing R2
 * bytes. Retries may read the identical claim, but can never rewrite or
 * downgrade it.
 */
export async function claimTediArtifact(
	db: DbClient,
	input: TediArtifactInsert & TenantScope,
): Promise<{ artifact: TediArtifactRow; created: boolean }> {
	input = { ...input, ...normalizeTenantScope(input) };
	const [created] = await db
		.insert(tediArtifacts)
		.values({
			...input,
			createdAt: input.createdAt ?? new Date().toISOString(),
		})
		.onConflictDoNothing({ target: tediArtifacts.id })
		.returning();
	if (created) return { artifact: created, created: true };
	const existing = await getTediArtifact(db, {
		...normalizeTenantScope(input),
		artifactId: input.id,
	});
	if (
		!existing ||
		existing.tediId !== input.tediId ||
		existing.conversationId !== (input.conversationId ?? null) ||
		existing.runId !== (input.runId ?? null) ||
		existing.messageId !== (input.messageId ?? null) ||
		existing.kind !== input.kind ||
		existing.name !== input.name ||
		existing.mimeType !== (input.mimeType ?? null) ||
		existing.uri !== input.uri ||
		existing.sizeBytes !== (input.sizeBytes ?? null) ||
		JSON.stringify(existing.metadata ?? null) !==
			JSON.stringify(input.metadata ?? null) ||
		existing.contentDigest !== input.contentDigest ||
		existing.accessClassification !== input.accessClassification ||
		existing.producerExecutionId !== (input.producerExecutionId ?? null) ||
		existing.accessEnvelope !== (input.accessEnvelope ?? null) ||
		(input.createdAt !== undefined && existing.createdAt !== input.createdAt)
	) {
		throw new TediArtifactOwnershipConflictError(input.id);
	}
	return { artifact: existing, created: false };
}

/** Publish only the exact pending immutable claim after storage verification. */
export async function markTediArtifactPublished(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		tediId: string;
		contentDigest: string | null;
	} & TenantScope,
): Promise<TediArtifactRow | null> {
	input = { ...input, ...normalizeTenantScope(input) };
	const [published] = await db
		.update(tediArtifacts)
		.set({ publicationState: "ready" })
		.where(
			and(
				eq(tediArtifacts.id, input.id),
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				input.contentDigest === null
					? isNull(tediArtifacts.contentDigest)
					: eq(tediArtifacts.contentDigest, input.contentDigest),
				eq(tediArtifacts.publicationState, "pending"),
			),
		)
		.returning();
	return published ?? null;
}

export async function getTediArtifact(
	db: DbClient,
	input: TenantScope & { tediId?: string; artifactId: string },
): Promise<TediArtifactRow | null> {
	input = { ...input, ...normalizeTenantScope(input) };
	const ownerCondition = and(
		eq(tediArtifacts.organizationId, input.organizationId),
		input.tediId ? eq(tediArtifacts.tediId, input.tediId) : undefined,
	);
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(and(ownerCondition, eq(tediArtifacts.id, input.artifactId)))
		.limit(1);
	return row ?? null;
}

/** Exact global-id lookup used only to fence create-only ownership claims. */
export async function getTediArtifactClaim(
	db: DbClient,
	artifactId: string,
): Promise<TediArtifactRow | null> {
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(eq(tediArtifacts.id, artifactId))
		.limit(1);
	return row ?? null;
}

export async function patchOldestQueuedDispatchRunId(
	db: DbClient,
	input: {
		tediId: string;
		conversationId: string;
		runId: string;
		cutoff: string;
		mappedAt: string;
	},
): Promise<number> {
	const [candidate] = await db
		.select({ idempotencyKey: chatDispatchIdempotency.idempotencyKey })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				eq(chatDispatchIdempotency.conversationId, input.conversationId),
				sql`${chatDispatchIdempotency.runId} IS NULL`,
				sql`datetime(${chatDispatchIdempotency.createdAt}) > datetime(${input.cutoff})`,
			),
		)
		.orderBy(chatDispatchIdempotency.createdAt)
		.limit(1);
	if (!candidate) return 0;
	await updateChatDispatchRunId(db, {
		idempotencyKey: candidate.idempotencyKey,
		runId: input.runId,
		mappedAt: input.mappedAt,
	});
	return 1;
}

export type OrphanRunCandidate = {
	tediId: string;
	organizationId: string;
	runId: string;
	conversationId: string | null;
	runtimeBackend: TediRuntimeEventRow["runtimeBackend"];
	runtimeExternalId: string | null;
	startedEventId: string;
	startedAt: string;
	/** A durable success signal exists but the terminal event was lost. */
	succeededLost: boolean;
};

// A workstation wake, clone, install, and full test can legitimately run for
// 8-12 minutes without a progress event. Keep the orphan age and activity
// window above that gap so the sweep does not seal live coding work.
const ORPHAN_DEFAULT_AGE_MINUTES = 12;
const ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES = 12;
const ORPHAN_DEFAULT_LIMIT = 100;
// The lower bound prevents every two-minute sweep from rescanning the complete
// runtime-event ledger. A swept run receives a terminal row and cannot become a
// candidate again, so seven days is safely wider than the recovery cadence.
const ORPHAN_DEFAULT_LOOKBACK_DAYS = 7;

type RuntimeEventAlias = Record<
	"tediId" | "runId" | "kind" | "payload" | "createdAt",
	AnySQLiteColumn
>;

export async function findOrphanRuns(
	db: DbClient,
	options: {
		now?: Date;
		organizationId?: string;
		orphanAgeMinutes?: number;
		activityWindowMinutes?: number;
		lookbackDays?: number;
		limit?: number;
	} = {},
): Promise<OrphanRunCandidate[]> {
	const now = options.now ?? new Date();
	const orphanAgeMinutes =
		options.orphanAgeMinutes ?? ORPHAN_DEFAULT_AGE_MINUTES;
	const activityWindowMinutes =
		options.activityWindowMinutes ?? ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES;
	const limit = options.limit ?? ORPHAN_DEFAULT_LIMIT;
	const lookbackDays = options.lookbackDays ?? ORPHAN_DEFAULT_LOOKBACK_DAYS;
	const organizationId = options.organizationId ?? null;
	// The fleet sweep intentionally stays unscoped. Org-scoped health reads add
	// an indexable outer predicate and fence every correlated alias to the same
	// organization so malformed cross-org rows cannot suppress a candidate.
	// Kind filters stay SQL literals so the planner sees the same statement shape.
	const run = tediRuntimeEvents;
	const ok = alias(tediRuntimeEvents, "ok");
	const term = alias(tediRuntimeEvents, "term");
	const act = alias(tediRuntimeEvents, "act");
	const own = alias(tediRuntimeEvents, "own");
	const ar = alias(tediRuntimeEvents, "ar");
	const res = alias(tediRuntimeEvents, "res");
	const map = alias(chatDispatchIdempotency, "map");
	const mappedTerm = alias(tediRuntimeEvents, "mapped_term");
	const mappedAct = alias(tediRuntimeEvents, "mapped_act");
	const sameOrganization = (correlated: AnySQLiteColumn) =>
		organizationId ? eq(correlated, run.organizationId) : undefined;
	const sameRun = (correlated: RuntimeEventAlias) =>
		and(eq(correlated.tediId, run.tediId), eq(correlated.runId, run.runId));
	const successfulCompletion = (event: RuntimeEventAlias) =>
		and(
			sql`${event.kind} = 'message.completed'`,
			sql`COALESCE(LOWER(json_extract(${event.payload}, '$.status')), '')
				NOT IN ('failed', 'error', 'canceled', 'cancelled')`,
			sql`json_extract(${event.payload}, '$.error') IS NULL`,
		);
	const recentActivity = (event: RuntimeEventAlias) =>
		and(
			sql`${event.kind} IN ('message.delta', 'tool.started', 'tool.completed', 'tool.failed', 'message.progress', 'step.completed', 'step.retry')`,
			sql`${event.createdAt} >= ${activityCutoff}`,
		);
	const orphanCutoff = new Date(
		now.getTime() - orphanAgeMinutes * 60_000,
	).toISOString();
	const activityCutoff = new Date(
		now.getTime() - activityWindowMinutes * 60_000,
	).toISOString();
	const lookbackFloor = new Date(
		now.getTime() - lookbackDays * 24 * 60 * 60_000,
	).toISOString();
	const nowIso = now.toISOString();
	const one = { one: sql`1` };

	const rows = await db
		.select({
			id: run.id,
			tedi_id: run.tediId,
			organization_id: run.organizationId,
			run_id: sql<string>`${run.runId}`.as("run_id"),
			conversation_id: run.conversationId,
			runtime_backend: run.runtimeBackend,
			runtime_external_id: run.runtimeExternalId,
			created_at: run.createdAt,
			succeeded_lost: sql<number>`${exists(
				db
					.select(one)
					.from(ok)
					.where(
						and(
							sameRun(ok),
							sameOrganization(ok.organizationId),
							successfulCompletion(ok),
						),
					),
			)}`.as("succeeded_lost"),
		})
		.from(run)
		.where(
			and(
				sql`${run.kind} = 'run.started'`,
				isNotNull(run.runId),
				organizationId ? eq(run.organizationId, organizationId) : undefined,
				sql`${run.createdAt} < ${orphanCutoff}`,
				sql`${run.createdAt} > ${lookbackFloor}`,
				notExists(
					db
						.select(one)
						.from(term)
						.where(
							and(
								sameRun(term),
								sameOrganization(term.organizationId),
								sql`${term.kind} IN ('run.completed', 'run.failed', 'run.canceled')`,
							),
						),
				),
				notExists(
					db
						.select(one)
						.from(act)
						.where(
							and(
								sameRun(act),
								sameOrganization(act.organizationId),
								recentActivity(act),
							),
						),
				),
				// A runtime that is re-driving this run after a transient loss
				// (isolate memory reset, platform Workflows error) owns it until the
				// lease it recorded expires; sealing it now would fail a child the
				// pending retry is about to rerun.
				notExists(
					db
						.select(one)
						.from(own)
						.where(
							and(
								sameRun(own),
								sameOrganization(own.organizationId),
								sql`${own.kind} = 'step.retry'`,
								sql`json_extract(${own.payload}, '$.retryOwnedUntil') > ${nowIso}`,
							),
						),
				),
				notExists(
					db
						.select(one)
						.from(ar)
						.where(
							and(
								sameRun(ar),
								sameOrganization(ar.organizationId),
								sql`${ar.kind} = 'approval.requested'`,
								notExists(
									db
										.select(one)
										.from(res)
										.where(
											and(
												eq(res.tediId, ar.tediId),
												eq(res.runId, ar.runId),
												sameOrganization(res.organizationId),
												sql`${res.kind} = 'approval.resolved'`,
											),
										),
								),
							),
						),
				),
				notExists(
					db
						.select(one)
						.from(map)
						.where(
							and(
								eq(map.tediId, run.tediId),
								eq(map.conversationId, run.conversationId),
								eq(map.idempotencyKey, run.runId),
								sameOrganization(map.organizationId),
								isNotNull(map.runId),
								sql`${map.runId} != ${run.runId}`,
								or(
									exists(
										db
											.select(one)
											.from(mappedTerm)
											.where(
												and(
													eq(mappedTerm.tediId, run.tediId),
													eq(mappedTerm.runId, map.runId),
													sameOrganization(mappedTerm.organizationId),
													or(
														sql`${mappedTerm.kind} IN ('run.completed', 'run.failed', 'run.canceled')`,
														successfulCompletion(mappedTerm),
													),
												),
											),
									),
									exists(
										db
											.select(one)
											.from(mappedAct)
											.where(
												and(
													eq(mappedAct.tediId, run.tediId),
													eq(mappedAct.runId, map.runId),
													sameOrganization(mappedAct.organizationId),
													recentActivity(mappedAct),
												),
											),
									),
								),
							),
						),
				),
			),
		)
		.orderBy(asc(run.createdAt))
		.limit(limit);

	return rows.map((row) => ({
		tediId: row.tedi_id,
		organizationId: row.organization_id,
		runId: row.run_id,
		conversationId: row.conversation_id,
		runtimeBackend:
			(row.runtime_backend as TediRuntimeEventRow["runtimeBackend"]) ??
			"cloudflare-agents",
		runtimeExternalId: row.runtime_external_id,
		startedEventId: row.id,
		startedAt: row.created_at,
		succeededLost: row.succeeded_lost === 1,
	}));
}

export async function insertOrphanTerminalEvent(
	db: DbClient,
	input: TediRuntimeEventInsert & TenantScope,
): Promise<boolean> {
	input = { ...input, ...normalizeTenantScope(input) };
	return (await insertTediRuntimeEvent(db, input)) !== null;
}
