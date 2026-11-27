import {
	and,
	desc,
	eq,
	exists,
	getColumns,
	inArray,
	isNull,
	ne,
	notExists,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	chatDispatchIdempotency as d1ChatDispatchIdempotency,
	kernelRuntimeEvents as d1KernelRuntimeEvents,
	kernelRuntimeRuns as d1KernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import {
	workAttempts as d1WorkAttempts,
	workItems as d1WorkItems,
} from "../schema/work-items";
import { runtimeSubmissions as d1RuntimeSubmissions } from "../schema/runtime-submissions";
import type { BatchItem } from "drizzle-orm/batch";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { coreTable } from "../core-store/client";
import {
	anyIds,
	coreStore,
	jsonRead,
	jsonType,
	likeText,
	pgTextArray,
	unixTime,
} from "../core-store/dialect";
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

export type KernelRuntimeRun = Omit<
	typeof d1KernelRuntimeRuns.$inferSelect,
	"workItemId" | "targetTediId"
>;
export type KernelRuntimeRunUpdate = Partial<
	Omit<typeof d1KernelRuntimeRuns.$inferInsert, "id" | "organizationId">
>;
export type NewKernelRuntimeRun = typeof d1KernelRuntimeRuns.$inferInsert;

type StoreDb = DbClient | DbQueryClient;

function postgres(db: StoreDb): boolean {
	return coreStore(db) === "postgres";
}

/** SQLite JSON path text bound as a parameter; segments are fixed code paths, never caller SQL. */
function sqliteJsonPath(path: readonly string[]): string {
	return (
		"$" +
		path
			.map((segment) =>
				/^[A-Za-z_][A-Za-z_0-9]*$/.test(segment)
					? "." + segment
					: "." + JSON.stringify(segment),
			)
			.join("")
	);
}

/** `json_type`/`jsonb_typeof` of a whole JSON document expression. */
function jsonDocumentKind(db: StoreDb, document: SQL): SQL {
	return postgres(db)
		? sql`jsonb_typeof(${document})`
		: sql`json_type(${document})`;
}

/** Empty JSON object literal matching the active store's JSON type. */
function emptyJsonDocument(db: StoreDb): SQL {
	return postgres(db) ? sql`'{}'::jsonb` : sql`'{}'`;
}

/** A bound JSON value usable as a `json_set`/`jsonb_set` target document. */
function jsonDocument(db: StoreDb, value: unknown): SQL {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("JSON values must be serializable");
	return postgres(db) ? sql`${text}::text::jsonb` : sql`${text}`;
}

/** A JSON literal for `json_set`/`jsonb_set` values. */
function jsonLiteral(db: StoreDb, value: unknown): SQL {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("JSON values must be serializable");
	return postgres(db) ? sql`${text}::text::jsonb` : sql`json(${text})`;
}

/** A scalar string as a JSON value (`json_set` stores text as a JSON string). */
function jsonStringValue(db: StoreDb, value: SQLWrapper): SQL {
	return postgres(db) ? sql`to_jsonb(${value})` : sql`${value}`;
}

/**
 * `json_set`/`jsonb_set` over path/value pairs applied in order. `base` is the
 * document expression (a column, a bound document, or a CASE expression).
 */
function jsonSetPaths(
	db: StoreDb,
	base: SQLWrapper,
	pairs: readonly (readonly [path: readonly string[], value: SQL])[],
): SQL {
	if (postgres(db)) {
		let document: SQLWrapper = base;
		for (const [path, value] of pairs)
			document = sql`jsonb_set(${document}, ${pgTextArray(path)}::text[], coalesce(${value}, 'null'::jsonb), true)`;
		return pairs.length ? (document as SQL) : sql`${base}`;
	}
	return sql`json_set(${base}, ${sql.join(
		pairs.flatMap(([path, value]) => [sql`${sqliteJsonPath(path)}`, value]),
		sql`, `,
	)})`;
}

/** `json_remove`/`#-` for one path on a JSON document expression. */
function jsonRemovePath(
	db: StoreDb,
	document: SQL,
	path: readonly string[],
): SQL {
	return postgres(db)
		? sql`(${document} #- ${pgTextArray(path)}::text[])`
		: sql`json_remove(${document}, ${sqliteJsonPath(path)})`;
}

/** Run-row columns readers select/return; generated columns stay in SQL only. */
function kernelRunStoredColumns(db: StoreDb) {
	const {
		workItemId: _workItemId,
		targetTediId: _targetTediId,
		...columns
	} = getColumns(coreTable(db, d1KernelRuntimeRuns));
	return columns;
}

/**
 * D1 `work_item_id` is a generated column over `metadata.workItemId`; the
 * Postgres column is a plain NULL, so read the same JSON path there.
 */
function runWorkItemId(db: StoreDb): SQL {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return postgres(db)
		? jsonRead(db, kernelRuntimeRuns.metadata, ["workItemId"])
		: sql`${kernelRuntimeRuns.workItemId}`;
}

/** Same split for the generated `target_tedi_id` column. */
function runTargetTediId(db: StoreDb): SQL {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return postgres(db)
		? jsonRead(db, kernelRuntimeRuns.metadata, [
				"homeDelegation",
				"workOrder",
				"targetTediId",
			])
		: sql`${kernelRuntimeRuns.targetTediId}`;
}

/**
 * `value = strftime('%Y-%m-%dT%H:%M:%fZ', value)`: the text is a canonical ISO
 * instant. Postgres matches the same shape with a regex instead.
 */
function canonicalIsoInstant(db: StoreDb, value: SQL): SQL {
	return postgres(db)
		? sql`${value} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'`
		: sql`${value} = strftime('%Y-%m-%dT%H:%M:%fZ', ${value})`;
}

/**
 * `julianday(value)` as a comparable instant. Postgres casts ISO and
 * `CURRENT_TIMESTAMP`-style text to timestamptz behind a shape guard so a
 * malformed value yields NULL instead of an error.
 */
function instantSeconds(db: StoreDb, value: SQL): SQL {
	return postgres(db)
		? sql`CASE WHEN ${value} ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z)?$' THEN extract(epoch FROM (${value})::timestamptz) END`
		: sql`julianday(${value})`;
}

export async function getKernelRuntimeRun(
	db: DbClient,
	input: { id: string; organizationId?: string },
): Promise<KernelRuntimeRun | undefined> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const [row] = await db
		.select(kernelRunStoredColumns(db))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	await db
		.insert(kernelRuntimeRuns)
		.values(value)
		.onConflictDoNothing({ target: kernelRuntimeRuns.id });
}

export async function hasUnacceptedChatDispatch(
	db: DbClient,
	input: { tediId: string; homeRunId: string },
): Promise<boolean> {
	const chatDispatchIdempotency = coreTable(db, d1ChatDispatchIdempotency);
	const rows = await db
		.select({ runId: chatDispatchIdempotency.runId })
		.from(chatDispatchIdempotency)
		.where(
			and(
				eq(chatDispatchIdempotency.tediId, input.tediId),
				likeText(
					db,
					chatDispatchIdempotency.idempotencyKey,
					`${input.homeRunId}:%`,
				),
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const conditions = [
		eq(kernelRuntimeRuns.organizationId, input.organizationId),
		...(input.conversationId
			? [eq(kernelRuntimeRuns.conversationId, input.conversationId)]
			: []),
		// bound-params: delegated child-run refs of ONE Home run / conversation
		...(input.childRunIds
			? [anyIds(db, kernelRuntimeRuns.childRunId, input.childRunIds)]
			: []),
	];
	const base = db
		.select(kernelRunStoredColumns(db))
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
		/** Only runs whose conversation belongs to this workspace. */
		workspaceId?: string;
	},
): Promise<KernelRuntimeRun[]> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return db
		.select(kernelRunStoredColumns(db))
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				input.kind === "home_delegation"
					? sql`${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder"])} = 'object'`
					: sql`(${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder"])} = 'object' OR ${jsonRead(db, kernelRuntimeRuns.metadata, ["delegationWorkOrder", "kind"])} = 'workstation.attach')`,
				...(input.cursor
					? [
							sql`(${kernelRuntimeRuns.createdAt}, ${kernelRuntimeRuns.id}) < (${input.cursor.at}, ${input.cursor.id})`,
						]
					: []),
				...(input.workspaceId
					? [
							sql`${kernelRuntimeRuns.conversationId} IN (SELECT conversation_id FROM kernel_conversations WHERE organization_id = ${input.organizationId} AND workspace_id = ${input.workspaceId})`,
						]
					: []),
			),
		)
		.orderBy(desc(kernelRuntimeRuns.createdAt), desc(kernelRuntimeRuns.id))
		.limit(input.limit);
}

/**
 * Live delegated Home rows nobody has read lately, oldest first, across every
 * organization: queued or running, with a target tedi and child run, started
 * and last touched before `before`. The two-minute deadline sweep re-reads
 * their child evidence so a dispatch that never published, or a child that
 * outlived its deadline, ends with a visible reason even when no person or
 * client opens the conversation again.
 */
export async function listQuietDelegatedRuns(
	db: DbClient,
	input: { before: string; limit: number; dueIds?: string[] },
): Promise<KernelRuntimeRun[]> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return db
		.select(kernelRunStoredColumns(db))
		.from(kernelRuntimeRuns)
		.where(
			and(
				// bound-params: internal selector from claimWorkDue, LIMIT 50.
				input.dueIds ? inArray(kernelRuntimeRuns.id, input.dueIds) : undefined,
				inArray(kernelRuntimeRuns.status, ["queued", "running"]),
				sql`${kernelRuntimeRuns.delegatedTediId} IS NOT NULL`,
				sql`${kernelRuntimeRuns.childRunId} IS NOT NULL`,
				// Rows carry both ISO and SQLite CURRENT_TIMESTAMP spellings.
				sql`${unixTime(db, sql`coalesce(${kernelRuntimeRuns.startedAt}, ${kernelRuntimeRuns.createdAt})`)} < ${unixTime(db, sql`${input.before}`)}`,
				sql`${unixTime(db, kernelRuntimeRuns.updatedAt)} < ${unixTime(db, sql`${input.before}`)}`,
			),
		)
		.orderBy(kernelRuntimeRuns.updatedAt, kernelRuntimeRuns.id)
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
				sql`${unixTime(db, kernelRuntimeRuns.updatedAt)} >= ${unixTime(db, sql`${input.updatedSince}`)}`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return db
		.select({
			id: kernelRuntimeRuns.id,
			metadata: kernelRuntimeRuns.metadata,
			preview: kernelRuntimeRuns.preview,
		})
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				anyIds(db, kernelRuntimeRuns.id, [...new Set(input.ids)]),
			),
		);
}

export async function findKernelRuntimeRunByChild(
	db: DbClient,
	input: {
		organizationId: string;
		delegatedTediId: string;
		childRunId: string;
	},
): Promise<KernelRuntimeRun | undefined> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const [row] = await db
		.select(kernelRunStoredColumns(db))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const [row] = await db
		.select(kernelRunStoredColumns(db))
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

function preserveHomeDelegationClaims(
	db: StoreDb,
	patch: KernelRuntimeRunUpdate,
) {
	if (patch.metadata === undefined) return patch;
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	let metadata = jsonDocument(db, patch.metadata);
	for (const key of [
		"homeDelegationResume",
		"homeDelegationResolutionClaim",
	] as const) {
		const path = [key];
		metadata = sql`case when ${jsonType(db, kernelRuntimeRuns.metadata, path)} = 'object' then ${jsonSetPaths(db, sql`case when ${jsonDocumentKind(db, metadata)} = 'object' then ${metadata} else ${emptyJsonDocument(db)} end`, [[path, jsonRead(db, kernelRuntimeRuns.metadata, path, "json")]])} else ${jsonRemovePath(db, metadata, path)} end`;
	}
	return { ...patch, metadata };
}

export async function updateKernelRuntimeRun(
	db: DbClient,
	id: string,
	patch: KernelRuntimeRunUpdate,
): Promise<void> {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	await db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(db, patch))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	await db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(db, input.patch))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return db
		.update(kernelRuntimeRuns)
		.set(preserveHomeDelegationClaims(db, input.patch))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
 * A cut-off resolver's `resolving` claim the next decision may take over.
 * `claimId` is compared and swapped, so two takers cannot both win.
 */
export interface StaleDelegationResolutionTakeover {
	claimId: string;
	/** The claim must have been taken at or before this instant. */
	staleBefore: string;
	/**
	 * The decision the cut-off resolver already recorded. Present: the receipt
	 * must exist and the new claim finishes that decision. Absent: no receipt
	 * may exist, because a recorded decision is never decided twice.
	 */
	recorded?: {
		approvalEventId: string;
		approvalResolvedAt: string;
		status: "approved" | "rejected";
	};
}

/**
 * Guard for taking over a stale claim. A resolver records its receipt before
 * it starts any Work or dispatch, so "no receipt" also means "no effect".
 */
export function staleDelegationResolutionTakeoverGuard(
	takeover: StaleDelegationResolutionTakeover,
	db?: StoreDb,
) {
	const kernelRuntimeRuns = db
		? coreTable(db, d1KernelRuntimeRuns)
		: d1KernelRuntimeRuns;
	const kernelRuntimeEvents = db
		? coreTable(db, d1KernelRuntimeEvents)
		: d1KernelRuntimeEvents;
	const claimPath = (key: string) =>
		["homeDelegationResolutionClaim", key] as const;
	const claim = {
		phase: db
			? jsonRead(db, kernelRuntimeRuns.metadata, claimPath("phase"))
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.phase')`,
		claimId: db
			? jsonRead(db, kernelRuntimeRuns.metadata, claimPath("claimId"))
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.claimId')`,
		claimedAt: db
			? jsonRead(db, kernelRuntimeRuns.metadata, claimPath("claimedAt"))
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.claimedAt')`,
		approvalEventId: db
			? jsonRead(db, kernelRuntimeRuns.metadata, claimPath("approvalEventId"))
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalEventId')`,
		approvalResolvedAt: db
			? jsonRead(
					db,
					kernelRuntimeRuns.metadata,
					claimPath("approvalResolvedAt"),
				)
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResolutionClaim.approvalResolvedAt')`,
	};
	const receipt = (extra: SQL) =>
		(db
			? db.select({ id: kernelRuntimeEvents.id })
			: new QueryBuilder().select({ id: kernelRuntimeEvents.id })
		)
			.from(kernelRuntimeEvents)
			.where(
				and(
					eq(
						kernelRuntimeEvents.organizationId,
						kernelRuntimeRuns.organizationId,
					),
					eq(kernelRuntimeEvents.runId, kernelRuntimeRuns.id),
					eq(kernelRuntimeEvents.kind, "approval.resolved"),
					extra,
				),
			);
	const base = and(
		db
			? sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume"])} is null`
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume') is null`,
		eq(kernelRuntimeRuns.status, "requires_approval"),
		sql`${claim.phase} = 'resolving'`,
		sql`${claim.claimId} = ${takeover.claimId}`,
		sql`${claim.claimedAt} <= ${takeover.staleBefore}`,
	)!;
	const recorded = takeover.recorded;
	if (!recorded)
		return and(
			base,
			notExists(
				receipt(
					sql`(${kernelRuntimeEvents.id} = ${claim.approvalEventId} or ${kernelRuntimeEvents.createdAt} >= ${claim.claimedAt})`,
				),
			),
		)!;
	const payloadStatus = db
		? jsonRead(db, kernelRuntimeEvents.payload, ["status"])
		: sql`json_extract(${kernelRuntimeEvents.payload}, '$.status')`;
	return and(
		base,
		sql`${claim.approvalEventId} = ${recorded.approvalEventId}`,
		sql`${claim.approvalResolvedAt} = ${recorded.approvalResolvedAt}`,
		exists(
			receipt(
				and(
					eq(
						kernelRuntimeEvents.conversationId,
						kernelRuntimeRuns.conversationId,
					),
					eq(kernelRuntimeEvents.id, recorded.approvalEventId),
					eq(kernelRuntimeEvents.createdAt, recorded.approvalResolvedAt),
					sql`${payloadStatus} = ${recorded.status}`,
				)!,
			),
		),
	)!;
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
		/** The recorded decision time when finishing a decision a cut-off resolver recorded. */
		delegationApprovalResolvedAt?: string;
		/** Take over a cut-off resolver's claim instead of requiring none. */
		staleDelegationResolutionClaim?: StaleDelegationResolutionTakeover;
	},
): Promise<boolean> {
	if (
		input.requireNoDelegationResumeClaim &&
		(!input.delegationResolutionClaimId?.trim() ||
			!input.delegationApprovalEventId?.trim())
	)
		return false;
	const takeover = input.staleDelegationResolutionClaim;
	if (takeover && (!input.requireNoDelegationResumeClaim || !takeover.claimId))
		return false;
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.updatedAt,
			...(input.requireNoDelegationResumeClaim
				? {
						metadata: jsonSetPaths(
							db,
							sql`coalesce(${kernelRuntimeRuns.metadata}, ${emptyJsonDocument(db)})`,
							[
								[
									["homeDelegationResolutionClaim"],
									jsonLiteral(db, {
										version: 1,
										phase: "resolving",
										claimId: input.delegationResolutionClaimId,
										claimedAt: input.updatedAt,
										approvalEventId: input.delegationApprovalEventId,
										approvalResolvedAt:
											input.delegationApprovalResolvedAt ?? input.updatedAt,
										organizationId: input.organizationId,
										runId: input.id,
										workItemId: input.delegationWorkItemId ?? null,
										scopeDigest: input.delegationScopeDigest ?? null,
										...(takeover ? { takeoverOf: takeover.claimId } : {}),
									}),
								],
								[
									["homeDelegationResolutionClaim", "conversationId"],
									jsonStringValue(db, kernelRuntimeRuns.conversationId),
								],
							],
						),
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
					? takeover
						? staleDelegationResolutionTakeoverGuard(takeover, db)
						: and(
								sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume"])} is null`,
								sql`(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim"])} is null or (${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "phase"])} = 'admission_failed' and ${homeDelegationResolutionReceiptExists(db)}))`,
							)
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
		const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const [row] = await db
		.select(kernelRunStoredColumns(db))
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				eq(kernelRuntimeRuns.conversationId, input.conversationId),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				ne(kernelRuntimeRuns.id, input.excludeRunId),
				isNull(kernelRuntimeRuns.childRunId),
				input.targetTediId
					? sql`${runTargetTediId(db)} = ${input.targetTediId}`
					: undefined,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "decision", "mode"])} = 'needs_approval'`,
				sql`${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder"])} = 'object'`,
				sql`${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder", "targetTediId"])} = 'string' AND length(${runTargetTediId(db)}) > 0`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "resolutionStatus"])} IS NULL`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const rows = await db
		.select({
			id: kernelRuntimeRuns.id,
			conversationId: kernelRuntimeRuns.conversationId,
			status: kernelRuntimeRuns.status,
			outputId: jsonRead(db, kernelRuntimeRuns.metadata, [
				"kernelOutputReceipt",
				"outputId",
			]),
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
	db: StoreDb,
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
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
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
		return postgres(db) ? sql`false` : sql`0`;
	if (postgres(db)) {
		const field = (name: string) => sql`(approval_snapshot.value ->> ${name})`;
		return sql`
		${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "expiresAt"])} = ${proof.originalExpiresAt}
		and (select count(*) from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.organizationId} = ${input.organizationId} and ${kernelRuntimeEvents.runId} = ${input.runId} and ${kernelRuntimeEvents.kind} = 'approval.resolved') = ${proof.events.length}
		and not exists (
			select 1 from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.organizationId} = ${input.organizationId} and ${kernelRuntimeEvents.runId} = ${input.runId} and ${kernelRuntimeEvents.kind} = 'approval.resolved'
			and not exists (select 1 from jsonb_array_elements(${JSON.stringify(proof.events)}::jsonb) as approval_snapshot(value) where
				${kernelRuntimeEvents.id} IS NOT DISTINCT FROM ${field("id")}
				and ${kernelRuntimeEvents.organizationId} IS NOT DISTINCT FROM ${field("organizationId")}
				and ${kernelRuntimeEvents.runId} IS NOT DISTINCT FROM ${field("runId")}
				and ${kernelRuntimeEvents.conversationId} IS NOT DISTINCT FROM ${field("conversationId")}
				and ${kernelRuntimeEvents.kind} IS NOT DISTINCT FROM ${field("kind")}
				and ${kernelRuntimeEvents.createdAt} IS NOT DISTINCT FROM ${field("createdAt")}
				and ${kernelRuntimeEvents.payload} IS NOT DISTINCT FROM (approval_snapshot.value -> 'payload')
				and ${kernelRuntimeEvents.runtimeMetadata} IS NOT DISTINCT FROM (approval_snapshot.value -> 'runtimeMetadata')
				and ${kernelRuntimeEvents.runtimeBackend} IS NOT DISTINCT FROM ${field("runtimeBackend")}
				and ${kernelRuntimeEvents.runtimeExternalId} IS NOT DISTINCT FROM ${field("runtimeExternalId")}
				and ${kernelRuntimeEvents.runtimeExternalUrl} IS NOT DISTINCT FROM ${field("runtimeExternalUrl")}
				and ${kernelRuntimeEvents.delegatedTediId} IS NOT DISTINCT FROM ${field("delegatedTediId")}
				and ${kernelRuntimeEvents.childRunId} IS NOT DISTINCT FROM ${field("childRunId")}
				and ${kernelRuntimeEvents.causeEventId} IS NOT DISTINCT FROM ${field("causeEventId")}
				and ${kernelRuntimeEvents.messageId} IS NOT DISTINCT FROM ${field("messageId")}
				and ${kernelRuntimeEvents.sequence} IS NOT DISTINCT FROM (${field("sequence")})::bigint
				and ${kernelRuntimeEvents.delta} IS NOT DISTINCT FROM ${field("delta")}
				and ${kernelRuntimeEvents.traceId} IS NOT DISTINCT FROM ${field("traceId")}
			)
		)`;
	}
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const chatDispatchIdempotency = coreTable(db, d1ChatDispatchIdempotency);
	const runtimeSubmissions = coreTable(db, d1RuntimeSubmissions);
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
				sql`${jsonRead(db, kernelRuntimeEvents.payload, ["status"])} = 'approved'`,
				sql`${jsonType(db, kernelRuntimeEvents.payload, ["delegationWorkOrder"])} = 'object'`,
				sql`${jsonRead(db, kernelRuntimeEvents.payload, ["delegationWorkOrder", "targetTediId"])} = ${runTargetTediId(db)}`,
				sql`(${jsonRead(db, kernelRuntimeEvents.payload, ["delegationWorkOrder", "workItemId"])} is null or ${jsonRead(db, kernelRuntimeEvents.payload, ["delegationWorkOrder", "workItemId"])} = ${input.workItemId})`,
			),
		);
	const receiptWorkOrder = postgres(db)
		? sql`((${approvedReceipt}) #> '{delegationWorkOrder}')`
		: sql`json_extract((${approvedReceipt}), '$.delegationWorkOrder')`;
	const receiptField = (key: string) =>
		postgres(db)
			? sql`((${approvedReceipt}) #> ${pgTextArray([key])}::text[])`
			: sql`json_extract((${approvedReceipt}), ${"$." + key})`;
	const [run] = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.now,
			metadata: jsonSetPaths(
				db,
				jsonDocument(db, {
					...input.expectedMetadata,
					homeDelegationResume: {
						version: 1,
						phase: "claimed",
						claimId: input.claimId,
						approvalEventId: input.approvalEventId,
						approvalResolvedAt: input.approvalResolvedAt,
						workItemId: input.workItemId,
						workItemVersion: input.workItemVersion,
						admissionSpecRevision: input.admissionSpecRevision,
						scopeDigest: input.scopeDigest,
						targetTediId: input.targetTediId,
						expectedChildRunId: input.expectedChildRunId,
						claimedAt: input.now,
						...(input.approvalEventSet
							? { approvalEventSet: input.approvalEventSet }
							: {}),
					},
				}),
				[
					[["homeDelegation", "workOrder"], receiptWorkOrder],
					[["delegationWorkOrder"], receiptWorkOrder],
					[["homeDelegation", "resolutionStatus"], jsonLiteral(db, "approved")],
					[
						["homeDelegation", "resolvedAt"],
						jsonLiteral(db, input.approvalResolvedAt),
					],
					[["homeDelegation", "resolution"], receiptField("resolution")],
					[["homeDelegation", "resolvedBy"], receiptField("resolvedBy")],
				],
			),
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
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume"])} is null`,
				sql`(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim"])} is null or (${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "phase"])} = 'admission_failed' and ${homeDelegationResolutionReceiptExists(db)} and ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "approvalEventId"])} = ${input.approvalEventId} and ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "approvalResolvedAt"])} = ${input.approvalResolvedAt} and (${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "workItemId"])} is null or ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "workItemId"])} = ${input.workItemId}) and (${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "scopeDigest"])} is null or ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "scopeDigest"])} = ${input.scopeDigest})))`,
				sql`${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder"])} = 'object'`,
				sql`coalesce(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "resolutionStatus"])}, '') <> 'rejected'`,
				sql`coalesce(${runWorkItemId(db)}, ${jsonRead(db, kernelRuntimeRuns.runtimeMetadata, ["workItemId"])}, ${jsonRead(db, kernelRuntimeRuns.metadata, ["redriveInput", "runtimeMetadata", "workItemId"])}, ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder", "workItemId"])}) = ${input.workItemId}`,
				sql`(${runWorkItemId(db)} is null or ${runWorkItemId(db)} = ${input.workItemId})`,
				sql`(${jsonRead(db, kernelRuntimeRuns.runtimeMetadata, ["workItemId"])} is null or ${jsonRead(db, kernelRuntimeRuns.runtimeMetadata, ["workItemId"])} = ${input.workItemId})`,
				sql`(${jsonRead(db, kernelRuntimeRuns.metadata, ["redriveInput", "runtimeMetadata", "workItemId"])} is null or ${jsonRead(db, kernelRuntimeRuns.metadata, ["redriveInput", "runtimeMetadata", "workItemId"])} = ${input.workItemId})`,
				sql`(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder", "workItemId"])} is null or ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegation", "workOrder", "workItemId"])} = ${input.workItemId})`,
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

				approvedHomeApprovalHistoryGuard(db, input, input.now),
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
		.returning(kernelRunStoredColumns(db));
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

function approvedHomeResumeScope(
	db: StoreDb,
	input: ApprovedHomeDelegationResumeScope,
) {
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	return and(
		eq(kernelRuntimeRuns.id, input.runId),
		eq(kernelRuntimeRuns.organizationId, input.organizationId),
		eq(kernelRuntimeRuns.conversationId, input.conversationId),
		sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "version"], "number")} = 1`,
		postgres(db)
			? sql`(${kernelRuntimeRuns.metadata} #>> ${pgTextArray(["homeDelegationResume", "approvalEventSet"])}::text[]) IS NOT DISTINCT FROM (${JSON.stringify({ proof: input.approvalEventSet ?? null })}::jsonb #>> '{proof}')`
			: sql`json_extract(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume.approvalEventSet') is json_extract(${JSON.stringify({ proof: input.approvalEventSet ?? null })}, '$.proof')`,
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
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", key], key === "workItemVersion" ? "number" : "text")} = ${input[key]}`,
		),
	);
}

function approvedHomeResumeAuthority(
	db: DbQueryClient,
	input: ApprovedHomeDelegationResumeScope,
) {
	const workItems = coreTable(db, d1WorkItems);
	const runtimeSubmissions = coreTable(db, d1RuntimeSubmissions);
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
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
						sql`${jsonRead(db, kernelRuntimeEvents.payload, ["status"])} = 'approved'`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			updatedAt: input.now,
			metadata: jsonSetPaths(db, kernelRuntimeRuns.metadata, [
				[["homeDelegationResume", "phase"], jsonLiteral(db, "dispatching")],
				[
					["homeDelegationResume", "expectedChildRunId"],
					jsonLiteral(db, input.expectedChildRunId),
				],
				[
					["homeDelegationResume", "targetTediId"],
					jsonLiteral(db, input.targetTediId),
				],
				[
					["homeDelegationResume", "dispatchStartedAt"],
					jsonLiteral(db, input.now),
				],
			]),
		})
		.where(
			and(
				approvedHomeResumeScope(db, input),
				approvedHomeResumeAuthority(db, input),
				approvedHomeApprovalHistoryGuard(db, input, input.now),
				eq(kernelRuntimeRuns.status, "requires_approval"),
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "phase"])} = 'claimed'`,
				sql`${runTargetTediId(db)} = ${input.targetTediId}`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const observed = db
		.update(kernelRuntimeRuns)
		.set({
			metadata: jsonSetPaths(db, kernelRuntimeRuns.metadata, [
				[["homeDelegationResume", "phase"], jsonLiteral(db, "observed")],
				[["homeDelegationResume", "observation"], jsonLiteral(db, observation)],
			]),
		})
		.where(
			and(
				approvedHomeResumeScope(db, input),
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "phase"])} = 'dispatching'`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "expectedChildRunId"])} = ${input.expectedChildRunId}`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "observation"])} is null`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	const lateObserved = db
		.update(kernelRuntimeRuns)
		.set({
			metadata: jsonSetPaths(db, kernelRuntimeRuns.metadata, [
				[
					["homeDelegationResume", "lateObservation"],
					jsonLiteral(db, observation),
				],
			]),
		})
		.where(
			and(
				approvedHomeResumeScope(db, input),
				sql`${outcome} = 'acknowledged'`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "phase"])} = 'observed'`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "observation", "outcome"])} = 'unknown'`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "lateObservation"])} is null`,
			),
		)
		.returning({ id: kernelRuntimeRuns.id });

	const dispatchStartedAt = jsonRead(db, kernelRuntimeRuns.metadata, [
		"homeDelegationResume",
		"dispatchStartedAt",
	]);
	const physical = db
		.update(kernelRuntimeRuns)
		.set({
			status: outcome === "acknowledged" ? "queued" : "failed",
			...(outcome === "acknowledged"
				? {
						startedAt: dispatchStartedAt,
						childRunId: input.observedChildRunId!,
						childConversationId: input.childConversationId ?? null,
						delegatedTediId: jsonRead(db, kernelRuntimeRuns.metadata, [
							"homeDelegationResume",
							"targetTediId",
						]),
					}
				: {}),
			...(outcome === "failed" ? { completedAt: input.now } : {}),
			updatedAt: input.now,
		})
		.where(
			and(
				approvedHomeResumeScope(db, input),
				approvedHomeResumeAuthority(db, input),
				inArray(kernelRuntimeRuns.status, [
					"requires_approval",
					"queued",
					"running",
				]),
				sql`${outcome} <> 'unknown'`,
				outcome === "acknowledged"
					? and(
							sql`${jsonType(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "dispatchStartedAt"])} = 'string'`,
							canonicalIsoInstant(db, dispatchStartedAt),
							sql`${instantSeconds(db, dispatchStartedAt)} <= ${instantSeconds(db, sql`${input.now}`)}`,
							sql`${instantSeconds(db, dispatchStartedAt)} >= ${instantSeconds(db, jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "claimedAt"]))}`,
							sql`${instantSeconds(db, dispatchStartedAt)} >= ${instantSeconds(db, jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "approvalResolvedAt"]))}`,
						)
					: undefined,
				sql`(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "observation", "id"])} = ${observationId} or ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "lateObservation", "id"])} = ${observationId})`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume", "expectedChildRunId"])} = ${input.expectedChildRunId}`,
				isNull(kernelRuntimeRuns.childRunId),
				isNull(kernelRuntimeRuns.delegatedTediId),
				isNull(kernelRuntimeRuns.childConversationId),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	const canonical = db
		.select(kernelRunStoredColumns(db))
		.from(kernelRuntimeRuns)
		.where(approvedHomeResumeScope(db, input))
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const kernelRuntimeEvents = coreTable(db, d1KernelRuntimeEvents);
	return and(
		sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "version"], "number")} = 1`,
		sql`length(${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "claimId"])}) > 0`,
		sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "organizationId"])} = ${kernelRuntimeRuns.organizationId}`,
		sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "runId"])} = ${kernelRuntimeRuns.id}`,
		sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "conversationId"])} = ${kernelRuntimeRuns.conversationId}`,
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
						sql`${kernelRuntimeEvents.id} = ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "approvalEventId"])}`,
						sql`${kernelRuntimeEvents.createdAt} = ${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "approvalResolvedAt"])}`,
						sql`${jsonRead(db, kernelRuntimeEvents.payload, ["status"])} = 'approved'`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const runtimeSubmissions = coreTable(db, d1RuntimeSubmissions);
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			metadata: jsonSetPaths(db, kernelRuntimeRuns.metadata, [
				[
					["homeDelegationResolutionClaim", "phase"],
					jsonLiteral(db, "admission_failed"),
				],
				[
					["homeDelegationResolutionClaim", "admissionFailedAt"],
					jsonLiteral(db, input.now),
				],
			]),
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
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResume"])} is null`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "claimId"])} = ${input.expectedClaimId}`,
				sql`${jsonRead(db, kernelRuntimeRuns.metadata, ["homeDelegationResolutionClaim", "phase"])} = 'resolving'`,
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
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const runtimeSubmissions = coreTable(db, d1RuntimeSubmissions);
	const read = (path: readonly string[]) =>
		jsonRead(db, kernelRuntimeRuns.metadata, path);
	const acknowledgement = sql`((${read(["homeDelegationResume", "observation", "outcome"])} = 'acknowledged' and ${read(["homeDelegationResume", "observation", "observedChildRunId"])} = ${input.expectedChildRunId}) or (${read(["homeDelegationResume", "observation", "outcome"])} = 'unknown' and ${read(["homeDelegationResume", "lateObservation", "outcome"])} = 'acknowledged' and ${read(["homeDelegationResume", "lateObservation", "observedChildRunId"])} = ${input.expectedChildRunId}))`;
	const attempt = input.outcome === "attempted";
	const rows = await db
		.update(kernelRuntimeRuns)
		.set({
			metadata: attempt
				? jsonSetPaths(db, kernelRuntimeRuns.metadata, [
						[
							["homeDelegationResume", "stopObservation"],
							jsonLiteral(db, {
								attemptId: input.stopAttemptId,
								outcome: "attempted",
								attemptedAt: input.now,
							}),
						],
					])
				: jsonSetPaths(db, kernelRuntimeRuns.metadata, [
						[
							["homeDelegationResume", "stopObservation", "completion"],
							jsonLiteral(db, {
								outcome: input.outcome,
								completedAt: input.now,
								error: input.error?.slice(0, 1000) ?? null,
							}),
						],
					]),
		})
		.where(
			and(
				approvedHomeResumeScope(db, input),
				acknowledgement,
				sql`${read(["homeDelegationResume", "phase"])} = 'observed'`,
				attempt
					? and(
							sql`${read(["homeDelegationResume", "stopObservation"])} is null`,
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
							sql`${read(["homeDelegationResume", "stopObservation", "attemptId"])} = ${input.stopAttemptId}`,
							sql`${read(["homeDelegationResume", "stopObservation", "completion"])} is null`,
						),
			),
		)
		.returning({ id: kernelRuntimeRuns.id });
	return rows.length === 1;
}
