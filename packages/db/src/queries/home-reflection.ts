import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import { kernelRuntimeEvents } from "../schema/cognitive-runtime";
import { memoryFacts } from "../schema/memory-graph";

export async function hasActiveMemoryFactSource(
	db: DbClient,
	input: { organizationId: string; source: string },
): Promise<boolean> {
	const [row] = await db
		.select({ id: memoryFacts.id })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, input.organizationId),
				eq(memoryFacts.source, input.source),
				isNull(memoryFacts.archivedAt),
			),
		)
		.limit(1);
	return row !== undefined;
}

export async function listHomePlanDecisionEvents(
	db: DbClient,
	input: { organizationId: string; since: string; limit: number },
) {
	return db
		.select()
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.kind, "decision.recorded"),
				gte(kernelRuntimeEvents.createdAt, input.since),
				sql`json_extract(${kernelRuntimeEvents.payload}, '$.action') IN ('home.plan.approved', 'home.plan.rejected')`,
			),
		)
		.orderBy(desc(kernelRuntimeEvents.createdAt))
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
	return db
		.select()
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
		.orderBy(desc(auditEvents.timestamp))
		.limit(input.limit);
}
