import { and, asc, eq, sql } from "drizzle-orm";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { DbQueryClient } from "../../query-client";
import {
	workEvents,
	workItemComments,
	workItems,
} from "../../schema/work-items";

/** Only the designated triager's saved result counts; a queued wake never does. */
export async function listAgentReviewsForTriage(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		leadTediId: string;
		maxRetries: number;
		retryBefore: string;
		lateBefore: string;
	},
) {
	// Explicit outer qualification prevents Drizzle from resolving id against the inner comment table.
	const complete = sql<boolean>`EXISTS (SELECT 1 FROM work_item_comments AS result WHERE result.org_id = work_items.org_id AND result.work_item_id = work_items.id AND result.author_type = 'tedi' AND result.author_id = ${p.leadTediId} AND json_extract(result.metadata, '$.agentReviewTriageResult') = 1 AND length(trim(result.body)) > 0)`;
	const retries = sql<number>`(SELECT count(*) FROM work_item_comments AS retry WHERE retry.org_id = work_items.org_id AND retry.work_item_id = work_items.id AND json_extract(retry.metadata, '$.agentReviewRetry') = 1)`;
	const lastRetry = sql<
		string | null
	>`(SELECT max(retry.created_at) FROM work_item_comments AS retry WHERE retry.org_id = work_items.org_id AND retry.work_item_id = work_items.id AND json_extract(retry.metadata, '$.agentReviewRetry') = 1)`;
	const notified = (state: string) =>
		sql`EXISTS (SELECT 1 FROM work_events AS notice WHERE notice.org_id = work_items.org_id AND notice.work_item_id = work_items.id AND notice.event_type = ${`agent_review.${state}`})`;
	return db
		.select({
			id: workItems.id,
			createdAt: workItems.createdAt,
			complete: complete.as("triage_complete"),
			retries: retries.as("triage_retries"),
			lastRetry: lastRetry.as("triage_last_retry"),
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.projectId, p.projectId),
				sql`json_extract(${workItems.metadata}, '$.agentReview') = 1`,
				sql`((${complete} AND NOT ${notified("completed")}) OR (NOT ${complete} AND ((${retries} < ${p.maxRetries} AND coalesce(${lastRetry}, ${workItems.createdAt}) <= ${p.retryBefore}) OR (${workItems.createdAt} < ${p.lateBefore} AND NOT ${notified("late")}))))`,
			),
		)
		.orderBy(asc(workItems.createdAt), asc(workItems.id))
		.limit(50);
}

/** Claim before dispatch so duplicate ticks and failed wakes consume at most one retry. */
export async function claimAgentReviewRetry(
	db: DbQueryClient,
	p: { orgId: string; workItemId: string; retry: number; at: string },
) {
	const rows = await db
		.insert(workItemComments)
		.values({
			id: `${p.workItemId}:agent-review-retry:${p.retry}`,
			orgId: p.orgId,
			workItemId: p.workItemId,
			authorType: "system",
			body: "Review triage recovery attempted; completion remains unverified.",
			metadata: { agentReviewRetry: true, retry: p.retry },
			createdAt: p.at,
		})
		.onConflictDoNothing()
		.returning({ id: workItemComments.id });
	return rows.length === 1;
}

export async function recordAgentReviewTriageNotice(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		state: "completed" | "late";
		at: string;
	},
) {
	const hash = await sha256Hex(
		`${p.orgId}:${p.workItemId}:agent-review:${p.state}`,
	);
	const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	await db
		.insert(workEvents)
		.values({
			id,
			orgId: p.orgId,
			workItemId: p.workItemId,
			eventType: `agent_review.${p.state}`,
			actorType: "system",
			actorId: "agent-review-triage",
			payload: {
				summary:
					p.state === "completed"
						? "Agent review triage completed. See the private review for its result."
						: "Agent review triage is over two hours late. Maintainer attention required.",
			},
			occurredAt: p.at,
		})
		.onConflictDoNothing();
}
