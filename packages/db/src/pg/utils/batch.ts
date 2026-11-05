/**
 * Batch helpers
 *
 * Drizzle's D1 batch API requires a non-empty tuple. Most callers build the
 * queries with Array.map after checking length, so this helper keeps the single
 * unavoidable tuple assertion in one place.
 */
export function batchNonEmpty<T>(items: T[]): [T, ...T[]] {
	if (items.length === 0) {
		throw new Error("Cannot batch an empty query list");
	}
	return items as [T, ...T[]];
}

/**
 * Split `items` into `size`-length slices. D1 caps bound parameters at 100 per
 * statement (not SQLite's default 999), so IN() id lists and multi-row VALUES
 * writes must be issued in chunks that keep each statement under the budget —
 * the caller picks `size` from its own per-statement parameter arithmetic.
 */
export function chunkForBoundParams<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
