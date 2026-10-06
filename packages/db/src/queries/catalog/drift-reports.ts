/**
 * App Catalog Queries — Upstream drift reports.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
	type UpstreamDriftReport,
	upstreamDriftReports,
} from "../../schema/catalog";
import { getAffectedRows } from "../../utils/d1-result";
import type { Database, ToolDriftReportItem } from "./tool-source-policy";

// =============================================================================
// UPSTREAM DRIFT REPORTS
// =============================================================================

export interface SaveDriftReportOptions {
	catalogAppId: string;
	catalogAppName: string;
	addedTools: number;
	removedTools: number;
	changedTools: number;
	drifts: ToolDriftReportItem[];
	summary: string;
}

/**
 * Save (upsert) a drift report for a catalog app.
 * One report per catalog app — replaces previous report on each scan.
 */
export async function saveDriftReport(
	db: Database,
	opts: SaveDriftReportOptions,
): Promise<UpstreamDriftReport> {
	const {
		catalogAppId,
		catalogAppName,
		addedTools,
		removedTools,
		changedTools,
		drifts,
		summary,
	} = opts;
	const id = crypto.randomUUID();
	const checkedAt = new Date().toISOString();

	// Atomic upsert keyed by catalog_app_id (one report per catalog app).
	// Replaces previous non-atomic delete-then-insert which produced
	// duplicate rows under overlapping cron runs / interleaved writes.
	const result = await db
		.insert(upstreamDriftReports)
		.values({
			id,
			catalogAppId,
			catalogAppName,
			addedTools,
			removedTools,
			changedTools,
			drifts,
			summary,
			checkedAt,
		})
		.onConflictDoUpdate({
			target: upstreamDriftReports.catalogAppId,
			set: {
				catalogAppName,
				addedTools,
				removedTools,
				changedTools,
				drifts,
				summary,
				checkedAt,
				resolvedAt: null,
			},
		})
		.returning();

	return result[0]!;
}

export async function resolveDriftReport(
	db: Database,
	catalogAppId: string,
	resolvedAt = new Date().toISOString(),
): Promise<number> {
	const result = await db
		.update(upstreamDriftReports)
		.set({ resolvedAt })
		.where(
			and(
				eq(upstreamDriftReports.catalogAppId, catalogAppId),
				isNull(upstreamDriftReports.resolvedAt),
			),
		);
	return getAffectedRows(result);
}

/**
 * Get latest drift reports at the catalog level.
 * Optionally filter by a specific catalog app.
 */
export async function getLatestDriftReports(
	db: Database,
	opts?: { catalogAppId?: string; limit?: number },
): Promise<UpstreamDriftReport[]> {
	const conditions = [];
	if (opts?.catalogAppId) {
		conditions.push(eq(upstreamDriftReports.catalogAppId, opts.catalogAppId));
	}

	const query = db
		.select()
		.from(upstreamDriftReports)
		.orderBy(desc(upstreamDriftReports.checkedAt));

	if (conditions.length > 0) {
		return query.where(and(...conditions)).limit(opts?.limit ?? 100);
	}

	return query.limit(opts?.limit ?? 100);
}

/**
 * Delete old drift reports (retention cleanup).
 */
export async function deleteOldDriftReports(
	db: Database,
	daysOld: number,
): Promise<number> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysOld);
	const cutoffStr = cutoff.toISOString();

	const result = await db
		.delete(upstreamDriftReports)
		.where(
			and(
				sql`${upstreamDriftReports.checkedAt} < ${cutoffStr}`,
				sql`${upstreamDriftReports.resolvedAt} IS NOT NULL`,
			),
		);

	return getAffectedRows(result);
}
