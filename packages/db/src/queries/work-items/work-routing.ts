/**
 * Work routing facts: accepted non-coding Work that no executor will pick up,
 * with the tedi its organization's stewardship policy names for it. The job in
 * apps/api delegates each item once and records the delegation as a comment
 * whose id is derived from the item, which also keeps it out of later reads.
 */

import type { WorkStewardshipPolicy } from "@tedix/api-contract/schemas/work-stewardship";
import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { addWorkItemCommentIfAbsent } from "./comments";

export function workRoutingCommentId(workItemId: string): string {
	return `work-routing:${workItemId}`;
}

/** Organizations whose stewardship policy turns automatic routing on. */
export async function listWorkRoutingOrgs(
	db: DbQueryClient,
): Promise<Array<{ orgId: string; policy: unknown }>> {
	const rows = await db.all<{ org_id: string; policy: string | null }>(sql`
		SELECT o.id AS org_id, json_extract(o.metadata, '$.workStewardship') AS policy
		FROM organizations o
		WHERE json_extract(o.metadata, '$.workStewardship.enabled') = 1
			AND json_extract(o.metadata, '$.workStewardship.autoRoute.enabled') = 1
		ORDER BY o.id
	`);
	return rows.map((row) => ({
		orgId: row.org_id,
		policy: row.policy ? JSON.parse(row.policy) : null,
	}));
}

export interface RoutableWorkItem {
	id: string;
	title: string;
	description: string | null;
	workKind: string;
	projectId: string | null;
	version: number;
	doneWhen: string;
	tediId: string;
	tediSlug: string;
	tediName: string;
}

/**
 * Accepted, non-coding, not scheduled for later, with a done-when, no executor,
 * no live Attempt and no routing record, oldest first. The tedi is the item's
 * tedi steward, else the same order Work creation uses: the configured project
 * steward, the project's tedi lead, the Work kind's steward, the default. Only
 * an active, unretired tedi of the same organization qualifies.
 */
export async function listRoutableWork(
	db: DbQueryClient,
	input: {
		orgId: string;
		policy: WorkStewardshipPolicy;
		now: string;
		limit: number;
	},
): Promise<RoutableWorkItem[]> {
	const { policy } = input;
	const rows = await db.all<{
		id: string;
		title: string;
		description: string | null;
		work_kind: string;
		project_id: string | null;
		version: number;
		done_when: string;
		tedi_id: string;
		tedi_slug: string;
		tedi_name: string;
	}>(sql`
		SELECT w.id, w.title, w.description, w.work_kind, w.project_id, w.version,
			json_extract(w.acceptance_contract, '$.doneLooksLike') AS done_when,
			t.id AS tedi_id, t.slug AS tedi_slug, t.name AS tedi_name
		FROM work_items w
		LEFT JOIN projects p ON p.org_id = w.org_id AND p.id = w.project_id
		JOIN tedis t ON t.organization_id = w.org_id
			AND t.status = 'active' AND t.retired_at IS NULL
			AND t.id = coalesce(
				CASE WHEN w.steward_type = 'tedi' THEN w.steward_id END,
				json_extract(${JSON.stringify(policy.projectStewards)}, '$."' || w.project_id || '"'),
				CASE WHEN ${policy.useProjectLead ? 1 : 0} = 1 THEN p.lead_tedi_id END,
				json_extract(${JSON.stringify(policy.workKindStewards)}, '$."' || w.work_kind || '"'),
				${policy.defaultTediId ?? null}
			)
		WHERE w.org_id = ${input.orgId}
			AND w.disposition = 'accepted'
			AND json_extract(w.metadata, '$.executor') IS NULL
			AND w.work_kind <> 'coding'
			AND trim(coalesce(json_extract(w.acceptance_contract, '$.doneLooksLike'), '')) <> ''
			AND (w.start_at IS NULL OR w.start_at <= ${input.now})
			AND NOT EXISTS (
				SELECT 1 FROM work_attempts a
				WHERE a.org_id = w.org_id AND a.work_item_id = w.id
					AND a.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
			)
			AND NOT EXISTS (
				SELECT 1 FROM work_item_comments c
				WHERE c.id = ${workRoutingCommentId("")} || w.id
			)
		ORDER BY w.created_at, w.id
		LIMIT ${input.limit}
	`);
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		description: row.description,
		workKind: row.work_kind,
		projectId: row.project_id,
		version: Number(row.version),
		doneWhen: row.done_when,
		tediId: row.tedi_id,
		tediSlug: row.tedi_slug,
		tediName: row.tedi_name,
	}));
}

/** One routing record per item: the delegation receipt, or why it was skipped. */
export async function recordWorkRouting(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		body: string;
		metadata: Record<string, string | number | string[]>;
		now: string;
	},
) {
	return addWorkItemCommentIfAbsent(db, {
		id: workRoutingCommentId(input.workItemId),
		orgId: input.orgId,
		workItemId: input.workItemId,
		authorType: "system",
		authorId: "work-routing",
		body: input.body,
		metadata: { source: "work-routing", ...input.metadata },
		createdAt: input.now,
		recordActivity: true,
	});
}
