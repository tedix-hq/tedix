/// <reference path="../../worker-configuration.d.ts" />
/**
 * D1 retention tick, every 15 minutes. Policy rows in `d1_retention_policies` decide
 * what runs; with no active row this reads one small table and returns.
 * Archives go to the private tedi bucket under `d1-archive/v1/`; the
 * `move_to_logs_db` mode also needs the optional `LOGS_DB` binding.
 *
 * The same tick measures both databases and raises the size alert
 * (`lib/d1-size-health.ts`), so the alert runs exactly as often as the job
 * that can relieve it.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { createDbClient } from "@tedix/db/client";
import { readD1SizeBytes } from "@tedix/db/queries/d1-size";
import { pruneExpiredOfficeSnapshots } from "@tedix/db/queries/office-activity";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	type D1SizeAlertEnv,
	type D1SizeProbe,
	reconcileD1SizeAlert,
} from "../lib/d1-size-health";
import { runD1Retention } from "../services/d1-retention-archive";

/** The logs database binding is optional; its presence is the only switch. */
export function logsDatabase(env: object): D1Database | undefined {
	return (env as { LOGS_DB?: D1Database }).LOGS_DB;
}

export async function runD1RetentionTick(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	const logs = logsDatabase(env);
	const now = new Date(event.scheduledTime);
	const totals = {
		archivedRows: 0,
		movedRows: 0,
		conflictedRows: 0,
		deletedRows: 0,
	};
	let result: Awaited<ReturnType<typeof runD1Retention>>;
	// Temporary catch-up (Work 539ccae7): repeat the same run while a table
	// still stops on its row cap or time share, until 12.5 minutes after the
	// scheduled time, so the tick ends before the next one starts. Remove once
	// the MCP telemetry audit backlog is gone.
	for (;;) {
		const remainingMs =
			event.scheduledTime + D1_RETENTION_CATCH_UP_MS - Date.now();
		result = await runD1Retention({
			db: createDbQueryClient(env.DB),
			logsDb: logs ? createDbQueryClient(logs) : undefined,
			bucket: env.TEDI_R2_BUCKET,
			now,
			timeBudgetMs: Math.max(
				0,
				Math.min(D1_RETENTION_RUN_BUDGET_MS, remainingMs),
			),
		});
		logRetentionRun(result);
		totals.archivedRows += result.archivedRows;
		totals.movedRows += result.movedRows;
		totals.conflictedRows += result.conflictedRows;
		totals.deletedRows += result.deletedRows;
		const unfinished = result.tables.some(
			(table) =>
				table.stoppedBy === "row_cap" ||
				(table.stoppedBy === "time_budget" && table.deletedRows > 0),
		);
		const failed = result.tables.some((table) => table.stoppedBy === "error");
		if (
			!unfinished ||
			failed ||
			result.deletedRows === 0 ||
			event.scheduledTime + D1_RETENTION_CATCH_UP_MS - Date.now() < 60_000
		)
			break;
	}
	const sizes = await runD1SizeCheck(env, now.toISOString());
	const officeDeleted = await pruneExpiredOfficeSnapshots(
		createDbQueryClient(env.DB),
		now.toISOString(),
	);
	return {
		officeExpiredSnapshotsDeleted: officeDeleted,
		d1RetentionArchivedRows: totals.archivedRows,
		d1RetentionMovedRows: totals.movedRows,
		d1RetentionConflictedRows: totals.conflictedRows,
		d1RetentionDeletedRows: totals.deletedRows,
		d1RetentionIdleTables: result.tables.filter(
			(table) => table.eligibleRows === 0 && table.timings.pages === 0,
		).length,
		...(result.eligibleBytes === null
			? {}
			: {
					d1RetentionEligibleMb: Math.round(result.eligibleBytes / 1e6),
				}),
		d1RetentionBacklogUnknownTables: result.tables.filter(
			(table) => table.eligibleRows === null,
		).length,
		...sizes,
	};
}

/** Temporary catch-up window per tick (Work 539ccae7); see runD1RetentionTick. */
const D1_RETENTION_CATCH_UP_MS = 12.5 * 60_000;
/** Budget of one run inside the catch-up window. */
const D1_RETENTION_RUN_BUDGET_MS = 300_000;

function logRetentionRun(
	result: Awaited<ReturnType<typeof runD1Retention>>,
): void {
	if (result.tables.length > 0) {
		console.log(
			JSON.stringify({
				event: "d1.retention.run",
				tables: result.tables.map((table) => ({
					table: table.tableName,
					mode: table.mode,
					problem: table.problem,
					eligibleRows: table.eligibleRows,
					eligibleMb:
						table.eligibleBytes === null
							? null
							: Math.round(table.eligibleBytes / 1e6),
					archivedRows: table.archivedRows,
					movedRows: table.movedRows,
					conflictedRows: table.conflictedRows,
					deletedRows: table.deletedRows,
					stoppedBy: table.stoppedBy,
					error: table.error ?? null,
					timings: table.timings,
				})),
			}),
		);
	}
}

/** Measure main and logs D1, reconcile the size alerts, report megabytes. */
export async function runD1SizeCheck(
	env: Pick<CloudflareEnv, "DB"> & D1SizeAlertEnv,
	nowIso: string,
): Promise<Record<string, number>> {
	const logs = logsDatabase(env);
	const probes: D1SizeProbe[] = [
		{
			store: "main",
			bytes: await readD1SizeBytes(createDbQueryClient(env.DB)),
		},
		...(logs
			? [
					{
						store: "logs" as const,
						bytes: await readD1SizeBytes(createDbQueryClient(logs)),
					},
				]
			: []),
	];
	const db = createDbClient(env.DB);
	const numbers: Record<string, number> = {};
	for (const probe of probes) {
		const prefix = `d1${probe.store === "main" ? "Main" : "Logs"}`;
		if (probe.bytes !== null)
			numbers[`${prefix}SizeMb`] = Math.round(probe.bytes / 1e6);
		try {
			const { delivery } = await reconcileD1SizeAlert(db, env, probe, nowIso);
			// Receipt of a page: proves which channel delivered it.
			if (delivery) {
				numbers[`${prefix}AlertEmailed`] = delivery.emailed ? 1 : 0;
				numbers[`${prefix}AlertWebhookPosted`] = delivery.webhookPosted ? 1 : 0;
			}
		} catch (error) {
			console.error(
				JSON.stringify({
					signal: "d1.size.alert_failed",
					store: probe.store,
					exception: safeExceptionTopology(error),
				}),
			);
		}
	}
	return numbers;
}
