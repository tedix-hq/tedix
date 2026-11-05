import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workItems } from "../../schema/work-items";

const recentReviews = sql`${workItems} INDEXED BY idx_work_items_org_project_created`;
const isAgentReview = sql`json_extract(${workItems.metadata}, '$.agentReview') = 1`;

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
	// An aggregate without GROUP BY yields exactly one row, so the insert
	// selects from the day's counts and the cap check stays in one statement.
	const today = db
		.select({
			total: sql<number>`count(*)`.as("total"),
			caller:
				sql<number>`count(CASE WHEN json_extract(${workItems.metadata}, '$.callerOrgId') = ${p.metadata.callerOrgId ?? null} THEN 1 END)`.as(
					"caller",
				),
		})
		.from(recentReviews)
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				gte(workItems.createdAt, p.dayStart),
				lt(workItems.createdAt, p.nextDay),
				eq(workItems.projectId, p.projectId),
				isAgentReview,
			),
		)
		.as("today");
	const rows = await db
		.insert(workItems)
		.select(
			db
				.select({
					id: sql<string>`${p.id}`.as("id"),
					orgId: sql<string>`${p.orgId}`.as("org_id"),
					projectId: sql<string>`${p.projectId}`.as("project_id"),
					objectiveId: sql<string>`${p.objectiveId}`.as("objective_id"),
					title: sql<string>`${p.title}`.as("title"),
					description: sql<string>`${p.description}`.as("description"),
					sourceIntentId: sql<string>`${p.sourceIntentId}`.as(
						"source_intent_id",
					),
					accountableOwnerType: sql<"tedi">`'tedi'`.as(
						"accountable_owner_type",
					),
					accountableOwnerId: sql<string>`${p.leadTediId}`.as(
						"accountable_owner_id",
					),
					stewardType: sql<"tedi">`'tedi'`.as("steward_type"),
					stewardId: sql<string>`${p.leadTediId}`.as("steward_id"),
					workClass: sql<"objective">`'objective'`.as("work_class"),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(p.metadata)}`.as("metadata"),
					createdAt: sql<string>`${p.createdAt}`.as("created_at"),
					admissionSpecRevision: sql<string>`lower(hex(randomblob(16)))`.as(
						"admission_spec_revision",
					),
				})
				.from(today)
				.where(and(lt(today.total, p.dailyCap), lt(today.caller, p.dailyCap))),
		)
		.returning({ id: workItems.id });
	return rows.length === 1;
}

/** Bound each retention tick; only intake reviews are deleted, never derived proposals. */
export async function purgeExpiredAgentReviews(
	db: DbQueryClient,
	p: { orgId: string; projectId: string; before: string },
) {
	const rows = await db
		.delete(workItems)
		.where(
			and(
				// bound-params: a subquery, not a bound list.
				inArray(
					workItems.id,
					db
						.select({ id: sql<string>`${workItems.id}` })
						.from(recentReviews)
						.where(
							and(
								eq(workItems.orgId, p.orgId),
								lt(workItems.createdAt, p.before),
								eq(workItems.projectId, p.projectId),
								isAgentReview,
							),
						)
						.orderBy(asc(workItems.createdAt))
						.limit(50),
				),
				eq(workItems.orgId, p.orgId),
			),
		)
		.returning({ id: workItems.id });
	return rows.length;
}
