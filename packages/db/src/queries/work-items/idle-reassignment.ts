import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workItems,
	workAttempts,
	workItemComments,
} from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { getScopedWorkItem, WorkFactoryError } from "./factory-state";
import { normalizeWorkItemRow } from "./normalization";

const runners = ["codex", "claude-code", "opencode", "devin"];

/** Assignment bookkeeping must never create a fresh revision that clears a hold. */
export async function reassignIdleWork(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		expectedVersion: number;
		executor: string;
		fromExecutor: string;
		unavailableSince: string;
		minimumIdleMinutes: number;
		reason: "busy" | "unreachable";
		now?: string;
	},
) {
	const item = await getScopedWorkItem(db, input.orgId, input.workItemId);
	const now = input.now ?? new Date().toISOString();
	const age = Date.parse(now) - Date.parse(input.unavailableSince);
	const text = `${item.title}\n${item.description ?? ""}\n${item.acceptanceContract?.doneLooksLike ?? ""}\n${JSON.stringify(item.metadata?.tags ?? [])}`;
	if (
		!runners.includes(input.executor) ||
		!runners.includes(input.fromExecutor) ||
		input.executor === input.fromExecutor ||
		!Number.isFinite(age) ||
		input.minimumIdleMinutes < 1 ||
		age < input.minimumIdleMinutes * 60_000 ||
		item.version !== input.expectedVersion ||
		item.metadata?.executor !== input.fromExecutor ||
		item.disposition !== "accepted" ||
		!item.projectId ||
		!item.acceptanceContract ||
		item.requiredCapabilities.length ||
		item.requiredAuthorities.length ||
		item.riskLevel === "high" ||
		item.riskLevel === "critical" ||
		item.metadata?.requiredExecutor ||
		item.metadata?.executorRequirement ||
		/\b(codex|claude(?:[- ]code)?|opencode|devin)\b/i.test(text) ||
		humanReservedActionClasses(text).length ||
		!item.metadata?.laneDispatch ||
		(item.metadata.laneDispatch as { state?: string }).state !== "ready"
	)
		throw new WorkFactoryError(
			"NOT_READY",
			"Work requires its assigned executor or is not eligible for idle reassignment",
		);
	const receiptId = crypto.randomUUID();
	const metadata = {
		...item.metadata,
		executor: input.executor,
		idleReassignment: {
			id: receiptId,
			from: input.fromExecutor,
			to: input.executor,
			reason: input.reason,
			unavailableSince: input.unavailableSince,
			at: now,
		},
	};
	const fence = and(
		eq(workItems.orgId, input.orgId),
		eq(workItems.id, item.id),
		eq(workItems.version, input.expectedVersion),
		eq(workItems.metadata, item.metadata),
		eq(workItems.disposition, "accepted"),
		sql`(${workItems.startAt} IS NULL OR ${workItems.startAt} <= ${now})`,
		// Unresolved leases and retained user/deferred/success results stay with their runner.
		sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} WHERE ${workAttempts.orgId} = ${input.orgId} AND ${workAttempts.workItemId} = ${item.id}
			AND (${workAttempts.outcome} IS NULL OR (${workAttempts.outcome} NOT IN ('failed', 'expired') AND json_extract(${workAttempts.metadata}, '$.dispatchVersion') = ${item.version})))`,
		sql`(SELECT count(*) FROM ${workAttempts} WHERE ${workAttempts.orgId} = ${input.orgId} AND ${workAttempts.workItemId} = ${item.id}
			AND json_extract(${workAttempts.metadata}, '$.dispatchVersion') = ${item.version} AND ${workAttempts.outcome} IN ('failed', 'expired')) < 3`,
		sql`NOT EXISTS (SELECT 1 FROM ${workInteractions} WHERE ${workInteractions.orgId} = ${input.orgId} AND ${workInteractions.workItemId} = ${item.id} AND ${workInteractions.status} = 'open')`,
	);
	const body = `Reassigned from ${input.fromExecutor} to ${input.executor}: assigned runner ${input.reason} since ${input.unavailableSince} (at least ${input.minimumIdleMinutes} minutes). Work revision ${item.version} and failure holds preserved.`;
	const [changed] = await db.batch([
		db
			.update(workItems)
			.set({
				metadata,
				updatedAt: now,
				// Fence stale preparations without resetting revision-based failure holds.
				admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			})
			.where(fence)
			.returning(),
		db.insert(workItemComments).select(
			db
				.select({
					id: sql<string>`${receiptId}`.as("id"),
					orgId: workItems.orgId,
					workItemId: workItems.id,
					authorType: sql<string>`'system'`.as("author_type"),
					authorId: sql<string>`'lane-dispatch'`.as("author_id"),
					body: sql<string>`${body}`.as("body"),
					metadata: sql<Record<string, never>>`'{}'`.as("metadata"),
					createdAt: sql<string>`${now}`.as("created_at"),
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, input.orgId),
						eq(workItems.id, item.id),
						sql`json_extract(${workItems.metadata}, '$.idleReassignment.id') = ${receiptId}`,
					),
				),
		),
	]);
	if (!changed[0])
		throw new WorkFactoryError(
			"NOT_READY",
			"Work changed, is held, or is waiting for a person; assignment preserved",
		);
	return normalizeWorkItemRow(changed[0]);
}
