/**
 * Work routing facts: accepted non-coding Work that no executor will pick up,
 * with the tedi its organization's stewardship policy names for it. The job in
 * apps/api delegates each item once and records the delegation as a comment
 * whose id is derived from the item, which also keeps it out of later reads.
 */

import type { WorkStewardshipPolicy } from "@tedix/api-contract/schemas/work-stewardship";
import { and, asc, eq, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import {
	workAttempts,
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { addWorkItemCommentIfAbsent } from "./comments";

export function workRoutingCommentId(workItemId: string): string {
	return `work-routing:${workItemId}`;
}

/** Organizations whose stewardship policy turns automatic routing on. */
export async function listWorkRoutingOrgs(
	db: DbQueryClient,
): Promise<Array<{ orgId: string; policy: unknown }>> {
	const rows = await db
		.select({
			org_id: organizations.id,
			policy: sql<
				string | null
			>`json_extract(${organizations.metadata}, '$.workStewardship')`,
		})
		.from(organizations)
		.where(
			and(
				sql`json_extract(${organizations.metadata}, '$.workStewardship.enabled') = 1`,
				sql`json_extract(${organizations.metadata}, '$.workStewardship.autoRoute.enabled') = 1`,
			),
		)
		.orderBy(asc(organizations.id));
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
	const rows = await db
		.select({
			id: workItems.id,
			title: workItems.title,
			description: workItems.description,
			work_kind: workItems.workKind,
			project_id: workItems.projectId,
			version: workItems.version,
			done_when:
				sql<string>`json_extract(${workItems.acceptanceContract}, '$.doneLooksLike')`.as(
					"done_when",
				),
			tedi_id: sql<string>`${tedis.id}`.as("tedi_id"),
			tedi_slug: sql<string>`${tedis.slug}`.as("tedi_slug"),
			tedi_name: sql<string>`${tedis.name}`.as("tedi_name"),
		})
		.from(workItems)
		.leftJoin(
			projects,
			and(
				eq(projects.orgId, workItems.orgId),
				eq(projects.id, workItems.projectId),
			),
		)
		.innerJoin(
			tedis,
			and(
				eq(tedis.organizationId, workItems.orgId),
				eq(tedis.status, "active"),
				isNull(tedis.retiredAt),
				sql`${tedis.id} = coalesce(
					CASE WHEN ${workItems.stewardType} = 'tedi' THEN ${workItems.stewardId} END,
					json_extract(${JSON.stringify(policy.projectStewards)}, '$."' || ${workItems.projectId} || '"'),
					CASE WHEN ${policy.useProjectLead ? 1 : 0} = 1 THEN ${projects.leadTediId} END,
					json_extract(${JSON.stringify(policy.workKindStewards)}, '$."' || ${workItems.workKind} || '"'),
					${policy.defaultTediId ?? null}
				)`,
			),
		)
		.where(
			and(
				eq(workItems.orgId, input.orgId),
				eq(workItems.disposition, "accepted"),
				sql`json_extract(${workItems.metadata}, '$.executor') IS NULL`,
				ne(workItems.workKind, "coding"),
				sql`trim(coalesce(json_extract(${workItems.acceptanceContract}, '$.doneLooksLike'), '')) <> ''`,
				or(isNull(workItems.startAt), lte(workItems.startAt, input.now)),
				notExists(
					db
						.select({ one: sql`1` })
						.from(workAttempts)
						.where(
							and(
								eq(workAttempts.orgId, workItems.orgId),
								eq(workAttempts.workItemId, workItems.id),
								// Literal list: it must match the uniq_work_attempt_active partial index.
								sql`${workAttempts.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')`,
							),
						),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(workItemComments)
						.where(
							sql`${workItemComments.id} = ${workRoutingCommentId("")} || ${workItems.id}`,
						),
				),
			),
		)
		.orderBy(asc(workItems.createdAt), asc(workItems.id))
		.limit(input.limit);
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
