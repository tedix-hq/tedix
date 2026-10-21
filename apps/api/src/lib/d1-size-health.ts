/**
 * D1 size alert. Every hourly retention tick measures the main database and,
 * when bound, the logs database, and pages the ops channel when either is
 * near its ceiling:
 *
 * - main `DB` at or above 9 GB: the 10 GB cap is days away at current growth.
 * - `LOGS_DB` at or above 6 GB: the rotation trigger. Ops creates the next
 *   logs database and rebinds before this one reaches its cap.
 *
 * The size comes from D1's own `meta.size_after` on a trivial statement
 * (`@tedix/db/queries/d1-size`); no table is scanned. Paging follows the ops-alert-state pattern: one row per
 * condition, a page on NEW and on RESOLVED, silence while an open condition
 * is unchanged, and a re-page only when the size crosses the next 0.25 GB.
 */

import type { DbClient } from "@tedix/db/client";
import {
	getAlertState,
	markAlertsResolved,
	recordAlertState,
} from "@tedix/db/queries/ops-alert-state";
import { sendOpsAlert } from "./ops-alert-egress";

const GB = 1_000_000_000;
export const MAIN_D1_ALERT_BYTES = 9 * GB;
export const LOGS_D1_ALERT_BYTES = 6 * GB;

export const D1_SIZE_CONDITION_KEYS = {
	main: "d1-size:main",
	logs: "d1-size:logs",
} as const;

/** The egress needs the email binding plus the two alert vars. */
export type D1SizeAlertEnv = Partial<Pick<CloudflareEnv, "EMAIL">> &
	Pick<CloudflareEnv, "HEALTH_ALERT_EMAIL" | "HEALTH_ALERT_WEBHOOK">;

export interface D1SizeProbe {
	store: "main" | "logs";
	bytes: number | null;
}

export function d1SizeThreshold(store: D1SizeProbe["store"]): number {
	return store === "main" ? MAIN_D1_ALERT_BYTES : LOGS_D1_ALERT_BYTES;
}

export function describeD1Size(probe: D1SizeProbe): string {
	const gb = probe.bytes === null ? "unknown" : (probe.bytes / GB).toFixed(2);
	const limit = (d1SizeThreshold(probe.store) / GB).toFixed(0);
	return probe.store === "main"
		? `Main D1 is ${gb} GB (alert at ${limit} GB, hard cap 10 GB). Move or archive log tables before it fills.`
		: `Logs D1 is ${gb} GB (rotation trigger ${limit} GB, hard cap 10 GB). Create the next logs database and rebind LOGS_DB.`;
}

/**
 * Reconcile one store's size against its alert state. Returns what happened
 * so the cron receipt can carry it. A probe that returned no size leaves the
 * state untouched.
 */
export async function reconcileD1SizeAlert(
	db: DbClient,
	env: D1SizeAlertEnv,
	probe: D1SizeProbe,
	nowIso: string,
): Promise<"new" | "escalated" | "ongoing" | "resolved" | "unchanged"> {
	if (probe.bytes === null) return "unchanged";
	const key = D1_SIZE_CONDITION_KEYS[probe.store];
	const previous = await getAlertState(db, key);
	const firing = probe.bytes >= d1SizeThreshold(probe.store);
	if (!firing) {
		if (previous?.status !== "open") return "unchanged";
		await markAlertsResolved(db, [key], nowIso);
		await sendOpsAlert(env, {
			subject: `[Tedix Health] resolved · ${probe.store === "main" ? "Main" : "Logs"} D1 size`,
			text: `RESOLVED: ${describeD1Size(probe)}`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: { conditionKey: key, lifecycle: "resolved", bytes: probe.bytes },
		});
		return "resolved";
	}
	// Re-page only when the size crosses the next quarter gigabyte.
	const bucket = String(Math.floor(probe.bytes / (GB / 4)));
	const isNew = previous?.status !== "open";
	const escalated = !isNew && bucket > previous.metricBucket;
	const detail = describeD1Size(probe);
	await recordAlertState(db, {
		conditionKey: key,
		severity: "P1",
		metricBucket: bucket,
		detail,
		status: "open",
		firstSeenAt: isNew ? nowIso : previous.firstSeenAt,
		lastSeenAt: nowIso,
		lastNotifiedAt: isNew || escalated ? nowIso : previous.lastNotifiedAt,
		notifyCount: isNew ? 1 : previous.notifyCount + (escalated ? 1 : 0),
	});
	const lifecycle = isNew ? "new" : escalated ? "escalated" : "ongoing";
	if (lifecycle !== "ongoing") {
		await sendOpsAlert(env, {
			subject: `[Tedix Health] P1 · ${probe.store === "main" ? "Main" : "Logs"} D1 is near its size cap`,
			text: `${lifecycle.toUpperCase()}: ${detail}`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: { conditionKey: key, lifecycle, bytes: probe.bytes },
		});
	}
	console.warn(
		JSON.stringify({
			signal: "platform.health.finding",
			conditionKey: key,
			lifecycle,
			bytes: probe.bytes,
			asOf: nowIso,
		}),
	);
	return lifecycle;
}
