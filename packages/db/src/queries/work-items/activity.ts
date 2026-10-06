/**
 * Work Items — activity feed: the org-wide board event ledger joined to its
 * items, newest first.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type WorkItemDisposition,
	workEvents,
	workItems,
} from "../../schema/work-items";

/**
 * How a Work Item reached a terminal state, when the event records it.
 *
 * Without this the feed cannot answer the question the provenance gate exists
 * to answer: was this item settled by a verified commit, closed by hand, or
 * waived through by a human override? The settled attempt and
 * the certification row's `mode` each knew part of the answer, but neither is
 * on the activity feed.
 */
export interface WorkActivitySettlement {
	mode: string;
	commitSha: string | null;
}

/** A recent board event (comment/heartbeat/block/done/…) for the activity feed. */
export interface WorkActivityRow {
	id: string;
	workItemId: string;
	workItemTitle: string;
	workItemStatus: WorkItemDisposition;
	eventType: string;
	authorType: string;
	authorId: string | null;
	agentSession: string | null;
	agentHarness: string | null;
	settlement: WorkActivitySettlement | null;
	body: string;
	createdAt: string;
}

/** Read `metadata.settlement` without trusting its shape. */
function settlementFromMetadata(
	md: Record<string, unknown>,
): WorkActivitySettlement | null {
	const raw = md.settlement;
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.mode !== "string" || record.mode === "") return null;
	return {
		mode: record.mode,
		commitSha:
			typeof record.commitSha === "string" && record.commitSha !== ""
				? record.commitSha
				: null,
	};
}

export interface ListWorkActivityParams {
	orgId: string;
	workItemId?: string;
	projectId?: string;
	eventTypes?: string[];
	limit?: number;
}

const ACTIVITY_DEFAULT_LIMIT = 100;
const ACTIVITY_MAX_LIMIT = 300;

/**
 * Org-wide recent board events from the append-only work_events ledger, joined
 * to their items and newest first. Credential-derived actor/session fields let
 * callers group events by the exact execution attempt.
 */
export async function listWorkActivity(
	db: DbClient,
	params: ListWorkActivityParams,
): Promise<{ events: WorkActivityRow[]; truncated: boolean }> {
	const cap = Math.min(
		Math.max(1, params.limit ?? ACTIVITY_DEFAULT_LIMIT),
		ACTIVITY_MAX_LIMIT,
	);
	const conditions = [eq(workEvents.orgId, params.orgId)];
	if (params.workItemId) {
		conditions.push(eq(workEvents.workItemId, params.workItemId));
	}
	if (params.projectId) {
		conditions.push(eq(workItems.projectId, params.projectId));
	}
	if (params.eventTypes && params.eventTypes.length > 0) {
		// bound-params: API contract caps eventTypes at 50 values
		conditions.push(inArray(workEvents.eventType, params.eventTypes));
	}
	const rows = await db
		.select({
			id: workEvents.id,
			workItemId: workEvents.workItemId,
			workItemTitle: workItems.title,
			workItemStatus: workItems.disposition,
			eventType: workEvents.eventType,
			authorType: workEvents.actorType,
			authorId: workEvents.actorId,
			metadata: workEvents.payload,
			createdAt: workEvents.occurredAt,
		})
		.from(workEvents)
		.innerJoin(workItems, eq(workItems.id, workEvents.workItemId))
		.where(and(...conditions))
		.orderBy(desc(workEvents.occurredAt))
		.limit(cap + 1);
	const events: WorkActivityRow[] = rows.slice(0, cap).map((r) => {
		const md = (r.metadata ?? {}) as Record<string, unknown>;
		return {
			id: r.id,
			workItemId: r.workItemId,
			workItemTitle: r.workItemTitle,
			workItemStatus: r.workItemStatus,
			eventType: r.eventType,
			authorType: r.authorType,
			authorId: r.authorId,
			agentSession:
				typeof md.agentSession === "string" ? md.agentSession : null,
			agentHarness:
				typeof md.agentHarness === "string" ? md.agentHarness : null,
			settlement: settlementFromMetadata(md),
			body: typeof md.summary === "string" ? md.summary : r.eventType,
			createdAt: r.createdAt,
		};
	});
	return { events, truncated: rows.length > cap };
}
