/// <reference path="../../worker-configuration.d.ts" />
/**
 * 2am UTC billing quarantine + catalog sync log maintenance.
 */

export async function runDailyBillingAndCatalogMaintenance(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Running billing/catalog maintenance (${runId})`);
	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(env.DB);

	// Keep historical classification independent from catalog maintenance so
	// an unrelated 2am failure cannot starve backlog convergence.
	let legacySelected = 0;
	let legacyQuarantined = 0;
	try {
		const { quarantineLegacyGatewayCosts } = await import("./billing-metering");
		const legacy = await quarantineLegacyGatewayCosts(db);
		legacySelected = legacy.selected;
		legacyQuarantined = legacy.quarantined;
		console.log(
			`[Scheduled] Legacy billing quarantine: selected=${legacy.selected} quarantined=${legacy.quarantined} remainingAtLeast=${legacy.remainingAtLeast}`,
		);
	} catch (legacyQuarantineError) {
		console.warn(
			"[Scheduled] Legacy billing quarantine failed (non-fatal):",
			legacyQuarantineError instanceof Error
				? legacyQuarantineError.message
				: String(legacyQuarantineError),
		);
	}

	// Runs after the quarantine above so rows it reclassifies roll up fresh.
	const costRollups = await rebuildClosedCostRollups(db);

	let staleSyncsFailed = 0;
	try {
		console.log(`[Scheduled] Starting catalog sync log maintenance (${runId})`);
		const { failStaleAppCatalogSyncLogs } =
			await import("@tedix/db/queries/catalog/sync-logs");
		const syncStartedAt = new Date();
		staleSyncsFailed = await failStaleAppCatalogSyncLogs(
			db,
			new Date(syncStartedAt.getTime() - 6 * 60 * 60 * 1000).toISOString(),
			syncStartedAt.toISOString(),
		);
		if (staleSyncsFailed > 0) {
			console.warn(
				`[Scheduled] Reconciled ${staleSyncsFailed} stale catalog sync log(s)`,
			);
		}
	} catch (syncError) {
		console.warn(`[Scheduled] catalog sync log maintenance failed:`, syncError);
	}
	return {
		legacySelected,
		legacyQuarantined,
		costRollupDaysBuilt: costRollups.built,
		costRollupDaysFailed: costRollups.failed,
		staleSyncsFailed,
	};
}

/** Organization-days rebuilt per run; usage reads raw rows for the rest. */
export const COST_ROLLUP_DAYS_PER_RUN = 200;

/**
 * Build daily cost rollups for closed UTC days that have raw calls but no
 * fresh rollup. Bounded and non-fatal: a failed day stays on raw reads and is
 * retried on the next run. Today is never rolled up.
 */
export async function rebuildClosedCostRollups(
	db: import("@tedix/db/client").DbClient,
	now = new Date(),
): Promise<{ built: number; failed: number }> {
	let built = 0;
	let failed = 0;
	try {
		const { listCostRollupDaysToBuild, rebuildCostRollupDay } =
			await import("@tedix/db/queries/billing/cost-rollups");
		const days = await listCostRollupDaysToBuild(db, COST_ROLLUP_DAYS_PER_RUN, {
			now,
		});
		for (const { organizationId, day } of days) {
			try {
				await rebuildCostRollupDay(db, organizationId, day, { now });
				built++;
			} catch (dayError) {
				failed++;
				console.warn(
					`[Scheduled] Cost rollup ${organizationId}/${day} failed (non-fatal):`,
					dayError instanceof Error ? dayError.message : String(dayError),
				);
			}
		}
		console.log(
			`[Scheduled] Cost rollups: built=${built} failed=${failed} selected=${days.length}`,
		);
	} catch (rollupError) {
		console.warn(
			"[Scheduled] Cost rollup selection failed (non-fatal):",
			rollupError instanceof Error ? rollupError.message : String(rollupError),
		);
	}
	return { built, failed };
}
