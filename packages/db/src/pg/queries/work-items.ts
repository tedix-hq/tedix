import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
	WorkItemDisposition,
	WorkItemKind,
} from "../../schema/work-items";
import { normalizeWorkItemAcceptanceContract } from "../../queries/work-items/normalization";
import type { PgQueryClient } from "../query-client";
import { workAttempts, workItems } from "../schema/work-items";

export async function getWorkItemById(
	db: PgQueryClient,
	workItemId: string,
	orgId?: string,
) {
	const [row] = await db
		.select()
		.from(workItems)
		.where(
			and(
				eq(workItems.id, workItemId),
				orgId ? eq(workItems.orgId, orgId) : undefined,
			),
		)
		.limit(1);
	return row
		? {
				...row,
				acceptanceContract: normalizeWorkItemAcceptanceContract(
					row.acceptanceContract,
				),
			}
		: null;
}

export async function listWorkItems(
	db: PgQueryClient,
	options: {
		orgId: string;
		disposition?: WorkItemDisposition;
		workKind?: WorkItemKind;
		projectId?: string | null;
		parentWorkItemId?: string | null;
		executor?: string;
		limit?: number;
	},
) {
	return db
		.select()
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, options.orgId),
				options.disposition
					? eq(workItems.disposition, options.disposition)
					: undefined,
				options.workKind ? eq(workItems.workKind, options.workKind) : undefined,
				options.projectId === undefined
					? undefined
					: options.projectId === null
						? isNull(workItems.projectId)
						: eq(workItems.projectId, options.projectId),
				options.parentWorkItemId === undefined
					? undefined
					: options.parentWorkItemId === null
						? isNull(workItems.parentWorkItemId)
						: eq(workItems.parentWorkItemId, options.parentWorkItemId),
				options.executor
					? sql`${workItems.metadata} ->> 'executor' = ${options.executor}`
					: undefined,
			),
		)
		.orderBy(desc(workItems.createdAt))
		.limit(options.limit ?? 100)
		.then((rows) =>
			rows.map((row) => ({
				...row,
				acceptanceContract: normalizeWorkItemAcceptanceContract(
					row.acceptanceContract,
				),
			})),
		);
}

export async function listLatestWorkAttemptSummaries(
	db: PgQueryClient,
	params: { orgId: string; workItemIds: string[] },
) {
	if (params.workItemIds.length === 0) return new Map();
	const rows = await db
		.select({
			workItemId: workAttempts.workItemId,
			attemptId: workAttempts.id,
			runtimeState: workAttempts.runtimeState,
			outcome: workAttempts.outcome,
			finishedAt: workAttempts.finishedAt,
			workItemVersion: sql<
				number | null
			>`(${workAttempts.metadata} ->> 'dispatchVersion')::integer`,
		})
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.orgId),
				inArray(workAttempts.workItemId, params.workItemIds),
				sql`${workAttempts.id} = (SELECT latest.id FROM work_attempts latest
					WHERE latest.org_id = ${workAttempts.orgId}
					AND latest.work_item_id = ${workAttempts.workItemId}
					ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1)`,
			),
		);
	return new Map(rows.map(({ workItemId, ...row }) => [workItemId, row]));
}
