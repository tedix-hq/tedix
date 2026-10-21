/**
 * Scheduled Maintenance Query Helpers
 * Drizzle ORM queries for cron-triggered retention cleanup.
 */

import { lt, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import {
	appCatalogChanges,
	appCatalogHealthHistory,
	appCatalogToolTests,
} from "../../schema/catalog";
import { skillUsageEvents } from "../../schema/cognitive";
import { tediCronExecutions } from "../../schema/cron-executions";
import {
	harnessEvalResults,
	harnessEvalRuns,
	traceBundles,
} from "../../schema/harness-versions";
import { learningInteractionEvents } from "../../schema/learning-feedback";
import { runtimeSubmissions } from "../../schema/runtime-submissions";
import { getAffectedRows } from "../../utils/d1-result";

/**
 * Delete health history records older than N days.
 * Returns number of deleted records.
 */
export async function deleteOldHealthHistory(db: DbClient, days = 30) {
	const result = await db
		.delete(appCatalogHealthHistory)
		.where(
			lt(
				appCatalogHealthHistory.checkedAt,
				sql`datetime('now', ${`-${days} days`})`,
			),
		);
	return getAffectedRows(result);
}

/**
 * Delete tool test records older than N days.
 * Returns number of deleted records.
 */
export async function deleteOldToolTests(db: DbClient, days = 30) {
	const result = await db
		.delete(appCatalogToolTests)
		.where(
			lt(
				appCatalogToolTests.testedAt,
				sql`datetime('now', ${`-${days} days`})`,
			),
		);
	return getAffectedRows(result);
}

// audit_events, tedi_runtime_events and kernel_runtime_events are no longer
// deleted here. Their retention is policy-driven (`queries/d1-retention.ts`,
// `d1_retention_policies`): rows leave the main database only after a
// verified copy exists in the logs database and in R2.

/**
 * Shared batched-retention primitive (the `DELETE ... WHERE id IN (SELECT ... LIMIT n)` idiom).
 * Deletes rows older than `cutoff` in bounded batches via the portable SQLite
 * idiom `DELETE ... WHERE id IN (SELECT id ... LIMIT n)` (D1 has no
 * `DELETE ... LIMIT`); `maxBatches` caps work per cron tick so a historical
 * backlog drains over successive nights. The IN-subquery binds zero per-row
 * params (immune to D1's 100-bound-param limit). `cutoff` MUST match the
 * column's stored format: an ISO string for columns the writer stamps via
 * toISOString(), or a `datetime('now', '-N days')` SQL fragment for columns left
 * on the CURRENT_TIMESTAMP (space-format) default — mixing formats mis-sorts.
 */
async function deleteOldRowsBatched(
	db: DbClient,
	table: SQLiteTable,
	idColumn: AnySQLiteColumn,
	tsColumn: AnySQLiteColumn,
	cutoff: SQL | string,
	batchSize = 5_000,
	maxBatches = 40,
): Promise<number> {
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db
			.delete(table)
			.where(
				sql`${idColumn} in (select ${idColumn} from ${table} where ${tsColumn} < ${cutoff} limit ${batchSize})`,
			);
		const rows = getAffectedRows(result);
		deleted += rows;
		if (rows < batchSize) break;
	}
	return deleted;
}

const isoCutoff = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString();
const dtCutoff = (days: number): SQL =>
	sql`datetime('now', ${`-${days} days`})`;

// --- ISO timestamp column (writer stamps toISOString()) -> ISO cutoff ---

/**
 * skill_usage_events. 90d. success/failure_count are incremental rollups on
 * skill_entries, so pruning events never loses the aggregate counts.
 */
export function deleteOldSkillUsageEvents(db: DbClient, days = 90) {
	return deleteOldRowsBatched(
		db,
		skillUsageEvents,
		skillUsageEvents.id,
		skillUsageEvents.createdAt,
		isoCutoff(days),
	);
}

/** harness_eval_results. 180d — before/after + promotion/rollback evidence. */
export function deleteOldHarnessEvalResults(db: DbClient, days = 180) {
	return deleteOldRowsBatched(
		db,
		harnessEvalResults,
		harnessEvalResults.id,
		harnessEvalResults.createdAt,
		isoCutoff(days),
	);
}

/** harness_eval_runs. 180d. */
export function deleteOldHarnessEvalRuns(db: DbClient, days = 180) {
	return deleteOldRowsBatched(
		db,
		harnessEvalRuns,
		harnessEvalRuns.id,
		harnessEvalRuns.createdAt,
		isoCutoff(days),
	);
}

/**
 * trace_bundles. 180d — episodic evidence for harness before/after comparison
 * (raw bodies live in R2 via bundle_uri; this prunes the D1 index rows).
 */
export function deleteOldTraceBundles(db: DbClient, days = 180) {
	return deleteOldRowsBatched(
		db,
		traceBundles,
		traceBundles.id,
		traceBundles.createdAt,
		isoCutoff(days),
	);
}

/**
 * app_catalog_changes. 90d (matches `audit_events`) — non-financial catalog-diff
 * telemetry (field-level sync diffs + added/removed/version_bump lifecycle
 * events). It had NO retention policy and grew pure-append to 115,949 rows,
 * dominated by a single May sync spike (62,518 rows in 2026-05 alone). Nothing
 * reads it beyond the recent-changes UI feeds (`getCatalogAppChanges` /
 * `getRecentCatalogChanges`, both `ORDER BY detected_at DESC LIMIT n`), so old
 * rows are dead weight. The health-history sibling in the same cron uses 30d;
 * 90d here keeps a full quarter of diff history for drift investigation.
 *
 * TIMESTAMP FORMAT: `detected_at` stores ISO-8601 Z ("2026-03-23T09:22:39.075Z")
 * — every writer stamps `new Date().toISOString()` (upsert-sync, sync-logs,
 * merge), and a live check confirmed 115,949/115,949 rows in ISO-Z form with
 * ZERO space-format rows despite the column's `CURRENT_TIMESTAMP` default. So the
 * cutoff is an ISO string, NOT `datetime('now', ...)`: `datetime()` returns
 * space-format ("2026-05-06 09:53:31") and because 'T' (0x54) > ' ' (0x20), a
 * space-format cutoff compares WRONG against ISO-Z data on same-day rows. Same
 * reasoning as the ISO-cutoff deleters above; contrast the datetime() group below.
 *
 * Batched via the shared `deleteOldRowsBatched` idiom — an unbatched DELETE over
 * the ~100k-row over-retention set would be one oversized D1 transaction on a
 * 2.8GB database. Neither existing index is a standalone `detected_at` index
 * (both are composite: `idx_catalog_changes_app`, `idx_catalog_changes_type`), so
 * each batch is a filtered scan that stops early at the subquery LIMIT.
 */
export function deleteOldCatalogChanges(
	db: DbClient,
	days = 90,
	batchSize = 5_000,
	maxBatches = 40,
) {
	return deleteOldRowsBatched(
		db,
		appCatalogChanges,
		appCatalogChanges.id,
		appCatalogChanges.detectedAt,
		isoCutoff(days),
		batchSize,
		maxBatches,
	);
}

// --- space-format created_at (CURRENT_TIMESTAMP default) -> datetime() cutoff ---

/**
 * tedi_cron_executions. 90d. created_at is left on the CURRENT_TIMESTAMP
 * default (the flywheel writer stamps started_at, not created_at).
 */
export function deleteOldCronExecutions(db: DbClient, days = 90) {
	return deleteOldRowsBatched(
		db,
		tediCronExecutions,
		tediCronExecutions.id,
		tediCronExecutions.createdAt,
		dtCutoff(days),
	);
}

/**
 * runtime_submissions. 90d — recovery/reserved-sweep only reads recent
 * non-terminal rows (keyed off updated_at within minutes). Child
 * runtime_submission_attempts cascade-delete via the submission_id FK
 * (onDelete:"cascade"; D1 enforces FKs), so no separate attempts sweep.
 */
export function deleteOldRuntimeSubmissions(db: DbClient, days = 90) {
	return deleteOldRowsBatched(
		db,
		runtimeSubmissions,
		runtimeSubmissions.id,
		runtimeSubmissions.createdAt,
		dtCutoff(days),
	);
}

/**
 * learning_interaction_events. 180d — prune on ingest age (created_at, the
 * CURRENT_TIMESTAMP default); attributions/measurements/proposals reference
 * these for longer-range before/after windows so keep them well past 90d.
 */
export function deleteOldLearningInteractionEvents(db: DbClient, days = 180) {
	return deleteOldRowsBatched(
		db,
		learningInteractionEvents,
		learningInteractionEvents.id,
		learningInteractionEvents.createdAt,
		dtCutoff(days),
	);
}
