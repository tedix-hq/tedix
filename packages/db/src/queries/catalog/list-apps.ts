/**
 * App Catalog Queries — List apps.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import {
	getCatalogCategoryAliases,
	normalizeCatalogCategory,
} from "@tedix/api-contract/utils/catalog-categories";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	ne,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import {
	type CatalogApp,
	type Category,
	type ConnectorType,
	type DeveloperType,
	type HealthStatus,
	type Source,
} from "../../schema/catalog";
import { coreStore, jsonRead } from "../../core-store/dialect";
import { prefixedColumns } from "../../utils/select";
import { catalogTables } from "./catalog-tables";
import { catalogFeedKey } from "./sync-logs";
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

/** SQLite LOWER() + LIKE folded ASCII only; translate() matches that on Postgres. */
function lowerLike(db: Database, expr: SQLWrapper, pattern: string): SQL {
	return coreStore(db) === "postgres"
		? sql`translate(${expr}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE ${pattern}`
		: sql`LOWER(${expr}) LIKE ${pattern}`;
}

function lowerEq(db: Database, expr: SQLWrapper, value: string): SQL {
	return coreStore(db) === "postgres"
		? sql`translate(${expr}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = ${value}`
		: sql`LOWER(${expr}) = ${value}`;
}

function asText(db: Database, column: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`${column}::text`
		: sql`CAST(${column} AS TEXT)`;
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
	const postgres = coreStore(db) === "postgres";
	const {
		appCatalog,
		appCatalogBrowseTotals,
		appCatalogMcpTools,
		appCatalogStoreListings,
	} = catalogTables(db);
	const mcpToolsTable = postgres
		? sql`catalog.app_catalog_mcp_tools`
		: sql`app_catalog_mcp_tools`;
	const storeListingsTable = postgres
		? sql`catalog.app_catalog_store_listings`
		: sql`app_catalog_store_listings`;

	// Default: only trusted, discoverable, enabled, RELEASED apps
	const conditions: Array<SQL | undefined> = catalogVisibilityConditions(
		db,
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
			lowerLike(db, appCatalog.name, searchPattern),
			lowerLike(db, appCatalog.description, searchPattern),
			lowerLike(db, appCatalog.developer, searchPattern),
			lowerLike(db, appCatalog.slug, searchPattern),
			lowerLike(db, appCatalog.modelDescription, searchPattern),
			lowerLike(db, appCatalog.seoDescription, searchPattern),
			lowerLike(db, asText(db, appCatalog.keywordsForDiscovery), searchPattern),
			lowerLike(
				db,
				asText(db, appCatalog.keywordsForTriggering),
				searchPattern,
			),
			lowerLike(db, asText(db, appCatalog.categories), searchPattern),
			lowerLike(db, asText(db, appCatalog.subCategories), searchPattern),
			sql`EXISTS (
					SELECT 1 FROM ${mcpToolsTable}
					WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
						AND ${appCatalogMcpTools.removedAt} IS NULL
						AND (
							${lowerLike(db, appCatalogMcpTools.toolName, searchPattern)}
							OR ${lowerLike(db, appCatalogMcpTools.title, searchPattern)}
							OR ${lowerLike(db, appCatalogMcpTools.description, searchPattern)}
						)
				)`,
		);
		const semanticIds = normalizedSemanticMatches.map((match) => match.id);
		conditions.push(
			semanticMatchesJson && semanticIds.length > 0
				? or(lexicalCondition, inArray(appCatalog.id, semanticIds))
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
			sql`EXISTS (SELECT 1 FROM ${storeListingsTable} WHERE catalog_app_id = ${appCatalog.id} AND source = ${source})`,
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
			postgres
				? sql`EXISTS (SELECT 1 FROM ${storeListingsTable} WHERE catalog_app_id = ${appCatalog.id} AND jsonb_array_length(regions) > 0 AND regions::text LIKE ${`%"${region}"%`})`
				: sql`EXISTS (SELECT 1 FROM ${storeListingsTable} WHERE catalog_app_id = ${appCatalog.id} AND json_array_length(regions) > 0 AND regions LIKE ${`%"${region}"%`})`,
		);
	}

	// Health status filter
	if (healthStatus) {
		conditions.push(eq(appCatalog.healthStatus, healthStatus as HealthStatus));
	}

	// Tag filter - search within the categories JSON array
	if (tag) {
		conditions.push(
			sql`${asText(db, appCatalog.categories)} LIKE ${`%"${tag}"%`}`,
		);
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
	const effectiveDate = sql`COALESCE(${appCatalog.sourceCreatedAt}, ${jsonRead(db, appCatalog.firstSeen, ["at"])})`;
	switch (effectiveSortBy) {
		case "relevance": {
			const exact = normalizedSearch;
			const prefix = `${normalizedSearch}%`;
			const contains = `%${normalizedSearch}%`;
			const lexicalRank = sql`(
				CASE
					WHEN ${lowerEq(db, appCatalog.name, exact)} THEN 1000
					WHEN ${lowerEq(db, appCatalog.slug, exact)} THEN 950
					WHEN ${lowerLike(db, appCatalog.name, prefix)} THEN 850
					WHEN ${lowerEq(db, appCatalog.developer, exact)} THEN 780
					WHEN ${lowerLike(db, appCatalog.slug, prefix)} THEN 740
					WHEN ${lowerLike(db, appCatalog.developer, prefix)} THEN 700
					WHEN ${lowerLike(db, appCatalog.name, contains)} THEN 620
					WHEN ${lowerLike(db, appCatalog.category, contains)} THEN 560
					WHEN ${lowerLike(db, appCatalog.developer, contains)} THEN 520
					WHEN EXISTS (
						SELECT 1 FROM ${mcpToolsTable}
						WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
							AND ${appCatalogMcpTools.removedAt} IS NULL
							AND (
								${lowerLike(db, appCatalogMcpTools.toolName, contains)}
								OR ${lowerLike(db, appCatalogMcpTools.title, contains)}
							)
					) THEN 460
					WHEN ${lowerLike(db, asText(db, appCatalog.keywordsForTriggering), contains)} THEN 420
					WHEN ${lowerLike(db, asText(db, appCatalog.keywordsForDiscovery), contains)} THEN 380
					WHEN ${lowerLike(db, appCatalog.seoDescription, contains)} THEN 300
					WHEN ${lowerLike(db, appCatalog.description, contains)} THEN 260
					WHEN ${lowerLike(db, appCatalog.modelDescription, contains)} THEN 220
					WHEN EXISTS (
						SELECT 1 FROM ${mcpToolsTable}
						WHERE ${appCatalogMcpTools.catalogAppId} = ${appCatalog.id}
							AND ${appCatalogMcpTools.removedAt} IS NULL
							AND ${lowerLike(db, appCatalogMcpTools.description, contains)}
					) THEN 180
					ELSE 0
				END
				+ CASE WHEN ${appCatalog.healthStatus} IN ('healthy', 'degraded', 'requires_auth') THEN 30 ELSE 0 END
				+ CASE WHEN COALESCE(${appCatalog.mcpToolCount}, 0) > 0 THEN 20 ELSE 0 END
			)`;
			const semanticRank = semanticMatchesJson
				? postgres
					? sql`COALESCE((
						SELECT (match.value->>'score')::double precision * 500
						FROM jsonb_array_elements(${semanticMatchesJson}::jsonb) AS match(value)
						WHERE match.value->>'id' = ${appCatalog.id}
					), 0)`
					: sql`COALESCE((
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

	const unfilteredPublicBrowse =
		!includeAll &&
		!includeUnreleased &&
		!normalizedSearch &&
		!category &&
		!connectorType &&
		!developerType &&
		!source &&
		hasInteractive === undefined &&
		hasWrites === undefined &&
		!healthStatus &&
		!region &&
		!tag;
	const nameIndex = postgres
		? appCatalog
		: hideShadowedVariants
			? sql`${appCatalog} INDEXED BY app_catalog_explore_name_idx`
			: sql`${appCatalog} INDEXED BY app_catalog_public_browse_name_idx`;

	// A public page filtered by category or health status. Left to itself
	// SQLite reads every discoverable app for the count and again for the page
	// (18,560 rows each on 17 Nov 2026, whatever the category). The filter's own
	// index reads only the apps of that category or status.
	const filterIndex =
		postgres || includeAll || includeUnreleased || normalizedSearch
			? null
			: category && catalogCategoryFilterValues(category).length > 0
				? sql`${appCatalog} INDEXED BY app_catalog_category_idx`
				: healthStatus
					? sql`${appCatalog} INDEXED BY app_catalog_health_status_idx`
					: null;
	if (filterIndex) {
		const [counted] = await db
			.select({
				total: sql<number>`count(*)`.as("total"),
				browseTotal: sql<number | null>`(SELECT ${
					hideShadowedVariants
						? appCatalogBrowseTotals.exploreTotal
						: appCatalogBrowseTotals.total
				} FROM ${appCatalogBrowseTotals} WHERE ${appCatalogBrowseTotals.id} = 'public')`.as(
					"browseTotal",
				),
			})
			.from(filterIndex)
			.where(whereClause);
		const total = Number(counted?.total ?? 0);
		// Nothing on this page: the page read would return no rows.
		if (offset >= total) return { apps: [], total };

		// A page by name of a category alone can also walk the public name
		// index and keep the apps of the category until the page is full. That
		// reads about (offset + limit) × catalog size ÷ category size apps, so
		// it only pays for a category much larger than the page; the factor of
		// 4 allows for a category whose names are not spread evenly. Otherwise
		// the category's own apps are read and sorted.
		const byNameOfCategoryAlone =
			effectiveSortBy === "name" &&
			Boolean(category) &&
			!connectorType &&
			!developerType &&
			!source &&
			hasInteractive === undefined &&
			hasWrites === undefined &&
			!healthStatus &&
			!region &&
			!tag;
		const browseTotal = counted?.browseTotal ?? null;
		const walkNames =
			byNameOfCategoryAlone &&
			browseTotal !== null &&
			4 * (offset + limit) * browseTotal <= total * total;
		// Both ways read the same page: apps with one name keep table order.
		const tableOrder = sql`${appCatalog}."rowid"`;
		const apps = await db
			.select(prefixedColumns(appCatalog, "catalog"))
			.from(walkNames ? nameIndex : filterIndex)
			.where(whereClause)
			.orderBy(
				...(effectiveSortBy === "name"
					? effectiveSortDir === "desc"
						? [desc(appCatalog.name), desc(tableOrder)]
						: [asc(appCatalog.name), asc(tableOrder)]
					: orderBy),
			)
			.limit(limit)
			.offset(offset);
		return { apps, total };
	}

	// Contains search cannot seek text; narrow by status before matching it.
	const countSource =
		!postgres && normalizedSearch && healthStatus
			? sql`${appCatalog} INDEXED BY app_catalog_health_status_idx`
			: appCatalog;
	const total = unfilteredPublicBrowse
		? await getPublicBrowseTotal(db, hideShadowedVariants)
		: await db
				.select({ total: count() })
				.from(countSource)
				.where(whereClause)
				.then((rows) => Number(rows[0]?.total ?? 0));

	const browseTable =
		unfilteredPublicBrowse && effectiveSortBy === "name"
			? nameIndex
			: appCatalog;
	const apps = await db
		.select(prefixedColumns(appCatalog, "catalog"))
		.from(browseTable)
		.where(whereClause)
		.orderBy(...orderBy)
		.limit(limit)
		.offset(offset);

	return { apps, total };
}

/** Dated observations on publicly visible ChatGPT listings. Counts belong to
 * individual sweeps and cannot be summed into a shared query population. */
export async function listPublicChatgptObservations(
	db: Database,
	feedKey: string,
	offset: number,
	limit: number,
) {
	const postgres = coreStore(db) === "postgres";
	const { appCatalog, appCatalogStoreListings: listings } = catalogTables(db);
	// Bound as a parameter; catalogFeedKey also admits only a plain identifier.
	const key = catalogFeedKey(feedKey);
	const observation = jsonRead(
		db,
		listings.rawData,
		[key, "searchObservation"],
		"json",
	);
	const listingName = sql<
		string | null
	>`nullif(${jsonRead(db, observation, ["name"])}, '')`;
	const browsable = and(
		eq(appCatalog.status, "ENABLED"),
		eq(appCatalog.isDiscoverable, true),
	);
	const matchedCount = jsonRead(
		db,
		observation,
		["matchedCount"],
		"number",
	) as unknown as SQL<number>;
	const checkedAt = jsonRead(db, observation, ["checkedAt"]) as SQL<string>;
	const queryCount = jsonRead(
		db,
		observation,
		["queryCount"],
		"number",
	) as unknown as SQL<number>;
	return db
		.select({
			name: sql<string>`coalesce(${listingName}, ${appCatalog.name})`.as(
				"listing_name",
			),
			slug: sql<
				string | null
			>`case when ${browsable} and (${listingName} is null or ${listingName} = ${appCatalog.name}) then ${appCatalog.slug} end`.as(
				"catalog_slug",
			),
			storeUrl: listings.storeUrl,
			sourceAppId: listings.sourceAppId,
			checkedAt: checkedAt.as("checkedAt"),
			matchedCount: matchedCount.as("matchedCount"),
			queryCount: queryCount.as("queryCount"),
		})
		.from(listings)
		.innerJoin(appCatalog, eq(appCatalog.id, listings.catalogAppId))
		.where(
			and(
				eq(listings.source, "chatgpt"),
				eq(listings.reviewStatus, "RELEASED"),
				eq(appCatalog.reviewStatus, "RELEASED"),
				inArray(appCatalog.developerType, [
					"TRUSTED_PARTNER",
					"OAI",
					"THIRD_PARTY",
				]),
				inArray(appCatalog.status, ["ENABLED", "DISABLED"]),
				sql`coalesce(${jsonRead(db, listings.rawData, [key, "visibility"])}, 'public') <> 'private'`,
				// Health maintenance can hide or disable a connector while its native
				// store listing still has a public, dated search observation.
				or(
					browsable,
					and(
						sql`${listingName} is not null`,
						sql`${listings.storeUrl} like 'https://chatgpt.com/apps/%'`,
					),
				),
				sql`${matchedCount} >= 0`,
				sql`${queryCount} > 0`,
				postgres
					? sql`${checkedAt} ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}'`
					: sql`datetime(${checkedAt}) IS NOT NULL`,
			),
		)
		.orderBy(desc(matchedCount), asc(listings.sourceAppId))
		.limit(limit)
		.offset(offset);
}

export async function listPublicCatalogSitemapSlugs(
	db: Database,
): Promise<string[]> {
	const { appCatalog } = catalogTables(db);
	const rows = await db
		.select({ slug: sql<string>`${appCatalog.slug}`.as("slug") })
		.from(
			coreStore(db) === "postgres"
				? appCatalog
				: sql`${appCatalog} INDEXED BY app_catalog_explore_name_idx`,
		)
		.where(
			and(
				...catalogVisibilityConditions(db, appCatalog),
				buildHideShadowedVariantsCondition(db),
				ne(appCatalog.connectorType, "FIRST_PARTY_ECOSYSTEM"),
				ne(appCatalog.slug, ""),
			),
		)
		.orderBy(asc(appCatalog.name));
	return rows.map(({ slug }) => slug);
}

async function getPublicBrowseTotal(
	db: Database,
	hideShadowedVariants: boolean,
): Promise<number> {
	const { appCatalogBrowseTotals } = catalogTables(db);
	const [row] = await db
		.select({
			total: hideShadowedVariants
				? appCatalogBrowseTotals.exploreTotal
				: appCatalogBrowseTotals.total,
		})
		.from(appCatalogBrowseTotals)
		.where(eq(appCatalogBrowseTotals.id, "public"))
		.limit(1);
	if (!row) throw new Error("Catalog browse totals migration is missing");
	return row.total;
}
