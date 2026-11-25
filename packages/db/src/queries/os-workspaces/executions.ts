import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lt,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { anyIds, coreStore } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { announceOsWorkspaceChange } from "../os-workspace-events";
import { osWorkspaceEvents as d1OsWorkspaceEvents } from "../../schema/os-collaborators";
import {
	type NewOsGadgetExecutionRow,
	type OsGadgetExecutionRow,
	osGadgetExecutions as d1OsGadgetExecutions,
	osWorkspaces as d1OsWorkspaces,
} from "../../schema/os-workspaces";

export interface OsGadgetExecutionScopeParams {
	organizationId: string;
	executionId: string;
}

export interface ListOsGadgetExecutionsOptions {
	status?: OsGadgetExecutionRow["status"];
	callId?: string;
	includeTraces?: boolean;
	limit?: number;
}

export interface ClaimApprovedOsGadgetExecutionParams extends OsGadgetExecutionScopeParams {
	runId: string;
	billingReservationId: string | null;
	/** JSON string: the approval-time policy recheck that admitted dispatch. */
	policyDecision: string;
	/** JSON OsDerivedAccessEnvelope captured by the approval-time resource recheck. */
	resourceAccessEnvelope: string;
}

export interface RecordOsGadgetDispatchParams extends OsGadgetExecutionScopeParams {
	status: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
	runId: string;
	workflowInstanceId: string;
	executionEpoch: number;
}

export interface SettleAwaitingApprovalOsGadgetExecutionParams extends OsGadgetExecutionScopeParams {
	status: "denied" | "canceled";
	error: string;
	/** JSON string: the terminal approval/policy decision. */
	policyDecision: string;
}

export interface FailClaimedOsGadgetExecutionParams extends OsGadgetExecutionScopeParams {
	runId: string;
	error: string;
}

/** Receipt statuses a linked skill run can still move. */
const RUN_SETTLEABLE_STATUSES = ["queued", "running", "paused"] as const;

export interface SettleOsGadgetExecutionFromRunParams {
	runId: string;
	status: "running" | "paused" | "completed" | "failed" | "canceled";
	/** JSON string: run result recorded at settlement. */
	output?: string | null;
	error?: string | null;
	/** JSON string: run cost summary recorded at settlement. */
	costs?: string | null;
	/** JSON string: array of artifact/evidence references from run evidence. */
	evidenceRefs?: string | null;
	traceBundleId?: string | null;
	executionEpoch?: number;
}

export async function createOsGadgetExecution(
	db: DbQueryClient,
	execution: NewOsGadgetExecutionRow,
): Promise<OsGadgetExecutionRow> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.insert(osGadgetExecutions)
		.values(execution)
		.returning();
	if (!row) {
		throw new Error("OS gadget execution insert returned no row");
	}
	await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/** Settle only a direct runtime call; skill-run receipts have their own lifecycle. */
export async function settleOsAppCallExecution(
	db: DbQueryClient,
	params: OsGadgetExecutionScopeParams & {
		status: "completed" | "failed";
		output?: string;
		error?: string;
	},
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.update(osGadgetExecutions)
		.set({
			status: params.status,
			output: params.output ?? null,
			error: params.error ?? null,
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
				eq(osGadgetExecutions.status, "running"),
				isNull(osGadgetExecutions.runId),
			),
		)
		.returning();
	if (row) await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/** Publish or clear against the exact receipt version which was archived. */
export async function cutOverOsGadgetExecutionOutput(
	db: DbQueryClient,
	row: OsGadgetExecutionRow & { output: string; completedAt: string },
	sha256: string,
	phase: "publish" | "clear" | "archiveDetached",
): Promise<boolean> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const archiveDetached = phase === "archiveDetached";
	const attachableWorkspace = db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, row.organizationId),
				eq(osWorkspaces.id, row.workspaceId),
				or(
					ne(osWorkspaces.status, "archived"),
					ne(osWorkspaces.visibility, "private"),
				),
			),
		);
	const [updated] = await db
		.update(osGadgetExecutions)
		.set({
			workspaceOutputSha256: phase === "clear" ? undefined : sha256,
			output: phase === "publish" ? undefined : null,
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, row.organizationId),
				eq(osGadgetExecutions.workspaceId, row.workspaceId),
				eq(osGadgetExecutions.gadgetId, row.gadgetId),
				eq(osGadgetExecutions.id, row.id),
				eq(osGadgetExecutions.status, "completed"),
				eq(osGadgetExecutions.completedAt, row.completedAt),
				eq(osGadgetExecutions.output, row.output),
				eq(osGadgetExecutions.executionEpoch, row.executionEpoch),
				isNull(osGadgetExecutions.runId),
				isNull(osGadgetExecutions.workflowInstanceId),
				phase === "publish"
					? isNull(osGadgetExecutions.workspaceOutputSha256)
					: or(
							eq(osGadgetExecutions.workspaceOutputSha256, sha256),
							archiveDetached
								? isNull(osGadgetExecutions.workspaceOutputSha256)
								: undefined,
						),
				archiveDetached
					? and(
							eq(
								osGadgetExecutions.runtimeEnvironment,
								row.runtimeEnvironment ?? "",
							),
							notExists(attachableWorkspace),
						)
					: undefined,
			),
		)
		.returning({ id: osGadgetExecutions.id });
	return updated !== undefined;
}

export async function getOsGadgetExecution(
	db: DbQueryClient,
	params: OsGadgetExecutionScopeParams,
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.select()
		.from(osGadgetExecutions)
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
			),
		)
		.limit(1);
	return row;
}

export async function getOsGadgetExecutionByRunId(
	db: DbQueryClient,
	params: { organizationId: string; tediId?: string; runId: string },
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const rows = await db
		.select()
		.from(osGadgetExecutions)
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				...(params.tediId
					? [eq(osGadgetExecutions.tediId, params.tediId)]
					: []),
				eq(osGadgetExecutions.runId, params.runId),
			),
		)
		.limit(2);
	return rows.length === 1 ? rows[0] : undefined;
}

export async function listOsGadgetExecutions(
	db: DbQueryClient,
	params: { organizationId: string; gadgetId: string },
	options: ListOsGadgetExecutionsOptions = {},
): Promise<OsGadgetExecutionRow[]> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const trace = sql`coalesce(${osGadgetExecutions.traceMetadata}, ${osGadgetExecutions.output})`;
	const pgTrace = sql`(${trace})::jsonb`;
	const finalTrace =
		coreStore(db) === "postgres"
			? sql`CASE jsonb_typeof(${pgTrace} #> '{events,0,live}')
			WHEN 'boolean' THEN NOT (${pgTrace} #>> '{events,0,live}')::boolean
			WHEN 'number' THEN (${pgTrace} #>> '{events,0,live}')::numeric = 0
			ELSE (${pgTrace} #> '{events,0,live}') IS NULL OR (${pgTrace} #> '{events,0,live}') = 'null'::jsonb END`
			: sql`coalesce(json_extract(${trace}, '$.events[0].live'), 0) = 0`;
	const sequence =
		coreStore(db) === "postgres"
			? sql`CASE WHEN jsonb_typeof(${pgTrace} #> '{events,0,sequence}') = 'number' THEN (${pgTrace} #>> '{events,0,sequence}')::numeric END`
			: sql`json_extract(${trace}, '$.events[0].sequence')`;
	const conditions = [
		eq(osGadgetExecutions.organizationId, params.organizationId),
		eq(osGadgetExecutions.gadgetId, params.gadgetId),
	];
	if (options.status) {
		conditions.push(eq(osGadgetExecutions.status, options.status));
	}
	if (options.callId) {
		conditions.push(
			coreStore(db) === "postgres"
				? sql`${pgTrace} ->> 'callId' = ${options.callId}`
				: sql`json_extract(${trace}, '$.callId') = ${options.callId}`,
		);
		conditions.push(eq(osGadgetExecutions.createdById, "workspace-app-host"));
	}
	if (options.includeTraces === false)
		conditions.push(ne(osGadgetExecutions.createdById, "workspace-app-host"));
	return (
		db
			.select()
			.from(osGadgetExecutions)
			.where(and(...conditions))
			.orderBy(
				...(options.callId
					? [
							desc(finalTrace),
							coreStore(db) === "postgres"
								? sql`${sequence} DESC NULLS LAST`
								: desc(sequence),
						]
					: []),
				desc(osGadgetExecutions.createdAt),
				desc(osGadgetExecutions.id),
			)
			// The API requests one extra row to report whether its 200-row page is full.
			.limit(Math.min(Math.max(options.limit ?? 50, 1), 201))
	);
}

/**
 * Claim a parked receipt before the external runtime call. The deterministic
 * run id and billing reservation are durable retry state: after this CAS,
 * retries re-dispatch the same run rather than creating another one.
 */
export async function claimApprovedOsGadgetExecution(
	db: DbQueryClient,
	params: ClaimApprovedOsGadgetExecutionParams,
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.update(osGadgetExecutions)
		.set({
			status: "queued",
			runId: params.runId,
			billingReservationId: params.billingReservationId,
			policyDecision: params.policyDecision,
			resourceAccessEnvelope: params.resourceAccessEnvelope,
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
				eq(osGadgetExecutions.status, "awaiting_approval"),
			),
		)
		.returning();
	if (row) await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/**
 * Record the runtime response for a claimed receipt. Matching both the
 * receipt id and deterministic run id prevents a late response from attaching
 * lineage to another claim; `workflow_instance_id IS NULL` makes replay a no-op.
 */
export async function recordOsGadgetDispatch(
	db: DbQueryClient,
	params: RecordOsGadgetDispatchParams,
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const terminal =
		params.status === "completed" ||
		params.status === "failed" ||
		params.status === "canceled";
	const [row] = await db
		.update(osGadgetExecutions)
		.set({
			status: params.status,
			workflowInstanceId: params.workflowInstanceId,
			executionEpoch: params.executionEpoch,
			...(terminal ? { completedAt: new Date().toISOString() } : {}),
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
				eq(osGadgetExecutions.runId, params.runId),
				isNull(osGadgetExecutions.workflowInstanceId),
				eq(osGadgetExecutions.status, "queued"),
			),
		)
		.returning();
	if (row) await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/** Terminalize a parked receipt from a rejection, expiry, or failed recheck. */
export async function settleAwaitingApprovalOsGadgetExecution(
	db: DbQueryClient,
	params: SettleAwaitingApprovalOsGadgetExecutionParams,
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.update(osGadgetExecutions)
		.set({
			status: params.status,
			error: params.error,
			policyDecision: params.policyDecision,
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
				eq(osGadgetExecutions.status, "awaiting_approval"),
			),
		)
		.returning();
	if (row) await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/** Mark a claimed dispatch failed only while no runtime response was recorded. */
export async function failClaimedOsGadgetExecution(
	db: DbQueryClient,
	params: FailClaimedOsGadgetExecutionParams,
): Promise<OsGadgetExecutionRow | undefined> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const [row] = await db
		.update(osGadgetExecutions)
		.set({
			status: "failed",
			error: params.error,
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, params.organizationId),
				eq(osGadgetExecutions.id, params.executionId),
				eq(osGadgetExecutions.runId, params.runId),
				eq(osGadgetExecutions.status, "queued"),
				isNull(osGadgetExecutions.workflowInstanceId),
			),
		)
		.returning();
	if (row) await announceOsWorkspaceChange(db, row.workspaceId, "runs");
	return row;
}

/**
 * Settle (or sync) every receipt pinned to a dispatched skill run from run
 * evidence — the runtime-status reconciliation entry point. Only receipts
 * still in a run-settleable state (queued/running/paused) move; terminal
 * receipts are immutable audit evidence. Terminal statuses stamp
 * `completed_at`; the lifecycle statuses (`running`/`paused`) sync state
 * without settling.
 */
export async function settleOsGadgetExecutionFromRun(
	db: DbQueryClient,
	params: SettleOsGadgetExecutionFromRunParams,
): Promise<OsGadgetExecutionRow[]> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const osWorkspaceEvents = coreTable(db, d1OsWorkspaceEvents);
	const terminal =
		params.status === "completed" ||
		params.status === "failed" ||
		params.status === "canceled";
	const rows = await db
		.update(osGadgetExecutions)
		.set({
			status: params.status,
			...(params.output !== undefined ? { output: params.output } : {}),
			...(params.error !== undefined ? { error: params.error } : {}),
			...(params.costs !== undefined ? { costs: params.costs } : {}),
			...(params.evidenceRefs !== undefined
				? { evidenceRefs: params.evidenceRefs }
				: {}),
			...(params.traceBundleId !== undefined
				? { traceBundleId: params.traceBundleId }
				: {}),
			...(params.executionEpoch !== undefined
				? { executionEpoch: params.executionEpoch }
				: {}),
			...(terminal ? { completedAt: new Date().toISOString() } : {}),
		})
		.where(
			and(
				eq(osGadgetExecutions.runId, params.runId),
				inArray(osGadgetExecutions.status, [...RUN_SETTLEABLE_STATUSES]),
			),
		)
		.returning();
	if (rows.length) {
		try {
			await db.insert(osWorkspaceEvents).select(
				db
					.selectDistinct({
						workspaceId: osGadgetExecutions.workspaceId,
						kind: sql<"runs">`'runs'`.as("kind"),
					})
					.from(osGadgetExecutions)
					.where(
						anyIds(
							db,
							osGadgetExecutions.id,
							rows.map((row) => row.id),
						),
					),
			);
		} catch {
			// Hints follow committed writes and must not fail their settlement.
		}
	}
	return rows;
}

/** Keep receipt metadata in main; only immutable terminal bodies leave D1. */
export function listOsGadgetExecutionBodiesToOffload(
	db: DbQueryClient,
	cutoff: string,
) {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	return db
		.select()
		.from(osGadgetExecutions)
		.where(
			and(
				sql`${osGadgetExecutions.bodyR2Key} IS NULL AND (${osGadgetExecutions.input} IS NOT NULL OR ${osGadgetExecutions.output} IS NOT NULL) AND ${osGadgetExecutions.status} IN ('completed', 'failed', 'canceled', 'denied')`,
				lt(
					sql`coalesce(${osGadgetExecutions.completedAt}, ${osGadgetExecutions.createdAt})`,
					cutoff,
				),
			),
		)
		.orderBy(
			sql`coalesce(${osGadgetExecutions.completedAt}, ${osGadgetExecutions.createdAt})`,
		)
		.limit(20);
}

export async function offloadOsGadgetExecutionBody(
	db: DbQueryClient,
	row: OsGadgetExecutionRow,
	bodyR2Key: string,
	bodyBytes: number,
	cutoff: string,
): Promise<boolean> {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const output = sql`${osGadgetExecutions.output}::jsonb`;
	const traceMetadata =
		coreStore(db) === "postgres"
			? sql`CASE WHEN ${osGadgetExecutions.createdById} = 'workspace-app-host'
			AND pg_input_is_valid(${osGadgetExecutions.output}, 'jsonb')
			THEN jsonb_build_object('callId', ${output} -> 'callId', 'events',
				jsonb_build_array(jsonb_build_object(
					'live', CASE jsonb_typeof(${output} #> '{events,0,live}')
						WHEN 'boolean' THEN to_jsonb(CASE WHEN (${output} #>> '{events,0,live}')::boolean THEN 1 ELSE 0 END)
						ELSE ${output} #> '{events,0,live}' END,
					'sequence', ${output} #> '{events,0,sequence}')))::text ELSE NULL END`
			: sql`CASE WHEN ${osGadgetExecutions.createdById} = 'workspace-app-host' AND json_valid(${osGadgetExecutions.output}) THEN json_object('callId', json_extract(${osGadgetExecutions.output}, '$.callId'), 'events', json_array(json_object('live', json_extract(${osGadgetExecutions.output}, '$.events[0].live'), 'sequence', json_extract(${osGadgetExecutions.output}, '$.events[0].sequence')))) ELSE NULL END`;
	const same = (
		column: typeof osGadgetExecutions.output,
		value: string | null,
	) =>
		coreStore(db) === "postgres"
			? sql`${column} IS NOT DISTINCT FROM ${value}`
			: sql`${column} IS ${value}`;
	const updated = await db
		.update(osGadgetExecutions)
		.set({
			input: null,
			output: null,
			bodyR2Key,
			bodyBytes,
			traceMetadata,
		})
		.where(
			and(
				eq(osGadgetExecutions.organizationId, row.organizationId),
				eq(osGadgetExecutions.id, row.id),
				eq(osGadgetExecutions.status, row.status),
				inArray(osGadgetExecutions.status, [
					"completed",
					"failed",
					"canceled",
					"denied",
				]),
				lt(
					sql`coalesce(${osGadgetExecutions.completedAt}, ${osGadgetExecutions.createdAt})`,
					cutoff,
				),
				eq(osGadgetExecutions.executionEpoch, row.executionEpoch),
				isNull(osGadgetExecutions.bodyR2Key),
				same(osGadgetExecutions.input, row.input),
				same(osGadgetExecutions.output, row.output),
				same(osGadgetExecutions.completedAt, row.completedAt),
				same(
					osGadgetExecutions.workspaceOutputSha256,
					row.workspaceOutputSha256,
				),
			),
		)
		.returning({ id: osGadgetExecutions.id });
	return updated.length === 1;
}
