import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, desc, eq, inArray, like, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import {
	chatDispatchIdempotency,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	type TediRuntimeEventKind,
	tediArtifacts,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { chunkForBoundParams } from "../utils/batch";
import {
	compareCreatedAtId,
	mergeLogStoreRows,
	readLogStores,
} from "../utils/log-store";
import {
	unindexedKindIn,
	unindexedOrganizationId,
} from "../utils/tedi-runtime-event-predicates";

/** D1 caps bound parameters at 100 per statement; keep IN() lists ≤50. */
const D1_IN_LIST_CHUNK = 50;

export type KernelRuntimeEvent = typeof kernelRuntimeEvents.$inferSelect;
export type TediRuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
export type TediArtifactRow = typeof tediArtifacts.$inferSelect;
export type NewKernelRuntimeEvent = typeof kernelRuntimeEvents.$inferInsert;

export async function listHomeRunFinishedEvents(
	db: DbQueryClient,
	input: {
		organizationId: string;
		after?: { at: string; id: string } | null;
		conversationId?: string;
		runId?: string;
		limit: number;
		head?: boolean;
	},
) {
	// Group repeated ledger writes into one stable notice per run/status.
	// Child ACLs come from the parent conversation, including plan branches.
	// CROSS JOIN expands plan assignments before probing the child-run index;
	// an OR/EXISTS join instead compares every org event with every parent.
	const feed = sql`(
		SELECT min(event_id) AS id, min(created_at) AS at,
		       conversation_id, run_id, parent_run_id, status
		FROM (
			SELECT e.id AS event_id, e.created_at, e.conversation_id, e.run_id,
			       NULL AS parent_run_id,
			       CASE
			         WHEN e.kind = 'run.failed' OR json_extract(e.payload, '$.status') = 'failed' THEN 'failed'
			         WHEN e.kind = 'approval.requested' OR json_extract(e.payload, '$.status') IN ('requires_approval', 'needs_delegation') THEN 'needs_input'
			         ELSE 'completed' END AS status
			FROM ${kernelRuntimeEvents} e
			WHERE e.organization_id = ${input.organizationId} AND e.run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			  AND (e.kind != 'run.completed' OR coalesce(json_extract(e.payload, '$.status'), 'completed') IN ('completed', 'failed', 'requires_approval', 'needs_delegation'))
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END
			FROM ${kernelRuntimeRuns} p JOIN ${tediRuntimeEvents} e
			  ON e.organization_id = p.organization_id
			    AND e.run_id = p.child_run_id AND e.tedi_id = p.delegated_tedi_id
			WHERE e.organization_id = ${input.organizationId} AND e.run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END
			FROM ${kernelRuntimeRuns} p
			CROSS JOIN json_each(p.metadata, '$.homePlan.assignments') a
			CROSS JOIN ${tediRuntimeEvents} e
			WHERE p.organization_id = ${input.organizationId}
			  AND e.organization_id = p.organization_id
			  AND e.run_id = json_extract(a.value, '$.childRunId')
			  AND e.tedi_id = json_extract(a.value, '$.ownerTediId')
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
		) GROUP BY conversation_id, run_id, parent_run_id, status
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
		runId?: string;
		id?: string;
		kind?: TediRuntimeEventKind;
		kinds?: readonly TediRuntimeEventKind[];
		createdBefore?: string;
		order?: "asc" | "desc";
		limit?: number;
		offset?: number;
	},
): Promise<KernelRuntimeEvent[]> {
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
		...(input.runId ? [eq(kernelRuntimeEvents.runId, input.runId)] : []),
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
	if (input.offset) return query.limit(-1).offset(input.offset);
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
	},
): Promise<TediRuntimeEventRow[]> {
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
	const runQuery = (
		runId: string | undefined,
		limit: number | undefined,
		offset: number | undefined,
	) => {
		const runScoped = Boolean(runId) && !input.runIdPrefix;
		const conditions = [
			...(input.organizationId
				? [unindexedOrganizationId(input.organizationId)]
				: []),
			eq(tediRuntimeEvents.tediId, input.tediId),
			...(runId ? [eq(tediRuntimeEvents.runId, runId)] : []),
			...(input.runIdPrefix
				? [like(tediRuntimeEvents.runId, `${input.runIdPrefix}%`)]
				: []),
			...(input.kinds
				? [
						runScoped
							? unindexedKindIn(input.kinds)
							: // bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
								inArray(tediRuntimeEvents.kind, input.kinds),
					]
				: []),
		];
		const base = db
			.select()
			.from(tediRuntimeEvents)
			.where(and(...conditions));
		const query = order
			? base.orderBy(
					order(tediRuntimeEvents.createdAt),
					order(tediRuntimeEvents.id),
				)
			: base;
		if (limit !== undefined && offset) return query.limit(limit).offset(offset);
		if (limit !== undefined) return query.limit(limit);
		if (offset) return query.limit(-1).offset(offset);
		return query;
	};

	const uniqueRunIds = input.runIds ? [...new Set(input.runIds)] : undefined;
	if (!uniqueRunIds) return runQuery(input.runId, input.limit, input.offset);
	if (uniqueRunIds.length === 1)
		return runQuery(uniqueRunIds[0], input.limit, input.offset);

	// One statement per run id: a `run_id IN (...)` list multiplies the run
	// index estimate under production statistics and sends the planner to the
	// tedi-only index (every event of the tedi). Ordering, offset, and limit
	// apply to the MERGED set — each statement over-fetches (limit + offset)
	// rows and the single-statement contract is re-established in memory.
	const perRunLimit =
		input.limit !== undefined ? input.limit + (input.offset ?? 0) : undefined;
	const rows: TediRuntimeEventRow[] = [];
	for (const runId of uniqueRunIds) {
		rows.push(...(await runQuery(runId, perRunLimit, undefined)));
	}
	if (order) {
		const direction = input.order === "desc" ? -1 : 1;
		rows.sort(
			(a, b) =>
				direction *
				(a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
		);
	}
	const offsetRows = input.offset ? rows.slice(input.offset) : rows;
	return input.limit !== undefined
		? offsetRows.slice(0, input.limit)
		: offsetRows;
}

export async function listTediArtifacts(
	db: DbClient,
	input: {
		organizationId?: string;
		tediId: string;
		runIds: string[];
		limit: number;
	},
): Promise<TediArtifactRow[]> {
	if (input.runIds.length === 0) return [];
	const rows: TediArtifactRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select()
				.from(tediArtifacts)
				.where(
					and(
						...(input.organizationId
							? [eq(tediArtifacts.organizationId, input.organizationId)]
							: []),
						eq(tediArtifacts.tediId, input.tediId),
						inArray(tediArtifacts.runId, chunk),
					),
				)
				.orderBy(desc(tediArtifacts.createdAt))
				.limit(input.limit)),
		);
	}
	// Re-establish the single-statement contract across chunks: newest first,
	// limited over the merged set.
	rows.sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
	);
	return rows.slice(0, input.limit);
}

/** Read one artifact by its stable id and owning tedi, optionally org-scoped. */
export async function getTediArtifactById(
	db: DbClient,
	input: { organizationId?: string; tediId: string; artifactId: string },
): Promise<TediArtifactRow | undefined> {
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
	const [row] = await db
		.select()
		.from(chatDispatchIdempotency)
		.where(eq(chatDispatchIdempotency.idempotencyKey, idempotencyKey))
		.limit(1);
	return row;
}

export async function countTediRuntimeEvents(
	db: DbClient,
	input: { organizationId: string; tediId: string; runId: string },
): Promise<number> {
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
	id: string,
	runtimeMetadata: Record<string, JsonValue>,
): Promise<void> {
	const metadataTraceId = runtimeMetadata.traceId;
	await db
		.update(kernelRuntimeEvents)
		.set({
			runtimeMetadata,
			traceId: typeof metadataTraceId === "string" ? metadataTraceId : null,
		})
		.where(eq(kernelRuntimeEvents.id, id));
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
	value: NewKernelRuntimeEvent,
) {
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
	value: NewKernelRuntimeEvent,
) {
	if (value.causeEventId === undefined || value.causeEventId === null)
		return buildInsertKernelRuntimeEventIfAbsentStatement(db, value);
	if (value.causeEventId.length === 0)
		throw new KernelRuntimeEventConflictError();
	const traceId = resolveEventTraceId(value);
	const cause = alias(kernelRuntimeEvents, "cause");
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
					>`${value.payload === undefined ? null : JSON.stringify(value.payload)}`.as(
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
					>`${value.runtimeMetadata === undefined ? null : JSON.stringify(value.runtimeMetadata)}`.as(
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
	value: NewKernelRuntimeEvent,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
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
	value: NewKernelRuntimeEvent,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
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
	id: string,
): Promise<KernelRuntimeEvent | undefined> {
	const pages = await readLogStores(db, async (store) => {
		const row = await getKernelRuntimeEventById(store, id);
		return row ? [row] : [];
	});
	if (pages) return mergeLogStoreRows(pages, { limit: 1 })[0];
	const [row] = await db
		.select()
		.from(kernelRuntimeEvents)
		.where(eq(kernelRuntimeEvents.id, id))
		.limit(1);
	return row;
}

export async function countKernelConversationEventsByKind(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		kinds: readonly TediRuntimeEventKind[];
	},
): Promise<Map<TediRuntimeEventKind, number>> {
	if (input.kinds.length === 0) return new Map();
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
				// bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
				inArray(kernelRuntimeEvents.kind, input.kinds),
			),
		)
		.groupBy(kernelRuntimeEvents.kind);
	return new Map(rows.map((row) => [row.kind, Number(row.count) || 0]));
}
