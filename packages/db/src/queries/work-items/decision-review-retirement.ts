import { coreTable } from "../../core-store/client";
import {
	anyIds,
	coreStore,
	jsonParameter,
	jsonRead,
} from "../../core-store/dialect";
import { interactionColumns, interactionAuditTime } from "./interaction-store";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { isFactsChangedReview } from "@tedix/api-contract/utils/deck-action-boundary";
import type { DbQueryClient } from "../../query-client";
import { auditEvents as d1AuditEvents } from "../../schema/audit-events";
import { workInteractions as d1WorkInteractions } from "../../schema/work-factory";

/** Also follows the original card's Work link for project-filed legacy reviews. */
export async function retireDecisionReviews(
	db: DbQueryClient,
	p: {
		orgId: string;
		now: string;
		originalId?: string;
		originalIds?: readonly string[];
		workItemId?: string;
		dismiss?: {
			id: string;
			version: number;
			actorType: string;
			actorId: string;
			note: string;
		};
	},
) {
	const auditEvents = coreTable(db, d1AuditEvents);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const terminal = sql`EXISTS (SELECT 1 FROM work_interactions original
		WHERE original.org_id=${workInteractions.orgId}
		AND original.id=${jsonRead(db, workInteractions.metadata, ["replacesDecisionId"])}
		AND (original.status IN ('resolved','cancelled','expired') OR EXISTS (
			SELECT 1 FROM work_items w WHERE w.org_id=original.org_id
			AND w.id=original.work_item_id AND w.disposition IN ('completed','cancelled'))))
		OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId}
		AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`;
	const scope = and(
		eq(workInteractions.orgId, p.orgId),
		eq(workInteractions.status, "open"),
		sql`${jsonRead(db, workInteractions.metadata, ["decisionDeck", "classId"])}='decision-facts-changed'`,
		p.originalId
			? sql`${jsonRead(db, workInteractions.metadata, ["replacesDecisionId"])}=${p.originalId}`
			: undefined,
		p.originalIds
			? anyIds(
					db,
					jsonRead(db, workInteractions.metadata, ["replacesDecisionId"]),
					p.originalIds,
				)
			: undefined,
		p.workItemId
			? sql`(${workInteractions.workItemId}=${p.workItemId} OR EXISTS (SELECT 1 FROM work_interactions original WHERE original.org_id=${p.orgId} AND original.id=${jsonRead(db, workInteractions.metadata, ["replacesDecisionId"])} AND original.work_item_id=${p.workItemId}))`
			: undefined,
		p.dismiss
			? and(
					eq(workInteractions.id, p.dismiss.id),
					eq(workInteractions.version, p.dismiss.version),
				)
			: sql`(${terminal})`,
	);
	let retired = 0;
	let after: string | undefined;
	while (true) {
		const rows = await db
			.select(interactionColumns(db))
			.from(workInteractions)
			.where(and(scope, after ? gt(workInteractions.id, after) : undefined))
			.orderBy(asc(workInteractions.id))
			.limit(50);
		if (!rows.length) break;
		after = rows[rows.length - 1]!.id;
		const statements = [];
		for (const row of rows) {
			if (!isFactsChangedReview(row)) continue;
			const fence = crypto.randomUUID();
			const reason = p.dismiss
				? "review_dismissed"
				: "earlier_decision_or_work_closed";
			statements.push(
				db
					.update(workInteractions)
					.set({
						status: "cancelled",
						cancelledAt: p.now,
						resolutionFence: fence,
						version: sql`${workInteractions.version}+1`,
					})
					.where(
						and(
							scope,
							eq(workInteractions.id, row.id),
							eq(workInteractions.version, row.version),
							coreStore(db) === "postgres"
								? sql`${workInteractions.metadata}=${jsonParameter(db, row.metadata)}`
								: sql`json(${workInteractions.metadata})=json(${JSON.stringify(row.metadata)})`,
						),
					)
					.returning({ id: workInteractions.id }),
				db.insert(auditEvents).select(
					db
						.select({
							id: sql<string>`${fence}`.as("id"),
							organizationId: workInteractions.orgId,
							actorId: sql<string>`${p.dismiss?.actorId ?? "tedix"}`.as(
								"actor_id",
							),
							actorType: sql<string>`${p.dismiss?.actorType ?? "service"}`.as(
								"actor_type",
							),
							action: sql<string>`'decision.review.retired'`.as("action"),
							resourceType: sql<string>`'work_interaction'`.as("resource_type"),
							resourceId: workInteractions.id,
							metadata:
								sql<string>`${jsonParameter(db, { reason, replacesDecisionId: row.metadata.replacesDecisionId, workItemId: p.workItemId ?? row.workItemId, note: p.dismiss?.note ?? "The earlier decision or its Work closed; this review approves no action." })}`.as(
									"metadata",
								),
							timestamp: sql<number>`${interactionAuditTime(db, p.now)}`.as(
								"timestamp",
							),
						})
						.from(workInteractions)
						.where(
							and(
								eq(workInteractions.orgId, p.orgId),
								eq(workInteractions.id, row.id),
								eq(workInteractions.resolutionFence, fence),
							),
						),
				),
			);
		}
		if (statements.length) {
			const results = await db.batch(
				statements as [(typeof statements)[number], ...typeof statements],
			);
			for (let index = 0; index < results.length; index += 2) {
				const closed = results[index];
				if (Array.isArray(closed)) retired += closed.length;
			}
		}
	}
	return retired;
}
