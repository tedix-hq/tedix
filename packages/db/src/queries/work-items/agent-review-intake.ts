import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";

/** One conditional insert makes the D1 daily cap atomic across callers and colos. */
export async function createAgentReviewWithinDailyCap(
	db: DbQueryClient,
	p: {
		id: string;
		orgId: string;
		projectId: string;
		objectiveId: string;
		leadTediId: string;
		title: string;
		description: string;
		sourceIntentId: string;
		metadata: Record<string, JsonValue>;
		createdAt: string;
		dayStart: string;
		nextDay: string;
		dailyCap: number;
	},
) {
	const rows = await db.all<{ id: string }>(sql`
		INSERT INTO work_items (id, org_id, project_id, objective_id, title, description,
			source_intent_id, accountable_owner_type, accountable_owner_id, steward_type, steward_id,
			work_class, metadata, created_at, admission_spec_revision)
		SELECT ${p.id}, ${p.orgId}, ${p.projectId}, ${p.objectiveId}, ${p.title}, ${p.description},
			${p.sourceIntentId}, 'tedi', ${p.leadTediId}, 'tedi', ${p.leadTediId},
			'objective', ${JSON.stringify(p.metadata)}, ${p.createdAt}, lower(hex(randomblob(16)))
		WHERE (SELECT count(*) FROM work_items INDEXED BY idx_work_items_org_project_created
			WHERE org_id = ${p.orgId} AND created_at >= ${p.dayStart} AND created_at < ${p.nextDay}
			AND project_id = ${p.projectId} AND json_extract(metadata, '$.agentReview') = 1) < ${p.dailyCap}
		AND (SELECT count(*) FROM work_items INDEXED BY idx_work_items_org_project_created
			WHERE org_id = ${p.orgId} AND created_at >= ${p.dayStart} AND created_at < ${p.nextDay}
			AND project_id = ${p.projectId} AND json_extract(metadata, '$.agentReview') = 1
			AND json_extract(metadata, '$.callerOrgId') = ${p.metadata.callerOrgId ?? null}) < ${p.dailyCap}
		RETURNING id`);
	return rows.length === 1;
}

/** Bound each retention tick; only intake reviews are deleted, never derived proposals. */
export async function purgeExpiredAgentReviews(
	db: DbQueryClient,
	p: { orgId: string; projectId: string; before: string },
) {
	const rows = await db.all<{
		id: string;
	}>(sql`DELETE FROM work_items WHERE id IN (
		SELECT id FROM work_items INDEXED BY idx_work_items_org_project_created
		WHERE org_id = ${p.orgId} AND created_at < ${p.before} AND project_id = ${p.projectId}
		AND json_extract(metadata, '$.agentReview') = 1 ORDER BY created_at LIMIT 50
	) AND org_id = ${p.orgId} RETURNING id`);
	return rows.length;
}
