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
	const result = await runD1Retention({
		db: createDbQueryClient(env.DB),
		logsDb: logs ? createDbQueryClient(logs) : undefined,
		bucket: env.TEDI_R2_BUCKET,
		now,
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
					movedRows: table.movedRows,
					deletedRows: table.deletedRows,
					stoppedBy: table.stoppedBy,
					error: table.error ?? null,
					timings: table.timings,
				})),
			}),
		);
	}
	const sizes = await runD1SizeCheck(env, now.toISOString());
	return {
		d1RetentionArchivedRows: result.archivedRows,
		d1RetentionMovedRows: result.movedRows,
		d1RetentionDeletedRows: result.deletedRows,
		d1RetentionEligibleMb: Math.round(result.eligibleBytes / 1e6),
		...sizes,
	};
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
		if (probe.bytes !== null)
			numbers[`d1${probe.store === "main" ? "Main" : "Logs"}SizeMb`] =
				Math.round(probe.bytes / 1e6);
		try {
			await reconcileD1SizeAlert(db, env, probe, nowIso);
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
