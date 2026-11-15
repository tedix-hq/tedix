/**
 * Daily silent-failure heartbeat for decision capture.
 *
 * For every user with capture on (a captured turn in the last
 * {@link ACTIVE_DAYS} days), count captured turns, tedi drafts and lesson
 * deliveries over the last 24 h. When no turn was captured although the user
 * had agent sessions (lessons were delivered to one) or the window was a
 * weekday, ask a verified source agent to check its local setup first. If none
 * is available, explain the machine access needed in the user's inbox. Reuse
 * an unexpired open health item regardless of its recipient.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { createDbClient } from "@tedix/db/client";
import {
	CAPTURE_HEALTH_SCHEMA,
	type CaptureHealthRow,
	getCaptureHealthAgent,
	listCaptureHealth,
} from "@tedix/db/queries/work-items/capture-health";
import { createWorkInteraction } from "@tedix/db/queries/work-items/interactions";

const DAY_MS = 86_400_000;
const ACTIVE_DAYS = 14;
/** The item expires before the next run can raise a fresh one. */
const ALERT_TTL_MS = 36 * 3_600_000;

export const CAPTURE_HEALTH_SUBJECT =
	"Tedix captured nothing in 24 h — capture may be broken; run tedix setup agents context show";

/** A weekday window: the 24 h before `now` started Monday to Friday (UTC). */
function windowIsWeekday(now: number): boolean {
	const day = new Date(now - DAY_MS).getUTCDay();
	return day >= 1 && day <= 5;
}

export function captureLooksBroken(
	row: Pick<CaptureHealthRow, "turns" | "lessons">,
	now: number,
): boolean {
	return row.turns === 0 && (row.lessons > 0 || windowIsWeekday(now));
}

export async function runCaptureHealthHeartbeat(
	env: Pick<CloudflareEnv, "DB">,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB);
	const now = new Date(scheduledTime).toISOString();
	const rows = await listCaptureHealth(db, {
		since: new Date(scheduledTime - DAY_MS).toISOString(),
		activeSince: new Date(scheduledTime - ACTIVE_DAYS * DAY_MS).toISOString(),
		now,
	});
	let alerted = 0;
	let failed = 0;
	for (const row of rows) {
		if (row.alertOpen || !captureLooksBroken(row, scheduledTime)) continue;
		const counts = `${row.turns} turns · ${row.drafts} drafts · ${row.lessons} lessons in the last 24 h`;
		try {
			const agent = await getCaptureHealthAgent(db, {
				orgId: row.orgId,
				userId: row.userId,
				activeSince: new Date(
					scheduledTime - ACTIVE_DAYS * DAY_MS,
				).toISOString(),
			});
			const reason = agent
				? "The agent can run the local diagnostic. Ask the person only if it proves sign-in, consent, or machine access is required."
				: "No verified active agent session is available for this capture setup. Open an agent on the machine where capture is enabled and ask it to run the diagnostic; complete sign-in or consent yourself if required.";
			await createWorkInteraction(db, {
				id: crypto.randomUUID(),
				orgId: row.orgId,
				workItemId: row.workItemId,
				caseId: row.caseId,
				projectId: row.projectId,
				kind: "coordination",
				subject: CAPTURE_HEALTH_SUBJECT,
				prompt: `${CAPTURE_HEALTH_SUBJECT}\n\n${counts}. Decision capture has been on for you, but no agent turn reached Tedix. Run \`tedix setup agents context show\` on the machine where capture is enabled to check the hooks and login. ${reason}`,
				creator: { type: "system", id: "tedix" },
				targetType: agent ? "external_agent" : "user",
				targetId: agent?.id ?? row.userId,
				expiresAt: new Date(scheduledTime + ALERT_TTL_MS).toISOString(),
				metadata: {
					schema: CAPTURE_HEALTH_SCHEMA,
					captureUserId: row.userId,
					...(agent ? { sessionId: agent.sessionId } : {}),
					reason,
					triage: { status: "ok", urgency: "now" },
					counts: {
						turns: row.turns,
						drafts: row.drafts,
						lessons: row.lessons,
					},
				},
				now,
			});
			alerted++;
		} catch (error) {
			failed++;
			console.warn(
				JSON.stringify({
					event: "capture_health.alert_failed",
					orgId: row.orgId,
					exception: safeExceptionTopology(error),
				}),
			);
		}
	}
	if (failed > 0)
		throw new Error(`Capture-health items failed for ${failed} users`);
	return { users: rows.length, alerted };
}
