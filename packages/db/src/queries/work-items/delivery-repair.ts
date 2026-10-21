import { and, eq, sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import {
	workItemComments,
	workItems,
	type WorkItem,
} from "../../schema/work-items";

export function deliveryRepairSourceIntent(workItemId: string) {
	return `dispatcher-repair:${workItemId}`;
}

/**
 * One proposed repair per Work item, however many of its Attempts fail or
 * stay unverified. Each failure appends one comment to that repair, keyed by
 * the failed Attempt, so retries of the same tick write nothing new.
 */
export async function proposeWorkDeliveryRepair(
	db: DbQueryClient,
	p: {
		id: string;
		workItem: WorkItem;
		failedAttemptId: string;
		reason: string;
		now: string;
	},
) {
	const source = p.workItem;
	const sourceIntentId = deliveryRepairSourceIntent(source.id);
	const existingRepair = and(
		eq(workItems.orgId, source.orgId),
		eq(workItems.sourceIntentId, sourceIntentId),
	);
	await db.batch([
		db
			.insert(workItems)
			.values({
				id: p.id,
				orgId: source.orgId,
				projectId: source.projectId,
				objectiveId: source.objectiveId,
				title: `Repair: ${source.title}`.slice(0, 200),
				description: `Dispatcher Attempt on Work ${source.id} did not produce a verified delivery. Inspect the Work, its Attempts and any retained worktree before changing code.`,
				sourceIntentId,
				workKind: source.workKind,
				workClass: source.workClass,
				riskLevel: source.riskLevel,
				admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
				disposition: "proposed",
				priority: "high",
				accountableOwnerType: source.accountableOwnerType,
				accountableOwnerId: source.accountableOwnerId,
				stewardType: source.stewardType,
				stewardId: source.stewardId,
				metadata: { deliveryRepairOf: source.id },
				createdAt: p.now,
			})
			.onConflictDoNothing(),
		db
			.insert(workItemComments)
			.select(
				db
					.select({
						id: sql<string>`${workItems.id} || ':' || ${p.failedAttemptId}`.as(
							"id",
						),
						workItemId: workItems.id,
						orgId: workItems.orgId,
						authorType: sql<string>`'system'`.as("author_type"),
						authorId: sql<string>`'request-tracker'`.as("author_id"),
						body: sql<string>`${`Attempt ${p.failedAttemptId} on Work ${source.id}: ${p.reason}`.slice(0, 4000)}`.as(
							"body",
						),
						metadata: sql<
							Record<string, JsonValue>
						>`${JSON.stringify({ failedAttemptId: p.failedAttemptId, repairOf: source.id })}`.as(
							"metadata",
						),
						createdAt: sql<string>`${p.now}`.as("created_at"),
					})
					.from(workItems)
					.where(existingRepair),
			)
			.onConflictDoNothing(),
	]);
	return (
		(await db.select().from(workItems).where(existingRepair).limit(1))[0] ??
		null
	);
}
