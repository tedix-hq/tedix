import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	type OsWorkspaceEventRow,
	osWorkspaceEvents,
} from "../schema/os-collaborators";

export type OsWorkspaceEventKind = OsWorkspaceEventRow["kind"];

/** A reader that falls further behind than this refetches everything anyway. */
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Pruning rides one insert in this many, so no producer pays for it each time. */
const PRUNE_EVERY = 100;

/**
 * Appends a change hint for a workspace and returns its cursor. Producers call
 * this after the change committed; a failed hint must never fail the change,
 * so the caller decides whether to await or swallow.
 */
export async function recordOsWorkspaceEvent(
	db: DbQueryClient,
	params: { workspaceId: string; kind: OsWorkspaceEventKind },
): Promise<number> {
	const [row] = await db
		.insert(osWorkspaceEvents)
		.values({ workspaceId: params.workspaceId, kind: params.kind })
		.returning({ cursor: osWorkspaceEvents.seq });
	if (!row) throw new Error("OS workspace event insert returned no row");
	if (row.cursor % PRUNE_EVERY === 0) {
		await db
			.delete(osWorkspaceEvents)
			.where(
				lt(
					osWorkspaceEvents.createdAt,
					new Date(Date.now() - EVENT_RETENTION_MS)
						.toISOString()
						.slice(0, 19)
						.replace("T", " "),
				),
			);
	}
	return row.cursor;
}

/** The newest cursor of a workspace; 0 when nothing was ever recorded. */
export async function getLatestOsWorkspaceEventCursor(
	db: DbQueryClient,
	workspaceId: string,
): Promise<number> {
	const [row] = await db
		.select({ cursor: osWorkspaceEvents.seq })
		.from(osWorkspaceEvents)
		.where(eq(osWorkspaceEvents.workspaceId, workspaceId))
		.orderBy(desc(osWorkspaceEvents.seq))
		.limit(1);
	return row?.cursor ?? 0;
}

/** Events newer than `after`, oldest first. */
export async function listOsWorkspaceEventsAfter(
	db: DbQueryClient,
	params: { workspaceId: string; after: number; limit: number },
): Promise<Array<{ cursor: number; kind: OsWorkspaceEventKind }>> {
	return db
		.select({ cursor: osWorkspaceEvents.seq, kind: osWorkspaceEvents.kind })
		.from(osWorkspaceEvents)
		.where(
			and(
				eq(osWorkspaceEvents.workspaceId, params.workspaceId),
				gt(osWorkspaceEvents.seq, params.after),
			),
		)
		.orderBy(asc(osWorkspaceEvents.seq))
		.limit(params.limit);
}

/**
 * Producer entry point for query owners. The change already committed, so a
 * failed hint is dropped: readers also refetch on a slow fallback and on
 * reconnect, and a hint must never turn a good write into an error.
 */
export async function announceOsWorkspaceChange(
	db: DbQueryClient,
	workspaceId: string | null | undefined,
	kind: OsWorkspaceEventKind,
): Promise<void> {
	if (!workspaceId) return;
	try {
		await recordOsWorkspaceEvent(db, { workspaceId, kind });
	} catch {
		// Intentionally dropped; see above.
	}
}
