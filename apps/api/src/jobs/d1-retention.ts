/// <reference path="../../worker-configuration.d.ts" />
/**
 * D1 retention tick, four times an hour, with daily maintenance at 03:27 UTC.
 * Policy rows in `d1_retention_policies` decide
 * the table archives; session bodies are backfilled and reflections archived after 14 days.
 * Archives go to the private tedi bucket under `d1-archive/v1/`; the
 * `move_to_logs_db` mode also needs the optional `LOGS_DB` binding.
 *
 * The same tick measures both databases and raises the size alert
 * (`lib/d1-size-health.ts`), so the alert runs exactly as often as the job
 * that can relieve it.
 *
 * With `CORE_STORE=postgres` the shared tables are not in D1, so the table
 * archives and the main size probe are skipped; body retention, snapshot
 * pruning, the logs database size check and daily maintenance still run.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";

import { coreDb, coreQueryDb, isD1CoreStore } from "@tedix/db/core-store/scope";
import { readD1SizeBytes } from "@tedix/db/queries/d1-size";
import { pruneExpiredOfficeSnapshots } from "@tedix/db/queries/office-activity";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	type D1SizeAlertEnv,
	type D1SizeProbe,
	reconcileD1SizeAlert,
} from "../lib/d1-size-health";
import { runD1Retention } from "../services/d1-retention-archive";
import { retainGadgetExecutionBodies } from "../services/os-gadget-execution-body-store";
import {
	agentSessionEventBodies,
	retainAgentSessionEventBodies,
} from "../services/agent-session-event-bodies";

/** The logs database binding is optional; its presence is the only switch. */
export function logsDatabase(env: object): D1Database | undefined {
	return (env as { LOGS_DB?: D1Database }).LOGS_DB;
}

export async function runD1RetentionTick(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	const { PlatformCronPathError } = await import("./platform-cron-receipts");
	const counts: Record<string, number> = {};
	const errors: unknown[] = [];
	try {
		Object.assign(counts, await runD1RetentionArchives(env, event));
	} catch (error) {
		counts.d1RetentionFailed = 1;
		errors.push(error);
	}
	// Keep daily sweeps on one retention fire, clear of the quarter-hour billing tick.
	const at = new Date(event.scheduledTime);
	if (at.getUTCHours() === 3 && at.getUTCMinutes() === 27) {
		try {
			const { runRetentionMaintenance } =
				await import("./retention-maintenance");
			Object.assign(
				counts,
				await runRetentionMaintenance(
					env,
					event,
					`cron-${event.scheduledTime}`,
				),
			);
		} catch (error) {
			counts.dailyRetentionFailed = 1;
			errors.push(error);
		}
	}
	if (errors.length)
		throw new PlatformCronPathError(errors, "D1 retention failed", counts);
	return counts;
}

async function runD1RetentionArchives(
	env: CloudflareEnv,
	event: ScheduledController,
): Promise<Record<string, number>> {
	const logs = logsDatabase(env);
	const now = new Date(event.scheduledTime);
	const gadgetBodies = await retainGadgetExecutionBodies(
		coreQueryDb(env),
		env.R2_BUCKET,
		now,
	);
	const d1 = isD1CoreStore(env);
	if (!d1)
		console.log(
			JSON.stringify({
				event: "d1.retention.skipped",
				reason: "core_store_postgres",
			}),
		);
	const result = d1
		? await runD1Retention({
				db: coreQueryDb(env),
				logsDb: logs ? createDbQueryClient(logs) : undefined,
				bucket: env.TEDI_R2_BUCKET,
				now,
			})
		: null;
	if (result && result.tables.length > 0) {
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
					skippedRows: table.skippedRows,
					stoppedBy: table.stoppedBy,
					error: table.error ?? null,
					timings: table.timings,
				})),
			}),
		);
	}
	let sessionBodyRetention: Record<string, number> = {};
	try {
		const bodies = await retainAgentSessionEventBodies(
			coreQueryDb(env),
			agentSessionEventBodies(env.TEDI_R2_BUCKET),
			now,
		);
		sessionBodyRetention = {
			agentSessionBodiesMoved: bodies.moved,
			agentSessionBodyBytesMoved: bodies.inlineBytesMoved,
		};
	} catch (error) {
		// Body storage failure must not suppress the D1 size alerts below.
		sessionBodyRetention = { agentSessionBodyRetentionFailed: 1 };
		console.error({
			event: "agent_session_events.retention_failed",
			exception: safeExceptionTopology(error),
		});
	}
	const sizes = await runD1SizeCheck(env, now.toISOString());
	const officeDeleted = await pruneExpiredOfficeSnapshots(
		coreQueryDb(env),
		now.toISOString(),
	);
	return {
		officeExpiredSnapshotsDeleted: officeDeleted,
		...gadgetBodies,
		...sessionBodyRetention,
		...(result ? d1RetentionCounts(result) : { d1RetentionSkipped: 1 }),
		...sizes,
	};
}

function d1RetentionCounts(
	result: Awaited<ReturnType<typeof runD1Retention>>,
): Record<string, number> {
	return {
		d1RetentionArchivedRows: result.archivedRows,
		d1RetentionMovedRows: result.movedRows,
		d1RetentionConflictedRows: result.conflictedRows,
		d1RetentionDeletedRows: result.deletedRows,
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
	};
}

/** Measure main and logs D1, reconcile the size alerts, report megabytes. */
export async function runD1SizeCheck(
	env: Pick<CloudflareEnv, "DB" | "CORE_STORE"> & D1SizeAlertEnv,
	nowIso: string,
): Promise<Record<string, number>> {
	const logs = logsDatabase(env);
	const probes: D1SizeProbe[] = [
		...(isD1CoreStore(env)
			? [
					{
						store: "main" as const,
						bytes: await readD1SizeBytes(coreQueryDb(env)),
					},
				]
			: []),
		...(logs
			? [
					{
						store: "logs" as const,
						bytes: await readD1SizeBytes(createDbQueryClient(logs)),
					},
				]
			: []),
	];
	const db = coreDb(env);
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
