import { type TenantScope, normalizeTenantScope } from "../tenant-scope";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	getColumns,
	inArray,
	isNull,
	lt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../core-store/client";
import {
	anyIds,
	containsText,
	coreStore,
	jsonParameter,
	jsonRead,
	likeText,
} from "../core-store/dialect";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import {
	chatDispatchIdempotency as d1ChatDispatchIdempotency,
	kernelRuntimeEvents as d1KernelRuntimeEvents,
	kernelRuntimeRuns as d1KernelRuntimeRuns,
	type TediRuntimeEventKind,
	tediArtifacts as d1TediArtifacts,
	tediRuntimeEvents as d1TediRuntimeEvents,
} from "../schema/cognitive-runtime";
import {
	compareCreatedAtId,
	mergeLogStoreRows,
	readLogStores,
} from "../utils/log-store";
import {
	unindexedKindIn,
	unindexedOrganizationId,
} from "../utils/tedi-runtime-event-predicates";

/** Keep the existing public bound on conversation search batches. */
const D1_IN_LIST_CHUNK = 50;

export type KernelRuntimeEvent = typeof d1KernelRuntimeEvents.$inferSelect;
export type TediRuntimeEventRow = typeof d1TediRuntimeEvents.$inferSelect;
export type TediArtifactRow = typeof d1TediArtifacts.$inferSelect;
export type NewKernelRuntimeEvent = typeof d1KernelRuntimeEvents.$inferInsert;

export async function listHomeRunFinishedEvents(
	db: DbQueryClient,
	input: {
		organizationId: string;
		after?: { at: string; id: string } | null;
		conversationId?: string;
		ownerHostSessionId?: string;
		runId?: string;
		limit: number;
		head?: boolean;
	} & TenantScope,
) {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const tediRuntimeEvents = coreTable(db, d1TediRuntimeEvents);
	const read = (column: SQL, path: string[]) => jsonRead(db, column, path);
	const directJoin = coreStore(db) === "postgres" ? sql`JOIN` : sql`CROSS JOIN`;
	const assignments =
		coreStore(db) === "postgres"
			? sql`LATERAL jsonb_array_elements(coalesce(p.metadata #> '{homePlan,assignments}', '[]'::jsonb))`
			: sql`json_each(p.metadata, '$.homePlan.assignments')`;
	input = { ...input, ...normalizeTenantScope(input) };
	// Group repeated ledger writes into one stable notice per run/status.
	// Child ACLs come from the parent conversation, including plan branches.
	// CROSS JOIN expands plan assignments before probing the child-run index;
	// an OR/EXISTS join instead compares every org event with every parent.
	// The run and conversation are grouping keys, so each branch applies them
	// before grouping. Filtering only the grouped feed built every finished run
	// of the organization first (10M rows and 42 s per run lookup, 2026-11-12).
	// CROSS JOIN reads parents before child events: the planner otherwise walks
	// every event of the organization to find one parent.
	const { runId, conversationId } = input;
	const none = sql``;
	const own = {
		run: runId ? sql`AND e.run_id = ${runId}` : none,
		conversation: conversationId
			? sql`AND e.conversation_id = ${conversationId}`
			: none,
	};
	const child = {
		direct: runId
			? sql`AND p.child_run_id = ${runId} AND e.run_id = ${runId}`
			: none,
		planned: runId
			? sql`AND ${read(sql`a.value`, ["childRunId"])} = ${runId} AND e.run_id = ${runId}`
			: none,
		conversation: conversationId
			? sql`AND p.conversation_id = ${conversationId}`
			: none,
	};
	const feed = sql`(
		SELECT min(event_id) AS id, min(created_at) AS at,
		       conversation_id, run_id, parent_run_id, status, owner_host_session_id
		FROM (
			SELECT e.id AS event_id, e.created_at, e.conversation_id, e.run_id,
			       NULL AS parent_run_id,
			       CASE
			         WHEN e.kind = 'run.failed' OR ${read(sql`e.payload`, ["status"])} = 'failed' THEN 'failed'
			         WHEN e.kind = 'approval.requested' OR ${read(sql`e.payload`, ["status"])} IN ('requires_approval', 'needs_delegation') THEN 'needs_input'
			         ELSE 'completed' END AS status,
			       ${read(sql`r.metadata`, ["ownerHostSessionId"])} AS owner_host_session_id
			FROM ${kernelRuntimeEvents} e
			LEFT JOIN ${kernelRuntimeRuns} r
			  ON r.organization_id = e.organization_id AND r.id = e.run_id
			WHERE e.organization_id = ${input.organizationId} AND e.run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			  AND (e.kind != 'run.completed' OR coalesce(${read(sql`e.payload`, ["status"])}, 'completed') IN ('completed', 'failed', 'requires_approval', 'needs_delegation'))
			  ${own.run} ${own.conversation}
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END,
			       ${read(sql`p.metadata`, ["ownerHostSessionId"])}
			FROM ${kernelRuntimeRuns} p ${directJoin} ${tediRuntimeEvents} e
			  ON e.organization_id = p.organization_id
			    AND e.run_id = p.child_run_id AND e.tedi_id = p.delegated_tedi_id
			WHERE p.organization_id = ${input.organizationId} AND p.child_run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			  ${child.direct} ${child.conversation}
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END,
			       ${read(sql`p.metadata`, ["ownerHostSessionId"])}
			FROM ${kernelRuntimeRuns} p
			CROSS JOIN ${assignments} a
			CROSS JOIN ${tediRuntimeEvents} e
			WHERE p.organization_id = ${input.organizationId}
			  AND e.organization_id = p.organization_id
			  AND e.run_id = ${read(sql`a.value`, ["childRunId"])}
			  AND e.tedi_id = ${read(sql`a.value`, ["ownerTediId"])}
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			  ${child.planned} ${child.conversation}
		) GROUP BY conversation_id, run_id, parent_run_id, status, owner_host_session_id
	) AS home_finished`;
	const order = input.head ? desc : asc;
	return db
		.select({
			id: sql<string>`home_finished.id`,
			at: sql<string>`home_finished.at`,
			conversationId: sql<string>`home_finished.conversation_id`,
			runId: sql<string>`home_finished.run_id`,
			parentRunId: sql<string | null>`home_finished.parent_run_id`,
			status: sql<"completed" | "failed" | "needs_input">`home_finished.status`,
		})
		.from(feed)
		.where(
			and(
				input.runId ? sql`home_finished.run_id = ${input.runId}` : undefined,
				input.conversationId
					? sql`home_finished.conversation_id = ${input.conversationId}`
					: undefined,
				input.ownerHostSessionId
					? sql`home_finished.owner_host_session_id = ${input.ownerHostSessionId}`
					: undefined,
				input.after
					? sql`(home_finished.at, home_finished.id) > (${input.after.at}, ${input.after.id})`
					: undefined,
			),
		)
		.orderBy(order(sql`home_finished.at`), order(sql`home_finished.id`))
		.limit(input.limit);
}
export class KernelRuntimeEventConflictError extends Error {
	constructor() {
		super("Kernel runtime event cause conflicts with immutable event");
		this.name = "KernelRuntimeEventConflictError";
	}
}

export async function listKernelRuntimeEvents(
	db: DbClient,
	input: {
		organizationId?: string;
		conversationId?: string;
		messageSearch?: { conversationIds: string[]; query: string };
		runId?: string;
		/**
		 * Select only events that carry NO run id (the conversation-scoped
		 * overlay lane). Ignored when `runId` is set.
		 */
		runIdNull?: boolean;
		id?: string;
		kind?: TediRuntimeEventKind;
		kinds?: readonly TediRuntimeEventKind[];
		createdBefore?: string;
		order?: "asc" | "desc";
		limit?: number;
		offset?: number;
	} & TenantScope,
): Promise<KernelRuntimeEvent[]> {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	input = { ...input, ...normalizeTenantScope(input) };
	if (
		input.messageSearch &&
		input.messageSearch.conversationIds.length > D1_IN_LIST_CHUNK
	)
		throw new Error("Search up to 50 conversations per batch");
	if (input.kinds?.length === 0) return [];
	// Rows older than the retention keep window live in the logs database.
	// Each store applies the same filters; offset applies to the merged set.
	const pages = await readLogStores(
		db,
		(store) =>
			listKernelRuntimeEvents(store, {
				...input,
				limit:
					input.limit === undefined
						? undefined
						: input.limit + (input.offset ?? 0),
				offset: undefined,
			}),
		{ to: input.createdBefore },
	);
	if (pages)
		return mergeLogStoreRows(pages, {
			compare: input.order ? compareCreatedAtId(input.order) : undefined,
			limit: input.limit,
			offset: input.offset,
		});
	const conditions = [
		...(input.organizationId
			? [eq(kernelRuntimeEvents.organizationId, input.organizationId)]
			: []),
		...(input.conversationId
			? [eq(kernelRuntimeEvents.conversationId, input.conversationId)]
			: []),
		...(input.runId
			? [eq(kernelRuntimeEvents.runId, input.runId)]
			: input.runIdNull
				? [isNull(kernelRuntimeEvents.runId)]
				: []),
		...(input.messageSearch
			? [
					// bound-params: message search batches are checked against D1_IN_LIST_CHUNK above.
					anyIds(
						db,
						kernelRuntimeEvents.conversationId,
						input.messageSearch.conversationIds,
					),
					containsText(
						db,
						coreStore(db) === "postgres"
							? sql`translate(coalesce(${kernelRuntimeEvents.delta}, ${jsonRead(db, kernelRuntimeEvents.payload, ["content"])}, ${jsonRead(db, kernelRuntimeEvents.payload, ["text"])}, ${jsonRead(db, kernelRuntimeEvents.payload, ["message", "content"])}, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
							: sql`lower(coalesce(${kernelRuntimeEvents.delta}, ${jsonRead(db, kernelRuntimeEvents.payload, ["content"])}, ${jsonRead(db, kernelRuntimeEvents.payload, ["text"])}, ${jsonRead(db, kernelRuntimeEvents.payload, ["message", "content"])}, ''))`,
						input.messageSearch.query.replace(/[A-Z]/g, (char) =>
							char.toLowerCase(),
						),
					),
				]
			: []),
		...(input.id ? [eq(kernelRuntimeEvents.id, input.id)] : []),
		...(input.kind ? [eq(kernelRuntimeEvents.kind, input.kind)] : []),
		// bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
		...(input.kinds ? [inArray(kernelRuntimeEvents.kind, input.kinds)] : []),
		...(input.createdBefore
			? [lt(kernelRuntimeEvents.createdAt, input.createdBefore)]
			: []),
	];
	const order =
		input.order === "asc" ? asc : input.order === "desc" ? desc : null;
	const base = db
		.select()
		.from(kernelRuntimeEvents)
		.where(and(...conditions));
	const query = order
		? base.orderBy(
				order(kernelRuntimeEvents.createdAt),
				order(kernelRuntimeEvents.id),
			)
		: base;
	if (input.limit !== undefined && input.offset) {
		return query.limit(input.limit).offset(input.offset);
	}
	if (input.limit !== undefined) return query.limit(input.limit);
	if (input.offset)
		return coreStore(db) === "postgres"
			? query.offset(input.offset)
			: query.limit(-1).offset(input.offset);
	return query;
}

export async function listTediRuntimeEvents(
	db: DbClient,
	input: {
		organizationId?: string;
		tediId: string;
		runId?: string;
		runIds?: string[];
		runIdPrefix?: string;
		kinds?: readonly TediRuntimeEventKind[];
		order?: "asc" | "desc";
		limit?: number;
		offset?: number;
	} & TenantScope,
): Promise<TediRuntimeEventRow[]> {
	const tediRuntimeEvents = coreTable(db, d1TediRuntimeEvents);
	input = { ...input, ...normalizeTenantScope(input) };
	if (input.kinds?.length === 0) return [];
	if (input.runIds?.length === 0) return [];
	const pages = await readLogStores(db, (store) =>
		listTediRuntimeEvents(store, {
			...input,
			limit:
				input.limit === undefined
					? undefined
					: input.limit + (input.offset ?? 0),
			offset: undefined,
		}),
	);
	if (pages)
		return mergeLogStoreRows(pages, {
			compare: input.order ? compareCreatedAtId(input.order) : undefined,
			limit: input.limit,
			offset: input.offset,
		});
	const order =
		input.order === "asc" ? asc : input.order === "desc" ? desc : null;
	const runScoped = Boolean(input.runId || input.runIds) && !input.runIdPrefix;
	const conditions = [
		...(input.organizationId
			? [
					runScoped && coreStore(db) === "d1"
						? unindexedOrganizationId(input.organizationId)
						: eq(tediRuntimeEvents.organizationId, input.organizationId),
				]
			: []),
		eq(tediRuntimeEvents.tediId, input.tediId),
		...(input.runIds
			? [anyIds(db, tediRuntimeEvents.runId, [...new Set(input.runIds)])]
			: input.runId
				? [eq(tediRuntimeEvents.runId, input.runId)]
				: []),
		...(input.runIdPrefix
			? [likeText(db, tediRuntimeEvents.runId, `${input.runIdPrefix}%`)]
			: []),
		...(input.kinds
			? [
					runScoped && coreStore(db) === "d1"
						? unindexedKindIn(input.kinds)
						: // bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
							inArray(tediRuntimeEvents.kind, input.kinds),
				]
			: []),
	];
	const indexedSet = input.runIds && coreStore(db) === "d1";
	const columns = getColumns(tediRuntimeEvents);
	// A raw INDEXED BY source needs SQL projections, with the column decoders
	// retained so JSON and numeric fields keep their row contract.
	const projection = Object.fromEntries(
		Object.entries(columns).map(([key, column]) => [
			key,
			sql`${column}`.mapWith(column).as(column.name),
		]),
	) as {
		[K in keyof TediRuntimeEventRow]: SQL.Aliased<TediRuntimeEventRow[K]>;
	};
	const base = db
		.select(indexedSet ? projection : columns)
		.from(
			indexedSet
				? sql`${tediRuntimeEvents} INDEXED BY idx_tedi_runtime_events_run_created`
				: tediRuntimeEvents,
		)
		.where(and(...conditions));
	const query = order
		? base.orderBy(
				order(tediRuntimeEvents.createdAt),
				order(tediRuntimeEvents.id),
			)
		: base;
	if (input.limit !== undefined && input.offset)
		return query.limit(input.limit).offset(input.offset);
	if (input.limit !== undefined) return query.limit(input.limit);
	if (input.offset)
		return coreStore(db) === "postgres"
			? query.offset(input.offset)
			: query.limit(-1).offset(input.offset);
	return query;
}

export async function listTediArtifacts(
	db: DbClient,
	input: {
		organizationId?: string;
		tediId: string;
		runIds: string[];
		limit: number;
	} & TenantScope,
): Promise<TediArtifactRow[]> {
	const tediArtifacts = coreTable(db, d1TediArtifacts);
	input = { ...input, ...normalizeTenantScope(input) };
	if (input.runIds.length === 0) return [];
	return db
		.select()
		.from(tediArtifacts)
		.where(
			and(
				...(input.organizationId
					? [eq(tediArtifacts.organizationId, input.organizationId)]
					: []),
				eq(tediArtifacts.tediId, input.tediId),
				anyIds(db, tediArtifacts.runId, [...new Set(input.runIds)]),
			),
		)
		.orderBy(desc(tediArtifacts.createdAt), desc(tediArtifacts.id))
		.limit(input.limit);
}

/** Read one artifact by its stable id, organization and owning tedi. */
export async function getTediArtifactById(
	db: DbClient,
	input: {
		organizationId?: string;
		tediId: string;
		artifactId: string;
	} & TenantScope,
): Promise<TediArtifactRow | undefined> {
	const tediArtifacts = coreTable(db, d1TediArtifacts);
	input = { ...input, ...normalizeTenantScope(input) };
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(
			and(
				...(input.organizationId
					? [eq(tediArtifacts.organizationId, input.organizationId)]
					: []),
				eq(tediArtifacts.tediId, input.tediId),
				eq(tediArtifacts.id, input.artifactId),
			),
		)
		.limit(1);
	return row;
}

export async function getChatDispatchMappingByIdempotencyKey(
	db: DbClient,
	idempotencyKey: string,
) {
	const chatDispatchIdempotency = coreTable(db, d1ChatDispatchIdempotency);
	const [row] = await db
		.select()
		.from(chatDispatchIdempotency)
		.where(eq(chatDispatchIdempotency.idempotencyKey, idempotencyKey))
		.limit(1);
	return row;
}

export async function countTediRuntimeEvents(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		runId: string;
	} & TenantScope,
): Promise<number> {
	const tediRuntimeEvents = coreTable(db, d1TediRuntimeEvents);
	input = { ...input, ...normalizeTenantScope(input) };
	return db.$count(
		tediRuntimeEvents,
		and(
			eq(tediRuntimeEvents.organizationId, input.organizationId),
			eq(tediRuntimeEvents.tediId, input.tediId),
			eq(tediRuntimeEvents.runId, input.runId),
		),
	);
}

export async function updateKernelRuntimeEventMetadata(
	db: DbClient,
	tenantScope: TenantScope,
	id: string,
	runtimeMetadata: Record<string, JsonValue>,
): Promise<void> {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	const { organizationId } = normalizeTenantScope(tenantScope);
	const metadataTraceId = runtimeMetadata.traceId;
	await db
		.update(kernelRuntimeEvents)
		.set({
			runtimeMetadata,
			traceId: typeof metadataTraceId === "string" ? metadataTraceId : null,
		})
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, organizationId),
				eq(kernelRuntimeEvents.id, id),
			),
		);
}

function resolveEventTraceId(value: NewKernelRuntimeEvent): string | undefined {
	const metadataTraceId = value.runtimeMetadata?.traceId;
	return (
		value.traceId ??
		(typeof metadataTraceId === "string" ? metadataTraceId : undefined)
	);
}

/**
 * Unexecuted idempotent insert of a cause-less event, for `db.batch()`
 * composition. An empty `returning()` result means the id already existed;
 * the caller resolves the replay row with {@link insertKernelRuntimeEventIfAbsent}.
 * Events that bind a `causeEventId` go through
 * {@link buildInsertKernelRuntimeEventStatement}, whose INSERT…SELECT form
 * also leaves `returning()` empty when the cause row is missing.
 */
export function buildInsertKernelRuntimeEventIfAbsentStatement(
	db: DbClient,
	value: NewKernelRuntimeEvent & TenantScope,
) {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	value = { ...value, ...normalizeTenantScope(value) };
	if (value.causeEventId !== undefined && value.causeEventId !== null)
		throw new Error(
			"buildInsertKernelRuntimeEventIfAbsentStatement: cause-bound events are not batch-composable",
		);
	return db
		.insert(kernelRuntimeEvents)
		.values({ ...value, traceId: resolveEventTraceId(value) })
		.onConflictDoNothing({ target: kernelRuntimeEvents.id })
		.returning();
}

/**
 * Unexecuted idempotent insert of one event, cause-bound or not. A cause-bound
 * event is an INSERT…SELECT from its cause row, so inside a `db.batch()` the
 * cause may be an earlier statement of the same batch (D1 batches run
 * sequentially in one transaction). An empty `returning()` result means EITHER
 * the id already existed OR the cause row is missing; the caller resolves which
 * with {@link insertKernelRuntimeEventIfAbsent}, which raises
 * {@link KernelRuntimeEventConflictError} for the missing-cause case.
 */
export function buildInsertKernelRuntimeEventStatement(
	db: DbClient,
	value: NewKernelRuntimeEvent & TenantScope,
) {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	value = { ...value, ...normalizeTenantScope(value) };
	if (value.causeEventId === undefined || value.causeEventId === null)
		return buildInsertKernelRuntimeEventIfAbsentStatement(db, value);
	if (value.causeEventId.length === 0)
		throw new KernelRuntimeEventConflictError();
	const traceId = resolveEventTraceId(value);
	const cause =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)(kernelRuntimeEvents, "cause")
			: sqliteAlias(kernelRuntimeEvents, "cause");
	return db
		.insert(kernelRuntimeEvents)
		.select(
			db
				.select({
					id: sql<string>`${value.id}`.as("id"),
					organizationId: sql<string>`${value.organizationId}`.as(
						"organization_id",
					),
					kind: sql<NewKernelRuntimeEvent["kind"]>`${value.kind}`.as("kind"),
					conversationId: sql<string>`${value.conversationId}`.as(
						"conversation_id",
					),
					runId: sql<string | null>`${value.runId ?? null}`.as("run_id"),
					messageId: sql<string | null>`${value.messageId ?? null}`.as(
						"message_id",
					),
					causeEventId: sql<string>`${cause.id}`.as("cause_event_id"),
					delegatedTediId: sql<
						string | null
					>`${value.delegatedTediId ?? null}`.as("delegated_tedi_id"),
					childRunId: sql<string | null>`${value.childRunId ?? null}`.as(
						"child_run_id",
					),
					sequence: sql<number | null>`${value.sequence ?? null}`.as(
						"sequence",
					),
					delta: sql<string | null>`${value.delta ?? null}`.as("delta"),
					payload: sql<
						NewKernelRuntimeEvent["payload"]
					>`${value.payload == null ? sql`NULL` : jsonParameter(db, value.payload)}`.as(
						"payload",
					),
					runtimeBackend: sql<
						NonNullable<NewKernelRuntimeEvent["runtimeBackend"]>
					>`${value.runtimeBackend ?? "custom"}`.as("runtime_backend"),
					runtimeExternalId: sql<
						string | null
					>`${value.runtimeExternalId ?? null}`.as("runtime_external_id"),
					runtimeExternalUrl: sql<
						string | null
					>`${value.runtimeExternalUrl ?? null}`.as("runtime_external_url"),
					runtimeMetadata: sql<
						NewKernelRuntimeEvent["runtimeMetadata"]
					>`${value.runtimeMetadata == null ? sql`NULL` : jsonParameter(db, value.runtimeMetadata)}`.as(
						"runtime_metadata",
					),
					traceId: sql<string | null>`${traceId ?? null}`.as("trace_id"),
					createdAt:
						sql<string>`${value.createdAt ?? new Date().toISOString()}`.as(
							"created_at",
						),
				})
				.from(cause)
				.where(
					and(
						eq(cause.id, value.causeEventId),
						eq(cause.organizationId, value.organizationId),
						sql`${cause.id} <> ${value.id}`,
					),
				),
		)
		.onConflictDoNothing({ target: kernelRuntimeEvents.id })
		.returning();
}

export async function insertKernelRuntimeEventIfAbsent(
	db: DbClient,
	value: NewKernelRuntimeEvent & TenantScope,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
	value = { ...value, ...normalizeTenantScope(value) };
	const rows: KernelRuntimeEvent[] =
		await buildInsertKernelRuntimeEventStatement(db, value);
	if (rows[0]) return { row: rows[0], inserted: true };
	return resolveReplayedKernelRuntimeEvent(db, value);
}

/**
 * Resolve an idempotent insert whose `returning()` came back empty: the
 * existing row for a replay, or a conflict when the row is missing (a
 * cause-bound insert whose cause does not exist) or belongs to another
 * organization or cause.
 */
export async function resolveReplayedKernelRuntimeEvent(
	db: DbClient,
	value: NewKernelRuntimeEvent & TenantScope,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	value = { ...value, ...normalizeTenantScope(value) };
	const [existing] = await db
		.select()
		.from(kernelRuntimeEvents)
		.where(eq(kernelRuntimeEvents.id, value.id))
		.limit(1);
	if (existing && existing.organizationId !== value.organizationId)
		throw new KernelRuntimeEventConflictError();
	if (
		!existing &&
		value.causeEventId !== undefined &&
		value.causeEventId !== null
	)
		throw new KernelRuntimeEventConflictError();
	if (
		existing &&
		value.causeEventId !== undefined &&
		existing.causeEventId !== value.causeEventId
	)
		throw new KernelRuntimeEventConflictError();
	return { row: existing, inserted: false };
}

export async function getKernelRuntimeEventById(
	db: DbClient,
	tenantScope: TenantScope,
	id: string,
): Promise<KernelRuntimeEvent | undefined> {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	const { organizationId } = normalizeTenantScope(tenantScope);
	const pages = await readLogStores(db, async (store) => {
		const row = await getKernelRuntimeEventById(store, tenantScope, id);
		return row ? [row] : [];
	});
	if (pages) return mergeLogStoreRows(pages, { limit: 1 })[0];
	const [row] = await db
		.select()
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, organizationId),
				eq(kernelRuntimeEvents.id, id),
			),
		)
		.limit(1);
	return row;
}

/** Count first-settlement events and title-bearing conversation updates only. */
export async function countKernelConversationTitleGuardEvents(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
	} & TenantScope,
): Promise<Map<TediRuntimeEventKind, number>> {
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	input = { ...input, ...normalizeTenantScope(input) };
	const rows = await db
		.select({
			kind: kernelRuntimeEvents.kind,
			count: sql<number>`count(*)`,
		})
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.conversationId, input.conversationId),
				or(
					eq(kernelRuntimeEvents.kind, "message.completed"),
					and(
						eq(kernelRuntimeEvents.kind, "conversation.updated"),
						sql`(${jsonRead(db, kernelRuntimeEvents.payload, ["conversation", "title"])} IS NOT NULL OR ${jsonRead(db, kernelRuntimeEvents.payload, ["title"])} IS NOT NULL)`,
					),
				),
			),
		)
		.groupBy(kernelRuntimeEvents.kind);
	return new Map(rows.map((row) => [row.kind, Number(row.count) || 0]));
}
