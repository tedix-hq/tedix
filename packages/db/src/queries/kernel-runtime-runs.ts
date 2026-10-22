import { and, desc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { chunkForBoundParams } from "../utils/batch";
import {
	chatDispatchIdempotency,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import {
	buildRecordKernelConversationMessageStatement,
	type RecordKernelConversationMessageParams,
} from "./kernel-conversations";
import {
	buildInsertApprovalExecutionReceiptStatement,
	type RecordApprovalExecutionReceiptParams,
} from "./approval-simulations";

import {
	type BuildStartFirstAttemptParams,
	buildStartFirstAttemptStatements,
} from "./runtime-submissions/attempts";
import {
	buildInsertKernelRuntimeEventIfAbsentStatement,
	buildInsertKernelRuntimeEventStatement,
	insertKernelRuntimeEventIfAbsent,
	type KernelRuntimeEvent,
	type NewKernelRuntimeEvent,
	resolveReplayedKernelRuntimeEvent,
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

/** Stable cursor: resolving a row must not skip the next pending row. */
export async function listPendingDelegationRuns(
	db: DbClient,
	input: {
		organizationId: string;
		limit: number;
		cursor?: { at: string; id: string };
	},
): Promise<KernelRuntimeRun[]> {
	return db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				sql`(json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder') = 'object' OR json_extract(${kernelRuntimeRuns.metadata}, '$.delegationWorkOrder.kind') = 'workstation.attach')`,
				...(input.cursor
					? [
							sql`(${kernelRuntimeRuns.createdAt}, ${kernelRuntimeRuns.id}) < (${input.cursor.at}, ${input.cursor.id})`,
						]
					: []),
			),
		)
		.orderBy(desc(kernelRuntimeRuns.createdAt), desc(kernelRuntimeRuns.id))
		.limit(input.limit);
}

export interface CountActiveDelegatedRunsParams {
	organizationId: string;
	/** Ignore rows not touched since this ISO instant (stale, unsettled rows). */
	updatedSince: string;
}

/**
 * Live delegated load per target tedi: queued or running Home runs that
 * delegated to it. The org + status prefix of
 * `idx_kernel_runtime_runs_status_updated` bounds the scan to live rows.
 */
export async function countActiveDelegatedRunsByTedi(
	db: DbQueryClient,
	input: CountActiveDelegatedRunsParams,
): Promise<Map<string, number>> {
	const rows = await db
		.select({
			tediId: kernelRuntimeRuns.delegatedTediId,
			active: sql<number>`count(*)`.mapWith(Number),
		})
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				inArray(kernelRuntimeRuns.status, ["queued", "running"]),
				// Rows carry both ISO and SQLite CURRENT_TIMESTAMP spellings.
				sql`datetime(${kernelRuntimeRuns.updatedAt}) >= datetime(${input.updatedSince})`,
				sql`${kernelRuntimeRuns.delegatedTediId} IS NOT NULL`,
			),
		)
		.groupBy(kernelRuntimeRuns.delegatedTediId);
	return new Map(
		rows.flatMap((row) => (row.tediId ? [[row.tediId, row.active]] : [])),
	);
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
	expectedUpdatedAt?: string;
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
				...(input.expectedUpdatedAt === undefined
					? []
					: [eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt)]),
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
	approvalReceipt?: RecordApprovalExecutionReceiptParams;
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
	const runStatement = buildTransitionKernelRuntimeRunStatusStatement(
		db,
		params.run,
	);
	const eventStatements = params.events.map((event) =>
		buildInsertKernelRuntimeEventIfAbsentStatement(db, event),
	);
	const [runRows, ...eventRows] = params.approvalReceipt
		? await db
				.batch([
					runStatement,
					buildInsertApprovalExecutionReceiptStatement(
						db,
						params.approvalReceipt,
					),
					...eventStatements,
				])
				.then(([runs, _receipt, ...events]) => [runs, ...events] as const)
		: await db.batch([runStatement, ...eventStatements]);

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

export interface OpenKernelRuntimeTurnParams {
	/** The persist-first run row (`onConflictDoNothing` on its id). */
	run: NewKernelRuntimeRun;
	/**
	 * `message.received` first, `run.started` second. The second may bind its
	 * `causeEventId` to the first: the batch inserts them in order inside one
	 * transaction, so the cause row exists by the time the INSERT…SELECT runs.
	 */
	events: readonly [
		received: NewKernelRuntimeEvent,
		started: NewKernelRuntimeEvent,
	];
	/**
	 * Conversation-index bump for the `message.received` row, composed only on
	 * a first delivery (the caller proves there is no prior `run.started` for
	 * this turn). `null` skips it — a replay must not double-count.
	 */
	conversation: RecordKernelConversationMessageParams | null;
	/**
	 * The run's first submission attempt and its `submission.admitted` receipt,
	 * composed only when the caller saw the submission freshly admitted. `null`
	 * leaves both to the caller.
	 */
	submission: {
		attempt: BuildStartFirstAttemptParams;
		admittedEvent: NewKernelRuntimeEvent;
	} | null;
}

export interface OpenKernelRuntimeTurnResult {
	/** One entry per input event, in order; `inserted: false` is an idempotent replay. */
	events: Array<{ row: KernelRuntimeEvent; inserted: boolean }>;
}

/**
 * Land a Home turn's ingress rows — the conversation-index bump, the
 * `message.received` and `run.started` events, the run row and its first
 * submission attempt — in one D1 batch instead of one round trip per row.
 * Every statement is idempotent or caller-gated, so the batch is equivalent
 * to the former sequential writes; a replayed event (empty `returning()`) is
 * resolved to its existing row afterwards, and a `run.started` whose cause is
 * missing raises `KernelRuntimeEventConflictError` exactly as the single
 * insert did.
 */
export async function openKernelRuntimeTurn(
	db: DbClient,
	params: OpenKernelRuntimeTurnParams,
): Promise<OpenKernelRuntimeTurnResult> {
	const [received, started] = params.events;
	const eventStatements = [
		buildInsertKernelRuntimeEventStatement(db, received),
		buildInsertKernelRuntimeEventStatement(db, started),
	] as const;
	const runStatement = db
		.insert(kernelRuntimeRuns)
		.values(params.run)
		.onConflictDoNothing({ target: kernelRuntimeRuns.id })
		.returning({ id: kernelRuntimeRuns.id });
	const conversationStatements = params.conversation
		? [buildRecordKernelConversationMessageStatement(db, params.conversation)]
		: [];
	const submissionStatements = params.submission
		? [
				...buildStartFirstAttemptStatements(db, params.submission.attempt),
				buildInsertKernelRuntimeEventIfAbsentStatement(
					db,
					params.submission.admittedEvent,
				),
			]
		: [];
	const statements: BatchItem<"sqlite">[] = [
		...conversationStatements,
		...eventStatements,
		runStatement,
		...submissionStatements,
	];
	const results = (
		await db.batch(
			statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
		)
	).slice(conversationStatements.length, conversationStatements.length + 2);
	const events: OpenKernelRuntimeTurnResult["events"] = [];
	for (const [index, value] of params.events.entries()) {
		const inserted = (results[index] as KernelRuntimeEvent[] | undefined)?.[0];
		if (inserted) {
			events.push({ row: inserted, inserted: true });
			continue;
		}
		const replay = await resolveReplayedKernelRuntimeEvent(db, value);
		if (!replay.row)
			throw new Error(
				`openKernelRuntimeTurn: event ${value.id} was neither inserted nor found`,
			);
		events.push({ row: replay.row, inserted: false });
	}
	return { events };
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

/**
 * The newest of the conversation's runs that is parked on an approval
 * card (`requires_approval` with a stored `approvalRequestId`), so a bare
 * "approve" or "reject" reply can resolve that card even when another turn
 * came in between. Caller must separately authorize conversation access.
 */
export async function readLatestRunAwaitingApproval(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		excludeRunId: string;
	},
): Promise<{ runId: string; approvalRequestId: string } | null> {
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
				eq(kernelRuntimeRuns.status, "requires_approval"),
				ne(kernelRuntimeRuns.id, input.excludeRunId),
				sql`json_type(${kernelRuntimeRuns.metadata}, '$.approvalRequestId') = 'text' AND length(json_extract(${kernelRuntimeRuns.metadata}, '$.approvalRequestId')) > 0`,
			),
		)
		.orderBy(desc(kernelRuntimeRuns.updatedAt), desc(kernelRuntimeRuns.id))
		.limit(1);
	for (const row of rows) {
		if (row.id === input.excludeRunId || row.status !== "requires_approval")
			continue;
		const approvalRequestId = (row.metadata as Record<string, unknown> | null)
			?.approvalRequestId;
		if (typeof approvalRequestId === "string" && approvalRequestId)
			return { runId: row.id, approvalRequestId };
	}
	return null;
}

/** Conversation-bound pending delegation; completed follow-ups cannot hide it. */
export async function readLatestRunAwaitingDelegationApproval(
	db: DbQueryClient,
	input: {
		organizationId: string;
		conversationId: string;
		excludeRunId: string;
		targetTediId?: string;
	},
): Promise<KernelRuntimeRun | null> {
	const [row] = await db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.conversationId, input.conversationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				ne(kernelRuntimeRuns.id, input.excludeRunId),
				isNull(kernelRuntimeRuns.childRunId),
				input.targetTediId
					? sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.targetTediId') = ${input.targetTediId}`
					: undefined,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.decision.mode') = 'needs_approval'`,
				sql`json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder') = 'object'`,
				sql`json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.targetTediId') = 'text' AND length(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.targetTediId')) > 0`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.resolutionStatus') IS NULL`,
			),
		)
		.orderBy(desc(kernelRuntimeRuns.updatedAt), desc(kernelRuntimeRuns.id))
		.limit(1);
	return row ?? null;
}

/** Exact evidence only; caller must separately authorize conversation access. */
export async function findKernelRuntimeRunForOutputRevision(
	db: DbQueryClient,
	input: { organizationId: string; outputId: string; revisionId: string },
): Promise<{ id: string; conversationId: string } | null> {
	// Status and output are checked here, not in SQL: with a status equality the
	// planner prefers the (organization_id, status) index while most
	// output_revision_id values are NULL, and reads every completed run.
	const rows = await db
		.select({
			id: kernelRuntimeRuns.id,
			conversationId: kernelRuntimeRuns.conversationId,
			status: kernelRuntimeRuns.status,
			outputId: sql<
				string | null
			>`json_extract(${kernelRuntimeRuns.metadata}, '$.kernelOutputReceipt.outputId')`,
		})
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.outputRevisionId, input.revisionId),
			),
		)
		.limit(10);
	const matches = rows.filter(
		(row) => row.status === "completed" && row.outputId === input.outputId,
	);
	return matches.length === 1
		? { id: matches[0]!.id, conversationId: matches[0]!.conversationId }
		: null;
}
