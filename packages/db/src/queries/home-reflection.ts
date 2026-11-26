import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { jsonRead } from "../core-store/dialect";
import {
	auditReadColumns,
	auditReadTable,
	readAuditStores,
} from "./audit-delivery";
import { kernelRuntimeEvents } from "../schema/cognitive-runtime";
import { memoryFacts } from "../schema/memory-graph";
import { compareTimestampId, mergeLogStoreRows } from "../utils/log-store";

export async function hasActiveMemoryFactSource(
	db: DbClient,
	input: { organizationId: string; source: string },
): Promise<boolean> {
	const table = coreTable(db, memoryFacts);
	const [row] = await db
		.select({ id: table.id })
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.source, input.source),
				isNull(table.archivedAt),
			),
		)
		.limit(1);
	return row !== undefined;
}

export async function listHomePlanDecisionEvents(
	db: DbClient,
	input: { organizationId: string; since: string; limit: number },
) {
	const table = coreTable(db, kernelRuntimeEvents);
	return db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.kind, "decision.recorded"),
				gte(table.createdAt, input.since),
				sql`${jsonRead(db, table.payload, ["action"])} IN ('home.plan.approved', 'home.plan.rejected')`,
			),
		)
		.orderBy(desc(table.createdAt))
		.limit(input.limit);
}

export async function listHomeOperatorDecisionAuditEvents(
	db: DbClient,
	input: {
		organizationId: string;
		since: Date;
		actions: string[];
		limit: number;
	},
) {
	const read = async (store: DbClient) => {
		const auditEvents = auditReadTable(store);
		return store
			.select(auditReadColumns(store))
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.organizationId, input.organizationId),
					eq(auditEvents.actorType, "user"),
					// bound-params: sole caller passes the fixed DECISION_ACTIONS verb set
					inArray(auditEvents.action, input.actions),
					gte(auditEvents.timestamp, input.since),
				),
			)
			.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
			.limit(input.limit);
	};
	const pages = await readAuditStores(db, read, {
		from: input.since.toISOString(),
	});
	return pages
		? mergeLogStoreRows(pages, {
				compare: compareTimestampId("desc"),
				limit: input.limit,
			})
		: read(db);
}
