import { and, eq, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { DbQueryClient } from "../../query-client";
import {
	workEvents as d1WorkEvents,
	workItemComments as d1WorkItemComments,
} from "../../schema/work-items";

import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, jsonParameter } from "../../core-store/dialect";

/** Materialize a bounded recent window before examining comments; never scan the project history. */
// Raw: both CTEs need AS MATERIALIZED, which Drizzle $with cannot emit; flattened, each comment subquery runs repeatedly.
export function buildAgentReviewsForTriageStatement(
	p: {
		orgId: string;
		projectId: string;
		leadTediId: string;
		maxRetries: number;
		retryBefore: string;
		recentAfter: string;
		limit: number;
	},
	db?: DbQueryClient,
) {
	const dialect = db ?? {};
	return sql`WITH recent AS MATERIALIZED (
		SELECT id, org_id, created_at FROM work_items ${coreStore(dialect) === "d1" ? sql`INDEXED BY idx_work_items_org_project_created` : sql``}
		WHERE org_id = ${p.orgId} AND project_id = ${p.projectId} AND created_at >= ${p.recentAfter}
		AND ${jsonRead(dialect, sql`metadata`, ["agentReview"], "boolean")} = ${coreStore(dialect) === "d1" ? sql`1` : sql`true`}
		ORDER BY created_at, id LIMIT 400
	), pending AS MATERIALIZED (
		SELECT recent.id, recent.created_at AS "createdAt",
			(SELECT count(*) FROM work_item_comments AS retry WHERE retry.org_id = recent.org_id AND retry.work_item_id = recent.id AND ${jsonRead(dialect, sql`retry.metadata`, ["agentReviewRetry"], "boolean")} = ${coreStore(dialect) === "d1" ? sql`1` : sql`true`}) AS retries,
			(SELECT max(retry.created_at) FROM work_item_comments AS retry WHERE retry.org_id = recent.org_id AND retry.work_item_id = recent.id AND ${jsonRead(dialect, sql`retry.metadata`, ["agentReviewRetry"], "boolean")} = ${coreStore(dialect) === "d1" ? sql`1` : sql`true`}) AS "lastRetry"
		FROM recent
		WHERE NOT EXISTS (SELECT 1 FROM work_item_comments AS result WHERE result.org_id = recent.org_id AND result.work_item_id = recent.id AND result.author_type = 'tedi' AND result.author_id = ${p.leadTediId} AND ${jsonRead(dialect, sql`result.metadata`, ["agentReviewTriageResult"], "boolean")} = ${coreStore(dialect) === "d1" ? sql`1` : sql`true`} AND length(trim(result.body)) > 0)
	)
	SELECT id, "createdAt", retries, "lastRetry" FROM pending
	WHERE retries <= ${p.maxRetries} AND ("lastRetry" IS NULL OR "lastRetry" <= ${p.retryBefore})
	ORDER BY "createdAt", id LIMIT ${p.limit}`;
}

export async function listAgentReviewsForTriage(
	db: DbQueryClient,
	p: Parameters<typeof buildAgentReviewsForTriageStatement>[0],
) {
	return db.all<{
		id: string;
		createdAt: string;
		retries: number;
		lastRetry: string | null;
	}>(buildAgentReviewsForTriageStatement(p, db));
}

/** Claim both the project tick slot and review attempt atomically before dispatch. */
export async function claimAgentReviewRetry(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		retry: number;
		at: string;
		tickSlotId: string;
	},
) {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const [, attempt] = await db.batch([
		db
			.insert(workItemComments)
			.values({
				id: p.tickSlotId,
				orgId: p.orgId,
				workItemId: p.workItemId,
				authorType: "system",
				body: "Review triage tick slot reserved.",
				metadata: {},
				createdAt: p.at,
			})
			.onConflictDoNothing(),
		db
			.insert(workItemComments)
			.select(
				db
					.select({
						id: sql<string>`${`${p.workItemId}:agent-review-retry:${p.retry}`}`.as(
							"id",
						),
						orgId: sql<string>`${p.orgId}`.as("org_id"),
						workItemId: sql<string>`${p.workItemId}`.as("work_item_id"),
						authorType: sql<"system">`'system'`.as("author_type"),
						body: sql<string>`'Review triage attempted; completion remains unverified.'`.as(
							"body",
						),
						metadata: sql<
							Record<string, JsonValue>
						>`${jsonParameter(db, { agentReviewRetry: true, retry: p.retry })}`.as(
							"metadata",
						),
						createdAt: sql<string>`${p.at}`.as("created_at"),
					})
					.from(workItemComments)
					.where(
						and(
							eq(workItemComments.id, p.tickSlotId),
							eq(workItemComments.orgId, p.orgId),
							eq(workItemComments.workItemId, p.workItemId),
						),
					),
			)
			.onConflictDoNothing()
			.returning({ id: workItemComments.id }),
	]);
	return attempt.length === 1;
}

export async function recordAgentReviewTriageNotice(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		state: "digest";
		projectId: string;
		at: string;
	},
) {
	const workEvents = coreTable(db, d1WorkEvents);
	const hash = await sha256Hex(
		`${p.orgId}:${p.projectId}:agent-review:digest:${p.at.slice(0, 10)}`,
	);
	const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	await db
		.insert(workEvents)
		.values({
			id,
			orgId: p.orgId,
			workItemId: p.workItemId,
			eventType: "agent_review.digest",
			actorType: "system",
			actorId: "agent-review-triage",
			payload: {
				summary:
					"Daily private agent review queue digest. Open the review project to inspect pending triage.",
			},
			occurredAt: p.at,
		})
		.onConflictDoNothing();
}
