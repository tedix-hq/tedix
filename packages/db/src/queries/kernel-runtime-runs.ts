import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { chunkForBoundParams } from "../utils/batch";
import {
	chatDispatchIdempotency,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import {
	buildInsertKernelRuntimeEventIfAbsentStatement,
	insertKernelRuntimeEventIfAbsent,
	type KernelRuntimeEvent,
	type NewKernelRuntimeEvent,
} from "./kernel-runtime-events";

export type KernelRuntimeRun = typeof kernelRuntimeRuns.$inferSelect;
export type KernelRuntimeRunUpdate = Partial<
	Omit<typeof kernelRuntimeRuns.$inferInsert, "id" | "organizationId">
>;
export type NewKernelRuntimeRun = typeof kernelRuntimeRuns.$inferInsert;

export async function getKernelRuntimeRun(
	db: DbClient,
	input: { id: string; organizationId?: string },
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			input.organizationId
				? and(
						eq(kernelRuntimeRuns.id, input.id),
						eq(kernelRuntimeRuns.organizationId, input.organizationId),
					)
				: eq(kernelRuntimeRuns.id, input.id),
		)
		.limit(1);
	return row;
}

export async function insertKernelRuntimeRunIfAbsent(
	db: DbClient,
	value: NewKernelRuntimeRun,
): Promise<void> {
	await db
		.insert(kernelRuntimeRuns)
		.values(value)
		.onConflictDoNothing({ target: kernelRuntimeRuns.id });
}

export async function hasUnacceptedChatDispatch(
	db: DbClient,
	input: { tediId: string; homeRunId: string },
): Promise<boolean> {
	const rows = await db
		.select({ runId: chatDispatchIdempotency.runId })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				like(chatDispatchIdempotency.idempotencyKey, `${input.homeRunId}:%`),
				isNull(chatDispatchIdempotency.runId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export async function getKernelRuntimeRunStatus(
	db: DbClient,
	input: { id: string; organizationId: string },
): Promise<KernelRuntimeRun["status"] | undefined> {
	const [row] = await db
		.select({ status: kernelRuntimeRuns.status })
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
			),
		)
		.limit(1);
	return row?.status;
}

export async function listKernelRuntimeRuns(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId?: string;
		childRunIds?: string[];
		orderBy?: "created" | "updated" | "none";
		limit: number;
		offset?: number;
	},
): Promise<KernelRuntimeRun[]> {
	if (input.childRunIds?.length === 0) return [];
	const conditions = [
		eq(kernelRuntimeRuns.organizationId, input.organizationId),
		...(input.conversationId
			? [eq(kernelRuntimeRuns.conversationId, input.conversationId)]
			: []),
		// bound-params: delegated child-run refs of ONE Home run / conversation
		...(input.childRunIds
			? [inArray(kernelRuntimeRuns.childRunId, input.childRunIds)]
			: []),
	];
	const base = db
		.select()
		.from(kernelRuntimeRuns)
		.where(and(...conditions));
	const ordered =
		input.orderBy === "none"
			? base
			: base.orderBy(
					desc(
						input.orderBy === "created"
							? kernelRuntimeRuns.createdAt
							: kernelRuntimeRuns.updatedAt,
					),
				);
	const query = ordered.limit(input.limit);
	return input.offset ? query.offset(input.offset) : query;
}

export async function listKernelRuntimeRunMetadata(
	db: DbClient,
	input: { organizationId: string; conversationId: string; limit: number },
): Promise<Array<Pick<KernelRuntimeRun, "metadata">>> {
	return db
		.select({ metadata: kernelRuntimeRuns.metadata })
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.conversationId, input.conversationId),
			),
		)
		.orderBy(desc(kernelRuntimeRuns.createdAt))
		.limit(input.limit);
}

export async function listKernelRuntimeRunObjectiveSourcesByIds(
	db: DbClient,
	input: { organizationId: string; ids: string[] },
): Promise<Array<Pick<KernelRuntimeRun, "id" | "metadata" | "preview">>> {
	if (input.ids.length === 0) return [];
	const rows: Array<Pick<KernelRuntimeRun, "id" | "metadata" | "preview">> = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(input.ids)], 50)) {
		rows.push(
			...(await db
				.select({
					id: kernelRuntimeRuns.id,
					metadata: kernelRuntimeRuns.metadata,
					preview: kernelRuntimeRuns.preview,
				})
				.from(kernelRuntimeRuns)
				.where(
					and(
						eq(kernelRuntimeRuns.organizationId, input.organizationId),
						inArray(kernelRuntimeRuns.id, chunk),
					),
				)),
		);
	}
	return rows;
}

export async function findKernelRuntimeRunByChild(
	db: DbClient,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
	},
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.delegatedTediId, input.delegatedTediId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return row;
}

export async function getDurableKernelRuntimeRun(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
	},
): Promise<KernelRuntimeRun | undefined> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.delegatedTediId, input.delegatedTediId),
				eq(kernelRuntimeRuns.childRunId, input.childRunId),
			),
		)
		.limit(1);
	return row;
}

export async function updateKernelRuntimeRun(
	db: DbClient,
	id: string,
	patch: KernelRuntimeRunUpdate,
): Promise<void> {
	await db
		.update(kernelRuntimeRuns)
		.set(patch)
		.where(eq(kernelRuntimeRuns.id, id));
}

export async function updateKernelRuntimeRunForOrg(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		patch: KernelRuntimeRunUpdate;
	},
): Promise<void> {
	await db
		.update(kernelRuntimeRuns)
		.set(input.patch)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
			),
		);
}

export interface TransitionKernelRuntimeRunStatusParams {
	id: string;
	organizationId: string;
	fromStatus: KernelRuntimeRun["status"];
	patch: KernelRuntimeRunUpdate;
}

/** Unexecuted conditional status patch, for `db.batch()` composition. */
export function buildTransitionKernelRuntimeRunStatusStatement(
	db: DbClient,
	input: TransitionKernelRuntimeRunStatusParams,
) {
	return db
		.update(kernelRuntimeRuns)
		.set(input.patch)
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.fromStatus),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
}

export async function transitionKernelRuntimeRunStatus(
	db: DbClient,
	input: TransitionKernelRuntimeRunStatusParams,
): Promise<boolean> {
	const rows = await buildTransitionKernelRuntimeRunStatusStatement(db, input);
	return rows.length > 0;
}

export interface SettleKernelRuntimeTurnParams {
	run: TransitionKernelRuntimeRunStatusParams;
	/** Terminal transcript events in stream order, each without a `causeEventId`. */
	events: readonly NewKernelRuntimeEvent[];
}

export interface SettleKernelRuntimeTurnResult {
	/** False when the run had already left `fromStatus` (an operator cancel won). */
	runTransitioned: boolean;
	/** One entry per input event, in order; `inserted: false` is an idempotent replay. */
	events: Array<{ row: KernelRuntimeEvent; inserted: boolean }>;
}

/**
 * Land a turn's terminal run patch and its transcript events in one D1 batch
 * instead of one round trip per row. The patch is conditional and the inserts
 * are idempotent, so the statements are independent: a lost status CAS still
 * records the transcript, exactly as the sequential writes did. A replayed
 * event (empty `returning()`) is resolved to its existing row afterwards.
 */
export async function settleKernelRuntimeTurn(
	db: DbClient,
	params: SettleKernelRuntimeTurnParams,
): Promise<SettleKernelRuntimeTurnResult> {
	const [runRows, ...eventRows] = await db.batch([
		buildTransitionKernelRuntimeRunStatusStatement(db, params.run),
		...params.events.map((event) =>
			buildInsertKernelRuntimeEventIfAbsentStatement(db, event),
		),
	]);
	const events: SettleKernelRuntimeTurnResult["events"] = [];
	for (const [index, value] of params.events.entries()) {
		const inserted = eventRows[index]?.[0];
		if (inserted) {
			events.push({ row: inserted, inserted: true });
			continue;
		}
		const replay = await insertKernelRuntimeEventIfAbsent(db, value);
		if (!replay.row)
			throw new Error(
				`settleKernelRuntimeTurn: event ${value.id} was neither inserted nor found`,
			);
		events.push({ row: replay.row, inserted: replay.inserted });
	}
	return { runTransitioned: runRows.length > 0, events };
}

/**
 * Single-statement compare-and-set on a run's `updatedAt`: advances it only
 * when the row still has the status and `updatedAt` the caller read. Two
 * resolvers that read the same row cannot both win, which is what makes a
 * read-then-decide approval latch atomic without a metadata claim that could
 * be stranded by a crash.
 */
export async function compareAndTouchKernelRuntimeRun(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		status: KernelRuntimeRun["status"];
		expectedUpdatedAt: string;
		updatedAt: string;
	},
): Promise<boolean> {
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({ updatedAt: input.updatedAt })
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.status),
				eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length > 0;
}

export async function readPendingWorkflowHint(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		excludeRunId: string;
	},
): Promise<string | null> {
	try {
		const rows = await db
			.select({
				id: kernelRuntimeRuns.id,
				status: kernelRuntimeRuns.status,
				metadata: kernelRuntimeRuns.metadata,
			})
			.from(kernelRuntimeRuns)
			.where(
				and(
					eq(kernelRuntimeRuns.organizationId, input.organizationId),
					eq(kernelRuntimeRuns.conversationId, input.conversationId),
				),
			)
			.orderBy(desc(kernelRuntimeRuns.updatedAt))
			.limit(5);
		const priorRun = rows.find((row) => row.id !== input.excludeRunId);
		if (!priorRun || priorRun.status !== "completed") return null;
		const metadata = priorRun.metadata as Record<string, unknown> | null;
		const route = metadata?.kernelRoute as Record<string, unknown> | null;
		const hint = route?.workflowHint;
		return route?.routeKind === "run_workflow" &&
			typeof hint === "string" &&
			hint.trim()
			? hint.trim()
			: null;
	} catch {
		return null;
	}
}

/** Exact evidence only; caller must separately authorize conversation access. */
export async function findKernelRuntimeRunForOutputRevision(
	db: DbQueryClient,
	input: { organizationId: string; outputId: string; revisionId: string },
): Promise<{ id: string; conversationId: string } | null> {
	const metadata = sql`CASE WHEN json_valid(${kernelRuntimeRuns.metadata}) THEN ${kernelRuntimeRuns.metadata} ELSE '{}' END`;
	const rows = await db
		.select({
			id: kernelRuntimeRuns.id,
			conversationId: kernelRuntimeRuns.conversationId,
		})
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, "completed"),
				sql`json_extract(${metadata}, '$.kernelEvidence.toolName') IN ('os.create_os_output', 'os__create_os_output')`,
				sql`((json_extract(${metadata}, '$.kernelOutputReceipt.outputId') = ${input.outputId}
 AND json_extract(${metadata}, '$.kernelOutputReceipt.revisionId') = ${input.revisionId}) OR
 (json_type(${metadata}, '$.kernelOutputReceipt') IS NULL
 AND json_extract(${metadata}, '$.kernelEvidence.data.output.id') = ${input.outputId}
 AND json_extract(${metadata}, '$.kernelEvidence.data.revision.id') = ${input.revisionId}
 AND json_extract(${metadata}, '$.kernelEvidence.data.revision.outputId') = ${input.outputId}))`,
			),
		)
		.limit(2);
	return rows.length === 1 ? rows[0]! : null;
}
