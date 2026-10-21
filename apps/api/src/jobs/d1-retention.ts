/// <reference path="../../worker-configuration.d.ts" />
/**
 * Hourly D1 retention tick. Policy rows in `d1_retention_policies` decide
 * what runs; with no active row this reads one small table and returns.
 * Archives go to the private tedi bucket under `d1-archive/v1/`.
 */

export async function runD1RetentionTick(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	const { createDbQueryClient } = await import("@tedix/db/query-client");
	const { runD1Retention } = await import("../services/d1-retention-archive");
	const result = await runD1Retention({
		db: createDbQueryClient(env.DB),
		bucket: env.TEDI_R2_BUCKET,
		now: new Date(event.scheduledTime),
	});
	if (result.tables.length > 0) {
		console.log(
			JSON.stringify({
				event: "d1.retention.run",
				tables: result.tables.map((table) => ({
					table: table.tableName,
					mode: table.mode,
					problem: table.problem,
					eligibleRows: table.eligibleRows,
					eligibleMb: Math.round(table.eligibleBytes / 1e6),
					archivedRows: table.archivedRows,
					deletedRows: table.deletedRows,
					stoppedBy: table.stoppedBy,
					error: table.error ?? null,
				})),
			}),
		);
	}
	return {
		d1RetentionArchivedRows: result.archivedRows,
		d1RetentionDeletedRows: result.deletedRows,
		d1RetentionEligibleMb: Math.round(result.eligibleBytes / 1e6),
	};
}
