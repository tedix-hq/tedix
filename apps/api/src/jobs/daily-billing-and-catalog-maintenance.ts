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
		staleSyncsFailed,
	};
}
