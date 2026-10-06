/**
 * App Catalog Queries — Health metrics update.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type {
	ToolExecutionTaskSupport,
	ToolIcon,
} from "@tedix/api-contract/schemas/tools";
import {
	and,
	count,
	eq,
	inArray,
	isNotNull,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import {
	appCatalog,
	type CatalogApp,
	type ErrorClass,
	type HealthStatus,
	type TransportType,
} from "../../schema/catalog";
import { chunkForBoundParams } from "../../utils/batch";
import { getCatalogAppById } from "./get-app";
import { calculateCatalogAppUptime } from "./health-history";
import type { Database } from "./tool-source-policy";

// =============================================================================
// HEALTH METRICS UPDATE
// =============================================================================

/**
 * MCP scan result from MCP Scan Agent
 * Contains health status and server metadata discovered during the scan
 */
export interface McpScanResult {
	status: HealthStatus;
	connectTimeMs?: number;
	totalTimeMs?: number;
	transportUsed?: TransportType;
	authState?: "none" | "required" | "failed";
	serverName?: string;
	serverVersion?: string;
	capabilities?: Record<string, unknown>;
	instructions?: string;
	toolCount?: number;
	resourceCount?: number;
	promptCount?: number;
	resourceTemplateCount?: number;
	errorMessage?: string;
	errorClass?: ErrorClass;
	checkedAt: string;
	tools?: Array<{
		name: string;
		title?: string;
		description?: string;
		inputSchema?: Record<string, unknown>;
		outputSchema?: Record<string, unknown>;
		icons?: ToolIcon[];
		execution?: {
			taskSupport?: ToolExecutionTaskSupport;
		};
		_meta?: Record<string, unknown>;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			openWorldHint?: boolean;
			idempotentHint?: boolean;
		};
	}>;
	resources?: Array<{
		uri: string;
		name?: string;
		title?: string;
		description?: string;
		mimeType?: string;
		icons?: Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}>;
		annotations?: { audience?: string[]; priority?: number };
		_meta?: Record<string, unknown>;
	}>;
	resourceTemplates?: Array<{
		name: string;
		title?: string;
		uriTemplate: string;
		description?: string;
		mimeType?: string;
		icons?: Array<{
			src: string;
			mimeType?: string;
			sizes?: string[];
			theme?: "light" | "dark";
		}>;
		annotations?: { audience?: string[]; priority?: number };
		_meta?: Record<string, unknown>;
	}>;
	prompts?: Array<{
		name: string;
		description?: string;
		arguments?: Array<{
			name: string;
			description?: string;
			required?: boolean;
		}>;
	}>;
	// MCP protocol feature tracking
	protocolVersion?: string;
	supportsResources?: boolean;
	supportsPrompts?: boolean;
	supportsSampling?: boolean;
	supportsRoots?: boolean;
}

/** Enabled provider endpoints selected by the frequent scan cron. */
export async function listActiveProviderCatalogApps(
	db: Database,
	slugs: readonly string[],
): Promise<Array<{ id: string; slug: string }>> {
	if (slugs.length === 0) return [];
	const results: Array<{ id: string; slug: string }> = [];
	// D1 caps bound parameters at 100 per statement; chunk the slug IN() list.
	for (const chunk of chunkForBoundParams([...new Set(slugs)], 50)) {
		const rows = await db
			.select({ id: appCatalog.id, slug: appCatalog.slug })
			.from(appCatalog)
			.where(
				and(
					inArray(appCatalog.slug, chunk),
					eq(appCatalog.status, "ENABLED"),
					isNotNull(appCatalog.mcpEndpointNormalized),
				),
			);
		results.push(
			...rows.flatMap((row) =>
				row.slug ? [{ id: row.id, slug: row.slug }] : [],
			),
		);
	}
	return results;
}

/**
 * Update catalog app health metrics from health check result
 */
export async function updateCatalogAppHealthMetrics(
	db: Database,
	catalogAppId: string,
	result: McpScanResult,
): Promise<CatalogApp | null> {
	// Calculate consecutive failures
	const app = await getCatalogAppById(db, catalogAppId);
	if (!app) return null;

	const consecutiveFailures =
		result.status === "healthy" || result.status === "degraded"
			? 0
			: (app.healthData?.consecutiveFailures ?? 0) + 1;

	// Calculate uptime
	const uptime = await calculateCatalogAppUptime(db, catalogAppId);

	// Only stamp `updatedAt` when the scan actually observed a change.
	//
	// This runs on every scheduled scan of every app, and `app_catalog.updatedAt`
	// is public: the directory page renders it as "Directory updated" and emits it
	// as schema.org `dateModified`, and the catalog offers a sortBy=updatedAt.
	// Bumping unconditionally made every app claim to have been updated at scan
	// cadence — a listing untouched for months still read "updated 2 hours ago",
	// `dateModified` churned without any content change, and the sort degenerated
	// into scan order.
	//
	// Poll timestamps are deliberately excluded from this comparison:
	// healthData.lastCheckedAt and mcpMetadata.lastScannedAt change on every scan
	// by definition, so counting them would make the check vacuous. They are still
	// written — only the freshness stamp is conditional.
	const observedChange =
		app.healthStatus !== result.status ||
		app.mcpToolCount !== (result.toolCount ?? app.mcpToolCount) ||
		app.mcpResourceCount !== (result.resourceCount ?? app.mcpResourceCount) ||
		app.mcpPromptCount !== (result.promptCount ?? app.mcpPromptCount) ||
		app.protocolVersion !== (result.protocolVersion ?? app.protocolVersion) ||
		app.supportsResources !==
			(result.supportsResources ?? app.supportsResources) ||
		app.supportsPrompts !== (result.supportsPrompts ?? app.supportsPrompts) ||
		app.supportsSampling !==
			(result.supportsSampling ?? app.supportsSampling) ||
		app.supportsRoots !== (result.supportsRoots ?? app.supportsRoots) ||
		app.mcpMetadata?.serverName !==
			(result.serverName ?? app.mcpMetadata?.serverName) ||
		app.mcpMetadata?.serverVersion !==
			(result.serverVersion ?? app.mcpMetadata?.serverVersion);

	await db
		.update(appCatalog)
		.set({
			healthStatus: result.status,
			healthData: {
				lastCheckedAt: result.checkedAt,
				connectTimeMs: result.connectTimeMs ?? null,
				uptimePercent: uptime,
				consecutiveFailures,
				errorMessage: result.errorMessage ?? null,
				transportUsed: result.transportUsed ?? null,
			},
			mcpMetadata: {
				serverName: result.serverName ?? app.mcpMetadata?.serverName,
				serverVersion: result.serverVersion ?? app.mcpMetadata?.serverVersion,
				lastScannedAt: result.checkedAt,
				protocolObservedAt: result.protocolVersion
					? result.checkedAt
					: app.mcpMetadata?.protocolObservedAt,
				capabilities: result.capabilities ?? app.mcpMetadata?.capabilities,
				instructions: result.instructions ?? app.mcpMetadata?.instructions,
			},
			mcpToolCount: result.toolCount ?? app.mcpToolCount,
			mcpResourceCount: result.resourceCount ?? app.mcpResourceCount,
			mcpPromptCount: result.promptCount ?? app.mcpPromptCount,
			// MCP protocol feature tracking
			protocolVersion: result.protocolVersion ?? app.protocolVersion,
			supportsResources: result.supportsResources ?? app.supportsResources,
			supportsPrompts: result.supportsPrompts ?? app.supportsPrompts,
			supportsSampling: result.supportsSampling ?? app.supportsSampling,
			supportsRoots: result.supportsRoots ?? app.supportsRoots,
			...(observedChange ? { updatedAt: sql`datetime('now')` } : {}),
		})
		.where(eq(appCatalog.id, catalogAppId));

	return getCatalogAppById(db, catalogAppId);
}

/**
 * Get catalog apps that need scanning
 * Prioritizes apps that:
 * 1. Have never been scanned (unknown status)
 * 2. Were last scanned longest ago
 * 3. Have been unhealthy (to detect recovery)
 */
export async function getCatalogAppsNeedingScan(
	db: Database,
	options: {
		limit?: number;
		maxAgeHours?: number;
		catalogAppIds?: string[];
	} = {},
): Promise<CatalogApp[]> {
	const { limit = 25, maxAgeHours = 24, catalogAppIds } = options;

	// Targeted rescan: bypass age filter, just fetch the requested apps.
	// Chunked: D1 caps bound parameters at 100 per statement.
	if (catalogAppIds && catalogAppIds.length > 0) {
		const targeted: CatalogApp[] = [];
		for (const chunk of chunkForBoundParams([...new Set(catalogAppIds)], 50)) {
			targeted.push(
				...(await db
					.select()
					.from(appCatalog)
					.where(
						and(
							inArray(appCatalog.id, chunk),
							sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`,
						),
					)),
			);
		}
		return targeted;
	}

	const standardCutoff = new Date(
		Date.now() - maxAgeHours * 60 * 60 * 1000,
	).toISOString();
	// Re-scan authenticated/blocked and repeated zero-inventory unhealthy apps
	// less frequently to avoid burning scan budget on low-value long-tail rows.
	const gatedCutoff = new Date(
		Date.now() - Math.max(maxAgeHours * 3, 7 * 24) * 60 * 60 * 1000,
	).toISOString();
	const repeatedUnhealthyZeroInventory = sql`
		${appCatalog.healthStatus} = 'unhealthy'
		AND ${appCatalog.mcpToolCount} = 0
		AND ${appCatalog.mcpResourceCount} = 0
		AND ${appCatalog.mcpPromptCount} = 0
		AND COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0) >= 3
	`;

	return db
		.select()
		.from(appCatalog)
		.where(
			and(
				sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`,
				eq(appCatalog.status, "ENABLED"),
				or(
					// Never checked
					eq(appCatalog.healthStatus, "unknown"),
					sql`json_extract(${appCatalog.healthData}, '$.lastCheckedAt') IS NULL`,
					// Known auth/blocked endpoints: weekly cadence
					and(
						inArray(appCatalog.healthStatus, ["requires_auth", "blocked"]),
						sql`json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${gatedCutoff}`,
					),
					// Auth-gated zero-inventory endpoints still need a lighter manifest
					// discovery pass. A recent failed auth handshake should not block
					// public .well-known/mcp.json ingestion for a full week.
					and(
						inArray(appCatalog.healthStatus, ["requires_auth", "blocked"]),
						eq(appCatalog.mcpToolCount, 0),
						eq(appCatalog.mcpResourceCount, 0),
						eq(appCatalog.mcpPromptCount, 0),
						or(
							sql`json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL`,
							sql`json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${standardCutoff}`,
						),
					),
					// Repeated unhealthy zero-inventory endpoints are low-value; revisit
					// weekly so active/healthy provider inventory is not starved.
					and(
						repeatedUnhealthyZeroInventory,
						sql`json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${gatedCutoff}`,
					),
					// Everything else: standard cadence
					and(
						notInArray(appCatalog.healthStatus, ["requires_auth", "blocked"]),
						sql`NOT (${repeatedUnhealthyZeroInventory})`,
						sql`json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${standardCutoff}`,
					),
				),
			),
		)
		.orderBy(
			// First-party protocol readiness must not sit behind the public catalog
			// backlog. This changes ordering only: age and auth cadence gates above
			// still decide whether a Tedix-owned endpoint is due.
			sql`CASE
				WHEN lower(json_extract(${appCatalog.mcpMetadata}, '$.endpoint')) LIKE '%.tedix.dev/%'
					OR lower(${appCatalog.mcpEndpointNormalized}) LIKE '%.tedix.dev/%'
					OR lower(${appCatalog.mcpEndpointNormalized}) LIKE 'https://tedix.dev/%'
					THEN 0
				WHEN EXISTS (
					SELECT 1 FROM apps
					WHERE apps.catalog_app_id = ${appCatalog.id}
						AND apps.source_app_id IS NULL
				) THEN 1
				WHEN ${appCatalog.healthStatus} IN ('healthy', 'degraded')
					AND (${appCatalog.mcpToolCount} > 0 OR ${appCatalog.mcpResourceCount} > 0 OR ${appCatalog.mcpPromptCount} > 0) THEN 2
				WHEN ${appCatalog.healthStatus} = 'unknown' THEN 3
				WHEN ${appCatalog.healthStatus} IN ('requires_auth', 'blocked')
					AND ${appCatalog.mcpToolCount} = 0
					AND ${appCatalog.mcpResourceCount} = 0
					AND ${appCatalog.mcpPromptCount} = 0
					THEN 4
				WHEN ${appCatalog.healthStatus} = 'unhealthy'
					AND NOT (${repeatedUnhealthyZeroInventory}) THEN 5
				WHEN ${appCatalog.healthStatus} = 'unhealthy' THEN 6
				WHEN ${appCatalog.healthStatus} = 'blocked' THEN 7
				ELSE 8
			END`,
			sql`COALESCE(json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt'), json_extract(${appCatalog.healthData}, '$.lastCheckedAt'), '1970-01-01T00:00:00.000Z')`,
		)
		.limit(limit);
}

export interface CatalogScanBacklogSummary {
	totalEnabledMcp: number;
	dueNow: number;
	staleOver24h: number;
	staleOver7d: number;
	skippedRequiresAuth: number;
	skippedBlocked: number;
	blockedZeroToolCandidates: number;
	unhealthyZeroToolCandidates: number;
}

const LEGACY_PROTOCOL_SAMPLE_LIMIT = 25;
const TEDIX_OWNED_PROTOCOL_SAMPLE_LIMIT = 25;

function isTedixOwnedMcpEndpoint(endpoint: string | null): endpoint is string {
	if (!endpoint) return false;
	try {
		const hostname = new URL(endpoint).hostname.toLowerCase();
		return hostname === "tedix.dev" || hostname.endsWith(".tedix.dev");
	} catch {
		return false;
	}
}

/**
 * Summarize the catalog scan backlog using the same policy as
 * getCatalogAppsNeedingScan(). This makes "no apps need scans" explicit:
 * actionable apps may be clear while auth-gated/blocked endpoints are skipped.
 */
export async function getCatalogScanBacklogSummary(
	db: Database,
	options: { maxAgeHours?: number } = {},
): Promise<CatalogScanBacklogSummary> {
	const { maxAgeHours = 24 } = options;
	const standardCutoff = new Date(
		Date.now() - maxAgeHours * 60 * 60 * 1000,
	).toISOString();
	const stale24hCutoff = new Date(
		Date.now() - 24 * 60 * 60 * 1000,
	).toISOString();
	const stale7dCutoff = new Date(
		Date.now() - 7 * 24 * 60 * 60 * 1000,
	).toISOString();
	const gatedCutoff = new Date(
		Date.now() - Math.max(maxAgeHours * 3, 7 * 24) * 60 * 60 * 1000,
	).toISOString();
	const repeatedUnhealthyZeroInventory = sql`
		${appCatalog.healthStatus} = 'unhealthy'
		AND ${appCatalog.mcpToolCount} = 0
		AND ${appCatalog.mcpResourceCount} = 0
		AND ${appCatalog.mcpPromptCount} = 0
		AND COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0) >= 3
	`;

	const [row] = await db
		.select({
			totalEnabledMcp: sql<number>`COUNT(*)`.as("total_enabled_mcp"),
			dueNow: sql<number>`SUM(CASE WHEN (
				${appCatalog.healthStatus} = 'unknown'
				OR json_extract(${appCatalog.healthData}, '$.lastCheckedAt') IS NULL
				OR (
					${appCatalog.healthStatus} IN ('requires_auth', 'blocked')
					AND json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${gatedCutoff}
				)
				OR (
					${appCatalog.healthStatus} IN ('requires_auth', 'blocked')
					AND ${appCatalog.mcpToolCount} = 0
					AND ${appCatalog.mcpResourceCount} = 0
					AND ${appCatalog.mcpPromptCount} = 0
					AND (
						json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL
						OR json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${standardCutoff}
					)
				)
				OR (
					${repeatedUnhealthyZeroInventory}
					AND json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${gatedCutoff}
				)
				OR (
					${appCatalog.healthStatus} NOT IN ('requires_auth', 'blocked')
					AND NOT (${repeatedUnhealthyZeroInventory})
					AND json_extract(${appCatalog.healthData}, '$.lastCheckedAt') < ${standardCutoff}
				)
			) THEN 1 ELSE 0 END)`.as("due_now"),
			staleOver24h: sql<number>`SUM(CASE WHEN (
				json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL
				OR json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${stale24hCutoff}
			) THEN 1 ELSE 0 END)`.as("stale_over_24h"),
			staleOver7d: sql<number>`SUM(CASE WHEN (
				json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL
				OR json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${stale7dCutoff}
			) THEN 1 ELSE 0 END)`.as("stale_over_7d"),
			skippedRequiresAuth: sql<number>`SUM(CASE WHEN (
				${appCatalog.healthStatus} = 'requires_auth'
				AND (
					json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL
					OR json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${standardCutoff}
				)
				AND NOT (
					${appCatalog.mcpToolCount} = 0
					AND ${appCatalog.mcpResourceCount} = 0
					AND ${appCatalog.mcpPromptCount} = 0
				)
				AND (
					json_extract(${appCatalog.healthData}, '$.lastCheckedAt') IS NOT NULL
					AND json_extract(${appCatalog.healthData}, '$.lastCheckedAt') >= ${gatedCutoff}
				)
			) THEN 1 ELSE 0 END)`.as("skipped_requires_auth"),
			skippedBlocked: sql<number>`SUM(CASE WHEN (
				${appCatalog.healthStatus} = 'blocked'
				AND (
					json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') IS NULL
					OR json_extract(${appCatalog.mcpMetadata}, '$.lastScannedAt') < ${standardCutoff}
				)
				AND NOT (
					${appCatalog.mcpToolCount} = 0
					AND ${appCatalog.mcpResourceCount} = 0
					AND ${appCatalog.mcpPromptCount} = 0
				)
				AND (
					json_extract(${appCatalog.healthData}, '$.lastCheckedAt') IS NOT NULL
					AND json_extract(${appCatalog.healthData}, '$.lastCheckedAt') >= ${gatedCutoff}
				)
			) THEN 1 ELSE 0 END)`.as("skipped_blocked"),
			blockedZeroToolCandidates: sql<number>`SUM(CASE WHEN (
				${appCatalog.healthStatus} = 'blocked'
				AND ${appCatalog.mcpToolCount} = 0
				AND ${appCatalog.mcpResourceCount} = 0
				AND ${appCatalog.mcpPromptCount} = 0
				AND COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0) >= 3
			) THEN 1 ELSE 0 END)`.as("blocked_zero_tool_candidates"),
			unhealthyZeroToolCandidates: sql<number>`SUM(CASE WHEN (
				${appCatalog.healthStatus} = 'unhealthy'
				AND ${appCatalog.mcpToolCount} = 0
				AND ${appCatalog.mcpResourceCount} = 0
				AND ${appCatalog.mcpPromptCount} = 0
				AND COALESCE(json_extract(${appCatalog.healthData}, '$.consecutiveFailures'), 0) >= 3
			) THEN 1 ELSE 0 END)`.as("unhealthy_zero_tool_candidates"),
		})
		.from(appCatalog)
		.where(
			and(
				eq(appCatalog.status, "ENABLED"),
				sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`,
			),
		);

	return {
		totalEnabledMcp: Number(row?.totalEnabledMcp ?? 0),
		dueNow: Number(row?.dueNow ?? 0),
		staleOver24h: Number(row?.staleOver24h ?? 0),
		staleOver7d: Number(row?.staleOver7d ?? 0),
		skippedRequiresAuth: Number(row?.skippedRequiresAuth ?? 0),
		skippedBlocked: Number(row?.skippedBlocked ?? 0),
		blockedZeroToolCandidates: Number(row?.blockedZeroToolCandidates ?? 0),
		unhealthyZeroToolCandidates: Number(row?.unhealthyZeroToolCandidates ?? 0),
	};
}

/**
 * Get health status summary for catalog
 */
export async function getCatalogHealthSummary(db: Database): Promise<{
	total: number;
	healthy: number;
	degraded: number;
	unhealthy: number;
	requiresAuth: number;
	blocked: number;
	unsupported: number;
	unknown: number;
	qualityScorecard: CatalogQualityScorecard;
	protocolInventory: {
		modern2026: number;
		legacyStreamable: number;
		legacySse: number;
		unknown: number;
		freshWithin24h: {
			modern2026: number;
			legacyStreamable: number;
			legacySse: number;
			unknown: number;
		};
		staleOrUnscanned: number;
		enabled: {
			total: number;
			modern2026: number;
			legacyStreamable: number;
			legacySse: number;
			unknown: number;
			freshWithin24h: {
				modern2026: number;
				legacyStreamable: number;
				legacySse: number;
				unknown: number;
			};
			staleOrUnscanned: number;
		};
		tedixOwned: {
			total: number;
			modern2026: number;
			legacyStreamable: number;
			legacySse: number;
			unknown: number;
			freshWithin24h: {
				modern2026: number;
				legacyStreamable: number;
				legacySse: number;
				unknown: number;
			};
			staleOrUnscanned: number;
			apps: Array<{
				slug: string;
				endpoint: string;
				protocolVersion: string | null;
				protocolEra:
					| "modern_2026"
					| "legacy_streamable_2025"
					| "legacy_sse_2024"
					| "unknown";
				healthStatus: string | null;
				protocolObservedAt: string | null;
			}>;
			appsTruncated: boolean;
		};
		legacyApps: Array<{
			slug: string;
			protocolVersion: string | null;
			protocolEra: "legacy_streamable_2025" | "legacy_sse_2024";
			healthStatus: string | null;
			protocolObservedAt: string | null;
		}>;
		legacyAppsTruncated: boolean;
	};
	scanBacklog: CatalogScanBacklogSummary;
}> {
	const [result, protocolRows, scanBacklog] = await Promise.all([
		db
			.select({
				status: appCatalog.healthStatus,
				count: count(),
			})
			.from(appCatalog)
			.where(sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`)
			.groupBy(appCatalog.healthStatus),
		db
			.select({
				slug: appCatalog.slug,
				mcpEndpointNormalized: appCatalog.mcpEndpointNormalized,
				protocolVersion: appCatalog.protocolVersion,
				healthStatus: appCatalog.healthStatus,
				status: appCatalog.status,
				healthData: appCatalog.healthData,
				mcpMetadata: appCatalog.mcpMetadata,
			})
			.from(appCatalog)
			.where(sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL`),
		getCatalogScanBacklogSummary(db),
	]);
	const legacyApps: Array<{
		slug: string;
		protocolVersion: string | null;
		protocolEra: "legacy_streamable_2025" | "legacy_sse_2024";
		healthStatus: string | null;
		protocolObservedAt: string | null;
	}> = [];
	const protocolInventory = {
		modern2026: 0,
		legacyStreamable: 0,
		legacySse: 0,
		unknown: 0,
		freshWithin24h: {
			modern2026: 0,
			legacyStreamable: 0,
			legacySse: 0,
			unknown: 0,
		},
		tedixOwned: {
			total: 0,
			modern2026: 0,
			legacyStreamable: 0,
			legacySse: 0,
			unknown: 0,
			freshWithin24h: {
				modern2026: 0,
				legacyStreamable: 0,
				legacySse: 0,
				unknown: 0,
			},
			staleOrUnscanned: 0,
			apps: [] as Array<{
				slug: string;
				endpoint: string;
				protocolVersion: string | null;
				protocolEra:
					| "modern_2026"
					| "legacy_streamable_2025"
					| "legacy_sse_2024"
					| "unknown";
				healthStatus: string | null;
				protocolObservedAt: string | null;
			}>,
			appsTruncated: false,
		},
		staleOrUnscanned: 0,
		enabled: {
			total: 0,
			modern2026: 0,
			legacyStreamable: 0,
			legacySse: 0,
			unknown: 0,
			freshWithin24h: {
				modern2026: 0,
				legacyStreamable: 0,
				legacySse: 0,
				unknown: 0,
			},
			staleOrUnscanned: 0,
		},
		legacyApps,
		legacyAppsTruncated: false,
	};
	const freshCutoff = Date.now() - 24 * 60 * 60 * 1000;
	for (const row of protocolRows) {
		const transportUsed = row.healthData?.transportUsed;
		let protocolEra:
			| "modern2026"
			| "legacyStreamable"
			| "legacySse"
			| "unknown";
		if (transportUsed === "sse") {
			protocolEra = "legacySse";
			protocolInventory.legacySse++;
			if (row.status === "ENABLED" && row.slug) {
				legacyApps.push({
					slug: row.slug,
					protocolVersion: row.protocolVersion,
					protocolEra: "legacy_sse_2024",
					healthStatus: row.healthStatus,
					protocolObservedAt: row.mcpMetadata?.protocolObservedAt ?? null,
				});
			}
		} else if (row.protocolVersion === "2026-07-28") {
			protocolEra = "modern2026";
			protocolInventory.modern2026++;
		} else if (row.protocolVersion) {
			protocolEra = "legacyStreamable";
			protocolInventory.legacyStreamable++;
			if (row.status === "ENABLED" && row.slug) {
				legacyApps.push({
					slug: row.slug,
					protocolVersion: row.protocolVersion,
					protocolEra: "legacy_streamable_2025",
					healthStatus: row.healthStatus,
					protocolObservedAt: row.mcpMetadata?.protocolObservedAt ?? null,
				});
			}
		} else {
			protocolEra = "unknown";
			protocolInventory.unknown++;
		}
		const protocolObservedAt = row.mcpMetadata?.protocolObservedAt;
		if (protocolObservedAt && Date.parse(protocolObservedAt) >= freshCutoff) {
			protocolInventory.freshWithin24h[protocolEra]++;
		} else {
			protocolInventory.staleOrUnscanned++;
		}
		if (row.status === "ENABLED") {
			protocolInventory.enabled.total++;
			protocolInventory.enabled[protocolEra]++;
			if (protocolObservedAt && Date.parse(protocolObservedAt) >= freshCutoff) {
				protocolInventory.enabled.freshWithin24h[protocolEra]++;
			} else {
				protocolInventory.enabled.staleOrUnscanned++;
			}
		}
		if (
			row.status === "ENABLED" &&
			row.slug &&
			isTedixOwnedMcpEndpoint(row.mcpEndpointNormalized)
		) {
			protocolInventory.tedixOwned.total++;
			protocolInventory.tedixOwned[protocolEra]++;
			if (protocolObservedAt && Date.parse(protocolObservedAt) >= freshCutoff) {
				protocolInventory.tedixOwned.freshWithin24h[protocolEra]++;
			} else {
				protocolInventory.tedixOwned.staleOrUnscanned++;
			}
			protocolInventory.tedixOwned.apps.push({
				slug: row.slug,
				endpoint: row.mcpEndpointNormalized,
				protocolVersion: row.protocolVersion,
				protocolEra:
					protocolEra === "modern2026"
						? "modern_2026"
						: protocolEra === "legacyStreamable"
							? "legacy_streamable_2025"
							: protocolEra === "legacySse"
								? "legacy_sse_2024"
								: "unknown",
				healthStatus: row.healthStatus,
				protocolObservedAt: protocolObservedAt ?? null,
			});
		}
	}
	legacyApps.sort((a, b) => {
		const aCheckedAt = a.protocolObservedAt
			? Date.parse(a.protocolObservedAt)
			: 0;
		const bCheckedAt = b.protocolObservedAt
			? Date.parse(b.protocolObservedAt)
			: 0;
		return bCheckedAt - aCheckedAt || a.slug.localeCompare(b.slug);
	});
	protocolInventory.legacyAppsTruncated =
		legacyApps.length > LEGACY_PROTOCOL_SAMPLE_LIMIT;
	protocolInventory.legacyApps = legacyApps.slice(
		0,
		LEGACY_PROTOCOL_SAMPLE_LIMIT,
	);
	protocolInventory.tedixOwned.apps.sort((a, b) => {
		const aCheckedAt = a.protocolObservedAt
			? Date.parse(a.protocolObservedAt)
			: 0;
		const bCheckedAt = b.protocolObservedAt
			? Date.parse(b.protocolObservedAt)
			: 0;
		return bCheckedAt - aCheckedAt || a.slug.localeCompare(b.slug);
	});
	protocolInventory.tedixOwned.appsTruncated =
		protocolInventory.tedixOwned.apps.length >
		TEDIX_OWNED_PROTOCOL_SAMPLE_LIMIT;
	protocolInventory.tedixOwned.apps = protocolInventory.tedixOwned.apps.slice(
		0,
		TEDIX_OWNED_PROTOCOL_SAMPLE_LIMIT,
	);

	const summary = {
		total: 0,
		healthy: 0,
		degraded: 0,
		unhealthy: 0,
		requiresAuth: 0,
		blocked: 0,
		unsupported: 0,
		unknown: 0,
		protocolInventory,
		scanBacklog,
	};

	for (const row of result) {
		summary.total += row.count;
		switch (row.status) {
			case "healthy":
				summary.healthy = row.count;
				break;
			case "degraded":
				summary.degraded = row.count;
				break;
			case "unhealthy":
				summary.unhealthy = row.count;
				break;
			case "requires_auth":
				summary.requiresAuth = row.count;
				break;
			case "blocked":
				summary.blocked = row.count;
				break;
			case "unsupported":
				summary.unsupported = row.count;
				break;
			default:
				summary.unknown += row.count;
				break;
		}
	}
	return {
		...summary,
		qualityScorecard: buildCatalogQualityScorecard(summary),
	};
}

export type CatalogQualityScorecard = {
	version: "catalog_quality_v1";
	score: number;
	grade: "healthy" | "needs_attention" | "critical";
	measuredAt: string;
	dimensions: {
		healthClassifiedPercent: number;
		freshProtocolPercent: number;
		backlogClearPercent: number;
	};
	remediation: Array<{
		key: "scan_backlog" | "unhealthy_inventory" | "protocol_freshness";
		severity: "warning" | "critical";
		count: number;
		action: string;
	}>;
};

/**
 * Turns persisted catalog observations into an operator scorecard. This is
 * deliberately advisory: it names the next safe workflow class but never
 * starts a broad source sync as a side effect of a read.
 */
export function buildCatalogQualityScorecard(summary: {
	total: number;
	unknown: number;
	healthy: number;
	unhealthy: number;
	protocolInventory: {
		enabled: { total: number; staleOrUnscanned: number };
	};
	scanBacklog: CatalogScanBacklogSummary;
}): CatalogQualityScorecard {
	const percent = (numerator: number, denominator: number) =>
		denominator === 0 ? 100 : Math.round((numerator / denominator) * 100);
	const healthClassifiedPercent = percent(
		summary.total - summary.unknown,
		summary.total,
	);
	const freshProtocolPercent = percent(
		summary.protocolInventory.enabled.total -
			summary.protocolInventory.enabled.staleOrUnscanned,
		summary.protocolInventory.enabled.total,
	);
	const backlogClearPercent = percent(
		summary.scanBacklog.totalEnabledMcp - summary.scanBacklog.dueNow,
		summary.scanBacklog.totalEnabledMcp,
	);
	const score = Math.round(
		healthClassifiedPercent * 0.25 +
			freshProtocolPercent * 0.4 +
			backlogClearPercent * 0.35,
	);
	const remediation: CatalogQualityScorecard["remediation"] = [];
	if (summary.scanBacklog.dueNow > 0) {
		remediation.push({
			key: "scan_backlog",
			severity: summary.scanBacklog.dueNow > 500 ? "critical" : "warning",
			count: summary.scanBacklog.dueNow,
			action: "Run bounded MCP scan batches; do not start a full source sync.",
		});
	}
	if (summary.unhealthy > 0) {
		remediation.push({
			key: "unhealthy_inventory",
			severity: summary.unhealthy > 500 ? "critical" : "warning",
			count: summary.unhealthy,
			action:
				"Prioritize active-provider and zero-tool unhealthy candidates for review.",
		});
	}
	if (summary.protocolInventory.enabled.staleOrUnscanned > 0) {
		remediation.push({
			key: "protocol_freshness",
			severity:
				summary.protocolInventory.enabled.staleOrUnscanned > 500
					? "critical"
					: "warning",
			count: summary.protocolInventory.enabled.staleOrUnscanned,
			action:
				"Refresh protocol observations through bounded scans before migration decisions.",
		});
	}
	return {
		version: "catalog_quality_v1",
		score,
		grade:
			score >= 85 ? "healthy" : score >= 60 ? "needs_attention" : "critical",
		measuredAt: new Date().toISOString(),
		dimensions: {
			healthClassifiedPercent,
			freshProtocolPercent,
			backlogClearPercent,
		},
		remediation,
	};
}
