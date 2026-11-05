import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNull,
	like,
	lt,
	sql,
} from "drizzle-orm";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	tediRuntimeEvents,
	type TediRuntimeEventKind,
} from "../../schema/cognitive-runtime";
import {
	KernelRuntimeEventConflictError,
	type KernelRuntimeEvent,
	type NewKernelRuntimeEvent,
	type TediRuntimeEventRow,
} from "../kernel-runtime-events";
import type { TenantStoreDb } from "./tenant-store";

export { KernelRuntimeEventConflictError };
export type { KernelRuntimeEvent, NewKernelRuntimeEvent, TediRuntimeEventRow };

export async function listHomeRunFinishedEvents(
	db: TenantStoreDb,
	input: {
		organizationId: string;
		after?: { at: string; id: string } | null;
		conversationId?: string;
		ownerHostSessionId?: string;
		runId?: string;
		limit: number;
		head?: boolean;
	},
) {
	const feed = sql`(
		SELECT min(event_id) AS id, min(created_at) AS at,
		       conversation_id, run_id, parent_run_id, status, owner_host_session_id
		FROM (
			SELECT e.id AS event_id, e.created_at, e.conversation_id, e.run_id,
			       NULL AS parent_run_id,
			       CASE
			         WHEN e.kind = 'run.failed' OR json_extract(e.payload, '$.status') = 'failed' THEN 'failed'
			         WHEN e.kind = 'approval.requested' OR json_extract(e.payload, '$.status') IN ('requires_approval', 'needs_delegation') THEN 'needs_input'
			         ELSE 'completed' END AS status,
			       json_extract(r.metadata, '$.ownerHostSessionId') AS owner_host_session_id
			FROM ${kernelRuntimeEvents} e
			LEFT JOIN ${kernelRuntimeRuns} r
			  ON r.organization_id = e.organization_id AND r.id = e.run_id
			WHERE e.organization_id = ${input.organizationId} AND e.run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			  AND (e.kind != 'run.completed' OR coalesce(json_extract(e.payload, '$.status'), 'completed') IN ('completed', 'failed', 'requires_approval', 'needs_delegation'))
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END,
			       json_extract(p.metadata, '$.ownerHostSessionId')
			FROM ${kernelRuntimeRuns} p JOIN ${tediRuntimeEvents} e
			  ON e.organization_id = p.organization_id
			    AND e.run_id = p.child_run_id AND e.tedi_id = p.delegated_tedi_id
			WHERE e.organization_id = ${input.organizationId} AND e.run_id IS NOT NULL
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
			UNION ALL
			SELECT e.id, e.created_at, p.conversation_id, e.run_id, p.id,
			       CASE e.kind WHEN 'run.completed' THEN 'completed'
			         WHEN 'run.failed' THEN 'failed' ELSE 'needs_input' END,
			       json_extract(p.metadata, '$.ownerHostSessionId')
			FROM ${kernelRuntimeRuns} p
			CROSS JOIN json_each(p.metadata, '$.homePlan.assignments') a
			CROSS JOIN ${tediRuntimeEvents} e
			WHERE p.organization_id = ${input.organizationId}
			  AND e.organization_id = p.organization_id
			  AND e.run_id = json_extract(a.value, '$.childRunId')
			  AND e.tedi_id = json_extract(a.value, '$.ownerTediId')
			  AND e.kind IN ('run.completed', 'run.failed', 'approval.requested')
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

export interface ListKernelRuntimeEventsInput {
	organizationId: string;
	conversationId?: string;
	runId?: string;
	runIdNull?: boolean;
	id?: string;
	kind?: TediRuntimeEventKind;
	kinds?: readonly TediRuntimeEventKind[];
	createdBefore?: string;
	order?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

export async function listKernelRuntimeEvents(
	db: TenantStoreDb,
	input: ListKernelRuntimeEventsInput,
): Promise<KernelRuntimeEvent[]> {
	if (input.kinds?.length === 0) return [];
	const conditions = [
		eq(kernelRuntimeEvents.organizationId, input.organizationId),
		input.conversationId
			? eq(kernelRuntimeEvents.conversationId, input.conversationId)
			: undefined,
		input.runId
			? eq(kernelRuntimeEvents.runId, input.runId)
			: input.runIdNull
				? isNull(kernelRuntimeEvents.runId)
				: undefined,
		input.id ? eq(kernelRuntimeEvents.id, input.id) : undefined,
		input.kind ? eq(kernelRuntimeEvents.kind, input.kind) : undefined,
		input.kinds ? inArray(kernelRuntimeEvents.kind, input.kinds) : undefined,
		input.createdBefore
			? lt(kernelRuntimeEvents.createdAt, input.createdBefore)
			: undefined,
	];
	const base = db
		.select()
		.from(kernelRuntimeEvents)
		.where(and(...conditions));
	const ordered =
		input.order === "asc"
			? base.orderBy(
					asc(kernelRuntimeEvents.createdAt),
					asc(kernelRuntimeEvents.id),
				)
			: input.order === "desc"
				? base.orderBy(
						desc(kernelRuntimeEvents.createdAt),
						desc(kernelRuntimeEvents.id),
					)
				: base;
	if (input.limit !== undefined && input.offset)
		return ordered.limit(input.limit).offset(input.offset);
	if (input.limit !== undefined) return ordered.limit(input.limit);
	if (input.offset) return ordered.limit(-1).offset(input.offset);
	return ordered;
}

export interface ListTediRuntimeEventsInput {
	organizationId: string;
	tediId: string;
	runId?: string;
	runIds?: string[];
	runIdPrefix?: string;
	kinds?: readonly TediRuntimeEventKind[];
	order?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

export async function listTediRuntimeEvents(
	db: TenantStoreDb,
	input: ListTediRuntimeEventsInput,
): Promise<TediRuntimeEventRow[]> {
	if (input.kinds?.length === 0 || input.runIds?.length === 0) return [];
	if (input.runIds) {
		const { runIds, ...rest } = input;
		const rows: TediRuntimeEventRow[] = [];
		for (const runId of new Set(runIds))
			rows.push(
				...(await listTediRuntimeEvents(db, {
					...rest,
					runId,
					limit: undefined,
					offset: undefined,
				})),
			);
		if (input.order) {
			const direction = input.order === "desc" ? -1 : 1;
			rows.sort(
				(a, b) =>
					direction *
					(a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
			);
		}
		const offsetRows = input.offset ? rows.slice(input.offset) : rows;
		return input.limit === undefined
			? offsetRows
			: offsetRows.slice(0, input.limit);
	}
	const conditions = [
		eq(tediRuntimeEvents.organizationId, input.organizationId),
		eq(tediRuntimeEvents.tediId, input.tediId),
		input.runId ? eq(tediRuntimeEvents.runId, input.runId) : undefined,
		input.runIdPrefix
			? like(tediRuntimeEvents.runId, `${input.runIdPrefix}%`)
			: undefined,
		input.kinds ? inArray(tediRuntimeEvents.kind, input.kinds) : undefined,
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
	if (input.limit !== undefined && input.offset)
		return ordered.limit(input.limit).offset(input.offset);
	if (input.limit !== undefined) return ordered.limit(input.limit);
	if (input.offset) return ordered.limit(-1).offset(input.offset);
	return ordered;
}

export async function countTediRuntimeEvents(
	db: TenantStoreDb,
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

function eventTraceId(value: NewKernelRuntimeEvent): string | undefined {
	const metadataTraceId = value.runtimeMetadata?.traceId;
	return (
		value.traceId ??
		(typeof metadataTraceId === "string" ? metadataTraceId : undefined)
	);
}

export type TenantStoreTransaction = Parameters<
	Parameters<TenantStoreDb["transaction"]>[0]
>[0];

export function insertKernelRuntimeEventInTransaction(
	tx: TenantStoreTransaction,
	value: NewKernelRuntimeEvent,
): { row: KernelRuntimeEvent | undefined; inserted: boolean } {
	const [existing] = tx
		.select()
		.from(kernelRuntimeEvents)
		.where(eq(kernelRuntimeEvents.id, value.id))
		.limit(1)
		.all();
	if (existing) {
		if (
			existing.organizationId !== value.organizationId ||
			(value.causeEventId !== undefined &&
				existing.causeEventId !== value.causeEventId)
		)
			throw new KernelRuntimeEventConflictError();
		return { row: existing, inserted: false };
	}
	if (value.causeEventId !== undefined && value.causeEventId !== null) {
		if (!value.causeEventId || value.causeEventId === value.id)
			throw new KernelRuntimeEventConflictError();
		const [cause] = tx
			.select({ id: kernelRuntimeEvents.id })
			.from(kernelRuntimeEvents)
			.where(
				and(
					eq(kernelRuntimeEvents.id, value.causeEventId),
					eq(kernelRuntimeEvents.organizationId, value.organizationId),
				),
			)
			.limit(1)
			.all();
		if (!cause) throw new KernelRuntimeEventConflictError();
	}
	const [row] = tx
		.insert(kernelRuntimeEvents)
		.values({ ...value, traceId: eventTraceId(value) })
		.returning()
		.all();
	return { row, inserted: true };
}

export async function insertKernelRuntimeEventIfAbsent(
	db: TenantStoreDb,
	value: NewKernelRuntimeEvent,
): Promise<{ row: KernelRuntimeEvent | undefined; inserted: boolean }> {
	return db.transaction((tx) =>
		insertKernelRuntimeEventInTransaction(tx, value),
	);
}

export async function getKernelRuntimeEventById(
	db: TenantStoreDb,
	input: { organizationId: string; id: string },
): Promise<KernelRuntimeEvent | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.id, input.id),
			),
		)
		.limit(1);
	return row;
}

export async function updateKernelRuntimeEventMetadata(
	db: TenantStoreDb,
	input: {
		organizationId: string;
		id: string;
		runtimeMetadata: Record<string, JsonValue>;
	},
): Promise<void> {
	const metadataTraceId = input.runtimeMetadata.traceId;
	await db
		.update(kernelRuntimeEvents)
		.set({
			runtimeMetadata: input.runtimeMetadata,
			traceId: typeof metadataTraceId === "string" ? metadataTraceId : null,
		})
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.id, input.id),
			),
		);
}
