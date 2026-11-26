/**
 * Read marks — the write and read side of `read_marks` (see
 * `schema/read-marks.ts` for why the store exists).
 *
 * `markRowsRead` is the only writer. It is deliberately cheap: an
 * in-isolate cache answers repeat reads for free, and the D1 write is a
 * single guarded upsert per row per UTC day (`last_read_on` only moves
 * forward). A mark failure must never break the read it rode in on, so the
 * function logs and returns rather than throwing.
 *
 * The judges (`cognitive/skill-quality`, `skill-lifecycle`,
 * `memory-graph/fact-lifecycle`, `learning-feed-miner`,
 * `memory-graph/health-findings`) read the marks back through
 * `getReadMarkDates` or the `freshReadMarkExists` SQL fragment.
 */

import {
	and,
	eq,
	inArray,
	lt,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { readMarks, type ReadMarkKind } from "../schema/read-marks";
import { chunkForBoundParams } from "../utils/batch";

/** Bound ids per markRowsRead call; callers pass listing-sized sets. */
const MAX_MARK_IDS = 500;
/** 5 bound columns per VALUES row; 15 rows stays well under D1's 100-param cap. */
const UPSERT_CHUNK = 15;
/** IN() lookups bind one param per id plus org/kind. */
const LOOKUP_CHUNK = 50;

/**
 * In-isolate memory of "already marked today". Worker isolates are ephemeral,
 * so this only removes repeat writes inside one isolate's lifetime; the SQL
 * guard (`last_read_on < today`) keeps concurrent isolates honest.
 */
const markedToday = new Map<string, string>();
const MARKED_CACHE_CAP = 20_000;

/** Test hook: drop the in-isolate cache between cases. */
export function clearReadMarkCache(): void {
	markedToday.clear();
}

function markKey(
	organizationId: string,
	kind: ReadMarkKind,
	rowId: string,
): string {
	return [organizationId, kind, rowId].join("|");
}

function utcDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Record that `rowIds` of `kind` were read by `organizationId` today.
 * At most one write per row per UTC day reaches D1; reads inside the same
 * day and isolate cost nothing. Never throws — a failed mark is telemetry,
 * not a reason to fail the read it rode in on.
 */
export async function markRowsRead(
	db: DbQueryClient,
	organizationId: string,
	kind: ReadMarkKind,
	rowIds: readonly string[],
	options?: { now?: Date },
): Promise<void> {
	const now = options?.now ?? new Date();
	const today = utcDate(now);
	const pending = [
		...new Set(rowIds.filter((id) => typeof id === "string" && id.length > 0)),
	]
		.filter(
			(id) => markedToday.get(markKey(organizationId, kind, id)) !== today,
		)
		.slice(0, MAX_MARK_IDS);
	if (pending.length === 0) return;

	const written = new Set<string>();
	try {
		for (const chunk of chunkForBoundParams(pending, UPSERT_CHUNK)) {
			await db
				.insert(readMarks)
				.values(
					chunk.map((rowId) => ({
						organizationId,
						kind,
						rowId,
						lastReadOn: today,
						updatedAt: now.toISOString(),
					})),
				)
				.onConflictDoUpdate({
					target: [readMarks.organizationId, readMarks.kind, readMarks.rowId],
					set: { lastReadOn: today, updatedAt: now.toISOString() },
					setWhere: lt(readMarks.lastReadOn, today),
				});
			for (const rowId of chunk) written.add(rowId);
		}
	} catch (error) {
		console.warn("[read-marks] markRowsRead failed", {
			kind,
			count: pending.length,
			exception: error instanceof Error ? error.message : String(error),
		});
	}
	for (const rowId of written) {
		if (markedToday.size >= MARKED_CACHE_CAP) markedToday.clear();
		markedToday.set(markKey(organizationId, kind, rowId), today);
	}
}

/**
 * The recorded `last_read_on` date (`YYYY-MM-DD`) for each of `rowIds`, keyed
 * by row id. Rows never read since tracking shipped are absent from the map.
 */
export async function getReadMarkDates(
	db: DbQueryClient,
	organizationId: string,
	kind: ReadMarkKind,
	rowIds: readonly string[],
): Promise<Map<string, string>> {
	const marks = new Map<string, string>();
	const ids = [...new Set(rowIds)];
	for (const chunk of chunkForBoundParams(ids, LOOKUP_CHUNK)) {
		const rows = await db
			.select({
				rowId: readMarks.rowId,
				lastReadOn: readMarks.lastReadOn,
			})
			.from(readMarks)
			.where(
				and(
					eq(readMarks.organizationId, organizationId),
					eq(readMarks.kind, kind),
					inArray(readMarks.rowId, chunk),
				),
			);
		for (const row of rows) marks.set(row.rowId, row.lastReadOn);
	}
	return marks;
}

/**
 * SQL fragment for the bulk judges: true when `rowId` has a read mark of
 * `kind` dated on or after `sinceDate` (`YYYY-MM-DD`). `organizationId` and
 * `rowId` may be columns or bound values.
 */
export function freshReadMarkExists(args: {
	organizationId: SQLWrapper | string;
	kind: ReadMarkKind;
	rowId: SQLWrapper | string;
	sinceDate: string | SQLWrapper;
}): SQL {
	return sql`EXISTS (
		SELECT 1 FROM ${readMarks}
		WHERE ${readMarks.organizationId} = ${args.organizationId}
			AND ${readMarks.kind} = ${args.kind}
			AND ${readMarks.rowId} = ${args.rowId}
			AND ${readMarks.lastReadOn} >= ${args.sinceDate}
	)`;
}

/**
 * The honest label every "unused" report carries: reads are not usage events,
 * and only a daily last-read date is kept — so a row read before tracking
 * shipped, or through an uninstrumented path, can still look unused. The
 * caller states the window it checked; this states what "unused" means.
 */
export const READ_TRACKING_CAVEAT =
	"Reads are not counted as usage events; only the latest read date per row is kept (read_marks, one entry per row per day, tracked from when read tracking shipped — earlier reads left no trace), so a row can look unused while still being read.";

/** Caveat plus the concrete window a report examined. */
export function unusedReportNote(window: string): string {
	return `${READ_TRACKING_CAVEAT} Window checked: ${window}.`;
}
