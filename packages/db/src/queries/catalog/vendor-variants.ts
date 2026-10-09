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
 * The identity and runnability are expressed in SQL so the shadowed-variant
 * refresh is one set-based statement (no per-row queries, no bound-param
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
/** Discovered MCP tools + resources + prompts. */
export function catalogInventorySql(table: CatalogVendorColumns): SQL {
	return sql`(coalesce(${table.mcpToolCount}, 0) + coalesce(${table.mcpResourceCount}, 0) + coalesce(${table.mcpPromptCount}, 0))`;
}

export function catalogRunnableSql(table: CatalogVendorColumns): SQL {
	const connector = sql`coalesce(${table.connectorType}, '')`;
	const inventory = catalogInventorySql(table);
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
 * The ids the public catalog list hides as shadowed vendor variants: a row is
 * shadowed when it is non-runnable beside a runnable visible sibling, has no
 * inventory beside a stocked sibling, or is a stocked row that is not its
 * vendor's first card (plain slug first, then most stocked). A NULL vendor key
 * (no website or name) never matches, so such rows are never shadowed.
 *
 * One pass over the visible catalog: each row's vendor key, inventory and
 * runnability are computed once, and window functions compare it with its
 * vendor group. This is a full-catalog scan, so the public list reads the
 * precomputed `explore_shadowed` flag that `refreshCatalogShadowedVariants`
 * maintains instead of evaluating it per request.
 */
function shadowedCatalogIdsQuery(
	db: Database,
	options: CatalogVisibilityOptions = {},
) {
	const sibling = alias(appCatalog, "vendor_sibling");
	const key = catalogVendorKeySql(sibling);
	const inventory = catalogInventorySql(sibling);
	const runnable = sql`(CASE WHEN ${catalogRunnableSql(sibling)} THEN 1 ELSE 0 END)`;
	const stocked = sql`(CASE WHEN ${inventory} > 0 THEN 1 ELSE 0 END)`;
	const grouped = db
		.select({
			id: sql<string>`${sibling.id}`.as("grouped_id"),
			runnable: sql<number>`${runnable}`.as("grouped_runnable"),
			stocked: sql<number>`${stocked}`.as("grouped_stocked"),
			groupRunnable:
				sql<number>`max(${runnable}) OVER (PARTITION BY ${key})`.as(
					"group_runnable",
				),
			groupStocked: sql<number>`max(${stocked}) OVER (PARTITION BY ${key})`.as(
				"group_stocked",
			),
			rank: sql<number>`row_number() OVER (PARTITION BY ${key} ORDER BY ${stocked} DESC, (${sibling.slug} GLOB '*-[0-9]*') ASC, ${inventory} DESC, ${sibling.id} ASC)`.as(
				"group_rank",
			),
		})
		.from(sibling)
		.where(
			and(
				sql`${key} IS NOT NULL`,
				...catalogVisibilityConditions(sibling, options),
			),
		)
		.as("vendor_grouped");
	return db
		.select({ id: grouped.id })
		.from(grouped)
		.where(
			sql`(${grouped.runnable} = 0 AND ${grouped.groupRunnable} = 1) OR (${grouped.stocked} = 0 AND ${grouped.groupStocked} = 1) OR (${grouped.stocked} = 1 AND ${grouped.rank} > 1)`,
		);
}

/**
 * List-filter condition: keep a row unless it is a shadowed vendor variant.
 *
 * Public visibility (the default) reads the precomputed `explore_shadowed`
 * flag, which is computed against public visibility. Admin visibility
 * (`includeAll` / `includeUnreleased`) widens the sibling set, so it keeps the
 * live window subquery: rare, and never stale.
 */
export function buildHideShadowedVariantsCondition(
	db: Database,
	options: CatalogVisibilityOptions = {},
): SQL {
	if (!options.includeAll && !options.includeUnreleased) {
		return eq(appCatalog.exploreShadowed, false);
	}
	return sql`${appCatalog.id} NOT IN ${shadowedCatalogIdsQuery(db, options)}`;
}

export interface RefreshCatalogShadowedVariantsResult {
	/** Rows newly flagged as shadowed. */
	flagged: number;
	/** Rows whose shadowed flag was cleared. */
	cleared: number;
}

/**
 * The two unexecuted statements that recompute `explore_shadowed` against
 * public visibility: flag newly shadowed rows, then clear rows that are no
 * longer shadowed. Only rows whose flag changes are written, and `updated_at`
 * is left alone: the flag is derived list state, not an app edit. Append them
 * to a write batch that changes vendor grouping, runnability, inventory or
 * visibility so the flag commits with the write.
 */
export function buildRefreshCatalogShadowedVariantsStatements(db: Database) {
	const flag = db
		.update(appCatalog)
		.set({ exploreShadowed: true })
		.where(
			and(
				eq(appCatalog.exploreShadowed, false),
				sql`${appCatalog.id} IN ${shadowedCatalogIdsQuery(db)}`,
			),
		)
		.returning({ id: appCatalog.id });
	const clear = db
		.update(appCatalog)
		.set({ exploreShadowed: false })
		.where(
			and(
				eq(appCatalog.exploreShadowed, true),
				sql`${appCatalog.id} NOT IN ${shadowedCatalogIdsQuery(db)}`,
			),
		)
		.returning({ id: appCatalog.id });
	return [flag, clear] as const;
}

/**
 * Recompute `explore_shadowed` for the whole catalog in one batch. Run after
 * store sync and MCP scan runs, and from scheduled maintenance as a safety net.
 */
export async function refreshCatalogShadowedVariants(
	db: Database,
): Promise<RefreshCatalogShadowedVariantsResult> {
	const [flagged, cleared] = await db.batch(
		buildRefreshCatalogShadowedVariantsStatements(db),
	);
	return { flagged: flagged.length, cleared: cleared.length };
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
