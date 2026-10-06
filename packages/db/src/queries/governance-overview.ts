/**
 * Governance overview reads (flywheel remodel P5 #3 — the Weill & Ross
 * one-pager). Every query here is org-scoped, windowed, and grouped so the
 * whole overview stays cheap: one grouped count per ledger instead of a
 * per-tedi fan-out.
 *
 * The pace-layer portfolio read deliberately lives in skill-portfolio.ts
 * (`getSkillPortfolioBalance`) — the overview reuses it rather than growing a
 * second layer-semantics implementation.
 */

import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { tediApprovalRequests } from "../schema/approvals";
import { auditEvents } from "../schema/audit-events";
import { skillEntries } from "../schema/cognitive";
import { tediCronExecutions } from "../schema/cron-executions";

/** Grouped count keyed by tedi. `tediId: null` = org-scoped rows. */
export interface TediGovernanceCount {
	tediId: string | null;
	count: number;
}

/**
 * Pending human-in-the-loop approval requests per tedi
 * (tedi_approval_requests, status = pending).
 */
export async function countPendingApprovalsByTedi(
	db: DbClient,
	organizationId: string,
): Promise<TediGovernanceCount[]> {
	const rows = await db
		.select({
			tediId: tediApprovalRequests.tediId,
			count: sql<number>`count(*)`,
		})
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, organizationId),
				eq(tediApprovalRequests.status, "pending"),
			),
		)
		.groupBy(tediApprovalRequests.tediId);
	return rows.map((row) => ({ tediId: row.tediId, count: Number(row.count) }));
}

/**
 * Review-flagged skills per tedi: the record-layer safety valve
 * (`skill_entries.review_flagged_at`, set by recordSkillUsageEvent when a
 * crystallized skill fails instead of auto-demoting; cleared by a human).
 * Archived rows are out of scope. `tediId: null` = org-scoped skills.
 */
export async function countReviewFlaggedSkillsByTedi(
	db: DbClient,
	organizationId: string,
): Promise<TediGovernanceCount[]> {
	const rows = await db
		.select({
			tediId: skillEntries.tediId,
			count: sql<number>`count(*)`,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, organizationId),
				isNotNull(skillEntries.reviewFlaggedAt),
				sql`coalesce(${skillEntries.lifecycleState}, 'draft') <> 'archived'`,
			),
		)
		.groupBy(skillEntries.tediId);
	return rows.map((row) => ({ tediId: row.tediId, count: Number(row.count) }));
}

export interface TediCronExecutionSummary {
	tediId: string;
	fires: number;
	failures: number;
	lastFireAt: string | null;
}

/**
 * Windowed per-tedi summary over the mechanical cron execution ledger
 * (tedi_cron_executions — evidence stamps, not self-reported prose).
 */
export async function summarizeCronExecutionsByTedi(
	db: DbClient,
	organizationId: string,
	sinceIso: string,
): Promise<TediCronExecutionSummary[]> {
	const rows = await db
		.select({
			tediId: tediCronExecutions.tediId,
			fires: sql<number>`count(*)`,
			failures: sql<number>`sum(case when ${tediCronExecutions.status} = 'failure' then 1 else 0 end)`,
			lastFireAt: sql<string | null>`max(${tediCronExecutions.startedAt})`,
		})
		.from(tediCronExecutions)
		.where(
			and(
				eq(tediCronExecutions.orgId, organizationId),
				gte(tediCronExecutions.startedAt, sinceIso),
			),
		)
		.groupBy(tediCronExecutions.tediId);
	return rows.map((row) => ({
		tediId: row.tediId,
		fires: Number(row.fires),
		failures: Number(row.failures ?? 0),
		lastFireAt: row.lastFireAt ?? null,
	}));
}

/**
 * The audit_events actions the governance feed queries. Every entry is
 * verified to have a live writer in apps/api — do not add aspirational
 * actions here (gate graduations and mutation-gate rejections write NO
 * audit row today; the overview derives/declares those separately).
 */
export const GOVERNANCE_AUDIT_ACTIONS = [
	// tedis/crud.ts updateTediProcedure — config + governance-field changes.
	"tedi.config_change",
	// tedis/crud.ts governance endpoint (toolPolicy/selfImprovementPolicy/budgets).
	"tedi.governance.updated",
	// tedi-approvals router + approval-workflow — the human approval queue.
	"approval.requested",
	"approval.approved",
	"approval.rejected",
	// kernel write-proposal resolution (human plan approval trail).
	"home.plan.approved",
	"home.plan.rejected",
] as const;

export interface GovernanceAuditEventRow {
	action: string;
	actorId: string;
	actorType: string;
	resourceType: string;
	resourceId: string | null;
	timestamp: Date;
	metadata: Record<string, unknown> | null;
}

/** Most recent governance-relevant audit events, capped. */
export async function listGovernanceAuditEvents(
	db: DbClient,
	organizationId: string,
	limit = 10,
): Promise<GovernanceAuditEventRow[]> {
	const rows = await db
		.select({
			action: auditEvents.action,
			actorId: auditEvents.actorId,
			actorType: auditEvents.actorType,
			resourceType: auditEvents.resourceType,
			resourceId: auditEvents.resourceId,
			timestamp: auditEvents.timestamp,
			metadata: auditEvents.metadata,
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, organizationId),
				inArray(auditEvents.action, [...GOVERNANCE_AUDIT_ACTIONS]),
			),
		)
		.orderBy(desc(auditEvents.timestamp))
		.limit(limit);
	return rows;
}
