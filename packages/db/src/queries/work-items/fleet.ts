import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { workAttempts, workItems } from "../../schema/work-items";
import {
	workAdmissions,
	workApprovalProposals,
	workBudgetEnvelopes,
	workInteractions,
	workResourcePools,
} from "../../schema/work-factory";

type CountRow = { key: string; count: number };
const countMap = (rows: CountRow[]) =>
	Object.fromEntries(rows.map((row) => [row.key, row.count]));
const sum = (rows: Array<{ count: number }>) =>
	rows.reduce((total, row) => total + row.count, 0);

export async function getWorkFleetProjection(
	db: DbQueryClient,
	p: { orgId: string; now: string },
) {
	const newerAdmission = alias(workAdmissions, "newer_admission");
	// Keep the aggregate in one sequential D1 round trip. Concurrent
	// statements exceed D1's six simultaneous-connection limit in production.
	const [
		workItemRows,
		attemptRows,
		admissionRows,
		latestRejectedRows,
		approvalRows,
		interactionRows,
		resourceRows,
		budgetRows,
	] = await db.batch([
		db
			.select({
				key: workItems.disposition,
				count: sql<number>`COUNT(*)`.as("count"),
			})
			.from(workItems)
			.where(eq(workItems.orgId, p.orgId))
			.groupBy(workItems.disposition),
		db
			.select({
				key: workAttempts.runtimeState,
				count: sql<number>`COUNT(*)`.as("count"),
				active:
					sql<number>`SUM(CASE WHEN ${workAttempts.runtimeState} IN ('queued','running','waiting','retrying') AND (${workAttempts.expiresAt} IS NULL OR ${workAttempts.expiresAt}>${p.now}) THEN 1 ELSE 0 END)`.as(
						"active",
					),
				stale:
					sql<number>`SUM(CASE WHEN ${workAttempts.runtimeState} IN ('queued','running','waiting','retrying') AND ${workAttempts.expiresAt} IS NOT NULL AND ${workAttempts.expiresAt}<=${p.now} THEN 1 ELSE 0 END)`.as(
						"stale",
					),
				// Actionable subset: an elapsed lease on a terminal Work Item can
				// never be recovered into progress, so it is census, not pressure.
				staleActionable:
					sql<number>`SUM(CASE WHEN ${workAttempts.runtimeState} IN ('queued','running','waiting','retrying') AND ${workAttempts.expiresAt} IS NOT NULL AND ${workAttempts.expiresAt}<=${p.now} AND EXISTS (SELECT 1 FROM work_items wi WHERE wi.org_id=${workAttempts.orgId} AND wi.id=${workAttempts.workItemId} AND wi.disposition NOT IN ('completed','cancelled')) THEN 1 ELSE 0 END)`.as(
						"stale_actionable",
					),
				withoutAdmission:
					sql<number>`SUM(CASE WHEN ${workAttempts.admissionId} IS NULL THEN 1 ELSE 0 END)`.as(
						"without_admission",
					),
			})
			.from(workAttempts)
			.where(eq(workAttempts.orgId, p.orgId))
			.groupBy(workAttempts.runtimeState),
		db
			.select({
				key: sql<string>`CASE WHEN ${workAdmissions.expiresAt}<=${p.now} THEN 'expired' ELSE ${workAdmissions.decision} END`.as(
					"key",
				),
				count: sql<number>`COUNT(*)`.as("count"),
			})
			.from(workAdmissions)
			.where(eq(workAdmissions.orgId, p.orgId))
			.groupBy(
				sql`CASE WHEN ${workAdmissions.expiresAt}<=${p.now} THEN 'expired' ELSE ${workAdmissions.decision} END`,
			),
		db
			.select({ count: sql<number>`COUNT(*)`.as("count") })
			.from(workAdmissions)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, workAdmissions.orgId),
					eq(workItems.id, workAdmissions.workItemId),
					eq(
						workItems.admissionSpecRevision,
						workAdmissions.admissionSpecRevision,
					),
				),
			)
			.leftJoin(
				newerAdmission,
				and(
					eq(newerAdmission.orgId, workAdmissions.orgId),
					eq(newerAdmission.workItemId, workAdmissions.workItemId),
					eq(
						newerAdmission.admissionSpecRevision,
						workAdmissions.admissionSpecRevision,
					),
					or(
						gt(newerAdmission.createdAt, workAdmissions.createdAt),
						and(
							eq(newerAdmission.createdAt, workAdmissions.createdAt),
							gt(newerAdmission.id, workAdmissions.id),
						),
					),
				),
			)
			.where(
				and(
					eq(workAdmissions.orgId, p.orgId),
					eq(workAdmissions.decision, "rejected"),
					sql`${workAdmissions.expiresAt}>${p.now}`,
					isNull(newerAdmission.id),
				),
			),
		db
			.select({
				key: sql<string>`CASE WHEN ${workApprovalProposals.status}='pending' AND ${workApprovalProposals.expiresAt}<=${p.now} THEN 'expired' ELSE ${workApprovalProposals.status} END`.as(
					"key",
				),
				count: sql<number>`COUNT(*)`.as("count"),
			})
			.from(workApprovalProposals)
			.where(eq(workApprovalProposals.orgId, p.orgId))
			.groupBy(
				sql`CASE WHEN ${workApprovalProposals.status}='pending' AND ${workApprovalProposals.expiresAt}<=${p.now} THEN 'expired' ELSE ${workApprovalProposals.status} END`,
			),
		db
			.select({
				key: sql<string>`CASE WHEN ${workInteractions.status}='open' AND ${workInteractions.expiresAt} IS NOT NULL AND ${workInteractions.expiresAt}<=${p.now} THEN 'expired' ELSE ${workInteractions.status} END`.as(
					"key",
				),
				count: sql<number>`COUNT(*)`.as("count"),
				awaiting:
					sql<number>`SUM(CASE WHEN ${workInteractions.status}='open' AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now}) THEN 1 ELSE 0 END)`.as(
						"awaiting",
					),
				overdue:
					sql<number>`SUM(CASE WHEN ${workInteractions.status}='open' AND ${workInteractions.dueAt} IS NOT NULL AND ${workInteractions.dueAt}<${p.now} AND (${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now}) THEN 1 ELSE 0 END)`.as(
						"overdue",
					),
			})
			.from(workInteractions)
			.where(eq(workInteractions.orgId, p.orgId))
			.groupBy(
				sql`CASE WHEN ${workInteractions.status}='open' AND ${workInteractions.expiresAt} IS NOT NULL AND ${workInteractions.expiresAt}<=${p.now} THEN 'expired' ELSE ${workInteractions.status} END`,
			),
		db
			.select({
				resourceKey: workResourcePools.resourceKey,
				capacity: workResourcePools.capacity,
				activeReserved:
					sql<number>`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id="work_resource_pools"."org_id" AND r.pool_id="work_resource_pools"."id" AND r.state='active' AND r.expires_at>${p.now}),0)`.as(
						"active_reserved",
					),
				consumed:
					sql<number>`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id="work_resource_pools"."org_id" AND r.pool_id="work_resource_pools"."id" AND r.state='consumed'),0)`.as(
						"consumed",
					),
			})
			.from(workResourcePools)
			.where(
				and(
					eq(workResourcePools.orgId, p.orgId),
					eq(workResourcePools.enabled, true),
				),
			)
			.limit(5000),
		db
			.select({
				scopeType: workBudgetEnvelopes.scopeType,
				limitMicros: workBudgetEnvelopes.limitMicros,
				activeReservedMicros:
					sql<number>`COALESCE((SELECT SUM(r.amount_micros) FROM work_budget_reservations r WHERE r.org_id="work_budget_envelopes"."org_id" AND r.envelope_id="work_budget_envelopes"."id" AND r.state='active' AND r.expires_at>${p.now}),0)`.as(
						"active_reserved_micros",
					),
				consumedMicros:
					sql<number>`COALESCE((SELECT SUM(COALESCE(r.consumed_micros,r.amount_micros)) FROM work_budget_reservations r WHERE r.org_id="work_budget_envelopes"."org_id" AND r.envelope_id="work_budget_envelopes"."id" AND r.state='consumed'),0)`.as(
						"consumed_micros",
					),
			})
			.from(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.enabled, true),
				),
			)
			.limit(5000),
	]);
	const workBy = countMap(workItemRows);
	const attemptBy = countMap(attemptRows);
	const admissionBy = countMap(admissionRows);
	const approvalBy = countMap(approvalRows);
	const interactionBy = countMap(interactionRows);
	const saturated = resourceRows.filter(
		(row) => row.activeReserved >= row.capacity,
	);
	const scope = (
		scopeType: "organization" | "project" | "case" | "work_item",
	) => {
		const rows = budgetRows.filter((row) => row.scopeType === scopeType);
		const limitMicros = rows.reduce((n, row) => n + row.limitMicros, 0);
		const activeReservedMicros = rows.reduce(
			(n, row) => n + row.activeReservedMicros,
			0,
		);
		const consumedMicros = rows.reduce((n, row) => n + row.consumedMicros, 0);
		return {
			envelopeCount: rows.length,
			limitMicros,
			activeReservedMicros,
			consumedMicros,
			availableMicros: Math.max(
				0,
				limitMicros - activeReservedMicros - consumedMicros,
			),
			exhaustedEnvelopeCount: rows.filter(
				(row) =>
					row.activeReservedMicros + row.consumedMicros >= row.limitMicros,
			).length,
		};
	};
	const staleLeases = attemptRows.reduce((n, row) => n + row.stale, 0);
	const actionableStaleLeases = attemptRows.reduce(
		(n, row) => n + row.staleActionable,
		0,
	);
	const latestRejected = latestRejectedRows[0]?.count ?? 0;
	const awaitingDecision = approvalBy.pending ?? 0;
	const awaitingResponse = interactionRows.reduce(
		(n, row) => n + row.awaiting,
		0,
	);
	const exhaustedBudgets = budgetRows.filter(
		(row) => row.activeReservedMicros + row.consumedMicros >= row.limitMicros,
	).length;
	const attentionActions = [
		{
			key: "exhausted_budgets" as const,
			severity: "critical" as const,
			count: exhaustedBudgets,
			label: "Restore budget capacity",
			rationale:
				"Exhausted envelopes prevent otherwise eligible work from being admitted.",
			href: "/work/capacity" as const,
		},
		{
			key: "stale_attempt_leases" as const,
			severity: "critical" as const,
			count: actionableStaleLeases,
			label: "Recover stale Attempts",
			rationale:
				"Elapsed execution leases need recovery before their work can be admitted again.",
			href: "/work/attempts" as const,
		},
		{
			key: "rejected_admissions" as const,
			severity: "high" as const,
			count: latestRejected,
			label: "Resolve admission blockers",
			rationale:
				"Current admission rejections identify work that cannot start under canonical policy.",
			href: "/work/admission" as const,
		},
		{
			key: "saturated_resources" as const,
			severity: "high" as const,
			count: saturated.length,
			label: "Relieve resource saturation",
			rationale:
				"Saturated pools serialize or block new Attempts that require their capacity.",
			href: "/work/capacity" as const,
		},
		{
			key: "overdue_interactions" as const,
			severity: "high" as const,
			count: interactionRows.reduce((n, row) => n + row.overdue, 0),
			label: "Answer overdue interactions",
			rationale:
				"Overdue targeted responses can hold admitted work in a durable waiting state.",
			href: "/work/interactions" as const,
		},
		{
			key: "approval_backlog" as const,
			severity: "medium" as const,
			count: awaitingDecision,
			label: "Decide pending approvals",
			rationale:
				"Pending authority decisions keep accepted work outside admission.",
			href: "/work/approvals" as const,
		},
		{
			key: "interaction_backlog" as const,
			severity: "medium" as const,
			count: Math.max(
				0,
				awaitingResponse -
					interactionRows.reduce((n, row) => n + row.overdue, 0),
			),
			label: "Respond to open interactions",
			rationale:
				"Open questions, inputs, and handoffs may be the next dependency for waiting work.",
			href: "/work/interactions" as const,
		},
	].filter((action) => action.count > 0);
	return {
		observedAt: p.now,
		workItems: { total: sum(workItemRows), byDisposition: workBy },
		attempts: {
			total: sum(attemptRows),
			byRuntimeState: attemptBy,
			active: attemptRows.reduce((n, row) => n + row.active, 0),
			staleLeases,
			withoutAdmission: attemptRows.reduce(
				(n, row) => n + row.withoutAdmission,
				0,
			),
		},
		admissions: {
			total: sum(admissionRows),
			byEffectiveState: admissionBy,
			latestRejected,
		},
		approvals: {
			total: sum(approvalRows),
			byEffectiveStatus: approvalBy,
			awaitingDecision,
		},
		interactions: {
			total: sum(interactionRows),
			byEffectiveState: interactionBy,
			awaitingResponse,
			overdue: interactionRows.reduce((n, row) => n + row.overdue, 0),
		},
		resources: {
			poolCount: resourceRows.length,
			totalCapacity: resourceRows.reduce((n, row) => n + row.capacity, 0),
			activeReserved: resourceRows.reduce(
				(n, row) => n + row.activeReserved,
				0,
			),
			consumed: resourceRows.reduce((n, row) => n + row.consumed, 0),
			saturatedPoolCount: saturated.length,
			saturatedResourceKeys: saturated.map((row) => row.resourceKey),
		},
		budgets: {
			envelopeCount: budgetRows.length,
			byScope: {
				organization: scope("organization"),
				project: scope("project"),
				case: scope("case"),
				work_item: scope("work_item"),
			},
		},
		attention: {
			staleAttemptLeases: actionableStaleLeases,
			rejectedAdmissions: latestRejected,
			approvalBacklog: awaitingDecision,
			interactionBacklog: awaitingResponse,
			saturatedResources: saturated.length,
			exhaustedBudgets,
			actions: attentionActions,
		},
	};
}
