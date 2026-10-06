import type { DbClient } from "../../client";
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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const rows = (
		await d1
			.prepare(
				`SELECT id, name, slug, tool_source AS toolSource, description, logo_url AS logoUrl
					FROM app_catalog
					WHERE status = 'ENABLED'
						AND (?1 IS NULL OR id = ?1)
						AND (
							name IS NULL OR trim(name) = ''
							OR slug IS NULL OR trim(slug) = ''
							OR logo_url IS NULL OR trim(logo_url) = ''
							OR description IS NULL OR trim(description) = ''
						)
					ORDER BY name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<
				CatalogQualityAppRow & {
					description: string | null;
					logoUrl: string | null;
				}
			>()
	).results;

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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const rows = (
		await d1
			.prepare(
				`SELECT id,
						name,
						slug,
						tool_source AS toolSource,
						description,
						logo_url AS logoUrl,
						json_extract(system_hints, '$.svgLogo') AS svgLogo,
						json_extract(rich_content, '$.screenshotUrl') AS screenshotUrl,
						json_extract(raw_data, '$.quality.logoStatus') AS logoAssetStatus,
						json_extract(raw_data, '$.quality.screenshotStatus') AS screenshotAssetStatus
					FROM app_catalog
					WHERE status = 'ENABLED'
						AND (?1 IS NULL OR id = ?1)
						AND (
							description IS NULL
							OR length(trim(description)) < ?2
							OR logo_url IS NULL
							OR trim(logo_url) = ''
							OR lower(logo_url) LIKE 'data:image/%'
							OR logo_url LIKE 'connectors://%'
							OR logo_url LIKE '%google.com/s2/favicons%'
							OR logo_url NOT LIKE '%/app_catalog/%'
							OR json_extract(raw_data, '$.quality.logoStatus') IN ('fallback_favicon', 'fetch_failed', 'missing', 'invalid')
							OR json_extract(rich_content, '$.screenshotUrl') IS NULL
							OR trim(json_extract(rich_content, '$.screenshotUrl')) = ''
							OR json_extract(raw_data, '$.quality.screenshotStatus') IN ('missing', 'partial', 'fetch_failed', 'invalid')
						)
					ORDER BY name ASC
					LIMIT ?3`,
			)
			.bind(
				options.catalogAppId ?? null,
				MIN_PUBLIC_DESCRIPTION_LENGTH,
				QUALITY_ISSUE_LIMIT,
			)
			.all<
				CatalogQualityAppRow & {
					description: string | null;
					logoUrl: string | null;
					svgLogo: string | null;
					screenshotUrl: string | null;
					logoAssetStatus: string | null;
					screenshotAssetStatus: string | null;
				}
			>()
	).results;

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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const blankSourceRows = (
		await d1
			.prepare(
				`SELECT ac.id,
						ac.name,
						ac.slug,
						ac.tool_source AS toolSource,
						count(*) AS count
					FROM app_catalog_store_listings sl
					INNER JOIN app_catalog ac ON ac.id = sl.catalog_app_id
					WHERE ac.status = 'ENABLED'
						AND (?1 IS NULL OR ac.id = ?1)
						AND trim(sl.source_app_id) = ''
					GROUP BY ac.id
					ORDER BY ac.name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<CatalogQualityCountRow>()
	).results;

	const missingListingRows = (
		await d1
			.prepare(
				`SELECT ac.id,
						ac.name,
						ac.slug,
						ac.tool_source AS toolSource
					FROM app_catalog ac
					WHERE ac.status = 'ENABLED'
						AND (?1 IS NULL OR ac.id = ?1)
						AND NOT EXISTS (
							SELECT 1
							FROM app_catalog_store_listings sl
							WHERE sl.catalog_app_id = ac.id
						)
					ORDER BY ac.name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<CatalogQualityAppRow>()
	).results;

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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const endpointRows = (
		await d1
			.prepare(
				`SELECT id,
						name,
						slug,
						tool_source AS toolSource,
						base_url AS baseUrl,
						mcp_endpoint_normalized AS mcpEndpointNormalized,
						website
					-- .tedi.club stays in this detector after the staging lane was
					-- retired: its job is to FIND catalog rows still pointing at dead
					-- internal hosts. Dropping the pattern would hide them, not fix them.
					FROM app_catalog
					WHERE status = 'ENABLED'
						AND (?1 IS NULL OR id = ?1)
						AND (
							lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%.mcp.tedix.dev%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%.tedi.tedix.dev%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%.tedi.club%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%workers.dev%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%localhost%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%127.0.0.1%'
							OR lower(coalesce(base_url, '') || ' ' || coalesce(mcp_endpoint_normalized, '') || ' ' || coalesce(website, '')) LIKE '%/rpc/%'
						)
					ORDER BY name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<
				CatalogQualityAppRow & {
					baseUrl: string | null;
					mcpEndpointNormalized: string | null;
					website: string | null;
				}
			>()
	).results;

	const proxyToolRows = (
		await d1
			.prepare(
				`SELECT ac.id,
						ac.name,
						ac.slug,
						ac.tool_source AS toolSource,
						a.id AS appId,
						a.slug AS appSlug,
						count(t.id) AS count
					FROM apps a
					INNER JOIN app_catalog ac ON ac.id = a.catalog_app_id
					INNER JOIN app_tools t ON t.app_id = a.id
					WHERE ac.status = 'ENABLED'
						AND a.source_app_id IS NOT NULL
						AND (?1 IS NULL OR ac.id = ?1)
					GROUP BY ac.id, a.id
					ORDER BY ac.name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<
				CatalogQualityCountRow & {
					appId: string;
					appSlug: string | null;
				}
			>()
	).results;

	const publicProxyRows = (
		await d1
			.prepare(
				`SELECT ac.id,
						ac.name,
						ac.slug,
						ac.tool_source AS toolSource,
						a.id AS appId,
						a.slug AS appSlug
					FROM apps a
					INNER JOIN app_catalog ac ON ac.id = a.catalog_app_id
					WHERE ac.status = 'ENABLED'
						AND a.source_app_id IS NOT NULL
						AND a.visibility = 'public'
						AND (?1 IS NULL OR ac.id = ?1)
					ORDER BY ac.name ASC
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<CatalogQualityAppRow & { appId: string; appSlug: string | null }>()
	).results;

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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const rows = (
		await d1
			.prepare(
				`WITH normalized AS (
					SELECT id,
						name,
						slug,
						lower(replace(replace(replace(trim(slug), '_', '-'), ' ', '-'), '.', '-')) AS normalized_slug
					FROM app_catalog
					WHERE status = 'ENABLED'
						AND slug IS NOT NULL
						AND trim(slug) != ''
				)
				SELECT normalized_slug AS normalizedSlug,
					count(*) AS count,
					group_concat(id, ',') AS catalogAppIds,
					group_concat(name, ' | ') AS names,
					group_concat(slug, ' | ') AS slugs
				FROM normalized
				GROUP BY normalized_slug
				HAVING count(*) > 1
					AND (?1 IS NULL OR sum(case when id = ?1 then 1 else 0 end) > 0)
				ORDER BY count(*) DESC, normalized_slug ASC
				LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
			.all<DuplicateSlugRow>()
	).results;

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
	d1: D1Database,
	options: RunCatalogIntegrityOptions,
): Promise<CatalogQualityIssue[]> {
	const staleLastSeenDays = Math.min(
		Math.max(options.staleLastSeenDays ?? DEFAULT_STALE_LAST_SEEN_DAYS, 1),
		365,
	);
	const threshold = `-${staleLastSeenDays} days`;
	const tables = [
		{ table: "app_catalog_mcp_tools", entity: "tool" },
		{ table: "app_catalog_mcp_resources", entity: "resource" },
		{
			table: "app_catalog_mcp_resource_templates",
			entity: "resource_template",
		},
		{ table: "app_catalog_mcp_prompts", entity: "prompt" },
	] as const;
	const issues: CatalogQualityIssue[] = [];

	for (const table of tables) {
		const rows = (
			await d1
				.prepare(
					`SELECT ac.id,
							ac.name,
							ac.slug,
							ac.tool_source AS toolSource,
							count(s.id) AS count,
							min(s.last_seen_at) AS oldestLastSeenAt,
							max(s.last_seen_at) AS newestLastSeenAt
						FROM ${table.table} s
						INNER JOIN app_catalog ac ON ac.id = s.catalog_app_id
						WHERE ac.status = 'ENABLED'
							AND s.removed_at IS NULL
							AND s.last_seen_at < datetime('now', ?1)
							AND (?2 IS NULL OR ac.id = ?2)
						GROUP BY ac.id
						ORDER BY count(s.id) DESC, ac.name ASC
						LIMIT ?3`,
				)
				.bind(threshold, options.catalogAppId ?? null, QUALITY_ISSUE_LIMIT)
				.all<
					CatalogQualityCountRow & {
						oldestLastSeenAt: string | null;
						newestLastSeenAt: string | null;
					}
				>()
		).results;

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
	const issueGroups = await Promise.all([
		collectMissingCatalogFieldIssues(d1, options),
		collectPublicPresentationIssues(d1, options),
		collectMissingSourceIdIssues(d1, options),
		collectLeakageIssues(d1, options),
		collectDuplicateSlugIssues(d1, options),
		collectStaleLastSeenIssues(d1, { ...options, staleLastSeenDays }),
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
	const catalogApps = (
		await d1
			.prepare(
				`SELECT id,
						name,
						base_url AS baseUrl,
						mcp_endpoint_normalized AS mcpEndpointNormalized,
						health_status AS healthStatus,
						tool_source AS toolSource
					FROM app_catalog
					WHERE status = 'ENABLED'
						AND mcp_endpoint_normalized IS NOT NULL
						AND (?1 IS NULL OR id = ?1)
					ORDER BY
						CASE
							WHEN EXISTS (
								SELECT 1 FROM apps
								WHERE apps.catalog_app_id = app_catalog.id
									AND apps.source_app_id IS NULL
							) THEN 0
							ELSE 1
						END,
						CASE
							WHEN health_status = 'healthy' THEN 0
							WHEN health_status = 'degraded' THEN 1
							WHEN health_status = 'unknown' THEN 2
							ELSE 3
						END,
						COALESCE(
							json_extract(mcp_metadata, '$.lastScannedAt'),
							json_extract(health_data, '$.lastCheckedAt'),
							'1970-01-01T00:00:00.000Z'
						),
						slug
					LIMIT ?2`,
			)
			.bind(options.catalogAppId ?? null, limit)
			.all<CatalogDriftCandidate>()
	).results;

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

			const baseApps = (
				await d1
					.prepare(
						`SELECT id, name, metadata
							FROM apps
							WHERE catalog_app_id = ?
								AND source_app_id IS NULL`,
					)
					.bind(catalogApp.id)
					.all<AppMetadataRecord>()
			).results;

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
