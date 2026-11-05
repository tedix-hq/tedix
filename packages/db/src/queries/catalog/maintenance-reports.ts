import {
	and,
	asc,
	eq,
	exists,
	isNotNull,
	isNull,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { apps } from "../../schema/apps";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	appCatalogStoreListings,
} from "../../schema/catalog";
import { appTools } from "../../schema/tools";
import { resolveDriftReport, saveDriftReport } from "./drift-reports";
import { checkCatalogIntegrity } from "./mcp-tools";
import { syncCatalogToolsToApp } from "./sync-tools-to-app";
import { shouldProjectCatalogToolsFromBaseApp } from "./tool-source-policy";
import { checkUpstreamDrift } from "./upstream-drift";
import { reportUnclassifiedWriteCapability } from "./write-capability";

type CatalogDriftCandidate = {
	id: string;
	name: string;
	baseUrl: string | null;
	mcpEndpointNormalized: string | null;
	healthStatus: string | null;
	toolSource: "upstream_mcp" | "openapi" | "google-discovery" | "tedix_app";
};

type AppMetadataRecord = {
	id: string;
	name: string;
	metadata: unknown;
};

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
	if (typeof metadata === "string") {
		try {
			const parsed = JSON.parse(metadata);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: null;
}

function readAutoSyncPolicy(metadata: unknown): {
	autoSync: boolean;
	connectionProviderId?: string;
	connectionScope: "tenant" | "user";
} {
	const parsed = parseMetadata(metadata);
	const mcpConfig =
		parsed?.mcpConfig && typeof parsed.mcpConfig === "object"
			? (parsed.mcpConfig as Record<string, unknown>)
			: null;

	return {
		autoSync: mcpConfig?.autoSync !== false,
		connectionProviderId:
			typeof mcpConfig?.connectionProviderId === "string"
				? mcpConfig.connectionProviderId
				: undefined,
		connectionScope: mcpConfig?.connectionScope === "user" ? "user" : "tenant",
	};
}

function isAutoSyncableDrift(driftType: string): boolean {
	return (
		driftType === "schema_changed" ||
		driftType === "description_changed" ||
		driftType === "metadata_changed" ||
		driftType === "new_upstream" ||
		driftType === "removed_upstream"
	);
}

export type RunCatalogIntegrityOptions = {
	apply?: boolean;
	limit?: number;
	catalogAppId?: string;
	staleLastSeenDays?: number;
};

export type CatalogQualityIssueCode =
	| "missing_name"
	| "missing_slug"
	| "missing_logo"
	| "missing_description"
	| "weak_description"
	| "asset_backfill_candidate"
	| "missing_source_id"
	| "tenant_proxy_or_internal_leakage"
	| "duplicateish_slug"
	| "stale_last_seen";

export type CatalogQualityIssue = {
	code: CatalogQualityIssueCode;
	severity: "error" | "warning";
	count: number;
	summary: string;
	catalogAppId: string | null;
	catalogAppName: string | null;
	catalogAppSlug: string | null;
	details?: Record<string, string | number | boolean | null | string[]>;
};

export type CatalogQualityReport = {
	checkedAt: string;
	catalogAppId: string | null;
	staleLastSeenDays: number;
	issueCount: number;
	errorCount: number;
	warningCount: number;
	issues: CatalogQualityIssue[];
	summary: string;
};

type CatalogQualityAppRow = {
	id: string;
	name: string | null;
	slug: string | null;
	toolSource: string;
};

type CatalogQualityCountRow = CatalogQualityAppRow & {
	count: number;
};

type DuplicateSlugRow = {
	normalizedSlug: string;
	count: number;
	catalogAppIds: string;
	names: string;
	slugs: string;
};

const QUALITY_ISSUE_LIMIT = 200;
const DEFAULT_STALE_LAST_SEEN_DAYS = 14;
const MIN_PUBLIC_DESCRIPTION_LENGTH = 80;

const catalogQualityFields = {
	id: appCatalog.id,
	name: appCatalog.name,
	slug: appCatalog.slug,
	toolSource: appCatalog.toolSource,
};

/** `(?1 IS NULL OR column = ?1)`: only a supplied catalog app ID narrows. */
function scopedToCatalogApp(
	column: AnySQLiteColumn,
	catalogAppId: string | undefined,
) {
	return catalogAppId === undefined || catalogAppId === null
		? undefined
		: eq(column, catalogAppId);
}

const blankText = (column: AnySQLiteColumn) =>
	or(isNull(column), sql`trim(${column}) = ''`);

function isTedixHostedCatalogAsset(url: string | null | undefined): boolean {
	if (!url) return false;
	return /\/app_catalog\//.test(url) || /\/app_catalog%2F/.test(url);
}

function isLogoBackfillCandidate(
	url: string | null | undefined,
	status?: string | null,
): boolean {
	if (
		status === "fallback_favicon" ||
		status === "fetch_failed" ||
		status === "missing" ||
		status === "invalid"
	) {
		return true;
	}
	if (!url?.trim()) return true;
	const trimmed = url.trim();
	if (/^data:image\//i.test(trimmed)) return true;
	if (trimmed.startsWith("connectors://")) return true;
	if (trimmed.includes("google.com/s2/favicons")) return true;
	if (!/^https?:\/\//i.test(trimmed)) return true;
	return !isTedixHostedCatalogAsset(trimmed);
}

function normalizeCount(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}

function qualityIssue(
	row: CatalogQualityAppRow,
	code: CatalogQualityIssueCode,
	severity: CatalogQualityIssue["severity"],
	count: number,
	summary: string,
	details?: CatalogQualityIssue["details"],
): CatalogQualityIssue {
	return {
		code,
		severity,
		count,
		summary,
		catalogAppId: row.id,
		catalogAppName: row.name,
		catalogAppSlug: row.slug,
		...(details ? { details } : {}),
	};
}

async function collectMissingCatalogFieldIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const rows = await db
		.select({
			...catalogQualityFields,
			description: appCatalog.description,
			logoUrl: appCatalog.logoUrl,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				or(
					blankText(appCatalog.name),
					blankText(appCatalog.slug),
					blankText(appCatalog.logoUrl),
					blankText(appCatalog.description),
				),
			),
		)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	const issues: CatalogQualityIssue[] = [];
	for (const row of rows) {
		const label = row.slug ?? row.name ?? row.id;
		if (!row.name?.trim()) {
			issues.push(
				qualityIssue(
					row,
					"missing_name",
					"error",
					1,
					`${label} has no usable catalog name.`,
				),
			);
		}
		if (!row.slug?.trim()) {
			issues.push(
				qualityIssue(
					row,
					"missing_slug",
					"warning",
					1,
					`${label} has no catalog slug.`,
				),
			);
		}
		if (!row.logoUrl?.trim()) {
			issues.push(
				qualityIssue(
					row,
					"missing_logo",
					"warning",
					1,
					`${label} has no catalog logo URL.`,
				),
			);
		}
		if (!row.description?.trim()) {
			issues.push(
				qualityIssue(
					row,
					"missing_description",
					"warning",
					1,
					`${label} has no catalog description.`,
				),
			);
		}
	}

	return issues;
}

async function collectPublicPresentationIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const screenshotUrl = sql`json_extract(${appCatalog.richContent}, '$.screenshotUrl')`;
	const logoAssetStatus = sql`json_extract(${appCatalog.rawData}, '$.quality.logoStatus')`;
	const screenshotAssetStatus = sql`json_extract(${appCatalog.rawData}, '$.quality.screenshotStatus')`;
	const rows = await db
		.select({
			...catalogQualityFields,
			description: appCatalog.description,
			logoUrl: appCatalog.logoUrl,
			svgLogo: sql<
				string | null
			>`json_extract(${appCatalog.systemHints}, '$.svgLogo')`.as("svgLogo"),
			screenshotUrl: sql<string | null>`${screenshotUrl}`.as("screenshotUrl"),
			logoAssetStatus: sql<string | null>`${logoAssetStatus}`.as(
				"logoAssetStatus",
			),
			screenshotAssetStatus: sql<string | null>`${screenshotAssetStatus}`.as(
				"screenshotAssetStatus",
			),
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				or(
					isNull(appCatalog.description),
					sql`length(trim(${appCatalog.description})) < ${MIN_PUBLIC_DESCRIPTION_LENGTH}`,
					isNull(appCatalog.logoUrl),
					sql`trim(${appCatalog.logoUrl}) = ''`,
					sql`lower(${appCatalog.logoUrl}) LIKE 'data:image/%'`,
					sql`${appCatalog.logoUrl} LIKE 'connectors://%'`,
					sql`${appCatalog.logoUrl} LIKE '%google.com/s2/favicons%'`,
					sql`${appCatalog.logoUrl} NOT LIKE '%/app_catalog/%'`,
					sql`${logoAssetStatus} IN ('fallback_favicon', 'fetch_failed', 'missing', 'invalid')`,
					sql`${screenshotUrl} IS NULL`,
					sql`trim(${screenshotUrl}) = ''`,
					sql`${screenshotAssetStatus} IN ('missing', 'partial', 'fetch_failed', 'invalid')`,
				),
			),
		)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	const issues: CatalogQualityIssue[] = [];
	for (const row of rows) {
		const label = row.slug ?? row.name ?? row.id;
		const descriptionLength = row.description?.trim().length ?? 0;
		if (
			descriptionLength > 0 &&
			descriptionLength < MIN_PUBLIC_DESCRIPTION_LENGTH
		) {
			issues.push(
				qualityIssue(
					row,
					"weak_description",
					"warning",
					1,
					`${label} has a thin public description (${descriptionLength} chars).`,
					{
						descriptionLength,
						minDescriptionLength: MIN_PUBLIC_DESCRIPTION_LENGTH,
					},
				),
			);
		}

		const logoNeedsBackfill = isLogoBackfillCandidate(
			row.logoUrl,
			row.logoAssetStatus,
		);
		const screenshotNeedsBackfill =
			!row.screenshotUrl?.trim() ||
			row.screenshotAssetStatus === "missing" ||
			row.screenshotAssetStatus === "partial" ||
			row.screenshotAssetStatus === "fetch_failed" ||
			row.screenshotAssetStatus === "invalid";
		if (logoNeedsBackfill || screenshotNeedsBackfill) {
			const targets: string[] = [];
			if (logoNeedsBackfill) targets.push("logo");
			if (screenshotNeedsBackfill) targets.push("screenshot");
			issues.push(
				qualityIssue(
					row,
					"asset_backfill_candidate",
					"warning",
					targets.length,
					`${label} should be queued for public asset normalization (${targets.join(", ")}).`,
					{
						targets,
						logoUrl: row.logoUrl,
						hasSvgLogo: Boolean(row.svgLogo),
						screenshotUrl: row.screenshotUrl,
						logoAssetStatus: row.logoAssetStatus,
						screenshotAssetStatus: row.screenshotAssetStatus,
					},
				),
			);
		}
	}

	return issues;
}

async function collectMissingSourceIdIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const blankSourceRows = await db
		.select({
			...catalogQualityFields,
			count: sql<number>`count(*)`.as("count"),
		})
		.from(appCatalogStoreListings)
		.innerJoin(
			appCatalog,
			eq(appCatalog.id, appCatalogStoreListings.catalogAppId),
		)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				sql`trim(${appCatalogStoreListings.sourceAppId}) = ''`,
			),
		)
		.groupBy(appCatalog.id)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	const missingListingRows = await db
		.select(catalogQualityFields)
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				notExists(
					db
						.select({ one: sql`1` })
						.from(appCatalogStoreListings)
						.where(eq(appCatalogStoreListings.catalogAppId, appCatalog.id)),
				),
			),
		)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	return [
		...blankSourceRows.map((row) =>
			qualityIssue(
				row,
				"missing_source_id",
				"error",
				normalizeCount(row.count),
				`${row.slug ?? row.name} has ${normalizeCount(row.count)} store listing(s) with a blank sourceAppId.`,
			),
		),
		...missingListingRows.map((row) =>
			qualityIssue(
				row,
				"missing_source_id",
				"warning",
				1,
				`${row.slug ?? row.name} has no store listing source ID rows.`,
			),
		),
	];
}

async function collectLeakageIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const exposedUrls = sql`lower(coalesce(${appCatalog.baseUrl}, '') || ' ' || coalesce(${appCatalog.mcpEndpointNormalized}, '') || ' ' || coalesce(${appCatalog.website}, ''))`;
	const endpointRows = await db
		.select({
			...catalogQualityFields,
			baseUrl: appCatalog.baseUrl,
			mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
			website: appCatalog.website,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				// .tedi.club stays in this detector after the staging lane was
				// retired: its job is to FIND catalog rows still pointing at dead
				// internal hosts. Dropping the pattern would hide them, not fix them.
				or(
					sql`${exposedUrls} LIKE '%.mcp.tedix.dev%'`,
					sql`${exposedUrls} LIKE '%.tedi.tedix.dev%'`,
					sql`${exposedUrls} LIKE '%.tedi.club%'`,
					sql`${exposedUrls} LIKE '%workers.dev%'`,
					sql`${exposedUrls} LIKE '%localhost%'`,
					sql`${exposedUrls} LIKE '%127.0.0.1%'`,
					sql`${exposedUrls} LIKE '%/rpc/%'`,
				),
			),
		)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	const proxyToolRows = await db
		.select({
			...catalogQualityFields,
			appId: sql<string>`${apps.id}`.as("appId"),
			appSlug: sql<string | null>`${apps.slug}`.as("appSlug"),
			count: sql<number>`count(${appTools.id})`.as("count"),
		})
		.from(apps)
		.innerJoin(appCatalog, eq(appCatalog.id, apps.catalogAppId))
		.innerJoin(appTools, eq(appTools.appId, apps.id))
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				isNotNull(apps.sourceAppId),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
			),
		)
		.groupBy(appCatalog.id, apps.id)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	const publicProxyRows = await db
		.select({
			...catalogQualityFields,
			appId: sql<string>`${apps.id}`.as("appId"),
			appSlug: sql<string | null>`${apps.slug}`.as("appSlug"),
		})
		.from(apps)
		.innerJoin(appCatalog, eq(appCatalog.id, apps.catalogAppId))
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				isNotNull(apps.sourceAppId),
				eq(apps.visibility, "public"),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
			),
		)
		.orderBy(asc(appCatalog.name))
		.limit(QUALITY_ISSUE_LIMIT);

	return [
		...endpointRows.map((row) =>
			qualityIssue(
				row,
				"tenant_proxy_or_internal_leakage",
				"warning",
				1,
				`${row.slug ?? row.name} exposes a Tedix/internal-looking URL in catalog metadata.`,
				{
					baseUrl: row.baseUrl,
					mcpEndpointNormalized: row.mcpEndpointNormalized,
					website: row.website,
				},
			),
		),
		...proxyToolRows.map((row) =>
			qualityIssue(
				row,
				"tenant_proxy_or_internal_leakage",
				"error",
				normalizeCount(row.count),
				`${row.appSlug ?? row.appId} is a tenant proxy app with ${normalizeCount(row.count)} direct tool row(s).`,
				{ appId: row.appId, appSlug: row.appSlug },
			),
		),
		...publicProxyRows.map((row) =>
			qualityIssue(
				row,
				"tenant_proxy_or_internal_leakage",
				"warning",
				1,
				`${row.appSlug ?? row.appId} is a tenant proxy app marked public.`,
				{ appId: row.appId, appSlug: row.appSlug },
			),
		),
	];
}

async function collectDuplicateSlugIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const normalized = db.$with("normalized").as(
		db
			.select({
				id: appCatalog.id,
				name: appCatalog.name,
				slug: appCatalog.slug,
				normalizedSlug:
					sql<string>`lower(replace(replace(replace(trim(${appCatalog.slug}), '_', '-'), ' ', '-'), '.', '-'))`.as(
						"normalized_slug",
					),
			})
			.from(appCatalog)
			.where(
				and(
					eq(appCatalog.status, "ENABLED"),
					isNotNull(appCatalog.slug),
					sql`trim(${appCatalog.slug}) != ''`,
				),
			),
	);
	const catalogAppId = options.catalogAppId;
	const rows: DuplicateSlugRow[] = await db
		.with(normalized)
		.select({
			normalizedSlug: sql<string>`${normalized.normalizedSlug}`.as(
				"normalizedSlug",
			),
			count: sql<number>`count(*)`.as("count"),
			catalogAppIds: sql<string>`group_concat(${normalized.id}, ',')`.as(
				"catalogAppIds",
			),
			names: sql<string>`group_concat(${normalized.name}, ' | ')`.as("names"),
			slugs: sql<string>`group_concat(${normalized.slug}, ' | ')`.as("slugs"),
		})
		.from(normalized)
		.groupBy(normalized.normalizedSlug)
		.having(
			and(
				sql`count(*) > 1`,
				catalogAppId === undefined || catalogAppId === null
					? undefined
					: sql`sum(case when ${normalized.id} = ${catalogAppId} then 1 else 0 end) > 0`,
			),
		)
		.orderBy(sql`count(*) DESC`, asc(normalized.normalizedSlug))
		.limit(QUALITY_ISSUE_LIMIT);

	return rows.map((row) => ({
		code: "duplicateish_slug",
		severity: "warning",
		count: normalizeCount(row.count),
		summary: `${normalizeCount(row.count)} catalog apps normalize to slug "${row.normalizedSlug}".`,
		catalogAppId: null,
		catalogAppName: null,
		catalogAppSlug: row.normalizedSlug,
		details: {
			normalizedSlug: row.normalizedSlug,
			catalogAppIds: row.catalogAppIds.split(",").slice(0, 20),
			names: row.names,
			slugs: row.slugs,
		},
	}));
}

async function collectStaleLastSeenIssues(
	db: DbQueryClient,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const staleLastSeenDays = Math.min(
		Math.max(options.staleLastSeenDays ?? DEFAULT_STALE_LAST_SEEN_DAYS, 1),
		365,
	);
	const threshold = `-${staleLastSeenDays} days`;
	const tables = [
		{ table: appCatalogMcpTools, entity: "tool" },
		{ table: appCatalogMcpResources, entity: "resource" },
		{ table: appCatalogMcpResourceTemplates, entity: "resource_template" },
		{ table: appCatalogMcpPrompts, entity: "prompt" },
	] as const;
	const issues: CatalogQualityIssue[] = [];

	for (const table of tables) {
		const surface = table.table;
		const rows = await db
			.select({
				...catalogQualityFields,
				count: sql<number>`count(${surface.id})`.as("count"),
				oldestLastSeenAt: sql<string | null>`min(${surface.lastSeenAt})`.as(
					"oldestLastSeenAt",
				),
				newestLastSeenAt: sql<string | null>`max(${surface.lastSeenAt})`.as(
					"newestLastSeenAt",
				),
			})
			.from(surface)
			.innerJoin(appCatalog, eq(appCatalog.id, surface.catalogAppId))
			.where(
				and(
					eq(appCatalog.status, "ENABLED"),
					isNull(surface.removedAt),
					sql`julianday(${surface.lastSeenAt}) < julianday('now', ${threshold})`,
					scopedToCatalogApp(appCatalog.id, options.catalogAppId),
				),
			)
			.groupBy(appCatalog.id)
			.orderBy(sql`count(${surface.id}) DESC`, asc(appCatalog.name))
			.limit(QUALITY_ISSUE_LIMIT);

		for (const row of rows) {
			issues.push(
				qualityIssue(
					row,
					"stale_last_seen",
					"warning",
					normalizeCount(row.count),
					`${row.slug ?? row.name} has ${normalizeCount(row.count)} active ${table.entity} row(s) not seen in ${staleLastSeenDays}+ day(s).`,
					{
						entity: table.entity,
						staleLastSeenDays,
						oldestLastSeenAt: row.oldestLastSeenAt,
						newestLastSeenAt: row.newestLastSeenAt,
					},
				),
			);
		}
	}

	return issues;
}

export async function buildCatalogQualityReport(
	d1: D1Database,
	options: RunCatalogIntegrityOptions = {},
): Promise<CatalogQualityReport> {
	const staleLastSeenDays = Math.min(
		Math.max(options.staleLastSeenDays ?? DEFAULT_STALE_LAST_SEEN_DAYS, 1),
		365,
	);
	const db = createDbQueryClient(d1);
	const issueGroups = await Promise.all([
		collectMissingCatalogFieldIssues(db, options),
		collectPublicPresentationIssues(db, options),
		collectMissingSourceIdIssues(db, options),
		collectLeakageIssues(db, options),
		collectDuplicateSlugIssues(db, options),
		collectStaleLastSeenIssues(db, { ...options, staleLastSeenDays }),
	]);
	const issues = issueGroups.flat().slice(0, QUALITY_ISSUE_LIMIT);
	const errorCount = issues.filter(
		(issue) => issue.severity === "error",
	).length;
	const warningCount = issues.length - errorCount;

	return {
		checkedAt: new Date().toISOString(),
		catalogAppId: options.catalogAppId ?? null,
		staleLastSeenDays,
		issueCount: issues.length,
		errorCount,
		warningCount,
		issues,
		summary: `${issues.length} catalog quality issue(s): ${errorCount} error(s), ${warningCount} warning(s).`,
	};
}

export async function runCatalogIntegrityMaintenance(
	db: DbClient,
	d1: D1Database,
	options: RunCatalogIntegrityOptions = {},
) {
	const integrity = await checkCatalogIntegrity(db, {
		apply: options.apply ?? true,
		limit: options.limit ?? 10_000,
		catalogAppId: options.catalogAppId,
	});
	const qualityReport = await buildCatalogQualityReport(d1, options);
	// Standing backlog of tools nobody has classified. Rides this workflow (cron
	// + workflow_runs ledger + operator endpoint) rather than a one-off script,
	// because a script nobody re-runs is exactly the invisible backlog the
	// declarative column exists to expose.
	const writeCapabilityReport = await reportUnclassifiedWriteCapability(db);

	return {
		...integrity,
		qualityReport,
		writeCapabilityReport,
		summary: `${integrity.summary} ${qualityReport.summary} ${writeCapabilityReport.summary}`,
	};
}

export type RunCatalogDriftOptions = {
	limit?: number;
	catalogAppId?: string;
	autoSync?: boolean;
};

export async function runCatalogDriftDetection(
	db: DbClient,
	d1: D1Database,
	options: RunCatalogDriftOptions = {},
) {
	const limit = options.limit ?? 50;
	const autoSync = options.autoSync ?? true;
	const reader = createDbQueryClient(d1);
	const catalogApps: CatalogDriftCandidate[] = await reader
		.select({
			id: appCatalog.id,
			name: appCatalog.name,
			baseUrl: appCatalog.baseUrl,
			mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
			healthStatus: appCatalog.healthStatus,
			toolSource: appCatalog.toolSource,
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				isNotNull(appCatalog.mcpEndpointNormalized),
				scopedToCatalogApp(appCatalog.id, options.catalogAppId),
			),
		)
		.orderBy(
			sql`CASE WHEN ${exists(
				reader
					.select({ one: sql`1` })
					.from(apps)
					.where(
						and(eq(apps.catalogAppId, appCatalog.id), isNull(apps.sourceAppId)),
					),
			)} THEN 0 ELSE 1 END`,
			sql`CASE
				WHEN ${appCatalog.healthStatus} = 'healthy' THEN 0
				WHEN ${appCatalog.healthStatus} = 'degraded' THEN 1
				WHEN ${appCatalog.healthStatus} = 'unknown' THEN 2
				ELSE 3
			END`,
			sql`COALESCE(
				json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt'),
				json_extract(${appCatalog.healthData}, '$.lastCheckedAt'),
				'1970-01-01T00:00:00.000Z'
			)`,
			appCatalog.slug,
		)
		.limit(limit);

	const toCheck = catalogApps.filter(
		(app) =>
			app.healthStatus !== "requires_auth" ||
			shouldProjectCatalogToolsFromBaseApp(app),
	);

	let reportsSaved = 0;
	let totalDrifts = 0;
	let autoSyncs = 0;
	const failures: Array<{ catalogAppId: string; name: string; error: string }> =
		[];

	for (const catalogApp of toCheck) {
		try {
			const result = await checkUpstreamDrift(db, catalogApp.id);
			const hasDrift =
				result.addedTools > 0 ||
				result.removedTools > 0 ||
				result.changedTools > 0;

			if (!hasDrift) continue;

			const parts: string[] = [];
			if (result.addedTools) parts.push(`${result.addedTools} added`);
			if (result.removedTools) parts.push(`${result.removedTools} removed`);
			if (result.changedTools) parts.push(`${result.changedTools} changed`);
			const summary = `Drift detected for ${catalogApp.name}: ${parts.join(", ")}`;

			await saveDriftReport(db, {
				catalogAppId: catalogApp.id,
				catalogAppName: catalogApp.name,
				addedTools: result.addedTools,
				removedTools: result.removedTools,
				changedTools: result.changedTools,
				drifts: result.drifts,
				summary,
			});

			reportsSaved++;
			totalDrifts += result.drifts.length;

			const hasAutoSyncableDrift = result.drifts.some((drift) =>
				isAutoSyncableDrift(drift.driftType),
			);
			const upstreamUrl =
				catalogApp.mcpEndpointNormalized ?? catalogApp.baseUrl;
			if (!autoSync || !hasAutoSyncableDrift || !upstreamUrl) continue;

			const baseApps: AppMetadataRecord[] = await reader
				.select({
					id: apps.id,
					name: apps.name,
					// Raw stored JSON text; readAutoSyncPolicy parses it.
					metadata: sql<unknown>`${apps.metadata}`.as("metadata"),
				})
				.from(apps)
				.where(
					and(eq(apps.catalogAppId, catalogApp.id), isNull(apps.sourceAppId)),
				);

			for (const baseApp of baseApps) {
				const policy = readAutoSyncPolicy(baseApp.metadata);
				if (!policy.autoSync) continue;

				await syncCatalogToolsToApp(db, {
					catalogAppId: catalogApp.id,
					appId: baseApp.id,
					mcpServerUrl: upstreamUrl,
					connectionProviderId: policy.connectionProviderId,
					connectionScope: policy.connectionScope,
					dryRun: false,
					disableRemoved: true,
				});
				await resolveDriftReport(db, catalogApp.id);
				autoSyncs++;
			}
		} catch (error) {
			failures.push({
				catalogAppId: catalogApp.id,
				name: catalogApp.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		checked: toCheck.length,
		candidates: catalogApps.length,
		reportsSaved,
		totalDrifts,
		autoSyncs,
		failures,
		summary: `Checked ${toCheck.length} catalog app(s): ${reportsSaved} drift report(s), ${totalDrifts} drift item(s), ${autoSyncs} auto-sync(s), ${failures.length} failure(s).`,
	};
}
