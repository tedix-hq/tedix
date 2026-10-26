/**
 * Dispatcher health alarm, no AI. Every platform tick, per organization whose
 * active policy pack enables the request tracker (kernelRequestCoordinator):
 * when dispatchable Work waits and the last Work Attempt admission OR the last
 * request-tracker action is older than the threshold (never seen counts as
 * older), put ONE "For you" item in the org owner's inbox. The item stays open
 * while the condition persists (no repeat) and is cancelled on recovery.
 *
 * Both ages are also written to this path's cron receipt, so the platform cron
 * health read shows them without a second source.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { createDbClient } from "@tedix/db/client";
import {
	DISPATCHER_HEALTH_SCHEMA,
	listDispatcherHealthOrgs,
	readDispatcherActivity,
	type DispatcherHealthOrgRow,
} from "@tedix/db/queries/work-items/dispatcher-health";
import {
	cancelWorkInteraction,
	createWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";

/** Platform default; an organization overrides it in `metadata.dispatcherHealth`. */
export const DEFAULT_DISPATCHER_STALE_AFTER_MINUTES = 45;

export const DISPATCHER_HEALTH_SUBJECT =
	"Work is waiting but the dispatcher has gone quiet";

function ageMinutes(at: string | null, nowMs: number): number {
	const ms = at ? Date.parse(at) : Number.NaN;
	return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : (nowMs - ms) / 60_000;
}

function ageSeconds(at: string | null, nowMs: number): number | null {
	const ms = at ? Date.parse(at) : Number.NaN;
	return Number.isNaN(ms) ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
}

export function dispatcherLooksStalled(
	row: DispatcherHealthOrgRow,
	nowMs: number,
): boolean {
	// Without the request tracker there is no dispatcher to stall, and a
	// tracker action could never arrive to clear the item.
	if (!row.trackerEnabled || !row.alarmEnabled || row.dispatchableCount === 0)
		return false;
	const limit = row.staleAfterMinutes ?? DEFAULT_DISPATCHER_STALE_AFTER_MINUTES;
	return (
		ageMinutes(row.lastAdmissionAt, nowMs) > limit ||
		ageMinutes(row.lastTrackerActionAt, nowMs) > limit
	);
}

/**
 * The owner already answered an item raised during this stall. The stall began
 * at the older of the two last signals (never seen = always), so an answer
 * keeps the alarm quiet until a signal moves; recovery clears it for the next.
 */
function ownerAnsweredThisStall(row: DispatcherHealthOrgRow): boolean {
	if (!row.answeredAlertAt) return false;
	const stallStart =
		row.lastAdmissionAt && row.lastTrackerActionAt
			? row.lastAdmissionAt < row.lastTrackerActionAt
				? row.lastAdmissionAt
				: row.lastTrackerActionAt
			: "";
	return row.answeredAlertAt >= stallStart;
}

export async function runDispatcherHealthAlarm(
	env: Pick<CloudflareEnv, "DB">,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB);
	const now = new Date(scheduledTime).toISOString();
	const [rows, activity] = await Promise.all([
		listDispatcherHealthOrgs(db),
		readDispatcherActivity(db),
	]);
	let raised = 0;
	let cleared = 0;
	let failed = 0;
	for (const row of rows) {
		const stalled = dispatcherLooksStalled(row, scheduledTime);
		try {
			if (
				stalled &&
				!row.openAlertId &&
				!ownerAnsweredThisStall(row) &&
				row.ownerUserId &&
				row.workItemId
			) {
				const limit =
					row.staleAfterMinutes ?? DEFAULT_DISPATCHER_STALE_AFTER_MINUTES;
				await createWorkInteraction(db, {
					id: crypto.randomUUID(),
					orgId: row.orgId,
					workItemId: row.workItemId,
					kind: "coordination",
					subject: DISPATCHER_HEALTH_SUBJECT,
					prompt: `${DISPATCHER_HEALTH_SUBJECT}\n\n${row.dispatchableCount} dispatchable Work item(s) wait. The last Work Attempt admission was ${row.lastAdmissionAt ?? "never seen"} and the last request-tracker action was ${row.lastTrackerActionAt ?? "never seen"}; either is older than ${limit} minutes. Check that the dispatcher (lane serve) is running and admitting. This item closes by itself once both recover.`,
					creator: { type: "user", id: row.ownerUserId },
					targetType: "user",
					targetId: row.ownerUserId,
					metadata: {
						schema: DISPATCHER_HEALTH_SCHEMA,
						triage: { status: "ok", urgency: "now" },
						dispatchableCount: row.dispatchableCount,
						staleAfterMinutes: limit,
					},
					now,
				});
				raised++;
			} else if (!stalled && row.openAlertId && row.openAlertCreatorId) {
				await cancelWorkInteraction(db, {
					orgId: row.orgId,
					interactionId: row.openAlertId,
					expectedVersion: row.openAlertVersion ?? 1,
					actor: { type: "user", id: row.openAlertCreatorId },
					now,
				});
				cleared++;
			}
		} catch (error) {
			failed++;
			console.warn(
				JSON.stringify({
					event: "dispatcher_health.alarm_failed",
					orgId: row.orgId,
					exception: safeExceptionTopology(error),
				}),
			);
		}
	}
	if (failed > 0)
		throw new Error(`Dispatcher-health alarm failed for ${failed} orgs`);
	const admissionAge = ageSeconds(activity.lastAdmissionAt, scheduledTime);
	const trackerAge = ageSeconds(activity.lastTrackerActionAt, scheduledTime);
	return {
		orgsWithWork: rows.filter((r) => r.dispatchableCount > 0).length,
		raised,
		cleared,
		...(admissionAge === null ? {} : { admissionAgeSeconds: admissionAge }),
		...(trackerAge === null ? {} : { trackerAgeSeconds: trackerAge }),
	};
}
