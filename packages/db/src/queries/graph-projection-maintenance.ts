import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type GraphProjectionMaintenanceEnvironment,
	type GraphProjectionMaintenanceOperation,
	type GraphProjectionMaintenanceRun,
	graphProjectionConsumers,
	graphProjectionMaintenanceRuns,
	graphProjectionOutbox,
	graphProjectionReadiness,
} from "../schema/graph-projection";

export class GraphProjectionMaintenanceIdempotencyError extends Error {
	constructor() {
		super("Idempotency key is already bound to a different graph operation");
		this.name = "GraphProjectionMaintenanceIdempotencyError";
	}
}

export async function reserveGraphProjectionMaintenanceRun(
	db: DbClient,
	input: {
		id: string;
		runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
		organizationId: string;
		operation: GraphProjectionMaintenanceOperation;
		idempotencyKey: string;
		requestFingerprint: string;
	},
): Promise<{ run: GraphProjectionMaintenanceRun; deduplicated: boolean }> {
	const now = new Date().toISOString();
	const result = await db
		.insert(graphProjectionMaintenanceRuns)
		.values({
			id: input.id,
			runtimeEnvironment: input.runtimeEnvironment,
			organizationId: input.organizationId,
			operation: input.operation,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint: input.requestFingerprint,
			workflowId: input.id,
			status: "queued",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [
				graphProjectionMaintenanceRuns.runtimeEnvironment,
				graphProjectionMaintenanceRuns.organizationId,
				graphProjectionMaintenanceRuns.idempotencyKey,
			],
		});
	const [run] = await db
		.select()
		.from(graphProjectionMaintenanceRuns)
		.where(
			and(
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					input.runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, input.organizationId),
				eq(graphProjectionMaintenanceRuns.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	if (!run) {
		throw new Error("Failed to reserve graph projection maintenance run");
	}
	if (
		run.operation !== input.operation ||
		run.requestFingerprint !== input.requestFingerprint
	) {
		throw new GraphProjectionMaintenanceIdempotencyError();
	}
	return { run, deduplicated: (result.meta?.changes ?? 0) === 0 };
}

export async function getGraphProjectionMaintenanceRun(
	db: DbClient,
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment,
	organizationId: string,
	id: string,
): Promise<GraphProjectionMaintenanceRun | null> {
	const [run] = await db
		.select()
		.from(graphProjectionMaintenanceRuns)
		.where(
			and(
				eq(graphProjectionMaintenanceRuns.id, id),
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, organizationId),
			),
		)
		.limit(1);
	return run ?? null;
}

/**
 * Return old non-terminal rows so the two-minute control-plane tick can repair
 * the D1-reservation -> Workflow-create gap and reconcile missed terminal
 * settlement. Fresh callers retain the first chance to dispatch.
 */
export async function listStaleGraphProjectionMaintenanceRuns(
	db: DbClient,
	input: {
		runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
		updatedBefore: string;
		limit: number;
	},
): Promise<GraphProjectionMaintenanceRun[]> {
	return db
		.select()
		.from(graphProjectionMaintenanceRuns)
		.where(
			and(
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					input.runtimeEnvironment,
				),
				inArray(graphProjectionMaintenanceRuns.status, [
					"queued",
					"running",
					"cancel_requested",
				]),
				lte(graphProjectionMaintenanceRuns.updatedAt, input.updatedBefore),
			),
		)
		.orderBy(
			asc(graphProjectionMaintenanceRuns.updatedAt),
			asc(graphProjectionMaintenanceRuns.id),
		)
		.limit(Math.max(1, Math.min(input.limit, 25)));
}

export async function markGraphProjectionMaintenanceRunning(
	db: DbClient,
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment,
	organizationId: string,
	id: string,
): Promise<GraphProjectionMaintenanceRun | null> {
	const now = new Date().toISOString();
	await db
		.update(graphProjectionMaintenanceRuns)
		.set({
			status: "running",
			startedAt: sql`COALESCE(${graphProjectionMaintenanceRuns.startedAt}, ${now})`,
			updatedAt: now,
			error: null,
		})
		.where(
			and(
				eq(graphProjectionMaintenanceRuns.id, id),
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, organizationId),
				inArray(graphProjectionMaintenanceRuns.status, ["queued", "running"]),
			),
		);
	return getGraphProjectionMaintenanceRun(
		db,
		runtimeEnvironment,
		organizationId,
		id,
	);
}

export async function requestGraphProjectionMaintenanceCancel(
	db: DbClient,
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment,
	organizationId: string,
	id: string,
	reason: string,
): Promise<GraphProjectionMaintenanceRun | null> {
	const now = new Date().toISOString();
	await db
		.update(graphProjectionMaintenanceRuns)
		.set({
			status: "cancel_requested",
			cancelReason: reason,
			cancelRequestedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(graphProjectionMaintenanceRuns.id, id),
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, organizationId),
				inArray(graphProjectionMaintenanceRuns.status, ["queued", "running"]),
			),
		);
	return getGraphProjectionMaintenanceRun(
		db,
		runtimeEnvironment,
		organizationId,
		id,
	);
}

/**
 * Atomically publish GDS freshness and the terminal task receipt.
 *
 * Besides cancel/run ownership, the transaction fences the exact consumer
 * cursor and absence of a newer outbox event. A canonical write racing the
 * final verification therefore prevents both the freshness stamp and the
 * completed task receipt.
 */
export async function commitGraphProjectionMaintenanceGdsSuccess(
	db: DbClient,
	input: {
		runtimeEnvironment: GraphProjectionMaintenanceEnvironment;
		organizationId: string;
		id: string;
		watermark: number;
		epoch: string;
		result: Record<string, JsonValue>;
	},
): Promise<boolean> {
	const now = new Date().toISOString();
	const runningGuard = sql`EXISTS (
		SELECT 1
		FROM ${graphProjectionMaintenanceRuns} AS maintenance_run
		WHERE maintenance_run.id = ${input.id}
			AND maintenance_run.runtime_environment = ${input.runtimeEnvironment}
			AND maintenance_run.organization_id = ${input.organizationId}
			AND maintenance_run.status = 'running'
	)`;
	const stableSnapshotGuard = sql`EXISTS (
			SELECT 1
			FROM ${graphProjectionConsumers} AS consumer
			WHERE consumer.organization_id = ${input.organizationId}
				AND consumer.last_projected_sequence = ${input.watermark}
		)
		AND NOT EXISTS (
			SELECT 1
			FROM ${graphProjectionOutbox} AS outbox
			WHERE outbox.organization_id = ${input.organizationId}
				AND outbox.sequence > ${input.watermark}
		)`;
	const [readinessRows, runRows] = await db.batch([
		db
			.update(graphProjectionReadiness)
			.set({
				state: "ready",
				reason: null,
				gdsWatermark: input.watermark,
				gdsEpoch: input.epoch,
				updatedAt: now,
			})
			.where(
				and(
					eq(graphProjectionReadiness.organizationId, input.organizationId),
					eq(graphProjectionReadiness.state, "ready"),
					eq(graphProjectionReadiness.persistedWatermark, input.watermark),
					eq(graphProjectionReadiness.projectionEpoch, input.epoch),
					runningGuard,
					stableSnapshotGuard,
				),
			)
			.returning({ organizationId: graphProjectionReadiness.organizationId }),
		db
			.update(graphProjectionMaintenanceRuns)
			.set({
				status: "completed",
				result: input.result,
				error: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(graphProjectionMaintenanceRuns.id, input.id),
					eq(
						graphProjectionMaintenanceRuns.runtimeEnvironment,
						input.runtimeEnvironment,
					),
					eq(
						graphProjectionMaintenanceRuns.organizationId,
						input.organizationId,
					),
					eq(graphProjectionMaintenanceRuns.status, "running"),
					stableSnapshotGuard,
					sql`EXISTS (
						SELECT 1
						FROM ${graphProjectionReadiness} AS readiness
						WHERE readiness.organization_id = ${input.organizationId}
							AND readiness.state = 'ready'
							AND readiness.persisted_watermark = ${input.watermark}
							AND readiness.projection_epoch = ${input.epoch}
							AND readiness.gds_watermark = ${input.watermark}
							AND readiness.gds_epoch = ${input.epoch}
					)`,
				),
			)
			.returning({ id: graphProjectionMaintenanceRuns.id }),
	]);
	void readinessRows;
	return runRows.length === 1;
}

export async function failGraphProjectionMaintenance(
	db: DbClient,
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment,
	organizationId: string,
	id: string,
	error: string,
): Promise<GraphProjectionMaintenanceRun | null> {
	const now = new Date().toISOString();
	await db
		.update(graphProjectionMaintenanceRuns)
		.set({
			status: "failed",
			error,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(graphProjectionMaintenanceRuns.id, id),
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, organizationId),
				inArray(graphProjectionMaintenanceRuns.status, ["queued", "running"]),
			),
		);
	return getGraphProjectionMaintenanceRun(
		db,
		runtimeEnvironment,
		organizationId,
		id,
	);
}

export async function cancelGraphProjectionMaintenance(
	db: DbClient,
	runtimeEnvironment: GraphProjectionMaintenanceEnvironment,
	organizationId: string,
	id: string,
): Promise<GraphProjectionMaintenanceRun | null> {
	const now = new Date().toISOString();
	await db
		.update(graphProjectionMaintenanceRuns)
		.set({
			status: "canceled",
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(graphProjectionMaintenanceRuns.id, id),
				eq(
					graphProjectionMaintenanceRuns.runtimeEnvironment,
					runtimeEnvironment,
				),
				eq(graphProjectionMaintenanceRuns.organizationId, organizationId),
				eq(graphProjectionMaintenanceRuns.status, "cancel_requested"),
			),
		);
	return getGraphProjectionMaintenanceRun(
		db,
		runtimeEnvironment,
		organizationId,
		id,
	);
}
