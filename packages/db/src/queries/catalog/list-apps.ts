/**
 * App Catalog Queries — List apps.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import {
	getCatalogCategoryAliases,
	normalizeCatalogCategory,
} from "@tedix/api-contract/utils/catalog-categories";
import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import {
	appCatalog,
	appCatalogMcpTools,
	type CatalogApp,
	type Category,
	type ConnectorType,
	type DeveloperType,
	type HealthStatus,
	type Source,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";
import {
	buildHideShadowedVariantsCondition,
	catalogVisibilityConditions,
} from "./vendor-variants";

// =============================================================================
// LIST APPS
// =============================================================================

export interface ListCatalogAppsOptions {
	search?: string;
	/** AI Search candidates to union with lexical matches and blend into relevance. */
	semanticMatches?: ReadonlyArray<{ id: string; score: number }>;
	category?: string;
	connectorType?: string;
	developerType?: string;
	source?: Source;
	hasInteractive?: boolean;
	hasWrites?: boolean;
	healthStatus?: string;
	region?: string;
	/** Filter by tag in the categories JSON array */
	tag?: string;
	sortBy?:
		| "sourceCreatedAt"
		| "updatedAt"
		| "lastSyncedAt"
		| "name"
		| "relevance";
	sortDir?: "asc" | "desc";
	limit?: number;
	offset?: number;
	/** If true, includes untrusted/non-discoverable apps (admin only) */
	includeAll?: boolean;
	/** If true, includes apps with review_status != RELEASED (admin only) */
	includeUnreleased?: boolean;
	/**
	 * If true, omits non-runnable rows (listing-only, store-brokered, no MCP
	 * endpoint) that have a runnable, visible same-vendor sibling. Their detail
	 * pages stay resolvable by slug. Public listings read the precomputed
	 * `exploreShadowed` flag; admin listings compute it live.
	 */
	hideShadowedVariants?: boolean;
}

export function canonicalCatalogCategory(
	category: string | null | undefined,
): Category | null {
	return normalizeCatalogCategory(category) as Category | null;
}

function catalogCategoryFilterValues(category: string): Category[] {
	return getCatalogCategoryAliases(category) as Category[];
}

/**
 * List catalog apps with filtering and pagination
 */
export async function listCatalogApps(
	db: Database,
	options: ListCatalogAppsOptions = {},
): Promise<{
	apps: CatalogApp[];
	total: number;
}> {
	const {
		search,
		semanticMatches,
		category,
		connectorType,
		developerType,
		source,
		hasInteractive,
		hasWrites,
		healthStatus,
		region,
		tag,
		sortBy,
		sortDir,
		limit = 100,
		offset = 0,
		includeAll = false,
		includeUnreleased = false,
		hideShadowedVariants = false,
	} = options;

	// Default: only trusted, discoverable, enabled, RELEASED apps
	const conditions: Array<SQL | undefined> = catalogVisibilityConditions(
		appCatalog,
		{ includeAll, includeUnreleased },
	);

	if (hideShadowedVariants) {
		conditions.push(
			buildHideShadowedVariantsCondition(db, { includeAll, includeUnreleased }),
		);
	}

	// Search filter — searches across all discoverable text fields
	// Use LOWER() + LIKE for case-insensitive search in SQLite (D1 doesn't support ILIKE)
	// JSON array fields (keywords, categories) are cast to text and matched with LIKE
	const normalizedSearch = search?.trim().toLowerCase() ?? "";
	const normalizedSemanticMatches = (semanticMatches ?? []).filter(
		(match) => match.id && Number.isFinite(match.score),
	);
	const semanticMatchesJson =
		normalizedSemanticMatches.length > 0
			? JSON.stringify(normalizedSemanticMatches)
			: null;
	if (normalizedSearch) {
		const searchPattern = `%${normalizedSearch}%`;
		const lexicalCondition = or(
			sql`LOWER(${appCatalog.name}) LIKE ${searchPattern}`,
			sql`LOWER(${appCatalog.description}) LIKE ${searchPattern}`,
			sql`LOWER(${appCatalog.developer}) LIKE ${searchPattern}`,
			sql`LOWER(${appCatalog.slug}) LIKE ${searchPattern}`,
			sql`LOWER(${appCatalog.modelDescription}) LIKE ${searchPattern}`,
			sql`LOWER(${appCatalog.seoDescription}) LIKE ${searchPattern}`,
			sql`LOWER(CAST(${appCatalog.keywordsForDiscovery} AS TEXT)) LIKE ${searchPattern}`,
			sql`LOWER(CAST(${appCatalog.keywordsForTriggering} AS TEXT)) LIKE ${searchPattern}`,
			sql`LOWER(CAST(${appCatalog.categories} AS TEXT)) LIKE ${searchPattern}`,
			sql`LOWER(CAST(${appCatalog.subCategories} AS TEXT)) LIKE ${searchPattern}`,
			sql`EXISTS (
					SELECT 1 FROM ${appCatalogMcpTools}
					WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
						AND ${appCatalogMcpTools.removedAt} IS NULL
						AND (
							LOWER(${appCatalogMcpTools.toolName}) LIKE ${searchPattern}
							OR LOWER(${appCatalogMcpTools.title}) LIKE ${searchPattern}
							OR LOWER(${appCatalogMcpTools.description}) LIKE ${searchPattern}
						)
				)`,
		);
		conditions.push(
			semanticMatchesJson
				? or(
						lexicalCondition,
						sql`${appCatalog.id} IN (
							SELECT json_extract(value, '$.id')
							FROM json_each(${semanticMatchesJson})
						)`,
					)
				: lexicalCondition,
		);
	}

	// Category filter
	if (category) {
		const categoryValues = catalogCategoryFilterValues(category);
		conditions.push(
			categoryValues.length > 0
				? // bound-params: fixed category->values mapping from
					// catalogCategoryFilterValues, never caller data
					inArray(appCatalog.category, categoryValues)
				: sql`1 = 0`,
		);
	}

	// Connector type filter
	if (connectorType) {
		conditions.push(
			eq(appCatalog.connectorType, connectorType as ConnectorType),
		);
	}

	// Developer type filter
	if (developerType) {
		conditions.push(
			eq(appCatalog.developerType, developerType as DeveloperType),
		);
	}

	// Source filter — store_listings owns the per-store source
	if (source) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM app_catalog_store_listings WHERE catalog_app_id = ${appCatalog.id} AND source = ${source})`,
		);
	}

	// Capability filters
	if (hasInteractive !== undefined) {
		conditions.push(eq(appCatalog.hasInteractive, hasInteractive));
	}

	if (hasWrites !== undefined) {
		conditions.push(eq(appCatalog.hasWrites, hasWrites));
	}

	// Region filter — store_listings owns the per-store regions
	if (region) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM app_catalog_store_listings WHERE catalog_app_id = ${appCatalog.id} AND json_array_length(regions) > 0 AND regions LIKE ${`%"${region}"%`})`,
		);
	}

	// Health status filter
	if (healthStatus) {
		conditions.push(eq(appCatalog.healthStatus, healthStatus as HealthStatus));
	}

	// Tag filter - search within the categories JSON array
	if (tag) {
		conditions.push(sql`${appCatalog.categories} LIKE ${`%"${tag}"%`}`);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	// Sorting
	const effectiveSortBy = sortBy ?? (normalizedSearch ? "relevance" : "name");
	const effectiveSortDir =
		sortDir ?? (effectiveSortBy === "name" ? "asc" : "desc");

	let orderBy: Array<ReturnType<typeof asc> | ReturnType<typeof desc> | SQL> =
		[];
	// COALESCE so apps without source_created_at (NATIVE, SERVICE, Claude entries
	// missing createdOn) sort by first_seen_at instead of falling to the bottom.
	const effectiveDate = sql`COALESCE(${appCatalog.sourceCreatedAt}, json_extract(${appCatalog.firstSeen}, '$.at'))`;
	switch (effectiveSortBy) {
		case "relevance": {
			const exact = normalizedSearch;
			const prefix = `${normalizedSearch}%`;
			const contains = `%${normalizedSearch}%`;
			const lexicalRank = sql`(
				CASE
					WHEN LOWER(${appCatalog.name}) = ${exact} THEN 1000
					WHEN LOWER(${appCatalog.slug}) = ${exact} THEN 950
					WHEN LOWER(${appCatalog.name}) LIKE ${prefix} THEN 850
					WHEN LOWER(${appCatalog.developer}) = ${exact} THEN 780
					WHEN LOWER(${appCatalog.slug}) LIKE ${prefix} THEN 740
					WHEN LOWER(${appCatalog.developer}) LIKE ${prefix} THEN 700
					WHEN LOWER(${appCatalog.name}) LIKE ${contains} THEN 620
					WHEN LOWER(${appCatalog.category}) LIKE ${contains} THEN 560
					WHEN LOWER(${appCatalog.developer}) LIKE ${contains} THEN 520
					WHEN EXISTS (
						SELECT 1 FROM ${appCatalogMcpTools}
						WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
							AND ${appCatalogMcpTools.removedAt} IS NULL
							AND (
								LOWER(${appCatalogMcpTools.toolName}) LIKE ${contains}
								OR LOWER(${appCatalogMcpTools.title}) LIKE ${contains}
							)
					) THEN 460
					WHEN LOWER(CAST(${appCatalog.keywordsForTriggering} AS TEXT)) LIKE ${contains} THEN 420
					WHEN LOWER(CAST(${appCatalog.keywordsForDiscovery} AS TEXT)) LIKE ${contains} THEN 380
					WHEN LOWER(${appCatalog.seoDescription}) LIKE ${contains} THEN 300
					WHEN LOWER(${appCatalog.description}) LIKE ${contains} THEN 260
					WHEN LOWER(${appCatalog.modelDescription}) LIKE ${contains} THEN 220
					WHEN EXISTS (
						SELECT 1 FROM ${appCatalogMcpTools}
						WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
							AND ${appCatalogMcpTools.removedAt} IS NULL
							AND LOWER(${appCatalogMcpTools.description}) LIKE ${contains}
					) THEN 180
					ELSE 0
				END
				+ CASE WHEN ${appCatalog.healthStatus} IN ('healthy', 'degraded', 'requires_auth') THEN 30 ELSE 0 END
				+ CASE WHEN COALESCE(${appCatalog.mcpToolCount}, 0) > 0 THEN 20 ELSE 0 END
			)`;
			const semanticRank = semanticMatchesJson
				? sql`COALESCE((
					SELECT CAST(json_extract(value, '$.score') AS REAL) * 500
					FROM json_each(${semanticMatchesJson})
					WHERE json_extract(value, '$.id') = ${appCatalog.id}
				), 0)`
				: sql`0`;
			const searchRank = sql`(${lexicalRank} + ${semanticRank})`;
			orderBy = [desc(searchRank), asc(appCatalog.name)];
			break;
		}
		case "sourceCreatedAt":
			orderBy = [
				effectiveSortDir === "asc" ? asc(effectiveDate) : desc(effectiveDate),
				asc(appCatalog.name),
			];
			break;
		case "updatedAt":
			orderBy = [
				effectiveSortDir === "asc"
					? asc(appCatalog.updatedAt)
					: desc(appCatalog.updatedAt),
				asc(appCatalog.name),
			];
			break;
		case "lastSyncedAt":
			orderBy = [
				effectiveSortDir === "asc"
					? asc(appCatalog.lastSyncedAt)
					: desc(appCatalog.lastSyncedAt),
				asc(appCatalog.name),
			];
			break;
		default:
			orderBy = [
				effectiveSortDir === "desc"
					? desc(appCatalog.name)
					: asc(appCatalog.name),
			];
	}

	// Get total count
	const total = await db.$count(appCatalog, whereClause);

	const apps = await db
		.select()
		.from(appCatalog)
		.where(whereClause)
		.orderBy(...orderBy)
		.limit(limit)
		.offset(offset);

	return { apps, total };
}
