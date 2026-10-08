/**
 * App Catalog Queries — Catalog maintenance (scheduled handler).
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { appCatalog } from "../../schema/catalog";
import { chunkForBoundParams } from "../../utils/batch";
import { getAffectedRows } from "../../utils/d1-result";
import type { Database } from "./tool-source-policy";

// =============================================================================
// CATALOG MAINTENANCE (Scheduled Handler)
// =============================================================================

/**
 * Count discoverable apps that have been unhealthy for more than the given number of days.
 * Uses the raw `health_checked_at` D1 column (not in Drizzle schema).
 * Used by the scheduled cron to detect stale unhealthy apps.
 */
export async function getStaleUnhealthyAppCount(
	db: Database,
	days = 14,
): Promise<number> {
	const row = await db
		.select({
			staleCount: sql<number>`COUNT(*)`,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.healthStatus, "unhealthy"),
				sql`health_checked_at < datetime('now', ${`-${days} days`})`,
				eq(appCatalog.isDiscoverable, true),
			),
		)
		.then((rows) => rows[0]);

	return row?.staleCount ?? 0;
}

/**
 * Auto-hide apps that have been unhealthy for more than the given number of days.
 * Uses the raw `health_checked_at` D1 column (not in Drizzle schema).
 * Sets `is_discoverable = 0`. Returns the number of apps hidden.
 */
export async function autoHideUnhealthyCatalogApps(
	db: Database,
	days = 30,
): Promise<number> {
	const result = await db
		.update(appCatalog)
		// Visibility flip is a state change, and the sibling policy-timer write in
		// this same cron block (autoDisableDeadMcpCatalogApps) already bumps. The
		// selection predicate never reads updatedAt and the write clears its own
		// guard, so this fires at most once per app.
		.set({ isDiscoverable: false, updatedAt: sql`datetime('now')` })
		.where(
			and(
				eq(appCatalog.healthStatus, "unhealthy"),
				sql`health_checked_at < datetime('now', ${`-${days} days`})`,
				eq(appCatalog.isDiscoverable, true),
			),
		);

	return getAffectedRows(result);
}

/**
 * Disable MCP catalog rows that repeatedly scan as dead and have no usable MCP
 * surface. These rows should not stay installable: they have no tools,
 * resources, or prompts, and repeated scan failures show there is nothing a
 * user can currently connect to.
 */
export async function autoDisableDeadMcpCatalogApps(
	db: Database,
	options: {
		minConsecutiveFailures?: number;
		minLastScanAgeHours?: number;
		limit?: number;
	} = {},
): Promise<{ disabled: number; appIds: string[] }> {
	const {
		minConsecutiveFailures = 3,
		minLastScanAgeHours = 24,
		limit = 100,
	} = options;
	const cutoff = new Date(
		Date.now() - minLastScanAgeHours * 60 * 60 * 1000,
	).toISOString();

	const candidates = await db
		.select({ id: appCatalog.id })
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`,
				inArray(appCatalog.healthStatus, ["blocked", "unhealthy"]),
				eq(appCatalog.mcpToolCount, 0),
				eq(appCatalog.mcpResourceCount, 0),
				eq(appCatalog.mcpPromptCount, 0),
				sql`COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0) >= ${minConsecutiveFailures}`,
				or(
					sql`json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL`,
					sql`json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${cutoff}`,
				),
			),
		)
		.orderBy(
			desc(
				sql`COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0)`,
			),
			asc(sql`json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt')`),
		)
		.limit(limit);

	const appIds = candidates.map((candidate) => candidate.id);
	if (appIds.length === 0) {
		return { disabled: 0, appIds: [] };
	}

	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	let disabled = 0;
	for (const chunk of chunkForBoundParams(appIds, 50)) {
		const result = await db
			.update(appCatalog)
			.set({
				status: "DISABLED",
				isDiscoverable: false,
				updatedAt: sql`datetime('now')`,
			})
			.where(inArray(appCatalog.id, chunk));
		disabled += getAffectedRows(result);
	}

	return {
		disabled,
		appIds,
	};
}

/**
 * Auto-delist apps that have not been synced for more than the given number of days.
 * Sets `status = 'DELISTED'` and `is_discoverable = 0`. Returns the number of apps delisted.
 */
export async function autoDelistStaleCatalogApps(
	db: Database,
	days = 21,
): Promise<number> {
	const result = await db
		.update(appCatalog)
		// Lifecycle status transition — the clearest "this catalog record changed"
		// of the three maintenance writes. Cannot poison the API staleness signal,
		// which reads `lastSyncedAt ?? updatedAt`, and lastSyncedAt is non-null by
		// construction for a delist candidate.
		.set({
			status: "DELISTED",
			isDiscoverable: false,
			updatedAt: sql`datetime('now')`,
		})
		.where(
			and(
				sql`${appCatalog.lastSyncedAt} < datetime('now', ${`-${days} days`})`,
				eq(appCatalog.status, "ENABLED"),
			),
		);

	return getAffectedRows(result);
}

/**
 * Get catalog-wide aggregate stats (total, MCP count, enabled count).
 * Used by catalog sync workflow for before/after changelog diffs.
 */
export async function getCatalogSnapshotStats(
	db: Database,
): Promise<{ total: number; mcpCount: number; enabledCount: number }> {
	const row = await db
		.select({
			total: sql<number>`COUNT(*)`,
			mcpCount: sql<number>`COUNT(CASE WHEN connector_type = 'MCP' THEN 1 END)`,
			enabledCount: sql<number>`COUNT(CASE WHEN status = 'ENABLED' THEN 1 END)`,
		})
		.from(appCatalog)
		.then((rows) => rows[0]);

	return row ?? { total: 0, mcpCount: 0, enabledCount: 0 };
}

/**
 * List one deterministic page of enabled catalog apps for vector index sync.
 * Pagination stays in the query owner so Workflow steps can keep each remote
 * AI Search upload batch bounded without loading the full catalog into memory.
 */
export async function listEnabledCatalogAppsForVectorSync(
	db: Database,
	options: { limit: number; afterId?: string },
) {
	return db
		.select({
			id: appCatalog.id,
			slug: appCatalog.slug,
			name: appCatalog.name,
			description: appCatalog.description,
			modelDescription: appCatalog.modelDescription,
			developer: appCatalog.developer,
			category: appCatalog.category,
			categories: appCatalog.categories,
			keywordsForDiscovery: appCatalog.keywordsForDiscovery,
			keywordsForTriggering: appCatalog.keywordsForTriggering,
			seoDescription: appCatalog.seoDescription,
			healthStatus: appCatalog.healthStatus,
			mcpToolCount: appCatalog.mcpToolCount,
			mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
			connectorType: appCatalog.connectorType,
			hasWrites: appCatalog.hasWrites,
			hasInteractive: appCatalog.hasInteractive,
		})
		.from(appCatalog)
		.where(
			options.afterId
				? and(
						eq(appCatalog.status, "ENABLED"),
						gt(appCatalog.id, options.afterId),
					)
				: eq(appCatalog.status, "ENABLED"),
		)
		.orderBy(asc(appCatalog.id))
		.limit(options.limit);
}
