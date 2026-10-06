/**
 * Scheduled Maintenance Query Helpers
 * Drizzle ORM queries for cron-triggered retention cleanup.
 */

import { lt, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { auditEvents } from "../../schema/audit-events";
import {
	appCatalogChanges,
	appCatalogHealthHistory,
	appCatalogToolTests,
} from "../../schema/catalog";
import { skillUsageEvents } from "../../schema/cognitive";
import {
	kernelRuntimeEvents,
	tediRuntimeEvents,
} from "../../schema/cognitive-runtime";
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

/**
 * Delete audit event records older than N days.
 * audit_events.timestamp is integer (unix epoch), not text.
 * Returns number of deleted records.
 */
export async function deleteOldAuditEvents(db: DbClient, days = 90) {
	const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
	const result = await db
		.delete(auditEvents)
		.where(lt(auditEvents.timestamp, new Date(cutoff * 1000)));
	return getAffectedRows(result);
}

/**
 * Batched retention delete for `tedi_runtime_events` — the hottest table on the
 * platform (the documented D1-overload hotspot; ~80% of all D1 reads, zero
 * prior retention).
 *
 * Deletes rows older than `days` (default 90, matching `audit_events`). An
 * unbatched `DELETE ... WHERE created_at < cutoff` would open ONE transaction
 * over the whole over-retention set — the exact D1-overload risk we are
 * avoiding. We delete in bounded batches via the portable SQLite idiom
 * `DELETE ... WHERE id IN (SELECT id ... LIMIT n)`; D1 does NOT support
 * `DELETE ... LIMIT`. `created_at` is stored as ISO-8601 (`toISOString()`), so
 * the cutoff is an ISO string (NOT `datetime('now', ...)`, whose space-format
 * mis-sorts against the 'T'/'Z' ISO rows), mirroring `deleteOldWorkflowRunRecords`.
 * `maxBatches` caps work per cron tick so a historical backlog drains over
 * successive nights, never in one giant run. Uses the standalone
 * `idx_tedi_runtime_events_created` index for a cheap range seek + early LIMIT
 * stop. The IN-subquery binds zero per-row params, so it is immune to D1's
 * 100-bound-param limit.
 */
export async function deleteOldTediRuntimeEvents(
	db: DbClient,
	days = 90,
	batchSize = 5_000,
	maxBatches = 40,
): Promise<number> {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db
			.delete(tediRuntimeEvents)
			.where(
				sql`${tediRuntimeEvents.id} in (select ${tediRuntimeEvents.id} from ${tediRuntimeEvents} where ${tediRuntimeEvents.createdAt} < ${cutoff} limit ${batchSize})`,
			);
		const rows = getAffectedRows(result);
		deleted += rows;
		if (rows < batchSize) break;
	}
	return deleted;
}

/**
 * Batched retention delete for `kernel_runtime_events` (Home/kernel event
 * ledger). Same idiom/rationale as `deleteOldTediRuntimeEvents`. Safe against
 * the Home sidebar: `listConversations` reads the durable `kernel_conversations`
 * projection, not these raw events, so pruning old events never drops a
 * conversation. Uses the standalone `idx_kernel_runtime_events_created` index.
 */
export async function deleteOldKernelRuntimeEvents(
	db: DbClient,
	days = 90,
	batchSize = 5_000,
	maxBatches = 40,
): Promise<number> {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db
			.delete(kernelRuntimeEvents)
			.where(
				sql`${kernelRuntimeEvents.id} in (select ${kernelRuntimeEvents.id} from ${kernelRuntimeEvents} where ${kernelRuntimeEvents.createdAt} < ${cutoff} limit ${batchSize})`,
			);
		const rows = getAffectedRows(result);
		deleted += rows;
		if (rows < batchSize) break;
	}
	return deleted;
}

/**
 * Shared batched-retention primitive (the deleteOldTediRuntimeEvents idiom).
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
 * reasoning as `deleteOldTediRuntimeEvents`; contrast the datetime() group below.
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
