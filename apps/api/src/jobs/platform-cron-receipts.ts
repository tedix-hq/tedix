import { safeExceptionTopology } from "../lib/safe-log-metadata";

const MAX_COUNT_KEYS = 32;

export type PlatformCronAffectedRows = Record<string, number>;

function boundedAffectedRows(
	counts: PlatformCronAffectedRows | undefined,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(counts ?? {})
			.filter(
				([key, value]) =>
					key.length > 0 &&
					key.length <= 80 &&
					Number.isSafeInteger(value) &&
					value >= 0,
			)
			.slice(0, MAX_COUNT_KEYS),
	);
}

/** Track one logical maintenance path within a Cloudflare scheduled fire. */
export async function runPlatformCronPath(
	env: CloudflareEnv,
	event: ScheduledController,
	scheduleId: string,
	run: () => Promise<PlatformCronAffectedRows | void>,
): Promise<void> {
	const startedMs = Date.now();
	const startedAt = new Date(startedMs).toISOString();
	const scheduledAt = new Date(event.scheduledTime).toISOString();
	const id = crypto.randomUUID();
	const { createDbClient } = await import("@tedix/db/client");
	const {
		recordPlatformCronExecutionFinish,
		recordPlatformCronExecutionStart,
	} = await import("@tedix/db/queries/platform-cron-executions");
	const db = createDbClient(env.DB);
	const base = { id, scheduleId, cron: event.cron, scheduledAt, startedAt };

	try {
		const inserted = await recordPlatformCronExecutionStart(db, base);
		if (!inserted) {
			console.log(
				`[Scheduled] ${scheduleId} replay observed for ${scheduledAt}`,
			);
		}
	} catch (receiptStartError) {
		// Evidence must not starve the maintenance path. The terminal write below
		// can still upsert a complete receipt if this transient start write failed.
		console.error(
			JSON.stringify({
				event: "platform.cron.receipt_start_failed",
				scheduleId,
				exception: safeExceptionTopology(receiptStartError),
			}),
		);
	}
	try {
		const counts = await run();
		const finishedMs = Date.now();
		await recordPlatformCronExecutionFinish(db, {
			...base,
			status: "success",
			finishedAt: new Date(finishedMs).toISOString(),
			durationMs: Math.max(0, finishedMs - startedMs),
			affectedRowCounts: boundedAffectedRows(counts ?? undefined),
		});
	} catch (error) {
		const finishedMs = Date.now();
		try {
			await recordPlatformCronExecutionFinish(db, {
				...base,
				status: "failure",
				finishedAt: new Date(finishedMs).toISOString(),
				durationMs: Math.max(0, finishedMs - startedMs),
				affectedRowCounts: {},
				error: JSON.stringify(safeExceptionTopology(error)),
			});
		} catch (receiptFinishError) {
			console.error(
				JSON.stringify({
					event: "platform.cron.receipt_finish_failed",
					scheduleId,
					exception: safeExceptionTopology(receiptFinishError),
				}),
			);
		}
		throw error;
	}
}
