import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, desc, eq, inArray, like, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import {
	chatDispatchIdempotency,
	kernelRuntimeEvents,
	type TediRuntimeEventKind,
	tediArtifacts,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { chunkForBoundParams } from "../utils/batch";

/** D1 caps bound parameters at 100 per statement; keep IN() lists ≤50. */
const D1_IN_LIST_CHUNK = 50;

export type KernelRuntimeEvent = typeof kernelRuntimeEvents.$inferSelect;
export type TediRuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
export type TediArtifactRow = typeof tediArtifacts.$inferSelect;
export type NewKernelRuntimeEvent = typeof kernelRuntimeEvents.$inferInsert;
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
	const order =
		input.order === "asc" ? asc : input.order === "desc" ? desc : null;
	const runQuery = (
		runIds: string[] | undefined,
		limit: number | undefined,
		offset: number | undefined,
	) => {
		const conditions = [
			...(input.organizationId
				? [eq(tediRuntimeEvents.organizationId, input.organizationId)]
				: []),
			eq(tediRuntimeEvents.tediId, input.tediId),
			...(input.runId ? [eq(tediRuntimeEvents.runId, input.runId)] : []),
			// bound-params: chunked to ≤D1_IN_LIST_CHUNK ids by the caller below
			...(runIds ? [inArray(tediRuntimeEvents.runId, runIds)] : []),
			...(input.runIdPrefix
				? [like(tediRuntimeEvents.runId, `${input.runIdPrefix}%`)]
				: []),
			// bound-params: kinds is a subset of the closed TediRuntimeEventKind enum
			...(input.kinds ? [inArray(tediRuntimeEvents.kind, input.kinds)] : []),
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
	if (!uniqueRunIds || uniqueRunIds.length <= D1_IN_LIST_CHUNK) {
		return runQuery(uniqueRunIds, input.limit, input.offset);
	}

	// Chunked path: D1 caps bound parameters at 100 per statement, so a large
	// run-id list is issued in chunks. Ordering, offset, and limit then apply
	// to the MERGED set — each chunk over-fetches (limit + offset) rows and the
	// single-statement contract is re-established here in memory.
	const perChunkLimit =
		input.limit !== undefined ? input.limit + (input.offset ?? 0) : undefined;
	const rows: TediRuntimeEventRow[] = [];
	for (const chunk of chunkForBoundParams(uniqueRunIds, D1_IN_LIST_CHUNK)) {
		rows.push(...(await runQuery(chunk, perChunkLimit, undefined)));
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

export async function insertKernelRuntimeEventIfAbsent(
	db: DbClient,
	value: NewKernelRuntimeEvent,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
	const metadataTraceId = value.runtimeMetadata?.traceId;
	const traceId =
		value.traceId ??
		(typeof metadataTraceId === "string" ? metadataTraceId : undefined);
	let rows: KernelRuntimeEvent[] = [];
	if (value.causeEventId !== undefined && value.causeEventId !== null) {
		if (value.causeEventId.length === 0)
			throw new KernelRuntimeEventConflictError();
		const cause = alias(kernelRuntimeEvents, "cause");
		rows = await db
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
	} else {
		rows = await db
			.insert(kernelRuntimeEvents)
			.values({ ...value, traceId })
			.onConflictDoNothing({ target: kernelRuntimeEvents.id })
			.returning();
	}
	if (rows[0]) return { row: rows[0], inserted: true };
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
