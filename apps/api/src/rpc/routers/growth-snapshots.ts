/**
 * Growth Snapshots Router
 * Weekly cognitive metric snapshots for tedi Growth page
 *
 * REST Endpoints:
 * GET    /growth-snapshots                - List snapshots (user auth)
 * GET    /growth-snapshots/latest         - Get latest snapshot (user auth)
 * POST   /growth-snapshots                - Create snapshot (service auth — cron only)
 */

import { implement } from "@orpc/server";
import { growthSnapshotsContract } from "@tedix/api-contract/contracts/growth-snapshots";
import {
	createGrowthSnapshot,
	getLatestGrowthSnapshot,
	listGrowthSnapshots,
} from "@tedix/db/queries/growth-snapshots";
import { AUTHZ, type BaseContext, withAuth, withServiceAuth } from "../orpc";
import { requireTediAccess, type TediAccessPolicy } from "../tedi-access";

// =============================================================================
// IMPLEMENTER
// =============================================================================

const growthOs = implement(growthSnapshotsContract).$context<BaseContext>();
const authOs = growthOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

/** Strictly tenant-bound: no authority reads another organization's snapshots. */
export const GROWTH_SNAPSHOTS_TEDI_ACCESS: TediAccessPolicy = {
	scope: "organization",
	missingOrganizationCode: "FORBIDDEN",
	platformAuthority: "none",
};

// =============================================================================
// PROCEDURES
// =============================================================================

/**
 * List growth snapshots for a tedi (user auth)
 * Returns paginated list ordered by snapshotDate descending
 */
const listProcedure = authOs.list
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(
			context,
			input.tediId,
			GROWTH_SNAPSHOTS_TEDI_ACCESS,
		);

		const limit = input.limit ?? 52;
		const offset = input.offset ?? 0;

		const { data, total } = await listGrowthSnapshots(
			context.db,
			tedi.id,
			limit,
			offset,
		);

		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Get latest growth snapshot for a tedi (user auth)
 * Returns the most recent snapshot or null
 */
const latestProcedure = authOs.latest
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(
			context,
			input.tediId,
			GROWTH_SNAPSHOTS_TEDI_ACCESS,
		);

		const snapshot = await getLatestGrowthSnapshot(context.db, tedi.id);

		return snapshot ?? null;
	});

/**
 * Create a growth snapshot (service auth — cron job only)
 * Called by the weekly snapshot cron, not by users
 */
const createProcedure = growthOs.create
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const snapshot = await createGrowthSnapshot(context.db, {
			tediId: input.tediId,
			orgId: input.orgId,
			snapshotDate: input.snapshotDate,
			metrics: input.metrics,
		});

		return snapshot;
	});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const growthSnapshotsContractRouter = growthOs.router({
	list: listProcedure,
	latest: latestProcedure,
	create: createProcedure,
});
