import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type NewOsGadgetExecutionRow,
	type OsGadgetExecutionRow,
	osGadgetExecutions,
} from "../../schema/os-workspaces";

export interface OsGadgetExecutionScopeParams {
	organizationId: string;
	executionId: string;
}

export interface ListOsGadgetExecutionsOptions {
	status?: OsGadgetExecutionRow["status"];
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
	const [row] = await db
		.insert(osGadgetExecutions)
		.values(execution)
		.returning();
	if (!row) {
		throw new Error("OS gadget execution insert returned no row");
	}
	return row;
}

export async function getOsGadgetExecution(
	db: DbQueryClient,
	params: OsGadgetExecutionScopeParams,
): Promise<OsGadgetExecutionRow | undefined> {
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
	const conditions = [
		eq(osGadgetExecutions.organizationId, params.organizationId),
		eq(osGadgetExecutions.gadgetId, params.gadgetId),
	];
	if (options.status) {
		conditions.push(eq(osGadgetExecutions.status, options.status));
	}
	return db
		.select()
		.from(osGadgetExecutions)
		.where(and(...conditions))
		.orderBy(desc(osGadgetExecutions.createdAt), desc(osGadgetExecutions.id))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
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
	return row;
}

/** Terminalize a parked receipt from a rejection, expiry, or failed recheck. */
export async function settleAwaitingApprovalOsGadgetExecution(
	db: DbQueryClient,
	params: SettleAwaitingApprovalOsGadgetExecutionParams,
): Promise<OsGadgetExecutionRow | undefined> {
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
	return row;
}

/** Mark a claimed dispatch failed only while no runtime response was recorded. */
export async function failClaimedOsGadgetExecution(
	db: DbQueryClient,
	params: FailClaimedOsGadgetExecutionParams,
): Promise<OsGadgetExecutionRow | undefined> {
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
	const terminal =
		params.status === "completed" ||
		params.status === "failed" ||
		params.status === "canceled";
	return db
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
}
