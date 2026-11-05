import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import {
	tediRuntimeEvents,
	type TediRuntimeEventKind,
} from "../../schema/cognitive-runtime";
import type {
	TediRuntimeEventCursor,
	TediRuntimeEventInsert,
	TediRuntimeEventRow,
} from "../cognitive-runtime";
import type { TenantStoreDb } from "./tenant-store";

function traceId(input: TediRuntimeEventInsert): string | undefined {
	const metadataTraceId = input.runtimeMetadata?.traceId;
	return (
		input.traceId ??
		(typeof metadataTraceId === "string" ? metadataTraceId : undefined)
	);
}

export async function insertTediRuntimeEvent(
	db: TenantStoreDb,
	input: TediRuntimeEventInsert,
): Promise<TediRuntimeEventRow | null> {
	const [row] = await db
		.insert(tediRuntimeEvents)
		.values({ ...input, traceId: traceId(input) })
		.onConflictDoNothing({ target: tediRuntimeEvents.id })
		.returning();
	return row ?? null;
}

export async function getTediRuntimeEventById(
	db: TenantStoreDb,
	input: { organizationId: string; tediId?: string; id: string },
): Promise<TediRuntimeEventRow | null> {
	const [row] = await db
		.select()
		.from(tediRuntimeEvents)
		.where(
			and(
				eq(tediRuntimeEvents.organizationId, input.organizationId),
				eq(tediRuntimeEvents.id, input.id),
				input.tediId ? eq(tediRuntimeEvents.tediId, input.tediId) : undefined,
			),
		)
		.limit(1);
	return row ?? null;
}

export async function updateTediRuntimeEventPayload(
	db: TenantStoreDb,
	input: {
		id: string;
		organizationId: string;
		payload: TediRuntimeEventInsert["payload"];
	},
): Promise<TediRuntimeEventRow | null> {
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

export interface ListTediRuntimeEventsForRouterInput {
	organizationId: string;
	tediId: string;
	conversationId?: string;
	runId?: string;
	runIds?: string[];
	kind?: TediRuntimeEventKind;
	kinds?: TediRuntimeEventKind[];
	before?: TediRuntimeEventCursor;
	order?: "asc" | "desc";
	limit?: number;
}

export async function listTediRuntimeEventsForRouter(
	db: TenantStoreDb,
	input: ListTediRuntimeEventsForRouterInput,
): Promise<TediRuntimeEventRow[]> {
	if (input.runIds?.length === 0 || input.kinds?.length === 0) return [];
	if (input.runIds) {
		const { runIds, ...rest } = input;
		const rows: TediRuntimeEventRow[] = [];
		for (const runId of new Set(runIds))
			rows.push(
				...(await listTediRuntimeEventsForRouter(db, {
					...rest,
					runId,
					limit: undefined,
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
		return input.limit === undefined ? rows : rows.slice(0, input.limit);
	}
	const conditions = [
		eq(tediRuntimeEvents.organizationId, input.organizationId),
		eq(tediRuntimeEvents.tediId, input.tediId),
		input.conversationId
			? eq(tediRuntimeEvents.conversationId, input.conversationId)
			: undefined,
		input.runId ? eq(tediRuntimeEvents.runId, input.runId) : undefined,
		input.kind ? eq(tediRuntimeEvents.kind, input.kind) : undefined,
		input.kinds ? inArray(tediRuntimeEvents.kind, input.kinds) : undefined,
		input.before
			? or(
					lt(tediRuntimeEvents.createdAt, input.before.createdAt),
					and(
						eq(tediRuntimeEvents.createdAt, input.before.createdAt),
						lt(tediRuntimeEvents.id, input.before.id),
					),
				)
			: undefined,
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
