/**
 * Work routing facts: accepted non-coding Work that no executor will pick up,
 * with the tedi its organization's stewardship policy names for it. The job in
 * apps/api delegates each item once and records the delegation as a comment
 * whose id is derived from the item, which also keeps it out of later reads.
 */

import type { WorkStewardshipPolicy } from "@tedix/api-contract/schemas/work-stewardship";
import {
	and,
	asc,
	eq,
	isNull,
	lte,
	ne,
	notExists,
	or,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { booleanValue, coreStore, jsonRead } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import { organizations as d1Organizations } from "../../schema/organizations";
import { projects as d1Projects } from "../../schema/projects";
import { tedis as d1Tedis } from "../../schema/tedis";
import {
	workAttempts as d1WorkAttempts,
	workItemComments as d1WorkItemComments,
	workItems as d1WorkItems,
} from "../../schema/work-items";
import { addWorkItemCommentIfAbsent } from "./comments";

export function workRoutingCommentId(workItemId: string): string {
	return `work-routing:${workItemId}`;
}

/** Organizations whose stewardship policy turns automatic routing on. */
export async function listWorkRoutingOrgs(
	db: DbQueryClient,
): Promise<Array<{ orgId: string; policy: unknown }>> {
	const organizations = coreTable(db, d1Organizations);
	const enabled = (path: string[]) =>
		sql`${jsonRead(db, organizations.metadata, path, "boolean")} = ${booleanValue(db, true)}`;
	const rows = await db
		.select({
			org_id: organizations.id,
			// D1 returns JSON text; Postgres returns the parsed jsonb value.
			policy: sql<unknown>`${jsonRead(db, organizations.metadata, ["workStewardship"], "json")}`,
		})
		.from(organizations)
		.where(
			and(
				enabled(["workStewardship", "enabled"]),
				enabled(["workStewardship", "autoRoute", "enabled"]),
			),
		)
		.orderBy(asc(organizations.id));
	return rows.map((row) => ({
		orgId: row.org_id,
		policy:
			typeof row.policy === "string"
				? JSON.parse(row.policy)
				: (row.policy ?? null),
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
	const workItems = coreTable(db, d1WorkItems);
	const projects = coreTable(db, d1Projects);
	const tedis = coreTable(db, d1Tedis);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemComments = coreTable(db, d1WorkItemComments);
	const doneWhen = jsonRead(db, workItems.acceptanceContract, [
		"doneLooksLike",
	]);
	// Policy maps are bound JSON objects keyed by the row's project or Work kind.
	const steward = (map: Record<string, string>, key: SQLWrapper) =>
		coreStore(db) === "postgres"
			? sql`(${JSON.stringify(map)}::text::jsonb ->> ${key})`
			: sql`json_extract(${JSON.stringify(map)}, '$."' || ${key} || '"')`;
	const rows = await db
		.select({
			id: workItems.id,
			title: workItems.title,
			description: workItems.description,
			work_kind: workItems.workKind,
			project_id: workItems.projectId,
			version: workItems.version,
			done_when: sql<string>`${doneWhen}`.as("done_when"),
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
					${steward(policy.projectStewards, workItems.projectId)},
					${policy.useProjectLead ? sql`${projects.leadTediId}` : sql`NULL`},
					${steward(policy.workKindStewards, workItems.workKind)},
					${policy.defaultTediId ?? null}
				)`,
			),
		)
		.where(
			and(
				eq(workItems.orgId, input.orgId),
				eq(workItems.disposition, "accepted"),
				isNull(workItems.executorId),
				ne(workItems.workKind, "coding"),
				sql`trim(coalesce(${doneWhen}, '')) <> ''`,
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
