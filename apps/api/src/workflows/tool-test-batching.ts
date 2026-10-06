/**
 * Keep each durable step comfortably below the Workers CPU ceiling. Live
 * production batches of ten tools regularly consumed 7-9 seconds and one
 * batch exhausted CPU before completing, so use smaller independently
 * retryable units.
 */
export const TOOL_TEST_BATCH_SIZE = 5;

export interface ToolTestTarget {
	catalogAppId: string;
	toolName: string;
}

export interface ToolTestTargetGroup {
	catalogAppId: string;
	toolNames: string[];
}

/**
 * Deduplicate explicit targets and group them by app so the Workflow can load
 * the exact requested tools without falling back to the global test backlog.
 */
export function groupToolTestTargets(
	targets: ToolTestTarget[],
): ToolTestTargetGroup[] {
	const grouped = new Map<string, Set<string>>();

	for (const target of targets) {
		const names = grouped.get(target.catalogAppId) ?? new Set<string>();
		names.add(target.toolName);
		grouped.set(target.catalogAppId, names);
	}

	return Array.from(grouped, ([catalogAppId, toolNames]) => ({
		catalogAppId,
		toolNames: Array.from(toolNames),
	}));
}

export function splitToolTestsIntoBatches<T>(
	items: T[],
	batchSize = TOOL_TEST_BATCH_SIZE,
): T[][] {
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new RangeError("batchSize must be a positive integer");
	}

	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += batchSize) {
		batches.push(items.slice(i, i + batchSize));
	}
	return batches;
}
