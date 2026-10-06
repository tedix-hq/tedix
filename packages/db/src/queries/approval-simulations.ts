/** Append-only persistence for approval simulation, dependencies, and receipts. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import {
	type ApprovalExecutionError,
	type ApprovalExecutionProviderReceiptRef,
	type ApprovalSimulationAssumption,
	type ApprovalSimulationBaselineRef,
	type TediApprovalDependencyEvent,
	type TediApprovalExecutionReceipt,
	type TediApprovalSimulation,
	tediApprovalDependencyEvents,
	tediApprovalExecutionReceipts,
	tediApprovalSimulations,
} from "../schema/approval-simulations";
import { tediApprovalRequests } from "../schema/approvals";

export class ApprovalSimulationScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApprovalSimulationScopeError";
	}
}

export class AppendOnlyApprovalRecordConflictError extends Error {
	constructor(kind: string) {
		super(`${kind} idempotency key already exists with different content`);
		this.name = "AppendOnlyApprovalRecordConflictError";
	}
}

export interface RecordApprovalSimulationParams {
	id: string;
	organizationId: string;
	approvalRequestId: string;
	simulatorId: string;
	simulatorVersion: string;
	canonicalInputHash: string;
	recordHash: string;
	baselineEvidenceRefs: ApprovalSimulationBaselineRef[];
	predictedResult: Record<string, JsonValue>;
	assumptions: ApprovalSimulationAssumption[];
	confidence: number;
	createdAt: string;
}

export interface DeclareApprovalDependencyParams {
	id: string;
	organizationId: string;
	dependentApprovalRequestId: string;
	prerequisiteApprovalRequestId: string;
	simulationId: string;
	dependencyKind: "hard" | "informational";
	recordHash: string;
	createdAt: string;
}

export interface InvalidateApprovalDependencyParams {
	id: string;
	organizationId: string;
	dependentApprovalRequestId: string;
	declarationEventId: string;
	reason: string;
	recordHash: string;
	createdAt: string;
}

interface RecordApprovalExecutionReceiptBase {
	id: string;
	organizationId: string;
	approvalRequestId: string;
	simulationId?: string;
	idempotencyKey: string;
	canonicalInputHash: string;
	recordHash: string;
	baselineFenceOutcome: "matched" | "stale" | "not_checked";
	providerReceiptRefs: ApprovalExecutionProviderReceiptRef[];
	executedAt: string;
	createdAt: string;
}

export type RecordApprovalExecutionReceiptParams =
	| (RecordApprovalExecutionReceiptBase & {
			outcome: "succeeded";
			observedResult: Record<string, JsonValue>;
			observedError?: never;
	  })
	| (RecordApprovalExecutionReceiptBase & {
			outcome: "failed";
			observedResult?: never;
			observedError: ApprovalExecutionError;
	  });

async function requireApprovalRequest(
	db: DbQueryClient,
	organizationId: string,
	approvalRequestId: string,
): Promise<void> {
	const rows = await db
		.select({ id: tediApprovalRequests.id })
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, organizationId),
				eq(tediApprovalRequests.id, approvalRequestId),
			),
		)
		.limit(1);
	if (!rows[0]) {
		throw new ApprovalSimulationScopeError(
			`Approval request ${approvalRequestId} is not in organization ${organizationId}`,
		);
	}
}

async function requireSimulation(
	db: DbQueryClient,
	input: {
		organizationId: string;
		approvalRequestId: string;
		simulationId: string;
	},
): Promise<TediApprovalSimulation> {
	const rows = await db
		.select()
		.from(tediApprovalSimulations)
		.where(
			and(
				eq(tediApprovalSimulations.organizationId, input.organizationId),
				eq(tediApprovalSimulations.approvalRequestId, input.approvalRequestId),
				eq(tediApprovalSimulations.id, input.simulationId),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) {
		throw new ApprovalSimulationScopeError(
			`Simulation ${input.simulationId} is not attached to approval ${input.approvalRequestId} in organization ${input.organizationId}`,
		);
	}
	return row;
}

async function dependencyWouldCreateCycle(
	db: DbQueryClient,
	input: {
		organizationId: string;
		dependentApprovalRequestId: string;
		prerequisiteApprovalRequestId: string;
	},
): Promise<boolean> {
	const rows = (await db.all(sql`
		WITH RECURSIVE active_edges(dependent_id, prerequisite_id) AS (
			SELECT declared.dependent_approval_request_id,
				declared.prerequisite_approval_request_id
			FROM ${tediApprovalDependencyEvents} AS declared
			WHERE declared.organization_id = ${input.organizationId}
				AND declared.event_type = 'declared'
				AND NOT EXISTS (
					SELECT 1
					FROM ${tediApprovalDependencyEvents} AS invalidated
					WHERE invalidated.organization_id = ${input.organizationId}
						AND invalidated.invalidates_event_id = declared.id
				)
		), reach(node) AS (
			SELECT prerequisite_id
			FROM active_edges
			WHERE dependent_id = ${input.prerequisiteApprovalRequestId}
			UNION
			SELECT edge.prerequisite_id
			FROM active_edges AS edge
			INNER JOIN reach ON edge.dependent_id = reach.node
		)
		SELECT 1 AS found
		FROM reach
		WHERE node = ${input.dependentApprovalRequestId}
		LIMIT 1
	`)) as Array<{ found: number }>;
	return rows.length > 0;
}

export async function recordApprovalSimulation(
	db: DbQueryClient,
	input: RecordApprovalSimulationParams,
): Promise<TediApprovalSimulation> {
	await requireApprovalRequest(
		db,
		input.organizationId,
		input.approvalRequestId,
	);
	if (
		!Number.isFinite(input.confidence) ||
		input.confidence < 0 ||
		input.confidence > 1
	) {
		throw new RangeError("Simulation confidence must be between 0 and 1");
	}
	const rows = await db
		.insert(tediApprovalSimulations)
		.values({
			...input,
			evidenceKind: "simulation",
			notProof: true,
		})
		.returning();
	const created = rows[0];
	if (!created) throw new Error(`Failed to record simulation ${input.id}`);
	return created;
}

export async function listApprovalSimulations(
	db: DbQueryClient,
	input: { organizationId: string; approvalRequestId: string },
): Promise<TediApprovalSimulation[]> {
	return db
		.select()
		.from(tediApprovalSimulations)
		.where(
			and(
				eq(tediApprovalSimulations.organizationId, input.organizationId),
				eq(tediApprovalSimulations.approvalRequestId, input.approvalRequestId),
			),
		)
		.orderBy(
			asc(tediApprovalSimulations.createdAt),
			asc(tediApprovalSimulations.id),
		);
}

export interface ApprovalProvenancePageOptions {
	limit: number;
	cursor?: { timestamp: string; id: string };
}

export async function hasApprovalProvenanceRequest(
	db: DbQueryClient,
	input: { organizationId: string; approvalRequestId: string },
): Promise<boolean> {
	const rows = await db
		.select({ id: tediApprovalRequests.id })
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.id, input.approvalRequestId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

function provenancePageLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > 25)
		throw new RangeError(
			"Approval provenance page limit must be between 1 and 25",
		);
	return limit;
}

/** Immutable history ordered by (created_at, id); a timestamp tie never loses a row. */
export async function listApprovalSimulationPage(
	db: DbQueryClient,
	input: { organizationId: string; approvalRequestId: string },
	options: ApprovalProvenancePageOptions,
): Promise<{
	records: TediApprovalSimulation[];
	nextCursor: { timestamp: string; id: string } | null;
}> {
	const limit = provenancePageLimit(options.limit);
	const cursor = options.cursor;
	const rows = await db
		.select()
		.from(tediApprovalSimulations)
		.where(
			and(
				eq(tediApprovalSimulations.organizationId, input.organizationId),
				eq(tediApprovalSimulations.approvalRequestId, input.approvalRequestId),
				cursor
					? or(
							gt(tediApprovalSimulations.createdAt, cursor.timestamp),
							and(
								eq(tediApprovalSimulations.createdAt, cursor.timestamp),
								gt(tediApprovalSimulations.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(
			asc(tediApprovalSimulations.createdAt),
			asc(tediApprovalSimulations.id),
		)
		.limit(limit + 1);
	const records = rows.slice(0, limit);
	const last = records.at(-1);
	return {
		records,
		nextCursor:
			rows.length > limit && last
				? { timestamp: last.createdAt, id: last.id }
				: null,
	};
}

/** Receipt pagination is independent of prediction pagination and uses execution time. */
export async function listApprovalExecutionReceiptPage(
	db: DbQueryClient,
	input: { organizationId: string; approvalRequestId: string },
	options: ApprovalProvenancePageOptions,
): Promise<{
	records: TediApprovalExecutionReceipt[];
	nextCursor: { timestamp: string; id: string } | null;
}> {
	const limit = provenancePageLimit(options.limit);
	const cursor = options.cursor;
	const rows = await db
		.select()
		.from(tediApprovalExecutionReceipts)
		.where(
			and(
				eq(tediApprovalExecutionReceipts.organizationId, input.organizationId),
				eq(
					tediApprovalExecutionReceipts.approvalRequestId,
					input.approvalRequestId,
				),
				cursor
					? or(
							gt(tediApprovalExecutionReceipts.executedAt, cursor.timestamp),
							and(
								eq(tediApprovalExecutionReceipts.executedAt, cursor.timestamp),
								gt(tediApprovalExecutionReceipts.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(
			asc(tediApprovalExecutionReceipts.executedAt),
			asc(tediApprovalExecutionReceipts.id),
		)
		.limit(limit + 1);
	const records = rows.slice(0, limit);
	const last = records.at(-1);
	return {
		records,
		nextCursor:
			rows.length > limit && last
				? { timestamp: last.executedAt, id: last.id }
				: null,
	};
}

export async function declareApprovalDependency(
	db: DbQueryClient,
	input: DeclareApprovalDependencyParams,
): Promise<TediApprovalDependencyEvent> {
	if (
		input.dependentApprovalRequestId === input.prerequisiteApprovalRequestId
	) {
		throw new ApprovalSimulationScopeError(
			"An approval request cannot depend on itself",
		);
	}
	await requireApprovalRequest(
		db,
		input.organizationId,
		input.dependentApprovalRequestId,
	);
	await requireApprovalRequest(
		db,
		input.organizationId,
		input.prerequisiteApprovalRequestId,
	);
	await requireSimulation(db, {
		organizationId: input.organizationId,
		approvalRequestId: input.prerequisiteApprovalRequestId,
		simulationId: input.simulationId,
	});
	if (await dependencyWouldCreateCycle(db, input)) {
		throw new ApprovalSimulationScopeError(
			"Approval dependency would create a cycle",
		);
	}
	const rows = await db
		.insert(tediApprovalDependencyEvents)
		.values({
			...input,
			eventType: "declared",
			invalidatesEventId: null,
			reason: null,
		})
		.returning();
	const created = rows[0];
	if (!created) throw new Error(`Failed to declare dependency ${input.id}`);
	return created;
}

export async function invalidateApprovalDependency(
	db: DbQueryClient,
	input: InvalidateApprovalDependencyParams,
): Promise<TediApprovalDependencyEvent> {
	const declaredRows = await db
		.select()
		.from(tediApprovalDependencyEvents)
		.where(
			and(
				eq(tediApprovalDependencyEvents.id, input.declarationEventId),
				eq(tediApprovalDependencyEvents.organizationId, input.organizationId),
				eq(
					tediApprovalDependencyEvents.dependentApprovalRequestId,
					input.dependentApprovalRequestId,
				),
				eq(tediApprovalDependencyEvents.eventType, "declared"),
			),
		)
		.limit(1);
	const declared = declaredRows[0];
	if (!declared) {
		throw new ApprovalSimulationScopeError(
			`Dependency ${input.declarationEventId} is not an active declaration in the requested scope`,
		);
	}
	const rows = await db
		.insert(tediApprovalDependencyEvents)
		.values({
			id: input.id,
			organizationId: declared.organizationId,
			dependentApprovalRequestId: declared.dependentApprovalRequestId,
			prerequisiteApprovalRequestId: declared.prerequisiteApprovalRequestId,
			simulationId: declared.simulationId,
			eventType: "invalidated",
			dependencyKind: declared.dependencyKind,
			invalidatesEventId: declared.id,
			reason: input.reason,
			recordHash: input.recordHash,
			createdAt: input.createdAt,
		})
		.onConflictDoNothing()
		.returning();
	if (rows[0]) return rows[0];
	const existingRows = await db
		.select()
		.from(tediApprovalDependencyEvents)
		.where(
			and(
				eq(tediApprovalDependencyEvents.invalidatesEventId, declared.id),
				eq(tediApprovalDependencyEvents.organizationId, input.organizationId),
			),
		)
		.limit(1);
	const existing = existingRows[0];
	if (existing?.recordHash === input.recordHash) return existing;
	throw new AppendOnlyApprovalRecordConflictError("Dependency invalidation");
}

export async function listApprovalDependencyEvents(
	db: DbQueryClient,
	input: { organizationId: string; dependentApprovalRequestId: string },
): Promise<TediApprovalDependencyEvent[]> {
	return db
		.select()
		.from(tediApprovalDependencyEvents)
		.where(
			and(
				eq(tediApprovalDependencyEvents.organizationId, input.organizationId),
				eq(
					tediApprovalDependencyEvents.dependentApprovalRequestId,
					input.dependentApprovalRequestId,
				),
			),
		)
		.orderBy(
			asc(tediApprovalDependencyEvents.createdAt),
			asc(tediApprovalDependencyEvents.id),
		);
}

/**
 * Active dependency declarations touching a bounded set of approval ids.
 * Invalidation is append-only, so an edge is active only while no event names
 * its declaration in `invalidates_event_id`.
 */
export async function listActiveApprovalDependencies(
	db: DbQueryClient,
	input: {
		organizationId: string;
		approvalRequestIds: string[];
		relation?: "dependent" | "prerequisite" | "either";
	},
): Promise<TediApprovalDependencyEvent[]> {
	const ids = [...new Set(input.approvalRequestIds)].slice(0, 50);
	if (ids.length === 0) return [];
	const invalidated = alias(tediApprovalDependencyEvents, "invalidated");
	const dependent = inArray(
		tediApprovalDependencyEvents.dependentApprovalRequestId,
		ids,
	);
	const prerequisite = inArray(
		tediApprovalDependencyEvents.prerequisiteApprovalRequestId,
		ids,
	);
	const relation =
		input.relation === "dependent"
			? dependent
			: input.relation === "prerequisite"
				? prerequisite
				: or(dependent, prerequisite);
	return db
		.select({ declaration: tediApprovalDependencyEvents })
		.from(tediApprovalDependencyEvents)
		.leftJoin(
			invalidated,
			and(
				eq(invalidated.invalidatesEventId, tediApprovalDependencyEvents.id),
				eq(invalidated.organizationId, input.organizationId),
			),
		)
		.where(
			and(
				eq(tediApprovalDependencyEvents.organizationId, input.organizationId),
				eq(tediApprovalDependencyEvents.eventType, "declared"),
				relation,
				sql`${invalidated.id} is null`,
			),
		)
		.orderBy(
			asc(tediApprovalDependencyEvents.createdAt),
			asc(tediApprovalDependencyEvents.id),
		)
		.then((rows) => rows.map((row) => row.declaration));
}

export async function recordApprovalExecutionReceipt(
	db: DbQueryClient,
	input: RecordApprovalExecutionReceiptParams,
): Promise<TediApprovalExecutionReceipt> {
	if (input.baselineFenceOutcome === "stale" && input.outcome === "succeeded") {
		throw new Error(
			"A stale baseline fence cannot produce a successful receipt",
		);
	}
	await requireApprovalRequest(
		db,
		input.organizationId,
		input.approvalRequestId,
	);
	if (input.simulationId) {
		await requireSimulation(db, {
			organizationId: input.organizationId,
			approvalRequestId: input.approvalRequestId,
			simulationId: input.simulationId,
		});
	}
	const rows = await db
		.insert(tediApprovalExecutionReceipts)
		.values({
			...input,
			simulationId: input.simulationId ?? null,
			observedResult:
				input.outcome === "succeeded" ? input.observedResult : null,
			observedError: input.outcome === "failed" ? input.observedError : null,
		})
		.onConflictDoNothing()
		.returning();
	if (rows[0]) return rows[0];
	const existingRows = await db
		.select()
		.from(tediApprovalExecutionReceipts)
		.where(
			and(
				eq(tediApprovalExecutionReceipts.organizationId, input.organizationId),
				eq(
					tediApprovalExecutionReceipts.approvalRequestId,
					input.approvalRequestId,
				),
				eq(tediApprovalExecutionReceipts.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	const existing = existingRows[0];
	if (existing?.recordHash === input.recordHash) return existing;
	throw new AppendOnlyApprovalRecordConflictError("Execution receipt");
}

export async function listApprovalExecutionReceipts(
	db: DbQueryClient,
	input: { organizationId: string; approvalRequestId: string },
): Promise<TediApprovalExecutionReceipt[]> {
	return db
		.select()
		.from(tediApprovalExecutionReceipts)
		.where(
			and(
				eq(tediApprovalExecutionReceipts.organizationId, input.organizationId),
				eq(
					tediApprovalExecutionReceipts.approvalRequestId,
					input.approvalRequestId,
				),
			),
		)
		.orderBy(
			asc(tediApprovalExecutionReceipts.executedAt),
			asc(tediApprovalExecutionReceipts.id),
		);
}
