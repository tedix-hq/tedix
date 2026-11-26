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
import { coreTable } from "../core-store/client";
import { tediApprovalRequests } from "../schema/approvals";
import { auditReadTable, readAuditStores } from "./audit-delivery";
import { skillEntries } from "../schema/cognitive";
import { tediCronExecutions } from "../schema/cron-executions";
import { compareTimestampId, mergeLogStoreRows } from "../utils/log-store";

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
	const table = coreTable(db, tediApprovalRequests);
	const rows = await db
		.select({
			tediId: table.tediId,
			count: sql<number>`count(*)`,
		})
		.from(table)
		.where(and(eq(table.orgId, organizationId), eq(table.status, "pending")))
		.groupBy(table.tediId);
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
	const table = coreTable(db, skillEntries);
	const rows = await db
		.select({
			tediId: table.tediId,
			count: sql<number>`count(*)`,
		})
		.from(table)
		.where(
			and(
				eq(table.organizationId, organizationId),
				isNotNull(table.reviewFlaggedAt),
				sql`coalesce(${table.lifecycleState}, 'draft') <> 'archived'`,
			),
		)
		.groupBy(table.tediId);
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
	const table = coreTable(db, tediCronExecutions);
	const rows = await db
		.select({
			tediId: table.tediId,
			fires: sql<number>`count(*)`,
			failures: sql<number>`sum(case when ${table.status} = 'failure' then 1 else 0 end)`,
			lastFireAt: sql<string | null>`max(${table.startedAt})`,
		})
		.from(table)
		.where(and(eq(table.orgId, organizationId), gte(table.startedAt, sinceIso)))
		.groupBy(table.tediId);
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
	const read = async (store: DbClient) => {
		const auditEvents = auditReadTable(store);
		return store
			.select({
				id: auditEvents.id,
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
			.orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
			.limit(limit);
	};
	const pages = await readAuditStores(db, read);
	const rows = pages
		? mergeLogStoreRows(pages, { compare: compareTimestampId("desc"), limit })
		: await read(db);
	return rows.map(({ id: _id, ...row }) => row);
}
