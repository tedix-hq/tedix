/**
 * Merge helpers for readers that span the main database and the logs
 * database (`client.ts` `getLogStores`).
 *
 * Rules every merged reader follows:
 * - Run the SAME statement against each store, with the same filters and the
 *   same cursor, so each store applies tenant scope and the cursor itself.
 * - Never apply OFFSET per store: each store returns `limit + offset` rows and
 *   the offset is applied to the merged, ordered set.
 * - Dedupe by `id`. During a move a row can exist in both stores for a moment
 *   (copied to the logs store, not yet removed from the main one); the main
 *   store's copy wins because it is listed first.
 */

import { getLogStores, type LogStores } from "../client";
import { readLogPartition } from "../queries/log-partitions";

export interface LogTimeRange {
	from?: string;
	to?: string;
}

/**
 * Run `read` against main and overlapping partitions; null when the client has no
 * logs store, so the caller falls through to its single-store statement.
 */
export async function readLogStores<T>(
	db: object,
	read: (store: LogStores["main"]) => Promise<T>,
	range: LogTimeRange = {},
): Promise<T[] | null> {
	const stores = getLogStores(db);
	if (!stores) return null;
	const partitions = await Promise.all(
		stores.partitions.map(async ({ db }) => {
			// A lone legacy LOGS_DB has no directory migration requirement.
			const row =
				stores.partitions.length === 1 &&
				stores.partitions[0]?.binding === "LOGS_DB"
					? null
					: await readLogPartition(db);
			// Inclusive bounds are conservative for strict cursors and second-granular audit rows.
			const overlaps =
				!row ||
				((!range.to || Date.parse(row.fromTs) <= Date.parse(range.to)) &&
					(!range.from ||
						!row.toTs ||
						Date.parse(row.toTs) >= Date.parse(range.from)));
			return overlaps ? db : null;
		}),
	);
	return Promise.all(
		[stores.main, ...partitions.filter((db) => db !== null)].map(read),
	);
}

export interface MergeLogStoreRowsOptions<T> {
	/** Total order of the merged set; omit to keep per-store order, main first. */
	compare?: (a: T, b: T) => number;
	limit?: number;
	offset?: number;
}

/** Dedupe by id, order, then apply offset and limit to the merged set. */
export function mergeLogStoreRows<T extends { id: string }>(
	pages: readonly (readonly T[])[],
	options: MergeLogStoreRowsOptions<T> = {},
): T[] {
	const seen = new Set<string>();
	const rows: T[] = [];
	for (const page of pages) {
		for (const row of page) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			rows.push(row);
		}
	}
	if (options.compare) rows.sort(options.compare);
	const start = options.offset ?? 0;
	return options.limit === undefined
		? rows.slice(start)
		: rows.slice(start, start + options.limit);
}

/** `(createdAt, id)` text ordering shared by the runtime event tables. */
export function compareCreatedAtId<T extends { createdAt: string; id: string }>(
	direction: "asc" | "desc",
): (a: T, b: T) => number {
	const sign = direction === "desc" ? -1 : 1;
	return (a, b) =>
		sign * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** `(timestamp, id)` ordering of audit rows, newest first when `desc`. */
export function compareTimestampId<T extends { timestamp: Date; id: string }>(
	direction: "asc" | "desc",
): (a: T, b: T) => number {
	const sign = direction === "desc" ? -1 : 1;
	return (a, b) =>
		sign *
		(a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));
}
