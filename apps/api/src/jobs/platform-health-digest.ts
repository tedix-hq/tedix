/// <reference path="../../worker-configuration.d.ts" />
/**
 * 8am UTC platform-health digest tick. The dispatcher keeps the hour === 8 gate.
 */

export async function runPlatformHealthDigestTick(
	env: CloudflareEnv,
	event: ScheduledController,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Running platform-health digest (${runId})`);
	try {
		const { runPlatformHealthDigest } = await import("../lib/health-digest");
		const summary = await runPlatformHealthDigest(env, {
			scheduledTimeMs: event.scheduledTime,
		});
		console.log(
			`[Scheduled] Platform-health digest complete: firing=${summary.conditionCount}, new=${summary.newCount}, escalated=${summary.escalatedCount}, resolved=${summary.resolvedCount}, emailed=${summary.emailed}`,
		);
		return {
			conditions: summary.conditionCount,
			created: summary.newCount,
			escalated: summary.escalatedCount,
			resolved: summary.resolvedCount,
			emailsSent: summary.emailed ? 1 : 0,
		};
	} catch (healthErr) {
		console.error(`[Scheduled] Platform-health digest failed:`, healthErr);
		throw healthErr;
	}
}
