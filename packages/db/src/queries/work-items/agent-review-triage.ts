import { sql } from "drizzle-orm";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { DbQueryClient } from "../../query-client";
import { workEvents } from "../../schema/work-items";

/** Materialize a bounded recent window before examining comments; never scan the project history. */
export function buildAgentReviewsForTriageStatement(p: {
	orgId: string;
	projectId: string;
	leadTediId: string;
	maxRetries: number;
	retryBefore: string;
	recentAfter: string;
	limit: number;
}) {
	return sql`WITH recent AS MATERIALIZED (
		SELECT id, org_id, created_at FROM work_items INDEXED BY idx_work_items_org_project_created
		WHERE org_id = ${p.orgId} AND project_id = ${p.projectId} AND created_at >= ${p.recentAfter}
		AND json_extract(metadata, '$.agentReview') = 1
		ORDER BY created_at, id LIMIT 400
	), pending AS MATERIALIZED (
		SELECT recent.id, recent.created_at AS createdAt,
			(SELECT count(*) FROM work_item_comments AS retry WHERE retry.org_id = recent.org_id AND retry.work_item_id = recent.id AND json_extract(retry.metadata, '$.agentReviewRetry') = 1) AS retries,
			(SELECT max(retry.created_at) FROM work_item_comments AS retry WHERE retry.org_id = recent.org_id AND retry.work_item_id = recent.id AND json_extract(retry.metadata, '$.agentReviewRetry') = 1) AS lastRetry
		FROM recent
		WHERE NOT EXISTS (SELECT 1 FROM work_item_comments AS result WHERE result.org_id = recent.org_id AND result.work_item_id = recent.id AND result.author_type = 'tedi' AND result.author_id = ${p.leadTediId} AND json_extract(result.metadata, '$.agentReviewTriageResult') = 1 AND length(trim(result.body)) > 0)
	)
	SELECT id, createdAt, retries, lastRetry FROM pending
	WHERE retries <= ${p.maxRetries} AND (lastRetry IS NULL OR lastRetry <= ${p.retryBefore})
	ORDER BY createdAt, id LIMIT ${p.limit}`;
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
	}>(buildAgentReviewsForTriageStatement(p));
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
	const [, attempt] = await db.batch([
		db.run(sql`INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,body,metadata,created_at)
			VALUES (${p.tickSlotId},${p.orgId},${p.workItemId},'system','Review triage tick slot reserved.','{}',${p.at}) ON CONFLICT DO NOTHING`),
		db.all<{
			id: string;
		}>(sql`INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,body,metadata,created_at)
			SELECT ${`${p.workItemId}:agent-review-retry:${p.retry}`},${p.orgId},${p.workItemId},'system','Review triage attempted; completion remains unverified.',${JSON.stringify({ agentReviewRetry: true, retry: p.retry })},${p.at}
			WHERE EXISTS (SELECT 1 FROM work_item_comments WHERE id = ${p.tickSlotId} AND org_id = ${p.orgId} AND work_item_id = ${p.workItemId})
			ON CONFLICT DO NOTHING RETURNING id`),
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
