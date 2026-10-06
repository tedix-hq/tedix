/**
 * Run one already-bounded MCP scan batch concurrently.
 *
 * The workflow owns the batch-size limit. Keeping concurrency at this leaf
 * prevents a slow endpoint from serially delaying the other endpoints in the
 * same batch while preserving sequential workflow batches.
 */
export async function runMcpScanBatchConcurrently<T>(
	items: readonly T[],
	process: (item: T) => Promise<void>,
): Promise<void> {
	await Promise.all(items.map((item) => process(item)));
}

export function summarizeMcpScanThroughput(input: {
	batchConcurrency: number;
	batchDurationsMs: readonly number[];
	checked: number;
	dueNow: number;
}) {
	const scanDurationMs = input.batchDurationsMs.reduce(
		(total, duration) => total + duration,
		0,
	);
	const scansPerMinute =
		scanDurationMs > 0
			? Math.round((input.checked / (scanDurationMs / 60_000)) * 100) / 100
			: 0;

	return {
		batchConcurrency: input.batchConcurrency,
		scanDurationMs,
		scansPerMinute,
		estimatedMinutesToClear:
			scansPerMinute > 0 ? Math.ceil(input.dueNow / scansPerMinute) : null,
	};
}
