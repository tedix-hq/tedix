/**
 * App Catalog Queries — same-vendor variants.
 *
 * One vendor often appears several times in `app_catalog`: per-store endpoint
 * variants, plus non-runnable listings (first-party directory cards,
 * store-brokered connectors, rows with no MCP endpoint) next to a runnable
 * sibling. Vendor identity is the registrable website domain plus the
 * normalized display name — the same identity `extractVendorDomain` and
 * `normalizeVendorName` define. Rows with the same name on different domains
 * are different companies and never match.
 *
 * The identity and runnability are expressed in SQL so list browsing can hide
 * shadowed rows in the same statement (no per-row queries, no bound-param
 * growth) and detail reads agree with the list about which row is canonical.
 */

import { and, eq, ne, or, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { appCatalog } from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

type CatalogVendorColumns = {
	website: SQLiteColumn;
	name: SQLiteColumn;
	connectorType: SQLiteColumn;
	baseUrl: SQLiteColumn;
	mcpEndpointNormalized: SQLiteColumn;
	mcpToolCount: SQLiteColumn;
	mcpResourceCount: SQLiteColumn;
	mcpPromptCount: SQLiteColumn;
	developerType: SQLiteColumn;
	isDiscoverable: SQLiteColumn;
	status: SQLiteColumn;
	reviewStatus: SQLiteColumn;
};

/**
 * SQL mirror of `extractVendorDomain(website)`: lowercased host without a
 * scheme, path, query, fragment, port or leading `www.`; NULL when empty.
 */
function vendorDomainSql(table: CatalogVendorColumns): SQL {
	const unschemed = sql`replace(replace(lower(trim(${table.website})), 'https://', ''), 'http://', '')`;
	const delimited = sql`replace(replace(replace(${unschemed}, '?', '/'), '#', '/'), ':', '/')`;
	const host = sql`substr(${delimited}, 1, instr(${delimited} || '/', '/') - 1)`;
	return sql`nullif(substr(${host}, CASE WHEN ${host} LIKE 'www.%' THEN 5 ELSE 1 END), '')`;
}

/**
 * SQL mirror of `normalizeVendorName(name)`: trimmed, lowercased, internal
 * whitespace collapsed (runs of up to 16 characters); NULL when empty.
 */
function vendorNameSql(table: CatalogVendorColumns): SQL {
	let collapsed = sql`replace(replace(replace(lower(${table.name}), char(9), ' '), char(10), ' '), char(13), ' ')`;
	for (let pass = 0; pass < 4; pass += 1) {
		collapsed = sql`replace(${collapsed}, '  ', ' ')`;
	}
	return sql`nullif(trim(${collapsed}), '')`;
}

/** `domain|name` vendor key, NULL when either half is missing. */
export function catalogVendorKeySql(table: CatalogVendorColumns): SQL {
	return sql`(${vendorDomainSql(table)} || '|' || ${vendorNameSql(table)})`;
}

/**
 * True (1) when the row has something Tedix can run: it is not a first-party
 * directory card, and it has discovered MCP inventory or is an MCP connector
 * with an endpoint. Mirrors the endpoint/inventory half of the API's
 * `calculateCatalogInstallability`: rows that are false here are exactly the
 * `listing_only`, `service_connector` and `needs_mcp_endpoint` states.
 */
export function catalogRunnableSql(table: CatalogVendorColumns): SQL {
	const connector = sql`coalesce(${table.connectorType}, '')`;
	const inventory = sql`(coalesce(${table.mcpToolCount}, 0) + coalesce(${table.mcpResourceCount}, 0) + coalesce(${table.mcpPromptCount}, 0))`;
	const hasEndpoint = sql`(coalesce(${table.mcpEndpointNormalized}, '') <> '' OR coalesce(${table.baseUrl}, '') <> '')`;
	return sql`(${connector} <> 'FIRST_PARTY_ECOSYSTEM' AND (${inventory} > 0 OR (${connector} = 'MCP' AND ${hasEndpoint})))`;
}

export interface CatalogVisibilityOptions {
	/** Include untrusted/non-discoverable/disabled apps (admin only). */
	includeAll?: boolean;
	/** Include apps whose review_status is not RELEASED (admin only). */
	includeUnreleased?: boolean;
}

/** The public catalog visibility filter used by list browsing. */
export function catalogVisibilityConditions(
	table: CatalogVendorColumns,
	options: CatalogVisibilityOptions = {},
): SQL[] {
	const conditions: SQL[] = [];
	if (!options.includeAll) {
		const trusted = or(
			eq(table.developerType, "TRUSTED_PARTNER"),
			eq(table.developerType, "OAI"),
			eq(table.developerType, "THIRD_PARTY"),
		);
		if (trusted) conditions.push(trusted);
		conditions.push(eq(table.isDiscoverable, true));
		conditions.push(eq(table.status, "ENABLED"));
	}
	if (!options.includeUnreleased) {
		conditions.push(eq(table.reviewStatus, "RELEASED"));
	}
	return conditions;
}

/**
 * List-filter condition: keep a row unless it is non-runnable AND a runnable,
 * visible sibling with the same vendor key exists. The sibling set is a
 * non-correlated subquery, so SQLite evaluates it once per statement. A NULL
 * key (no website or name) never matches, so such rows are always kept.
 */
export function buildHideShadowedVariantsCondition(
	db: Database,
	options: CatalogVisibilityOptions = {},
): SQL {
	const sibling = alias(appCatalog, "vendor_sibling");
	const siblingKey = catalogVendorKeySql(sibling);
	const runnableVendorKeys = db
		.select({ vendorKey: sql<string>`${siblingKey}`.as("vendor_key") })
		.from(sibling)
		.where(
			and(
				catalogRunnableSql(sibling),
				...catalogVisibilityConditions(sibling, options),
			),
		);
	return sql`NOT (NOT ${catalogRunnableSql(appCatalog)} AND coalesce(${catalogVendorKeySql(appCatalog)} IN ${runnableVendorKeys}, 0))`;
}

export interface CatalogVendorVariantRow {
	id: string;
	slug: string | null;
	name: string;
	connectorType: string | null;
	status: string | null;
	baseUrl: string | null;
	mcpEndpointNormalized: string | null;
	mcpToolCount: number | null;
	mcpResourceCount: number | null;
	mcpPromptCount: number | null;
	primarySource: string | null;
	runnable: boolean;
}

const VARIANT_LIMIT = 20;

/**
 * Publicly visible same-vendor siblings of one catalog app (excluding the app
 * itself). One statement; the vendor key of the anchor row is resolved in a
 * scalar subquery so detail and list use the identical identity expression.
 */
export async function listCatalogVendorVariants(
	db: Database,
	catalogAppId: string,
	options: CatalogVisibilityOptions = {},
): Promise<CatalogVendorVariantRow[]> {
	const anchor = alias(appCatalog, "vendor_anchor");
	const anchorKey = db
		.select({
			vendorKey: sql<string>`${catalogVendorKeySql(anchor)}`.as("vendor_key"),
		})
		.from(anchor)
		.where(eq(anchor.id, catalogAppId))
		.limit(1);
	const rows = await db
		.select({
			id: appCatalog.id,
			slug: appCatalog.slug,
			name: appCatalog.name,
			connectorType: appCatalog.connectorType,
			status: appCatalog.status,
			baseUrl: appCatalog.baseUrl,
			mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
			mcpToolCount: appCatalog.mcpToolCount,
			mcpResourceCount: appCatalog.mcpResourceCount,
			mcpPromptCount: appCatalog.mcpPromptCount,
			primarySource: sql<string | null>`(
				SELECT source FROM app_catalog_store_listings
				WHERE catalog_app_id = ${sql.identifier("app_catalog")}.${sql.identifier("id")}
				ORDER BY CASE source
					WHEN 'official' THEN 0 WHEN 'tedix' THEN 1 WHEN 'chatgpt' THEN 2
					WHEN 'claude' THEN 3 WHEN 'community' THEN 4 WHEN 'manual' THEN 5
					ELSE 100 END, source
				LIMIT 1
			)`.as("primary_source"),
			runnable: sql<number>`${catalogRunnableSql(appCatalog)}`.as(
				"variant_runnable",
			),
		})
		.from(appCatalog)
		.where(
			and(
				ne(appCatalog.id, catalogAppId),
				...catalogVisibilityConditions(appCatalog, options),
				sql`${catalogVendorKeySql(appCatalog)} = (${anchorKey})`,
			),
		)
		.orderBy(
			sql`${catalogRunnableSql(appCatalog)} DESC`,
			sql`coalesce(${appCatalog.mcpToolCount}, 0) DESC`,
			appCatalog.name,
			appCatalog.id,
		)
		.limit(VARIANT_LIMIT);
	return rows.map((row) => ({ ...row, runnable: Boolean(row.runnable) }));
}
