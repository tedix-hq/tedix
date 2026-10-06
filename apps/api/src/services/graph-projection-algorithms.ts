/**
 * Explicit Graph Data Science refresh and D1-owned freshness stamp.
 *
 * The Neo4j algorithm pipeline writes derived FastRP, PageRank, and community
 * properties. D1 remains authoritative for whether those properties may be
 * read: the tenant projection lease serializes the shared GDS projection
 * against drain, repair, and another refresh; the freshness stamp is cleared
 * before mutation and restored only if canonical state stays unchanged.
 */

/// <reference path="../../worker-configuration.d.ts" />

import type { DbClient } from "@tedix/db/client";
import {
	acquireGraphProjectionLease,
	getGraphProjectionBacklogStats,
	getGraphProjectionReadState,
	releaseGraphProjectionLease,
	renewGraphProjectionLease,
	setGraphProjectionReadiness,
} from "@tedix/db/queries/graph-projection";
import { commitGraphProjectionMaintenanceGdsSuccess } from "@tedix/db/queries/graph-projection-maintenance";
import { getGraphClient } from "../integrations/graph-db/client";
import { invalidateInfluenceCache } from "./memory-graph-context-assembly";
import { graphProjectionReadAdmission } from "./graph-projection-certification";

export class GraphProjectionAlgorithmRefreshError extends Error {
	constructor(
		readonly reason:
			| "projection_busy"
			| "projection_not_ready"
			| "projection_changed_during_refresh"
			| "projection_lease_lost"
			| "operation_cancelled",
		message: string,
	) {
		super(message);
		this.name = "GraphProjectionAlgorithmRefreshError";
	}
}

export async function refreshGraphProjectionAlgorithms(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	/** Stable business operation id used to correlate Workflow retries. */
	operationId: string;
	/** Canonical maintenance run whose state fences freshness publication. */
	maintenanceRunId: string;
	/** Cooperative cancellation assertion, called before every mutation phase. */
	assertCanContinue?: () => Promise<void>;
}): Promise<{ watermark: number; epoch: string }> {
	const leaseToken = crypto.randomUUID();
	const acquiredLease = await acquireGraphProjectionLease(
		input.db,
		input.organizationId,
		leaseToken,
		300_000,
	);
	if (!acquiredLease) {
		throw new GraphProjectionAlgorithmRefreshError(
			"projection_busy",
			"Cannot refresh graph algorithms while projection drain, repair, or another refresh is active",
		);
	}

	try {
		await input.assertCanContinue?.();
		const checkedAt = new Date().toISOString();
		const client = getGraphClient(input.env);
		const [healthy, readiness, backlog] = await Promise.all([
			client ? client.isHealthy().catch(() => false) : false,
			getGraphProjectionReadState(input.db, input.organizationId),
			getGraphProjectionBacklogStats(input.db, input.organizationId),
		]);
		const admission = graphProjectionReadAdmission({
			inspection: {
				transportHealthy: healthy,
				readiness,
				backlog,
				checkedAt,
			},
		});
		if (!client || !admission.allowed || !readiness) {
			throw new GraphProjectionAlgorithmRefreshError(
				"projection_not_ready",
				`Cannot refresh graph algorithms: ${admission.reason ?? "projection_not_certified"}`,
			);
		}

		const watermark = backlog.cursor;
		const epoch = readiness.projectionEpoch;
		if (!epoch) {
			throw new GraphProjectionAlgorithmRefreshError(
				"projection_not_ready",
				"Cannot refresh graph algorithms without a stable projection generation",
			);
		}
		await input.assertCanContinue?.();
		await setGraphProjectionReadiness(input.db, {
			organizationId: input.organizationId,
			state: "ready",
			reason: null,
			gdsWatermark: 0,
			gdsEpoch: null,
		});
		await client.refreshStructuralEmbeddings(input.organizationId, {
			epoch,
			sourceWatermark: watermark,
			// The lease token makes cleanup ownership unique. If the lease is
			// lost after projection creation, this request can still safely drop
			// its own GDS graph without racing a successor.
			attemptKey: `${epoch}-${watermark}-${input.operationId}-${leaseToken}`,
			beforeStep: async () => {
				await input.assertCanContinue?.();
				const renewed = await renewGraphProjectionLease(
					input.db,
					input.organizationId,
					leaseToken,
					300_000,
				);
				if (!renewed) {
					throw new GraphProjectionAlgorithmRefreshError(
						"projection_lease_lost",
						"Graph projection lease was lost during GDS refresh; no freshness stamp was recorded",
					);
				}
			},
		});

		const renewed = await renewGraphProjectionLease(
			input.db,
			input.organizationId,
			leaseToken,
			300_000,
		);
		if (!renewed) {
			throw new GraphProjectionAlgorithmRefreshError(
				"projection_lease_lost",
				"Graph projection lease was lost during GDS refresh; no freshness stamp was recorded",
			);
		}

		await input.assertCanContinue?.();
		const [afterReadiness, afterBacklog] = await Promise.all([
			getGraphProjectionReadState(input.db, input.organizationId),
			getGraphProjectionBacklogStats(input.db, input.organizationId),
		]);
		if (
			afterReadiness?.state !== "ready" ||
			afterReadiness.persistedWatermark !== watermark ||
			afterReadiness.projectionEpoch !== epoch ||
			afterBacklog.cursor !== watermark ||
			afterBacklog.highWaterSequence !== watermark ||
			afterBacklog.pendingCount !== 0 ||
			afterBacklog.retryCount !== 0 ||
			afterBacklog.poisonedCount !== 0
		) {
			throw new GraphProjectionAlgorithmRefreshError(
				"projection_changed_during_refresh",
				"Canonical graph state changed while GDS was refreshing; no freshness stamp was recorded",
			);
		}

		const committed = await commitGraphProjectionMaintenanceGdsSuccess(
			input.db,
			{
				runtimeEnvironment: input.env.ENVIRONMENT,
				organizationId: input.organizationId,
				id: input.maintenanceRunId,
				watermark,
				epoch,
				result: {
					operation: "gds_refresh",
					organizationId: input.organizationId,
					watermark,
					epoch,
				},
			},
		);
		if (!committed) {
			throw new GraphProjectionAlgorithmRefreshError(
				"operation_cancelled",
				"Graph GDS refresh was canceled or lost its terminal readiness fence; no freshness stamp was recorded",
			);
		}
		invalidateInfluenceCache(input.organizationId);
		return { watermark, epoch };
	} finally {
		await releaseGraphProjectionLease(
			input.db,
			input.organizationId,
			leaseToken,
		);
	}
}
