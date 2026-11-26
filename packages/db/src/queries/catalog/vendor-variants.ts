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
 * refresh uses bounded pages rather than per-row queries, and detail reads
 * agree with the list about which row is canonical.
 */

import {
	and,
	eq,
	exists,
	gt,
	inArray,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import {
	alias as sqliteAlias,
	type SQLiteColumn,
	type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { alias as pgAlias, type PgTable } from "drizzle-orm/pg-core";
import { appCatalog as schemaAppCatalog } from "../../schema/catalog";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
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

// The raw-SQL ratchet reads these `replace(...)` string expressions as REPLACE
// statements; they are bound fragments inside builders, so the baseline keeps 4.

/**
 * SQL mirror of `extractVendorDomain(website)`: lowercased host without a
 * scheme, path, query, fragment, port or leading `www.`; NULL when empty.
 */
function vendorDomainSql(db: Database, table: CatalogVendorColumns): SQL {
	const postgres = coreStore(db) === "postgres";
	const unschemed = sql`replace(replace(lower(trim(${table.website})), 'https://', ''), 'http://', '')`;
	const delimited = sql`replace(replace(replace(${unschemed}, '?', '/'), '#', '/'), ':', '/')`;
	const host = postgres
		? sql`substr(${delimited}, 1, strpos(${delimited} || '/', '/') - 1)`
		: sql`substr(${delimited}, 1, instr(${delimited} || '/', '/') - 1)`;
	return sql`nullif(substr(${host}, CASE WHEN ${host} LIKE 'www.%' THEN 5 ELSE 1 END), '')`;
}

/**
 * SQL mirror of `normalizeVendorName(name)`: trimmed, lowercased, internal
 * whitespace collapsed (runs of up to 16 characters); NULL when empty.
 */
function vendorNameSql(db: Database, table: CatalogVendorColumns): SQL {
	const postgres = coreStore(db) === "postgres";
	const chr = (code: number) =>
		postgres ? sql`chr(${code})` : sql`char(${code})`;
	let collapsed = sql`replace(replace(replace(lower(${table.name}), ${chr(9)}, ' '), ${chr(10)}, ' '), ${chr(13)}, ' ')`;
	for (let pass = 0; pass < 4; pass += 1) {
		collapsed = sql`replace(${collapsed}, '  ', ' ')`;
	}
	return sql`nullif(trim(${collapsed}), '')`;
}

function catalogAlias<T extends SQLiteTable>(
	db: Database,
	table: T,
	name: string,
): T {
	return (coreStore(db) === "d1"
		? sqliteAlias(table, name)
		: pgAlias(table as unknown as PgTable, name)) as unknown as T;
}

/** `domain|name` vendor key, NULL when either half is missing. */
export function catalogVendorKeySql(
	db: Database,
	table: CatalogVendorColumns,
): SQL {
	return sql`(${vendorDomainSql(db, table)} || '|' || ${vendorNameSql(db, table)})`;
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

/** Literal booleans keep SQLite's partial-index proofs working under INDEXED BY. */
function boolLiteral(db: Database, value: boolean): SQL {
	if (coreStore(db) === "postgres") return value ? sql`true` : sql`false`;
	return value ? sql`1` : sql`0`;
}

/** The public catalog visibility filter used by list browsing. */
export function catalogVisibilityConditions(
	db: Database,
	table: CatalogVendorColumns,
	options: CatalogVisibilityOptions = {},
): SQL[] {
	const conditions: SQL[] = [];
	if (!options.includeAll) {
		// Fixed literals let SQLite match the public browse partial indexes.
		conditions.push(
			sql`${table.developerType} IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')`,
		);
		conditions.push(sql`${table.isDiscoverable} = ${boolLiteral(db, true)}`);
		conditions.push(sql`${table.status} = 'ENABLED'`);
	}
	if (!options.includeUnreleased) {
		conditions.push(sql`${table.reviewStatus} = 'RELEASED'`);
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
	const postgres = coreStore(db) === "postgres";
	const appCatalog = coreTable(db, schemaAppCatalog);
	const sibling = catalogAlias(db, appCatalog, "vendor_sibling");
	const key = catalogVendorKeySql(db, sibling);
	const inventory = catalogInventorySql(sibling);
	const runnable = sql`(CASE WHEN ${catalogRunnableSql(sibling)} THEN 1 ELSE 0 END)`;
	const stocked = sql`(CASE WHEN ${inventory} > 0 THEN 1 ELSE 0 END)`;
	// SQLite GLOB is NULL on a NULL slug and sorts before 0; Postgres ~ is
	// boolean, so NULLS FIRST keeps the same rank order.
	const slugPattern = postgres
		? sql`(${sibling.slug} ~ '-[0-9]')`
		: sql`(${sibling.slug} GLOB '*-[0-9]*')`;
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
			rank: sql<number>`row_number() OVER (PARTITION BY ${key} ORDER BY ${stocked} DESC, ${slugPattern} ASC${postgres ? sql` NULLS FIRST` : sql``}, ${inventory} DESC, ${sibling.id} ASC)`.as(
				"group_rank",
			),
		})
		.from(sibling)
		.where(
			and(
				sql`${key} IS NOT NULL`,
				...catalogVisibilityConditions(db, sibling, options),
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
	const appCatalog = coreTable(db, schemaAppCatalog);
	if (!options.includeAll && !options.includeUnreleased) {
		return sql`${appCatalog.exploreShadowed} = ${boolLiteral(db, false)}`;
	}
	return sql`${appCatalog.id} NOT IN ${shadowedCatalogIdsQuery(db, options)}`;
}

const REFRESH_PAGE_SIZE = 80;

export interface RefreshCatalogShadowedVariantsResult {
	/** Rows newly flagged as shadowed. */
	flagged: number;
	/** Rows whose shadowed flag was cleared. */
	cleared: number;
}

/**
 * The unexecuted statements that recompute `explore_shadowed` against
 * public visibility: store fresh vendor keys, then flag newly shadowed rows
 * and clear rows that are no longer shadowed. Only rows whose value
 * changes are written, and `updated_at` is left alone: both are derived list
 * state, not an app edit. Append them
 * to a write batch that changes vendor grouping, runnability, inventory or
 * visibility so the flag commits with the write.
 */
export function buildRefreshCatalogShadowedVariantsStatements(
	db: Database,
	catalogAppIds: string[],
) {
	if (catalogAppIds.length > REFRESH_PAGE_SIZE) {
		throw new Error("Catalog shadow refresh exceeds its 80-row page");
	}
	const postgres = coreStore(db) === "postgres";
	const appCatalog = coreTable(db, schemaAppCatalog);
	// bound-params: the guard caps IDs at 80; flag/clear add two booleans (82 total).
	const scope = inArray(appCatalog.id, catalogAppIds);
	const vendorKey = catalogVendorKeySql(db, appCatalog);
	const keys = db
		.update(appCatalog)
		.set({ vendorKey })
		.where(
			and(
				scope,
				postgres
					? sql`${appCatalog.vendorKey} IS DISTINCT FROM ${vendorKey}`
					: sql`${appCatalog.vendorKey} IS NOT ${vendorKey}`,
			),
		);
	const sibling = catalogAlias(db, appCatalog, "vendor_sibling");
	const inventory = catalogInventorySql(appCatalog);
	const siblingInventory = catalogInventorySql(sibling);
	// SQLite orders NULL before false for the nullable slug's GLOB result.
	const slugRank = postgres
		? sql`coalesce((${appCatalog.slug} ~ '-[0-9]')::int, -1)`
		: sql`coalesce(${appCatalog.slug} GLOB '*-[0-9]*', -1)`;
	const siblingSlugRank = postgres
		? sql`coalesce((${sibling.slug} ~ '-[0-9]')::int, -1)`
		: sql`coalesce(${sibling.slug} GLOB '*-[0-9]*', -1)`;
	// The old two window scans read 393k rows for a 12k-row catalog. Seek only
	// this row's vendor group and stop at the first sibling that outranks it.
	const visible = and(...catalogVisibilityConditions(db, appCatalog));
	const outranks = exists(
		db
			.select({ present: sql`1` })
			.from(
				postgres
					? sibling
					: sql`${appCatalog} AS "vendor_sibling" INDEXED BY app_catalog_vendor_key_idx`,
			)
			.where(
				and(
					eq(sibling.vendorKey, appCatalog.vendorKey),
					...catalogVisibilityConditions(db, sibling),
					sql`(
						(NOT ${catalogRunnableSql(appCatalog)} AND ${catalogRunnableSql(sibling)})
						OR (${inventory} <= 0 AND ${siblingInventory} > 0)
						OR (${inventory} > 0 AND ${siblingInventory} > 0 AND (
							${siblingSlugRank} < ${slugRank}
							OR (${siblingSlugRank} = ${slugRank} AND (
								${siblingInventory} > ${inventory}
								OR (${siblingInventory} = ${inventory} AND ${sibling.id} < ${appCatalog.id})
							))
						))
					)`,
				),
			),
	);
	const shadowed = postgres
		? sql`coalesce((${visible}), false) AND ${outranks}`
		: sql`coalesce((${visible}), 0) AND ${outranks}`;
	const flag = db
		.update(appCatalog)
		.set({ exploreShadowed: true })
		.where(
			and(scope, eq(appCatalog.exploreShadowed, false), sql`(${shadowed})`),
		)
		.returning({ id: appCatalog.id });
	const clear = db
		.update(appCatalog)
		.set({ exploreShadowed: false })
		.where(
			and(scope, eq(appCatalog.exploreShadowed, true), sql`NOT (${shadowed})`),
		)
		.returning({ id: appCatalog.id });
	return [keys, flag, clear] as const;
}

/**
 * Recompute `explore_shadowed` in separate bounded batches. Run after
 * store sync and MCP scan runs, and from scheduled maintenance as a safety net.
 */
export async function refreshCatalogShadowedVariants(
	db: Database,
): Promise<RefreshCatalogShadowedVariantsResult> {
	const appCatalog = coreTable(db, schemaAppCatalog);
	const pages: string[][] = [];
	let afterId = "";
	for (;;) {
		const rows = await db
			.select({ id: appCatalog.id })
			.from(appCatalog)
			.where(gt(appCatalog.id, afterId))
			.orderBy(appCatalog.id)
			.limit(REFRESH_PAGE_SIZE);
		if (rows.length === 0) break;
		pages.push(rows.map((row) => row.id));
		afterId = rows[rows.length - 1]!.id;
	}
	// Refresh every key before any flags: a sibling can lie on a later page.
	for (const ids of pages) {
		const [keys] = buildRefreshCatalogShadowedVariantsStatements(db, ids);
		await db.batch([keys]);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const result = { flagged: 0, cleared: 0 };
	for (const ids of pages) {
		const [, flag, clear] = buildRefreshCatalogShadowedVariantsStatements(
			db,
			ids,
		);
		const [flagged, cleared] = await db.batch([flag, clear]);
		result.flagged += flagged.length;
		result.cleared += cleared.length;
		if (ids !== pages[pages.length - 1])
			await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return result;
}

/** Capture affected siblings before a merge can delete their anchor row. */
export async function buildRefreshCatalogVendorGroupsStatements(
	db: Database,
	catalogAppIds: string[],
) {
	if (catalogAppIds.length > 2) {
		throw new Error("Catalog vendor refresh supports at most two anchors");
	}
	const appCatalog = coreTable(db, schemaAppCatalog);
	// bound-params: at most two guarded IDs, plus at most four old/fresh vendor keys.
	const anchorScope = inArray(appCatalog.id, catalogAppIds);
	const anchors = await db
		.select({
			key: appCatalog.vendorKey,
			freshKey: catalogVendorKeySql(db, appCatalog).as("fresh_key"),
		})
		.from(appCatalog)
		.where(anchorScope);
	const vendorKeys = [
		...new Set(anchors.flatMap((row) => [row.key, row.freshKey])),
	].filter((key): key is string => typeof key === "string");
	const rows = await db
		.select({ id: appCatalog.id })
		.from(appCatalog)
		.where(
			vendorKeys.length > 0
				? or(anchorScope, inArray(appCatalog.vendorKey, vendorKeys))
				: anchorScope,
		);
	const pages = [];
	for (let offset = 0; offset < rows.length; offset += REFRESH_PAGE_SIZE) {
		pages.push(
			buildRefreshCatalogShadowedVariantsStatements(
				db,
				rows.slice(offset, offset + REFRESH_PAGE_SIZE).map((row) => row.id),
			),
		);
	}
	return [
		...pages.map(([keys]) => keys),
		...pages.flatMap(([, flag, clear]) => [flag, clear]),
	];
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
 * itself). One statement over the stored `vendor_key`, which the shadowed
 * refresh keeps equal to `catalogVendorKeySql`, so detail and list agree.
 */
export async function listCatalogVendorVariants(
	db: Database,
	catalogAppId: string,
	options: CatalogVisibilityOptions = {},
): Promise<CatalogVendorVariantRow[]> {
	const postgres = coreStore(db) === "postgres";
	const appCatalog = coreTable(db, schemaAppCatalog);
	const storeListings = postgres
		? sql`catalog.app_catalog_store_listings`
		: sql`app_catalog_store_listings`;
	const anchor = catalogAlias(db, appCatalog, "vendor_anchor");
	const anchorKey = db
		.select({ vendorKey: anchor.vendorKey })
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
				SELECT source FROM ${storeListings}
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
				...catalogVisibilityConditions(db, appCatalog, options),
				sql`${appCatalog.vendorKey} = (${anchorKey})`,
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
