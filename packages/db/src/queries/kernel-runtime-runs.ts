import {
	and,
	desc,
	eq,
	exists,
	inArray,
	isNull,
	like,
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { workItems, workAttempts } from "../schema/work-items";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { chunkForBoundParams } from "../utils/batch";
import {
	chatDispatchIdempotency,
	kernelRuntimeEvents,
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
		kind?: "home_delegation";
	},
): Promise<KernelRuntimeRun[]> {
	return db
		.select()
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				input.kind === "home_delegation"
					? sql`json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder') = 'object'`
					: sql`(json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder') = 'object' OR json_extract(${kernelRuntimeRuns.metadata}, '$.delegationWorkOrder.kind') = 'workstation.attach')`,
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

function preserveHomeDelegationClaims(patch: KernelRuntimeRunUpdate) {
	if (patch.metadata === undefined) return patch;
	let metadata = sql`${JSON.stringify(patch.metadata)}`;
	for (const key of ["homeDelegationResume", "homeDelegationResolutionClaim"]) {
		const path = "$." + key;
		metadata = sql`case when json_type(${kernelRuntimeRuns.metadata}, ${path}) = 'object' then json_set(case when json_type(${metadata}) = 'object' then ${metadata} else '{}' end, ${path}, json_extract(${kernelRuntimeRuns.metadata}, ${path})) else json_remove(${metadata}, ${path}) end`;
	}
	return { ...patch, metadata };
}

export async function updateKernelRuntimeRun(
	db: DbClient,
	id: string,
	patch: KernelRuntimeRunUpdate,
): Promise<void> {
	await db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(patch))
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
		.set(preserveHomeDelegationClaims(input.patch))
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
		.set(preserveHomeDelegationClaims(input.patch))
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
 * read-then-decide approval latch atomic. Home delegation also retains a
 * durable owner marker so a fresh reread cannot overtake an in-flight resolver.
 */
export async function compareAndTouchKernelRuntimeRun(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		status: KernelRuntimeRun["status"];
		expectedUpdatedAt: string;
		updatedAt: string;
		requireNoDelegationResumeClaim?: boolean;
		delegationResolutionClaimId?: string;
		delegationApprovalEventId?: string;
		delegationWorkItemId?: string;
		delegationScopeDigest?: string;
	},
): Promise<boolean> {
	if (
		input.requireNoDelegationResumeClaim &&
		(!input.delegationResolutionClaimId?.trim() ||
			!input.delegationApprovalEventId?.trim())
	)
		return false;
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.updatedAt,
			...(input.requireNoDelegationResumeClaim
				? {
						metadata: sql`json_set(coalesce(${kernelRuntimeRuns.metadata}, '{}'), '$.homeDelegationResolutionClaim', json(${JSON.stringify({ version: 1, phase: "resolving", claimId: input.delegationResolutionClaimId, claimedAt: input.updatedAt, approvalEventId: input.delegationApprovalEventId, approvalResolvedAt: input.updatedAt, organizationId: input.organizationId, runId: input.id, workItemId: input.delegationWorkItemId ?? null, scopeDigest: input.delegationScopeDigest ?? null })}), '$.homeDelegationResolutionClaim.conversationId', ${kernelRuntimeRuns.conversationId})`,
					}
				: {}),
		})
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.id),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, input.status),
				eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt),
				input.requireNoDelegationResumeClaim
					? sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume') is null and (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim') is null or (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.phase') = 'admission_failed' and ${homeDelegationResolutionReceiptExists(db)}))`
					: undefined,
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

export interface ApprovedHomeDelegationApprovalEventSet {
	digest: string;
	originalExpiresAt: string;
	events: KernelRuntimeEvent[];
}

function validApprovalEventSet(
	value: unknown,
): value is ApprovedHomeDelegationApprovalEventSet {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proof = value as Partial<ApprovedHomeDelegationApprovalEventSet>;
	if (
		typeof proof.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(proof.digest) ||
		typeof proof.originalExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(proof.originalExpiresAt)) ||
		!Array.isArray(proof.events) ||
		proof.events.length < 2 ||
		proof.events.length > 8 ||
		new TextEncoder().encode(JSON.stringify(proof)).byteLength > 256 * 1024
	)
		return false;
	const ids = new Set<string>();
	let previous = "";
	for (const event of proof.events) {
		if (
			!event ||
			typeof event !== "object" ||
			typeof event.id !== "string" ||
			!event.id ||
			typeof event.createdAt !== "string" ||
			!Number.isFinite(Date.parse(event.createdAt)) ||
			ids.has(event.id) ||
			![
				"id",
				"organizationId",
				"runId",
				"conversationId",
				"kind",
				"createdAt",
				"payload",
				"runtimeMetadata",
				"runtimeBackend",
				"runtimeExternalId",
				"runtimeExternalUrl",
				"delegatedTediId",
				"childRunId",
				"causeEventId",
				"messageId",
				"sequence",
				"delta",
				"traceId",
			].every((key) => Object.hasOwn(event, key))
		)
			return false;
		const key = `${event.createdAt}\0${event.id}`;
		if (key <= previous) return false;
		previous = key;
		ids.add(event.id);
	}
	return true;
}

/** Freeze the complete approval history, including producer fields, through the send boundary. */
function approvedHomeApprovalHistoryGuard(
	input: Pick<
		ClaimApprovedHomeDelegationResumeParams,
		| "organizationId"
		| "runId"
		| "conversationId"
		| "approvalEventId"
		| "approvalResolvedAt"
		| "approvalEventSet"
	>,
	now: string,
) {
	const proof = input.approvalEventSet;
	if (!proof)
		return sql`(select count(*) from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.organizationId} = ${input.organizationId} and ${kernelRuntimeEvents.runId} = ${input.runId} and ${kernelRuntimeEvents.kind} = 'approval.resolved') = 1`;
	if (
		!validApprovalEventSet(proof) ||
		!Number.isFinite(Date.parse(now)) ||
		Date.parse(proof.originalExpiresAt) <= Date.parse(now) ||
		proof.events.at(-1)?.id !== input.approvalEventId ||
		proof.events.at(-1)?.createdAt !== input.approvalResolvedAt ||
		proof.events.some(
			(event) =>
				event.organizationId !== input.organizationId ||
				event.runId !== input.runId ||
				event.conversationId !== input.conversationId ||
				event.kind !== "approval.resolved",
		)
	)
		return sql`0`;
	return sql`
		json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.expiresAt') = ${proof.originalExpiresAt}
		and (select count(*) from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.organizationId} = ${input.organizationId} and ${kernelRuntimeEvents.runId} = ${input.runId} and ${kernelRuntimeEvents.kind} = 'approval.resolved') = ${proof.events.length}
		and not exists (
			select 1 from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.organizationId} = ${input.organizationId} and ${kernelRuntimeEvents.runId} = ${input.runId} and ${kernelRuntimeEvents.kind} = 'approval.resolved'
			and not exists (select 1 from json_each(${JSON.stringify(proof.events)}) as approval_snapshot where
				${kernelRuntimeEvents.id} is json_extract(approval_snapshot.value, '$.id')
				and ${kernelRuntimeEvents.organizationId} is json_extract(approval_snapshot.value, '$.organizationId')
				and ${kernelRuntimeEvents.runId} is json_extract(approval_snapshot.value, '$.runId')
				and ${kernelRuntimeEvents.conversationId} is json_extract(approval_snapshot.value, '$.conversationId')
				and ${kernelRuntimeEvents.kind} is json_extract(approval_snapshot.value, '$.kind')
				and ${kernelRuntimeEvents.createdAt} is json_extract(approval_snapshot.value, '$.createdAt')
				and json(${kernelRuntimeEvents.payload}) is json_extract(approval_snapshot.value, '$.payload')
				and json(${kernelRuntimeEvents.runtimeMetadata}) is json_extract(approval_snapshot.value, '$.runtimeMetadata')
				and ${kernelRuntimeEvents.runtimeBackend} is json_extract(approval_snapshot.value, '$.runtimeBackend')
				and ${kernelRuntimeEvents.runtimeExternalId} is json_extract(approval_snapshot.value, '$.runtimeExternalId')
				and ${kernelRuntimeEvents.runtimeExternalUrl} is json_extract(approval_snapshot.value, '$.runtimeExternalUrl')
				and ${kernelRuntimeEvents.delegatedTediId} is json_extract(approval_snapshot.value, '$.delegatedTediId')
				and ${kernelRuntimeEvents.childRunId} is json_extract(approval_snapshot.value, '$.childRunId')
				and ${kernelRuntimeEvents.causeEventId} is json_extract(approval_snapshot.value, '$.causeEventId')
				and ${kernelRuntimeEvents.messageId} is json_extract(approval_snapshot.value, '$.messageId')
				and ${kernelRuntimeEvents.sequence} is json_extract(approval_snapshot.value, '$.sequence')
				and ${kernelRuntimeEvents.delta} is json_extract(approval_snapshot.value, '$.delta')
				and ${kernelRuntimeEvents.traceId} is json_extract(approval_snapshot.value, '$.traceId')
			)
		)`;
}

export interface ClaimApprovedHomeDelegationResumeParams {
	organizationId: string;
	runId: string;
	conversationId: string;
	expectedUpdatedAt: string;
	expectedLatestEventAt: string | null;
	expectedMetadata: Record<string, JsonValue>;
	approvalEventId: string;
	approvalResolvedAt: string;
	approvalEventSet?: ApprovedHomeDelegationApprovalEventSet;
	workItemId: string;
	workItemVersion: number;
	admissionSpecRevision: string;
	scopeDigest: string;
	targetTediId: string;
	expectedChildRunId: string;
	now: string;
	claimId: string;
}

/** Claim one exact recorded approval without rewriting its actor, receipt or selected Work. */
export async function claimApprovedHomeDelegationResume(
	db: DbQueryClient,
	input: ClaimApprovedHomeDelegationResumeParams,
): Promise<KernelRuntimeRun | null> {
	const currentWork = db
		.select({ id: workItems.id })
		.from(workItems)
		.where(
			and(
				eq(workItems.id, input.workItemId),
				eq(workItems.orgId, input.organizationId),
				eq(workItems.disposition, "accepted"),
				eq(workItems.version, input.workItemVersion),
				eq(workItems.admissionSpecRevision, input.admissionSpecRevision),
			),
		);
	const approvedReceipt = db
		.select({ payload: kernelRuntimeEvents.payload })
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.id, input.approvalEventId),
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.runId, input.runId),
				eq(kernelRuntimeEvents.conversationId, input.conversationId),
				eq(kernelRuntimeEvents.kind, "approval.resolved"),
				eq(kernelRuntimeEvents.createdAt, input.approvalResolvedAt),
				sql`json_extract(${kernelRuntimeEvents.payload}, '$.status') = 'approved'`,
				sql`json_type(${kernelRuntimeEvents.payload}, '$.delegationWorkOrder') = 'object'`,
				sql`json_extract(${kernelRuntimeEvents.payload}, '$.delegationWorkOrder.targetTediId') = json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.targetTediId')`,
				sql`(json_extract(${kernelRuntimeEvents.payload}, '$.delegationWorkOrder.workItemId') is null or json_extract(${kernelRuntimeEvents.payload}, '$.delegationWorkOrder.workItemId') = ${input.workItemId})`,
			),
		);
	const [run] = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.now,
			metadata: sql`json_set(${JSON.stringify({ ...input.expectedMetadata, homeDelegationResume: { version: 1, phase: "claimed", claimId: input.claimId, approvalEventId: input.approvalEventId, approvalResolvedAt: input.approvalResolvedAt, workItemId: input.workItemId, workItemVersion: input.workItemVersion, admissionSpecRevision: input.admissionSpecRevision, scopeDigest: input.scopeDigest, targetTediId: input.targetTediId, expectedChildRunId: input.expectedChildRunId, claimedAt: input.now, ...(input.approvalEventSet ? { approvalEventSet: input.approvalEventSet } : {}) } })}, '$.homeDelegation.workOrder', json_extract((${approvedReceipt}), '$.delegationWorkOrder'), '$.delegationWorkOrder', json_extract((${approvedReceipt}), '$.delegationWorkOrder'), '$.homeDelegation.resolutionStatus', 'approved', '$.homeDelegation.resolvedAt', ${input.approvalResolvedAt}, '$.homeDelegation.resolution', json_extract((${approvedReceipt}), '$.resolution'), '$.homeDelegation.resolvedBy', json_extract((${approvedReceipt}), '$.resolvedBy'))`,
		})
		.where(
			and(
				eq(kernelRuntimeRuns.id, input.runId),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.conversationId, input.conversationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				eq(kernelRuntimeRuns.updatedAt, input.expectedUpdatedAt),
				input.expectedLatestEventAt === null
					? isNull(kernelRuntimeRuns.latestEventAt)
					: eq(kernelRuntimeRuns.latestEventAt, input.expectedLatestEventAt),
				eq(kernelRuntimeRuns.metadata, input.expectedMetadata),
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume') is null`,
				sql`(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim') is null or (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.phase') = 'admission_failed' and ${homeDelegationResolutionReceiptExists(db)} and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalEventId') = ${input.approvalEventId} and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalResolvedAt') = ${input.approvalResolvedAt} and (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.workItemId') is null or json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.workItemId') = ${input.workItemId}) and (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.scopeDigest') is null or json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.scopeDigest') = ${input.scopeDigest})))`,
				sql`json_type(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder') = 'object'`,
				sql`coalesce(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.resolutionStatus'), '') <> 'rejected'`,
				sql`coalesce(json_extract(${kernelRuntimeRuns.metadata}, '$.workItemId'), json_extract(${kernelRuntimeRuns.runtimeMetadata}, '$.workItemId'), json_extract(${kernelRuntimeRuns.metadata}, '$.redriveInput.runtimeMetadata.workItemId'), json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.workItemId')) = ${input.workItemId}`,
				sql`(json_extract(${kernelRuntimeRuns.metadata}, '$.workItemId') is null or json_extract(${kernelRuntimeRuns.metadata}, '$.workItemId') = ${input.workItemId})`,
				sql`(json_extract(${kernelRuntimeRuns.runtimeMetadata}, '$.workItemId') is null or json_extract(${kernelRuntimeRuns.runtimeMetadata}, '$.workItemId') = ${input.workItemId})`,
				sql`(json_extract(${kernelRuntimeRuns.metadata}, '$.redriveInput.runtimeMetadata.workItemId') is null or json_extract(${kernelRuntimeRuns.metadata}, '$.redriveInput.runtimeMetadata.workItemId') = ${input.workItemId})`,
				sql`(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.workItemId') is null or json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.workItemId') = ${input.workItemId})`,
				notExists(
					db
						.select({ id: workAttempts.id })
						.from(workAttempts)
						.where(
							and(
								eq(workAttempts.orgId, input.organizationId),
								eq(workAttempts.executorType, "tedi"),
								eq(workAttempts.executorId, input.targetTediId),
								eq(workAttempts.runId, input.expectedChildRunId),
							),
						),
				),

				notExists(
					db
						.select({ id: workAttempts.id })
						.from(workAttempts)
						.where(
							and(
								eq(workAttempts.orgId, input.organizationId),
								eq(workAttempts.workItemId, input.workItemId),
								eq(workAttempts.runId, input.expectedChildRunId),
							),
						),
				),
				notExists(
					db
						.select({ id: chatDispatchIdempotency.idempotencyKey })
						.from(chatDispatchIdempotency)
						.where(
							and(
								eq(chatDispatchIdempotency.tediId, input.targetTediId),
								eq(chatDispatchIdempotency.runId, input.expectedChildRunId),
							),
						),
				),
				notExists(
					db
						.select({ id: runtimeSubmissions.id })
						.from(runtimeSubmissions)
						.where(
							and(
								eq(runtimeSubmissions.organizationId, input.organizationId),
								eq(runtimeSubmissions.runId, input.expectedChildRunId),
							),
						),
				),

				approvedHomeApprovalHistoryGuard(input, input.now),
				exists(currentWork),
				exists(approvedReceipt),
				notExists(
					db
						.select({ id: runtimeSubmissions.id })
						.from(runtimeSubmissions)
						.where(
							and(
								eq(runtimeSubmissions.organizationId, input.organizationId),
								eq(runtimeSubmissions.runId, input.runId),
								sql`${runtimeSubmissions.abortRequestedAt} is not null`,
							),
						),
				),
			),
		)
		.returning();
	return run ?? null;
}

export type ApprovedHomeDelegationResumeScope = Pick<
	ClaimApprovedHomeDelegationResumeParams,
	| "organizationId"
	| "runId"
	| "conversationId"
	| "claimId"
	| "approvalEventId"
	| "approvalResolvedAt"
	| "approvalEventSet"
	| "workItemId"
	| "workItemVersion"
	| "admissionSpecRevision"
	| "scopeDigest"
	| "targetTediId"
	| "expectedChildRunId"
>;

export function parseApprovedHomeDelegationResumeScope(input: {
	organizationId: string;
	runId: string;
	conversationId: string;
	metadata: Record<string, JsonValue> | null;
}): ApprovedHomeDelegationResumeScope | null {
	const value = input.metadata?.homeDelegationResume;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.version !== 1
	)
		return null;
	const keys = [
		"claimId",
		"approvalEventId",
		"approvalResolvedAt",
		"workItemId",
		"admissionSpecRevision",
		"scopeDigest",
		"targetTediId",
		"expectedChildRunId",
	] as const;
	for (const key of keys)
		if (typeof value[key] !== "string" || !value[key].trim()) return null;
	if (
		typeof value.workItemVersion !== "number" ||
		!Number.isSafeInteger(value.workItemVersion) ||
		value.workItemVersion < 1 ||
		(value.approvalEventSet !== undefined &&
			!validApprovalEventSet(value.approvalEventSet))
	)
		return null;
	return {
		organizationId: input.organizationId,
		runId: input.runId,
		conversationId: input.conversationId,
		claimId: value.claimId as string,
		approvalEventId: value.approvalEventId as string,
		approvalResolvedAt: value.approvalResolvedAt as string,
		workItemId: value.workItemId as string,
		admissionSpecRevision: value.admissionSpecRevision as string,
		scopeDigest: value.scopeDigest as string,
		targetTediId: value.targetTediId as string,
		expectedChildRunId: value.expectedChildRunId as string,
		workItemVersion: value.workItemVersion,
		...(value.approvalEventSet
			? {
					approvalEventSet:
						value.approvalEventSet as unknown as ApprovedHomeDelegationApprovalEventSet,
				}
			: {}),
	};
}

function approvedHomeResumeScope(input: ApprovedHomeDelegationResumeScope) {
	return and(
		eq(kernelRuntimeRuns.id, input.runId),
		eq(kernelRuntimeRuns.organizationId, input.organizationId),
		eq(kernelRuntimeRuns.conversationId, input.conversationId),
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.version') = 1`,
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.approvalEventSet') is json_extract(${JSON.stringify({ proof: input.approvalEventSet ?? null })}, '$.proof')`,
		...(
			[
				"claimId",
				"approvalEventId",
				"approvalResolvedAt",
				"workItemId",
				"workItemVersion",
				"admissionSpecRevision",
				"scopeDigest",
				"targetTediId",
				"expectedChildRunId",
			] as const
		).map(
			(key) =>
				sql`json_extract(${kernelRuntimeRuns.metadata}, ${"$.homeDelegationResume." + key}) = ${input[key]}`,
		),
	);
}

function approvedHomeResumeAuthority(
	db: DbQueryClient,
	input: ApprovedHomeDelegationResumeScope,
) {
	return and(
		exists(
			db
				.select({ id: workItems.id })
				.from(workItems)
				.where(
					and(
						eq(workItems.id, input.workItemId),
						eq(workItems.orgId, input.organizationId),
						eq(workItems.disposition, "accepted"),
						eq(workItems.version, input.workItemVersion),
						eq(workItems.admissionSpecRevision, input.admissionSpecRevision),
					),
				),
		),
		notExists(
			db
				.select({ id: runtimeSubmissions.id })
				.from(runtimeSubmissions)
				.where(
					and(
						eq(runtimeSubmissions.organizationId, input.organizationId),
						eq(runtimeSubmissions.runId, input.runId),
						sql`${runtimeSubmissions.abortRequestedAt} is not null`,
					),
				),
		),
		exists(
			db
				.select({ id: kernelRuntimeEvents.id })
				.from(kernelRuntimeEvents)
				.where(
					and(
						eq(kernelRuntimeEvents.id, input.approvalEventId),
						eq(kernelRuntimeEvents.organizationId, input.organizationId),
						eq(kernelRuntimeEvents.runId, input.runId),
						eq(kernelRuntimeEvents.conversationId, input.conversationId),
						eq(kernelRuntimeEvents.kind, "approval.resolved"),
						eq(kernelRuntimeEvents.createdAt, input.approvalResolvedAt),
						sql`json_extract(${kernelRuntimeEvents.payload}, '$.status') = 'approved'`,
					),
				),
		),
	);
}

export interface BeginApprovedHomeDelegationResumeDispatchParams extends ApprovedHomeDelegationResumeScope {
	targetTediId: string;
	expectedChildRunId: string;
	now: string;
}

/** Reserve the sole send before any enqueue; unknown delivery never reopens this phase. */
export async function beginApprovedHomeDelegationResumeDispatch(
	db: DbQueryClient,
	input: BeginApprovedHomeDelegationResumeDispatchParams,
): Promise<boolean> {
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.now,
			metadata: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase', 'dispatching', '$.homeDelegationResume.expectedChildRunId', ${input.expectedChildRunId}, '$.homeDelegationResume.targetTediId', ${input.targetTediId}, '$.homeDelegationResume.dispatchStartedAt', ${input.now})`,
		})
		.where(
			and(
				approvedHomeResumeScope(input),
				approvedHomeResumeAuthority(db, input),
				approvedHomeApprovalHistoryGuard(input, input.now),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase') = 'claimed'`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegation.workOrder.targetTediId') = ${input.targetTediId}`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length === 1;
}

export interface RecordApprovedHomeDelegationResumeDispatchParams extends ApprovedHomeDelegationResumeScope {
	expectedChildRunId: string;
	observedChildRunId?: string | null;
	childConversationId?: string | null;
	outcome: "acknowledged" | "failed" | "unknown";
	error?: string;
	now: string;
}

/** Retain the real enqueue outcome even when cancellation has won the parent. */
export async function recordApprovedHomeDelegationResumeDispatch(
	db: DbQueryClient,
	input: RecordApprovedHomeDelegationResumeDispatchParams,
): Promise<{
	run: KernelRuntimeRun | null;
	livePersisted: boolean;
	observationPersisted: boolean;
}> {
	const matchesChild = input.observedChildRunId === input.expectedChildRunId;
	const outcome =
		(input.observedChildRunId && !matchesChild) ||
		(input.outcome === "acknowledged" && !matchesChild)
			? "unknown"
			: input.outcome;
	const observationId = crypto.randomUUID();
	const observation = {
		id: observationId,
		outcome,
		observedChildRunId: input.observedChildRunId ?? null,
		childConversationId: input.childConversationId ?? null,
		error: input.error?.slice(0, 1000) ?? null,
		observedAt: input.now,
	};
	const observed = db
		.update(kernelRuntimeRuns)
		.set({
			metadata: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase', 'observed', '$.homeDelegationResume.observation', json(${JSON.stringify(observation)}))`,
		})
		.where(
			and(
				approvedHomeResumeScope(input),
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase') = 'dispatching'`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.expectedChildRunId') = ${input.expectedChildRunId}`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation') is null`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	const lateObserved = db
		.update(kernelRuntimeRuns)
		.set({
			metadata: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.lateObservation', json(${JSON.stringify(observation)}))`,
		})
		.where(
			and(
				approvedHomeResumeScope(input),
				sql`${outcome} = 'acknowledged'`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase') = 'observed'`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation.outcome') = 'unknown'`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.lateObservation') is null`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });

	const physical = db
		.update(kernelRuntimeRuns)
		.set({
			status: outcome === "acknowledged" ? "queued" : "failed",
			...(outcome === "acknowledged"
				? {
						childRunId: input.observedChildRunId!,
						childConversationId: input.childConversationId ?? null,
						delegatedTediId: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.targetTediId')`,
					}
				: {}),
			...(outcome === "failed" ? { completedAt: input.now } : {}),
			updatedAt: input.now,
		})
		.where(
			and(
				approvedHomeResumeScope(input),
				approvedHomeResumeAuthority(db, input),
				inArray(kernelRuntimeRuns.status, [
					"requires_approval",
					"queued",
					"running",
				]),
				sql`${outcome} <> 'unknown'`,
				sql`(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation.id') = ${observationId} or json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.lateObservation.id') = ${observationId})`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.expectedChildRunId') = ${input.expectedChildRunId}`,
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	const canonical = db
		.select()
		.from(kernelRuntimeRuns)
		.where(approvedHomeResumeScope(input))
		.limit(1);
	const [saved, lateSaved, live, runs] = await db.batch([
		observed,
		lateObserved,
		physical,
		canonical,
	]);
	return {
		run: runs[0] ?? null,
		livePersisted: live.length === 1,
		observationPersisted: saved.length === 1 || lateSaved.length === 1,
	};
}

function homeDelegationResolutionReceiptExists(db: DbQueryClient) {
	return and(
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.version') = 1`,
		sql`length(json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.claimId')) > 0`,
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.organizationId') = ${kernelRuntimeRuns.organizationId}`,
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.runId') = ${kernelRuntimeRuns.id}`,
		sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.conversationId') = ${kernelRuntimeRuns.conversationId}`,
		exists(
			db
				.select({ id: kernelRuntimeEvents.id })
				.from(kernelRuntimeEvents)
				.where(
					and(
						eq(
							kernelRuntimeEvents.organizationId,
							kernelRuntimeRuns.organizationId,
						),
						eq(kernelRuntimeEvents.runId, kernelRuntimeRuns.id),
						eq(
							kernelRuntimeEvents.conversationId,
							kernelRuntimeRuns.conversationId,
						),
						eq(kernelRuntimeEvents.kind, "approval.resolved"),
						sql`${kernelRuntimeEvents.id} = json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalEventId')`,
						sql`${kernelRuntimeEvents.createdAt} = json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalResolvedAt')`,
						sql`json_extract(${kernelRuntimeEvents.payload}, '$.status') = 'approved'`,
					),
				),
		),
	);
}

/** Only a caller that proved admission failed before provider entry may retire its own fence. */
export async function markHomeDelegationResolutionAdmissionFailed(
	db: DbQueryClient,
	input: {
		organizationId: string;
		runId: string;
		expectedClaimId: string;
		now: string;
	},
): Promise<boolean> {
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			metadata: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.phase', 'admission_failed', '$.homeDelegationResolutionClaim.admissionFailedAt', ${input.now})`,
		})
		.where(
			and(
				homeDelegationResolutionReceiptExists(db),
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.id, input.runId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
				notExists(
					db
						.select({ id: runtimeSubmissions.id })
						.from(runtimeSubmissions)
						.where(
							and(
								eq(runtimeSubmissions.organizationId, input.organizationId),
								eq(runtimeSubmissions.runId, input.runId),
								sql`${runtimeSubmissions.abortRequestedAt} is not null`,
							),
						),
				),
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume') is null`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.claimId') = ${input.expectedClaimId}`,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.phase') = 'resolving'`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length === 1;
}

export interface RecordApprovedHomeDelegationResumeStopOutcomeParams extends ApprovedHomeDelegationResumeScope {
	stopAttemptId: string;
	outcome: "attempted" | "succeeded" | "failed" | "unknown";
	error?: string;
	now: string;
}

/** Reserve one stop for the acknowledged child, then retain its result without reviving its parent. */
export async function recordApprovedHomeDelegationResumeStopOutcome(
	db: DbQueryClient,
	input: RecordApprovedHomeDelegationResumeStopOutcomeParams,
): Promise<boolean> {
	if (!input.stopAttemptId.trim()) return false;
	const acknowledgement = sql`((json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation.outcome') = 'acknowledged' and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation.observedChildRunId') = ${input.expectedChildRunId}) or (json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.observation.outcome') = 'unknown' and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.lateObservation.outcome') = 'acknowledged' and json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.lateObservation.observedChildRunId') = ${input.expectedChildRunId}))`;
	const attempt = input.outcome === "attempted";
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			metadata: attempt
				? sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.stopObservation', json(${JSON.stringify({ attemptId: input.stopAttemptId, outcome: "attempted", attemptedAt: input.now })}))`
				: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.stopObservation.completion', json(${JSON.stringify({ outcome: input.outcome, completedAt: input.now, error: input.error?.slice(0, 1000) ?? null })}))`,
		})
		.where(
			and(
				approvedHomeResumeScope(input),
				acknowledgement,
				sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.phase') = 'observed'`,
				attempt
					? and(
							sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.stopObservation') is null`,
							sql`(${kernelRuntimeRuns.status} = 'canceled' or ${exists(
								db
									.select({ id: runtimeSubmissions.id })
									.from(runtimeSubmissions)
									.where(
										and(
											eq(
												runtimeSubmissions.organizationId,
												input.organizationId,
											),
											eq(runtimeSubmissions.runId, input.runId),
											sql`${runtimeSubmissions.abortRequestedAt} is not null`,
										),
									),
							)})`,
						)
					: and(
							sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.stopObservation.attemptId') = ${input.stopAttemptId}`,
							sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.stopObservation.completion') is null`,
						),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length === 1;
}
