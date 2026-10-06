/** Activity-aware, 15-minute freshness alert for Gateway billing metering. */

import type { DbClient } from "@tedix/db/client";
import {
	getAlertState,
	markAlertsResolved,
	recordAlertState,
} from "@tedix/db/queries/ops-alert-state";
import { sendOpsAlert } from "./ops-alert-egress";

export const BILLING_METERING_DARK_CONDITION_KEY =
	"billing-metering-dark:tedix-llm-production";
export const BILLING_METERING_MAX_LAG_MS = 30 * 60 * 1000;

export interface BillingMeteringFreshnessSnapshot {
	reservationCount30d: number;
	maxReservationAt: string | null;
	maxGatewaySnapshotAt: string | null;
}

export type BillingMeteringFreshnessProbe =
	| { status: "firing"; lagMinutes: number; detail: string }
	| { status: "healthy" }
	| { status: "indeterminate" };

export function classifyBillingMeteringFreshness(
	snapshot: BillingMeteringFreshnessSnapshot,
	nowMs: number,
): BillingMeteringFreshnessProbe {
	if (snapshot.reservationCount30d === 0 || !snapshot.maxReservationAt) {
		return { status: "indeterminate" };
	}
	const reservationMs = Date.parse(snapshot.maxReservationAt);
	if (!Number.isFinite(reservationMs)) return { status: "indeterminate" };
	const gatewayMs = snapshot.maxGatewaySnapshotAt
		? Date.parse(snapshot.maxGatewaySnapshotAt)
		: Number.NaN;
	if (Number.isFinite(gatewayMs) && gatewayMs >= reservationMs) {
		return { status: "healthy" };
	}
	const lagMs = nowMs - reservationMs;
	if (lagMs < BILLING_METERING_MAX_LAG_MS) {
		return { status: "indeterminate" };
	}
	const lagMinutes = Math.floor(lagMs / 60_000);
	return {
		status: "firing",
		lagMinutes,
		detail:
			`Gateway billing metering is stale behind admitted inference: ` +
			`latestReservation=${snapshot.maxReservationAt}; ` +
			`latestGatewayCost=${snapshot.maxGatewaySnapshotAt ?? "none"}; ` +
			`lagMinutes=${lagMinutes}`,
	};
}

export async function reconcileBillingMeteringFreshness(
	db: DbClient,
	env: CloudflareEnv,
	snapshot: BillingMeteringFreshnessSnapshot,
	nowIso: string,
): Promise<"new" | "ongoing" | "resolved" | "unchanged"> {
	const probe = classifyBillingMeteringFreshness(snapshot, Date.parse(nowIso));
	if (probe.status === "indeterminate") return "unchanged";
	const previous = await getAlertState(db, BILLING_METERING_DARK_CONDITION_KEY);
	if (probe.status === "healthy") {
		if (previous?.status !== "open") return "unchanged";
		await markAlertsResolved(db, [BILLING_METERING_DARK_CONDITION_KEY], nowIso);
		await sendOpsAlert(env, {
			subject: "[Tedix Health] resolved · Gateway billing metering",
			text: `RESOLVED: Gateway cost rows caught up with admitted inference at ${nowIso}.`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: {
				conditionKey: BILLING_METERING_DARK_CONDITION_KEY,
				lifecycle: "resolved",
			},
		});
		return "resolved";
	}

	const isNew = previous?.status !== "open";
	await recordAlertState(db, {
		conditionKey: BILLING_METERING_DARK_CONDITION_KEY,
		severity: "P1",
		metricBucket: String(Math.max(1, Math.floor(probe.lagMinutes / 30))),
		detail: probe.detail,
		status: "open",
		firstSeenAt: isNew ? nowIso : previous.firstSeenAt,
		lastSeenAt: nowIso,
		lastNotifiedAt: isNew ? nowIso : previous.lastNotifiedAt,
		notifyCount: isNew ? 1 : previous.notifyCount,
	});
	if (isNew) {
		await sendOpsAlert(env, {
			subject: "[Tedix Health] P1 · Gateway billing metering is stale",
			text: `NEW: ${probe.detail}\n\nInference reservations are advancing while tedi_call_costs is not. Stripe usage may also be delayed.`,
			emailRecipients: env.HEALTH_ALERT_EMAIL,
			webhookUrl: env.HEALTH_ALERT_WEBHOOK,
			meta: {
				conditionKey: BILLING_METERING_DARK_CONDITION_KEY,
				lifecycle: "new",
				lagMinutes: probe.lagMinutes,
			},
		});
	}
	console.warn(
		JSON.stringify({
			signal: "platform.health.finding",
			conditionKey: BILLING_METERING_DARK_CONDITION_KEY,
			lifecycle: isNew ? "new" : "ongoing",
			lagMinutes: probe.lagMinutes,
			asOf: nowIso,
		}),
	);
	return isNew ? "new" : "ongoing";
}
