import type { PlatformCronExecutionFinish } from "@tedix/db/queries/platform-cron-executions";
import { isTransientD1ReadError } from "@tedix/db/utils/d1-retry";
import { sleep } from "@tedix/worker-kit/sleep";
import {
	safeExceptionTopology,
	safeErrorClassification,
} from "../lib/safe-log-metadata";

const MAX_COUNT_KEYS = 32;
const RECEIPT_FINISH_BACKOFF_MS = [500, 1000, 2000];

export type PlatformCronAffectedRows = Record<string, number>;

export class PlatformCronPathError extends AggregateError {
	constructor(
		errors: unknown[],
		message: string,
		readonly counts: PlatformCronAffectedRows,
	) {
		super(errors, message, { cause: errors[0] });
	}
}

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

	// The upsert only updates running receipts, so retrying the same stamp is safe.
	async function writeFinish(
		stamp: PlatformCronExecutionFinish,
	): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			try {
				await recordPlatformCronExecutionFinish(db, stamp);
				return;
			} catch (error) {
				const delayMs = RECEIPT_FINISH_BACKOFF_MS[attempt];
				if (delayMs !== undefined && isTransientD1ReadError(error)) {
					await sleep(delayMs);
					continue;
				}
				console.error(
					JSON.stringify({
						event: "platform.cron.receipt_finish_failed",
						scheduleId,
						exception: safeExceptionTopology(error),
					}),
				);
				throw error;
			}
		}
	}

	let counts: PlatformCronAffectedRows | void;
	try {
		counts = await run();
	} catch (error) {
		const finishedMs = Date.now();
		const diagnostic = {
			...safeExceptionTopology(error),
			...safeErrorClassification(error),
			...(error instanceof AggregateError && {
				failures: error.errors.slice(0, 8).map((failure: unknown) => ({
					...safeExceptionTopology(failure),
					...safeErrorClassification(failure),
				})),
			}),
		};
		console.error(
			JSON.stringify({
				event: "platform.cron.path_failed",
				scheduleId,
				executionId: id,
				...diagnostic,
			}),
		);
		await writeFinish({
			...base,
			status: "failure",
			finishedAt: new Date(finishedMs).toISOString(),
			durationMs: Math.max(0, finishedMs - startedMs),
			affectedRowCounts: boundedAffectedRows(
				error instanceof PlatformCronPathError ? error.counts : undefined,
			),
			error: JSON.stringify(diagnostic),
		}).catch(() => {
			// writeFinish logged the receipt error. Propagate the job error.
		});
		throw error;
	}

	const finishedMs = Date.now();
	await writeFinish({
		...base,
		status: "success",
		finishedAt: new Date(finishedMs).toISOString(),
		durationMs: Math.max(0, finishedMs - startedMs),
		affectedRowCounts: boundedAffectedRows(counts ?? undefined),
	});
}
