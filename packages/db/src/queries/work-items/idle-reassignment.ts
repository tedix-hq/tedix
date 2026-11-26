import { and, eq, getColumns, sql } from "drizzle-orm";
import { COMMITMENT_REMINDER_SOURCE } from "@tedix/api-contract/utils/commitment-reminder";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead } from "../../core-store/dialect";
import {
	workItems as d1WorkItems,
	workItemStoredColumns,
	workAttempts as d1WorkAttempts,
	workItemComments as d1WorkItemComments,
} from "../../schema/work-items";
import { workInteractions as d1WorkInteractions } from "../../schema/work-factory";
import { getScopedWorkItem, WorkFactoryError } from "./factory-state";
import { normalizeWorkItemRow } from "./normalization";

const runners = ["codex", "claude-code", "opencode", "devin", "tedi"];

function workItemSelection(db: DbQueryClient): typeof workItemStoredColumns {
	const columns = getColumns(coreTable(db, d1WorkItems));
	return Object.fromEntries(
		Object.keys(workItemStoredColumns).map((key) => [
			key,
			columns[key as keyof typeof columns],
		]),
	) as typeof workItemStoredColumns;
}

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
		reason: "unreachable" | "unavailable" | "chosen";
		/** Why the tool cannot take Work, in plain words, for the item's comment. */
		detail?: string;
		now?: string;
	},
) {
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemComments = coreTable(db, d1WorkItemComments);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const item = await getScopedWorkItem(db, input.orgId, input.workItemId);
	const now = input.now ?? new Date().toISOString();
	const age = Date.parse(now) - Date.parse(input.unavailableSince);
	const tags: unknown[] = Array.isArray(item.metadata?.tags)
		? item.metadata.tags
		: [];
	if (
		!runners.includes(input.executor) ||
		!(
			runners.includes(input.fromExecutor) ||
			(input.reason === "chosen" && input.fromExecutor === "any-local")
		) ||
		input.executor === input.fromExecutor ||
		!Number.isFinite(age) ||
		input.minimumIdleMinutes < 1 ||
		(input.reason !== "chosen" && age < input.minimumIdleMinutes * 60_000) ||
		item.version !== input.expectedVersion ||
		item.executorType !== "external_agent" ||
		item.executorId !== input.fromExecutor ||
		item.disposition !== "accepted" ||
		!item.projectId ||
		!item.acceptanceContract ||
		item.requiredCapabilities.length ||
		item.requiredAuthorities.length ||
		// Only fields a person set keep Work on its tool, never its wording.
		item.metadata?.onlyExecutor === true ||
		item.metadata?.requiredExecutor ||
		item.metadata?.executorRequirement ||
		tags.some(
			(tag) => typeof tag === "string" && tag.startsWith("requires:"),
		) ||
		item.dispatchState !== "ready"
	)
		throw new WorkFactoryError(
			"NOT_READY",
			"Work requires its assigned executor or is not eligible for idle reassignment",
		);
	const receiptId = crypto.randomUUID();
	const metadata = {
		...item.metadata,
		idleReassignment: {
			id: receiptId,
			from: input.fromExecutor,
			to: input.executor,
			reason: input.reason,
			...(input.detail ? { detail: input.detail } : {}),
			// The revision it was decided on, so a pick is not asked again.
			version: item.version,
			unavailableSince: input.unavailableSince,
			at: now,
		},
	};
	const fence = and(
		eq(workItems.orgId, input.orgId),
		eq(workItems.id, item.id),
		eq(workItems.version, input.expectedVersion),
		eq(workItems.executorType, "external_agent"),
		eq(workItems.executorId, input.fromExecutor),
		eq(workItems.disposition, "accepted"),
		sql`(${workItems.startAt} IS NULL OR ${workItems.startAt} <= ${now})`,
		// Unresolved leases and retained user/deferred/success results stay with
		// their runner. When the runner itself reports its tool unavailable, it
		// has already checked its own records for a kept result, so a cancelled
		// Attempt (a restart, or a run its tool refused) no longer pins the Work.
		sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} WHERE ${workAttempts.orgId} = ${input.orgId} AND ${workAttempts.workItemId} = ${item.id}
			AND (${workAttempts.outcome} IS NULL OR (${workAttempts.outcome} NOT IN (${sql.join(
				(input.reason === "unavailable"
					? ["failed", "expired", "cancelled"]
					: ["failed", "expired"]
				).map((outcome) => sql`${outcome}`),
				sql`, `,
			)}) AND ${jsonRead(db, workAttempts.metadata, ["dispatchVersion"], "number")} = ${item.version})))`,
		sql`(SELECT count(*) FROM ${workAttempts} WHERE ${workAttempts.orgId} = ${input.orgId} AND ${workAttempts.workItemId} = ${item.id}
			AND ${jsonRead(db, workAttempts.metadata, ["dispatchVersion"], "number")} = ${item.version} AND ${workAttempts.outcome} IN ('failed', 'expired')) < 3`,
		// A status follow-up is not a person waiting; starting an Attempt closes it.
		sql`NOT EXISTS (SELECT 1 FROM ${workInteractions} WHERE ${workInteractions.orgId} = ${input.orgId} AND ${workInteractions.workItemId} = ${item.id} AND ${workInteractions.status} = 'open'
			AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt} > ${now})
			AND COALESCE(${jsonRead(db, workInteractions.metadata, ["source"])}, '') <> ${COMMITMENT_REMINDER_SOURCE})`,
	);
	const why =
		input.detail ??
		(input.reason === "chosen"
			? "the decision model chose it"
			: input.reason === "unreachable"
				? `no ${input.fromExecutor} runner is running`
				: `${input.fromExecutor} cannot take Work`);
	const body = `Reassigned from ${input.fromExecutor} to ${input.executor}: ${why}, since ${input.unavailableSince} (waited at least ${input.minimumIdleMinutes} minutes). Work revision ${item.version} and failure holds preserved. Set metadata.onlyExecutor to keep a task on its tool.`;
	const [changed] = await db.batch([
		db
			.update(workItems)
			.set({
				metadata,
				executorType: "external_agent",
				executorId: input.executor,
				updatedAt: now,
				// Fence stale preparations without resetting revision-based failure holds.
				admissionSpecRevision:
					coreStore(db) === "postgres"
						? sql`gen_random_uuid()::text`
						: sql`lower(hex(randomblob(16)))`,
			})
			.where(fence)
			.returning(workItemSelection(db)),
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
						sql`${jsonRead(db, workItems.metadata, ["idleReassignment", "id"])} = ${receiptId}`,
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
