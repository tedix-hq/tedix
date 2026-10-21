import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { auditEvents } from "../schema/audit-events";
import { kernelWakeQueue } from "../schema/cognitive-runtime";
import { mergeLogStoreRows, readLogStores } from "../utils/log-store";
import { workstationLeases } from "../schema/workstations";

export async function listHomeRunAuditReferences(
	db: DbQueryClient,
	input: {
		organizationId: string;
		childRunIds: string[];
		from: Date;
		to: Date;
		limit: number;
	},
): Promise<Array<{ id: string; traceId: string | null }>> {
	if (
		!Number.isFinite(input.from?.getTime()) ||
		!Number.isFinite(input.to?.getTime()) ||
		input.from > input.to
	) {
		throw new Error("Home run references require valid audit time bounds");
	}
	// Organization, two timestamps and limit leave 96 of D1's 100 parameters.
	if (input.childRunIds.length > 96) {
		throw new Error("Home run audit references support at most 96 child runs");
	}
	if (input.childRunIds.length === 0) return [];
	const pages = await readLogStores(db, (store) =>
		listHomeRunAuditReferences(store, input),
	);
	if (pages) return mergeLogStoreRows(pages, { limit: input.limit });
	return db
		.select({
			id: auditEvents.id,
			traceId: sql<string>`json_extract(${auditEvents.metadata}, '$.traceId')`,
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, input.organizationId),
				gte(auditEvents.timestamp, input.from),
				lte(auditEvents.timestamp, input.to),
				sql`json_extract(${auditEvents.metadata}, '$.traceId') IN (${sql.join(
					input.childRunIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			),
		)
		.limit(input.limit);
}

export async function listHomeRunWakeReceipts(
	db: DbClient,
	input: { organizationId: string; childRunIds: string[]; limit: number },
) {
	if (input.childRunIds.length === 0) return [];
	return db
		.select()
		.from(kernelWakeQueue)
		.where(
			and(
				eq(kernelWakeQueue.organizationId, input.organizationId),
				// bound-params: delegated child-run refs of ONE Home run (the caller
				// walks a BRANCH_LIMIT-capped branch list)
				inArray(kernelWakeQueue.childRunId, input.childRunIds),
			),
		)
		.orderBy(asc(kernelWakeQueue.queuedAt))
		.limit(input.limit);
}

export async function listHomeRunWorkstationReferences(
	db: DbClient,
	input: { organizationId: string; kernelRunId: string; limit: number },
) {
	return db
		.select({
			id: workstationLeases.id,
			workItemId: workstationLeases.workItemId,
			metadata: workstationLeases.metadata,
		})
		.from(workstationLeases)
		.where(
			and(
				eq(workstationLeases.orgId, input.organizationId),
				eq(workstationLeases.kernelRunId, input.kernelRunId),
			),
		)
		.limit(input.limit);
}
