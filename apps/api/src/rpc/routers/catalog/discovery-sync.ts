import { failRunningAppCatalogSyncLog } from "@tedix/db/queries/catalog/sync-logs";
import { catalogSyncTerminalFailure } from "../../../lib/catalog-sync-recovery";
import { AUTHZ } from "../../orpc";
import { countAutoSyncBaseApps } from "@tedix/db/queries/apps";
import {
	createAppCatalogSyncLog,
	failStaleAppCatalogSyncLogs,
	getRecentAppCatalogSyncLogs,
	updateAppCatalogSyncLog,
} from "@tedix/db/queries/catalog/sync-logs";
import { createCatalogVectorClient } from "@tedix/db/vector/catalog";
import { getCatalogAppBySlugWithRelations } from "@tedix/db/queries/catalog/list-with-relations";
import {
	getCatalogCategories,
	getCatalogStats,
	getCatalogSyncStatus,
} from "@tedix/db/queries/catalog/categories-stats";
import { getCatalogHealthSummary } from "@tedix/db/queries/catalog/health-metrics";
import { listCatalogApps } from "@tedix/db/queries/catalog/list-apps";
import {
	type CatalogVendorVariantRow,
	listCatalogVendorVariants,
} from "@tedix/db/queries/catalog/vendor-variants";
import {
	type CatalogAppVariant,
	SourceSchema,
} from "@tedix/api-contract/schemas/catalog";
import { semanticSearchCatalogApps } from "@tedix/db/queries/catalog/semantic-search";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import {
	BaseAppSummary,
	calculateCatalogInstallability,
	calculateCatalogQuality,
	calculateDiscoverability,
	fleetCatalogOs,
	getCatalogBaseApp,
	listBaseAppsForCatalogApps,
	listStoreListingsForCatalogApps,
	normalizeOutputJsonSchema,
	normalizeToolJsonSchema,
	publicCategories,
	publicCategory,
	publicLogoUrl,
	sanitizePublicText,
	syncLogSourceLabel,
} from "./policy-quality";
import { runClaudeRegistrySync } from "./install-scan";
import { isSupportedCatalogR2Path } from "../../../lib/catalog-sync-source";
import {
	getUpstreamProtocolUsageFromAE,
	hasAEConfig,
} from "../../../lib/analytics-engine";

/** Installability states the catalog list hides behind a runnable sibling. */
const NON_RUNNABLE_INSTALLABILITY_STATES = new Set<string>([
	"listing_only",
	"service_connector",
	"needs_mcp_endpoint",
]);

async function mapCatalogVariants(
	db: Parameters<typeof listBaseAppsForCatalogApps>[0],
	rows: CatalogVendorVariantRow[],
): Promise<CatalogAppVariant[]> {
	if (rows.length === 0) return [];
	const baseApps = await listBaseAppsForCatalogApps(
		db,
		rows.map((row) => row.id),
	);
	const baseAppByCatalogId = new Map<string, BaseAppSummary>();
	for (const app of baseApps) {
		if (app.catalogAppId && !baseAppByCatalogId.has(app.catalogAppId)) {
			baseAppByCatalogId.set(app.catalogAppId, app);
		}
	}
	return rows.map((row) => {
		const parsedSource = SourceSchema.safeParse(row.primarySource);
		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			source: parsedSource.success ? parsedSource.data : null,
			installabilityState: calculateCatalogInstallability(
				row,
				baseAppByCatalogId.get(row.id),
			).state,
			mcpToolCount: row.mcpToolCount ?? 0,
		};
	});
}

// =============================================================================
// PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * List catalog apps with filtering and pagination
 * GET /catalog/apps
 */
export const listCatalog = fleetCatalogOs.list
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const limit = input.limit ?? 50;
		const offset = input.offset ?? 0;
		const normalizedSearch = input.search?.trim() ?? "";
		let semanticMatches: Array<{ id: string; score: number }> | undefined;
		let semanticSearchMs: number | undefined;
		if (normalizedSearch) {
			const vectorClient = createCatalogVectorClient(context.env);
			if (vectorClient) {
				const startedAt = Date.now();
				try {
					semanticMatches = await semanticSearchCatalogApps(
						vectorClient,
						normalizedSearch,
						{
							source: input.source,
							connectorType: input.connectorType,
							topK: Math.min(100, Math.max(40, offset + limit * 2)),
						},
					);
				} catch (error) {
					console.warn("[Catalog Search] AI Search unavailable; using D1", {
						error: error instanceof Error ? error.message : String(error),
					});
				} finally {
					semanticSearchMs = Date.now() - startedAt;
				}
			}
		}
		const { apps, total } = await listCatalogApps(db, {
			search: input.search,
			semanticMatches,
			category: input.category,
			connectorType: input.connectorType,
			developerType: input.developerType,
			hasInteractive: input.hasInteractive,
			hasWrites: input.hasWrites,
			healthStatus: input.healthStatus,
			region: input.region,
			source: input.source,
			tag: input.tag,
			sortBy: input.sortBy,
			sortDir: input.sortDir,
			limit,
			offset,
			includeAll: false,
			hideShadowedVariants: !input.includeVariants,
		});
		if (normalizedSearch) {
			console.log("[Catalog Search] retrieval", {
				queryLength: normalizedSearch.length,
				semanticCandidates: semanticMatches?.length ?? 0,
				semanticSearchMs,
				resultCount: apps.length,
				total,
			});
		}
		const appIds = apps.map((app) => app.id);
		const listingRows =
			appIds.length > 0
				? await listStoreListingsForCatalogApps(db, appIds)
				: [];
		const baseAppRows =
			appIds.length > 0 ? await listBaseAppsForCatalogApps(db, appIds) : [];
		const baseAppByCatalogId = new Map<string, BaseAppSummary>();
		for (const app of baseAppRows) {
			if (!app.catalogAppId || baseAppByCatalogId.has(app.catalogAppId)) {
				continue;
			}
			baseAppByCatalogId.set(app.catalogAppId, app);
		}
		const sourcePriority: Record<string, number> = {
			official: 0,
			tedix: 1,
			chatgpt: 2,
			claude: 3,
			community: 4,
			manual: 5,
		};
		const primaryListingByAppId = new Map<
			string,
			(typeof listingRows)[number]
		>();
		for (const listing of listingRows) {
			const current = primaryListingByAppId.get(listing.catalogAppId);
			const currentPriority = current
				? (sourcePriority[current.source] ?? 100)
				: 100;
			const nextPriority = sourcePriority[listing.source] ?? 100;
			if (!current || nextPriority < currentPriority) {
				primaryListingByAppId.set(listing.catalogAppId, listing);
			}
		}

		// Map to list item schema (includes all fields for catalog grid)
		// Unpack JSON blob columns back into flat API response fields
		const appSummaries = apps.map((app) => {
			const primaryListing = primaryListingByAppId.get(app.id);
			const quality = calculateCatalogQuality(app, primaryListing);
			const installability = calculateCatalogInstallability(
				app,
				baseAppByCatalogId.get(app.id),
			);
			return {
				id: app.id,
				source: primaryListing?.source ?? null,
				sourceAppId: primaryListing?.sourceAppId ?? null,
				slug: app.slug ?? null,
				regions: primaryListing?.regions ?? null,
				name: app.name,
				description: sanitizePublicText(app.description),
				logoUrl: publicLogoUrl(app.logoUrl),
				svgLogo: null,
				category: publicCategory(app.category),
				developer: app.developer ?? null,
				website: app.website ?? null,
				connectorType: app.connectorType ?? null,
				developerType: app.developerType ?? null,
				hasWrites: Boolean(app.hasWrites),
				hasInteractive: Boolean(app.hasInteractive),
				hasFileSearch: Boolean(app.hasFileSearch),
				keywordsForTriggering: app.keywordsForTriggering ?? null,
				version: app.version ?? null,
				screenshotUrl: app.richContent?.screenshotUrl ?? null,
				healthStatus: app.healthStatus ?? null,
				healthUptimePercent: app.healthData?.uptimePercent ?? null,
				mcpToolCount: app.mcpToolCount ?? null,
				sourceCreatedAt: app.sourceCreatedAt ?? null,
				lastSyncedAt: app.lastSyncedAt ?? null,
				toolSource: app.toolSource ?? null,
				quality,
				installability,
				createdAt: app.createdAt ?? null,
				updatedAt: app.updatedAt ?? null,
			};
		});
		return {
			apps: appSummaries,
			total,
			pagination: {
				limit,
				offset,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Get a single app by slug with full details and relations
 * GET /catalog/apps/{slug}
 */

/**
 * Get a single app by slug with full details and relations
 * GET /catalog/apps/{slug}
 */
export const getBySlugCatalog = fleetCatalogOs.getBySlug
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { slug } = input;
		const result = await getCatalogAppBySlugWithRelations(db, slug);
		if (!result) {
			return null;
		}
		const discoverability = calculateDiscoverability(result);
		const primaryListing =
			result.storeListings.find((listing) => listing.source === "official") ??
			result.storeListings.find((listing) => listing.source === "tedix") ??
			result.storeListings.find((listing) => listing.source === "chatgpt") ??
			result.storeListings.find((listing) => listing.source === "claude") ??
			result.storeListings[0] ??
			null;
		const quality = calculateCatalogQuality(result, primaryListing);
		const [baseApp, variantRows] = await Promise.all([
			getCatalogBaseApp(db, result.id),
			listCatalogVendorVariants(db, result.id),
		]);
		const installability = calculateCatalogInstallability(result, baseApp);
		const variants = await mapCatalogVariants(db, variantRows);
		const canonicalSlug = NON_RUNNABLE_INSTALLABILITY_STATES.has(
			installability.state,
		)
			? (variantRows.find((variant) => variant.runnable && variant.slug)
					?.slug ?? null)
			: null;

		// Map to detail schema with relations
		// Unpack JSON blob columns (systemHints, healthData, scores, mcpMetadata,
		// richContent, firstSeen) back into flat API response fields
		return {
			// Identity
			id: result.id,
			slug: result.slug,
			name: result.name,
			description: sanitizePublicText(result.description),
			modelDescription: sanitizePublicText(result.modelDescription),
			// MCP Endpoint
			baseUrl: result.baseUrl,
			mcpEndpointNormalized: result.mcpEndpointNormalized,
			toolSource: result.toolSource ?? null,
			// Classification
			connectorType: result.connectorType,
			distributionChannel: result.distributionChannel,
			developerType: result.developerType,
			status: result.status,
			// Branding
			category: publicCategory(result.category),
			developer: result.developer,
			website: result.website,
			privacyPolicy: result.privacyPolicy,
			termsOfService: result.termsOfService,
			logoUrl: publicLogoUrl(result.logoUrl),
			svgLogo: null,
			logoUrlDark: publicLogoUrl(result.logoUrlDark),
			screenshots: result.screenshots ?? null,
			// Discovery
			keywordsForDiscovery: result.keywordsForDiscovery,
			keywordsForTriggering: result.keywordsForTriggering,
			// Capabilities
			hasWrites: result.hasWrites,
			hasInteractive: result.hasInteractive,
			hasFileSearch: result.hasFileSearch,
			hasDeepResearch: result.hasDeepResearch,
			hasSync: result.hasSync,
			authTypes: result.authTypes,
			// MCP Server Metadata (from mcpMetadata blob)
			mcpServerName: result.mcpMetadata?.serverName ?? null,
			mcpServerVersion: result.mcpMetadata?.serverVersion ?? null,
			mcpToolCount: result.mcpToolCount,
			mcpResourceCount: result.mcpResourceCount,
			mcpPromptCount: result.mcpPromptCount,
			mcpLastScannedAt:
				result.mcpMetadata?.lastScannedAt ??
				result.healthData?.lastCheckedAt ??
				null,
			mcpInstructions: result.mcpMetadata?.instructions ?? null,
			// Health Status (from healthData blob, healthStatus stays top-level)
			healthStatus: result.healthStatus,
			healthLastCheckedAt: result.healthData?.lastCheckedAt ?? null,
			healthConnectTimeMs: result.healthData?.connectTimeMs ?? null,
			healthUptimePercent: result.healthData?.uptimePercent ?? null,
			healthErrorMessage: result.healthData?.errorMessage ?? null,
			// Enrichment Data (from richContent blob)
			screenshotUrl: result.richContent?.screenshotUrl ?? null,
			enrichedDescription: sanitizePublicText(
				result.richContent?.enrichedDescription,
			),
			seoDescription: sanitizePublicText(result.seoDescription),
			socialLinks: result.richContent?.socialLinks ?? null,
			examplePrompts: result.richContent?.examplePrompts ?? null,
			categories: publicCategories(result.categories),
			enrichedAt: result.richContent?.enrichedAt ?? null,
			discoverability,
			quality,
			installability,
			variants,
			canonicalSlug,
			// Timestamps
			lastSyncedAt: result.lastSyncedAt,
			createdAt: result.createdAt,
			updatedAt: result.updatedAt,
			sourceCreatedAt: result.sourceCreatedAt,
			// Relations
			storeListings: result.storeListings.map(
				(listing: (typeof result.storeListings)[number]) => ({
					id: listing.id,
					source: listing.source,
					sourceAppId: listing.sourceAppId,
					regions: listing.regions,
					storeUrl: listing.storeUrl,
					reviewStatus: listing.reviewStatus,
					authRequired: listing.authRequired,
					storeLogoUrl: publicLogoUrl(listing.storeLogoUrl),
					storeDescription: sanitizePublicText(listing.storeDescription),
					lastSyncedAt: listing.lastSyncedAt,
				}),
			),
			tools: result.tools.map((tool: (typeof result.tools)[number]) => ({
				id: tool.id,
				toolName: tool.toolName,
				title: tool.title,
				description: sanitizePublicText(tool.description),
				inputSchema: normalizeToolJsonSchema(tool.inputSchema),
				outputSchema: normalizeOutputJsonSchema(tool.outputSchema),
				icons: tool.icons,
				executionTaskSupport: tool.executionTaskSupport,
				annotations: tool.annotations,
				meta: tool.meta,
				detectedAt: tool.detectedAt,
				lastSeenAt: tool.lastSeenAt,
				removedAt: tool.removedAt,
				// Test metrics
				lastTestedAt: tool.lastTestedAt ?? null,
				testSuccessRate: tool.testSuccessRate ?? null,
				avgLatencyMs: tool.avgLatencyMs ?? null,
				testCount: tool.testCount ?? null,
				// Example I/O from tests
				exampleInput: tool.exampleInput ?? null,
				exampleOutput: tool.exampleOutput ?? null,
			})),
			resources: result.resources.map((resource) => ({
				id: resource.id,
				uri: resource.uri,
				name: resource.name,
				title: resource.title,
				description: sanitizePublicText(resource.description),
				mimeType: resource.mimeType,
				icons: resource.icons,
				annotations: resource.annotations,
				meta: resource.meta,
				detectedAt: resource.detectedAt,
				lastSeenAt: resource.lastSeenAt,
				removedAt: resource.removedAt,
			})),
			resourceTemplates: result.resourceTemplates.map((template) => ({
				id: template.id,
				name: template.name,
				title: template.title,
				uriTemplate: template.uriTemplate,
				description: sanitizePublicText(template.description),
				mimeType: template.mimeType,
				icons: template.icons,
				annotations: template.annotations,
				meta: template.meta,
				detectedAt: template.detectedAt,
				lastSeenAt: template.lastSeenAt,
				removedAt: template.removedAt,
			})),
			prompts: result.prompts.map((prompt) => ({
				id: prompt.id,
				promptName: prompt.promptName,
				description: sanitizePublicText(prompt.description),
				arguments: prompt.arguments,
				detectedAt: prompt.detectedAt,
				lastSeenAt: prompt.lastSeenAt,
				removedAt: prompt.removedAt,
			})),
			skills: result.skills.map((skill) => ({
				id: skill.id,
				skillUri: skill.skillUri,
				frontmatter: skill.frontmatter,
				resources: skill.resources,
				detectedAt: skill.detectedAt,
				lastSeenAt: skill.lastSeenAt,
			})),
		};
	});

/**
 * Get category counts
 * GET /catalog/categories
 */

/**
 * Get category counts
 * GET /catalog/categories
 */
export const getCategoriesCatalog = fleetCatalogOs.getCategories
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		const { db } = context;
		return getCatalogCategories(db);
	});

/**
 * Get catalog statistics
 * GET /catalog/stats
 */

/**
 * Get catalog statistics
 * GET /catalog/stats
 */
export const getStatsCatalog = fleetCatalogOs.getStats
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		const { db } = context;

		// Get stats and sync status
		const [stats, syncStatus, autoSyncEnabledBaseApps] = await Promise.all([
			getCatalogStats(db, false),
			getCatalogSyncStatus(db),
			countAutoSyncBaseApps(db),
		]);
		return {
			total: stats.total,
			mcp: stats.mcp,
			withInteractive: stats.withInteractive,
			withWrites: stats.withWrites,
			sourceBreakdown: stats.sourceBreakdown,
			lastSyncedAt: syncStatus.lastSyncedAt,
			syncSource: syncStatus.syncSource,
			autoSyncEnabledBaseApps,
		};
	});

/**
 * Get health status summary
 * GET /catalog/health-summary
 */

/**
 * Get health status summary
 * GET /catalog/health-summary
 */
export const getHealthSummaryCatalog = fleetCatalogOs.getHealthSummary
	.use(AUTHZ.appsRead)
	.handler(async ({ context }) => {
		const { db, env } = context;
		const to = new Date();
		const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
		const [health, usage] = await Promise.all([
			getCatalogHealthSummary(db),
			hasAEConfig(env)
				? getUpstreamProtocolUsageFromAE(
						env,
						from.toISOString(),
						to.toISOString(),
					).catch((error) => {
						console.error("[Catalog Health] Compatibility usage unavailable", {
							error: error instanceof Error ? error.message : String(error),
						});
						return null;
					})
				: null,
		]);
		const compatibilityUsage = usage
			? {
					status: "available" as const,
					from: usage.from,
					to: usage.to,
					sampled: usage.sampled,
					uses: {
						external: {
							modern2026: usage.uses.external.modern_2026,
							legacyStreamable: usage.uses.external.legacy_streamable_2025,
							legacySse: usage.uses.external.legacy_sse_2024,
						},
						firstParty: {
							modern2026: usage.uses.first_party.modern_2026,
							legacyStreamable: usage.uses.first_party.legacy_streamable_2025,
							legacySse: usage.uses.first_party.legacy_sse_2024,
						},
					},
					callerClasses: usage.callerClasses,
					attributionCoverage: usage.attributionCoverage,
					legacyApps: usage.legacyApps,
					legacyAppsTruncated: usage.legacyAppsTruncated,
				}
			: {
					status: hasAEConfig(env)
						? ("unavailable" as const)
						: ("unconfigured" as const),
					from: from.toISOString(),
					to: to.toISOString(),
					sampled: true as const,
					uses: null,
					callerClasses: [],
					attributionCoverage: null,
					legacyApps: [],
					legacyAppsTruncated: false,
				};
		return { ...health, compatibilityUsage };
	});

/**
 * Get recent sync logs for pipeline monitoring
 * GET /catalog/sync-logs
 */

/**
 * Get recent sync logs for pipeline monitoring
 * GET /catalog/sync-logs
 */
export const getSyncLogsCatalog = fleetCatalogOs.getSyncLogs
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const limit = input.limit ?? 20;
		const [logs, syncStatus] = await Promise.all([
			getRecentAppCatalogSyncLogs(db, limit),
			getCatalogSyncStatus(db),
		]);
		const latestLogStartedAt = logs[0]?.startedAt
			? Date.parse(logs[0].startedAt)
			: 0;
		const latestAppSyncedAt = syncStatus.lastSyncedAt
			? Date.parse(syncStatus.lastSyncedAt)
			: 0;
		const freshnessLog =
			syncStatus.lastSyncedAt && latestAppSyncedAt > latestLogStartedAt
				? [
						{
							id: `latest-app-sync-${syncStatus.lastSyncedAt}`,
							syncType: "app_update",
							source: syncStatus.syncSource ?? "app_catalog",
							startedAt: syncStatus.lastSyncedAt,
							completedAt: syncStatus.lastSyncedAt,
							appsDiscovered: syncStatus.appsCount,
							appsUpdated: null,
							appsRemoved: null,
							appsFailed: null,
							status: "completed",
							error: null,
						},
					]
				: [];
		return {
			logs: [
				...freshnessLog,
				...logs.map((log) => ({
					id: log.id,
					syncType: log.syncType,
					source: syncLogSourceLabel(log.source, log.details),
					startedAt: log.startedAt,
					completedAt: log.completedAt ?? null,
					appsDiscovered: log.appsDiscovered ?? null,
					appsUpdated: log.appsUpdated ?? null,
					appsRemoved: log.appsRemoved ?? null,
					appsFailed: log.appsFailed ?? null,
					status: log.status ?? null,
					error: log.error ?? null,
				})),
			].slice(0, limit),
		};
	});

// =============================================================================
// INTERNAL PROCEDURE IMPLEMENTATIONS (service token required)
// =============================================================================

/**
 * Trigger catalog sync workflow
 * POST /catalog/sync
 *
 * Sync modes:
 * - full: Fetch the official registry
 * - r2: Read official registry JSON files from R2
 * - upload: Accept JSON data in request body (for small datasets)
 *
 * Supplier-specific ingestion is owned by private executable skills.
 * Use `source: "claude"` for the official Anthropic MCP Registry supplement.
 */
export const triggerSyncCatalog = fleetCatalogOs.triggerSync
	.use(AUTHZ.catalogWrite)
	.handler(async ({ input, context }) => {
		requireCatalogOperatorAccess(context);
		const { db, env } = context;
		const { r2Path, data, source, searchOnly = false } = input;
		const syncType = searchOnly ? "full" : input.syncType;
		if (searchOnly && (source || r2Path || data)) {
			return {
				success: false,
				syncLogId: "",
				message: "searchOnly cannot be combined with source, r2Path, or data",
			};
		}
		const syncStartedAt = new Date();
		// Repair stranded snapshot logs only from verified native terminal outcomes.
		// The deterministic instance id was introduced with snapshot imports.
		if (env.CATALOG_SYNC_WORKFLOW) {
			for (const log of await getRecentAppCatalogSyncLogs(db, 50)) {
				if (log.status !== "running" || !log.details?.snapshotKey) continue;
				try {
					const state = await (
						await env.CATALOG_SYNC_WORKFLOW.get(`catalog-snapshot-${log.id}`)
					).status();
					const failure = catalogSyncTerminalFailure(state);
					if (failure)
						await failRunningAppCatalogSyncLog(
							db,
							log.id,
							failure,
							new Date().toISOString(),
						);
				} catch (error) {
					console.error("[Catalog] Could not reconcile snapshot workflow", {
						syncLogId: log.id,
						error: String(error),
					});
				}
			}
		}

		await failStaleAppCatalogSyncLogs(
			db,
			new Date(syncStartedAt.getTime() - 6 * 60 * 60 * 1000).toISOString(),
			syncStartedAt.toISOString(),
		);

		// Dispatch by source. "claude" reuses the registry sync (no r2Path
		// needed — fetched live from Claude's public MCP Registry API).
		if (!searchOnly && source === "claude") {
			const result = await runClaudeRegistrySync(db, env);
			return {
				success: result.success,
				syncLogId: result.syncLogId ?? "",
				workflowInstanceId: result.workflowInstanceId,
				message: result.message,
			};
		}
		// Validate input based on sync type. Supplier feeds use the snapshot import capability;
		// R2 imports are retained only for official registry maintenance.
		if (syncType === "r2" && !r2Path) {
			return {
				success: false,
				syncLogId: "",
				message: "R2 sync type requires r2Path parameter",
			};
		}
		if (syncType === "r2" && r2Path && !isSupportedCatalogR2Path(r2Path)) {
			return {
				success: false,
				syncLogId: "",
				message: "R2 sync supports only the Claude registry namespace.",
			};
		}
		if (syncType === "upload" && !data) {
			return {
				success: false,
				syncLogId: "",
				message: "Upload sync type requires data parameter",
			};
		}

		// Detect source from R2 path prefix.
		const detectedSource = syncType === "r2" ? "claude" : null;

		// Create a sync log entry
		const syncLog = await createAppCatalogSyncLog(db, {
			syncType,
			startedAt: syncStartedAt.toISOString(),
			status: "running",
			source: detectedSource as typeof detectedSource,
			details: {
				searchOnly,
				r2Path: r2Path || null,
				hasUploadData: !!data,
			},
		});

		// Trigger the Cloudflare Workflow
		try {
			const workflow = env.CATALOG_SYNC_WORKFLOW;
			if (!workflow)
				throw new Error("CATALOG_SYNC_WORKFLOW binding not available");
			const instance = await workflow.create({
				params: {
					syncType,
					r2Path,
					data,
					searchOnly,
					syncLogId: syncLog.id,
				},
			});
			console.log(
				`[Catalog] Workflow started: ${instance.id} for sync log: ${syncLog.id}`,
			);
			return {
				success: true,
				syncLogId: syncLog.id,
				workflowInstanceId: instance.id,
				message: `Sync workflow started with type: ${syncType}${r2Path ? ` from R2 path: ${r2Path}` : ""}`,
				filesQueued: r2Path ? [r2Path] : undefined,
			};
		} catch (error) {
			console.error("[Catalog] Failed to start sync workflow:", error);

			// Update sync log to failed status
			await updateAppCatalogSyncLog(db, syncLog.id, {
				status: "failed",
				completedAt: new Date().toISOString(),
				error:
					error instanceof Error ? error.message : "Failed to start workflow",
			});
			return {
				success: false,
				syncLogId: syncLog.id,
				workflowInstanceId: undefined,
				message: `Failed to start sync workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	});

/**
 * Trigger MCP scan workflow
 * POST /catalog/scan
 */
/**
 * Bind a catalog app's scanner to a connection provider + org credential.
 *
 * Without this, an auth-gated upstream is scanned anonymously: `tools/list`
 * 401s, so the catalog holds only registry-derived tool NAMES with empty
 * inputSchemas — and every tedi consuming that app has to guess call shapes.
 * `resolveVaultToken()` in McpScanWorkflow already knows how to borrow a Token
 * Vault credential; it just needs these two columns populated.
 */
