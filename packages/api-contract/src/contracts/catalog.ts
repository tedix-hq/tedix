import "@orpc/openapi/extensions/route";
/**
 * Catalog Contract
 * Public API for browsing the App Catalog
 *
 * This contract provides a clean, focused API for:
 * - Listing and filtering catalog apps
 * - Getting detailed app information with relations
 * - Category counts and statistics
 * - Health status summaries
 * - Sync and scan workflow triggers (internal)
 */

import { oc } from "@orpc/contract";
import {
	ImportCatalogSnapshotInputSchema,
	ImportCatalogSnapshotOutputSchema,
} from "../schemas/catalog-snapshot";
import * as z from "zod";
import {
	BackfillCatalogToolProvenanceInputSchema,
	BackfillCatalogToolProvenanceOutputSchema,
	CatalogAppDetailSchema,
	CatalogStatsSchema,
	CheckCatalogIntegrityInputSchema,
	CheckCatalogIntegrityOutputSchema,
	CreateBaseAppFromCatalogInputSchema,
	CreateBaseAppFromCatalogOutputSchema,
	CreateFromEndpointInputSchema,
	CreateFromEndpointOutputSchema,
	CreateTenantOpenApiMcpAppInputSchema,
	CreateTenantOpenApiMcpAppOutputSchema,
	DeleteCatalogAppInputSchema,
	DeleteCatalogAppOutputSchema,
	GetAppChangelogInputSchema,
	GetAppChangelogOutputSchema,
	GetCategoriesOutputSchema,
	GetDriftReportsInputSchema,
	GetDriftReportsOutputSchema,
	GetRecentChangesInputSchema,
	GetRecentChangesOutputSchema,
	GetSyncLogsInputSchema,
	GetSyncLogsOutputSchema,
	GetToolTestsInputSchema,
	GetToolTestsOutputSchema,
	HealthSummarySchema,
	InstallFromCatalogInputSchema,
	InstallFromCatalogOutputSchema,
	ListCatalogAppsInputSchema,
	ListCatalogAppsOutputSchema,
	MergeCatalogAppsInputSchema,
	MergeCatalogAppsOutputSchema,
	OpenApiImportInputSchema,
	OpenApiImportWorkflowOutputSchema,
	PropagateToolsInputSchema,
	PropagateToolsOutputSchema,
	ReconcileCatalogAppInputSchema,
	ReconcileCatalogAppOutputSchema,
	SyncCatalogToolsToAppInputSchema,
	SyncCatalogToolsToAppOutputSchema,
	SyncClaudeRegistryInputSchema,
	SyncClaudeRegistryOutputSchema,
	ToolTestStatsSchema,
	TriggerScanInputSchema,
	TriggerScanOutputSchema,
	TriggerSyncInputSchema,
	TriggerSyncOutputSchema,
	TriggerToolTestInputSchema,
	TriggerToolTestOutputSchema,
	UpdateCatalogAppInputSchema,
	UpdateCatalogAppOutputSchema,
	UpdateCatalogStoreListingInputSchema,
	UpdateCatalogStoreListingOutputSchema,
} from "../schemas/catalog";

/**
 * Catalog Contract
 *
 * Customer-facing REST endpoints (authentication required):
 * - GET /catalog/apps - List apps with filtering
 * - GET /catalog/apps/:slug - Get app by slug with relations
 * - GET /catalog/categories - Get category counts
 * - GET /catalog/stats - Get catalog statistics
 * - GET /catalog/health-summary - Get health status summary
 *
 * Internal RPC/MCP endpoints (service/operator authorization required):
 * - POST /catalog/sync - Trigger sync workflow
 * - POST /catalog/scan - Trigger scan workflow
 */
export const catalogContract = oc
	.route({ tags: ["catalog"], prefix: "/catalog" })
	.router({
		importSnapshot: oc
			.route({
				method: "POST",
				path: "/import-snapshot",
				summary: "Import a complete supplier catalog snapshot",
				description:
					"Operator-only browser capture and durable normalized catalog import. Supplier extraction code is supplied by the caller.",
			})
			.input(ImportCatalogSnapshotInputSchema)
			.output(ImportCatalogSnapshotOutputSchema),
		// ============================================================
		// Customer-facing REST endpoints (authentication required)
		// ============================================================

		/**
		 * List catalog apps with filtering and pagination
		 * GET /catalog/apps
		 */
		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/apps",
				summary: "List catalog apps",
				description:
					"List apps from the catalog with filtering and pagination. Only returns discoverable apps from trusted developers.",
			})
			.input(ListCatalogAppsInputSchema)
			.output(ListCatalogAppsOutputSchema),

		/**
		 * Get a single app by slug with full details and relations
		 * GET /catalog/apps/:slug
		 */
		getBySlug: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/apps/{slug}",
				summary: "Get catalog app by slug",
				description:
					"Get detailed information about a catalog app including store listings and MCP tools",
			})
			.input(z.object({ slug: z.string() }))
			.output(CatalogAppDetailSchema.nullable()),

		/**
		 * Get category counts
		 * GET /catalog/categories
		 */
		getCategories: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/categories",
				summary: "Get category counts",
				description: "Get all categories with app counts",
			})
			.input(z.object({}))
			.output(GetCategoriesOutputSchema),

		/**
		 * Get catalog statistics
		 * GET /catalog/stats
		 */
		getStats: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/stats",
				summary: "Get catalog statistics",
				description:
					"Get overall statistics including total apps, MCP count, and capability counts",
			})
			.input(z.object({}))
			.output(CatalogStatsSchema),

		/**
		 * Get health status summary
		 * GET /catalog/health-summary
		 */
		getHealthSummary: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/health-summary",
				summary: "Get health status summary",
				description:
					"Get catalog health, scan backlog, protocol-era inventory, and bounded 30-day successful compatibility usage",
			})
			.input(z.object({}))
			.output(HealthSummarySchema),

		/**
		 * Get recent sync logs for pipeline insights
		 * GET /catalog/sync-logs
		 */
		getSyncLogs: oc
			.route({
				method: "GET",
				path: "/sync-logs",
				tags: ["internal"],
				summary: "Get recent sync logs",
				description:
					"Get recent catalog sync log entries for pipeline monitoring",
			})
			.input(GetSyncLogsInputSchema)
			.output(GetSyncLogsOutputSchema),

		// ============================================================
		// Internal Endpoints (service token required)
		// ============================================================

		/**
		 * Trigger catalog sync workflow
		 * POST /catalog/sync
		 */
		triggerSync: oc
			.route({
				method: "POST",
				path: "/sync",
				summary: "Trigger catalog sync",
				description:
					"Start a Cloudflare Workflow for official registry imports. Supplier-specific executable skills use the normalized snapshot import capability.",
				tags: ["service", "internal"],
			})
			.input(TriggerSyncInputSchema)
			.output(TriggerSyncOutputSchema),

		/**
		 * Sync Claude MCP Registry
		 * POST /catalog/sync-claude-registry
		 *
		 * Fetches the public Claude MCP Registry API, saves to R2,
		 * and triggers a sync workflow to import servers into the catalog.
		 */
		syncClaudeRegistry: oc
			.route({
				method: "POST",
				path: "/sync-claude-registry",
				summary: "Sync Claude MCP Registry",
				description:
					"Fetch servers from Claude's public MCP Registry API and sync them into the catalog.",
				tags: ["service", "internal"],
			})
			.input(SyncClaudeRegistryInputSchema)
			.output(SyncClaudeRegistryOutputSchema),

		/**
		 * Trigger scan workflow
		 * POST /catalog/scan
		 */
		triggerScan: oc
			.route({
				method: "POST",
				path: "/scan",
				summary: "Trigger scan workflow",
				description:
					"Start a Cloudflare Workflow to scan MCP endpoints and discover tools for apps needing scans.",
				tags: ["service", "internal"],
			})
			.input(TriggerScanInputSchema)
			.output(TriggerScanOutputSchema),

		/**
		 * Bind a catalog app's scanner to a connection provider + org credential.
		 * POST /catalog/scan-connection
		 *
		 * An auth-gated upstream (healthStatus `requires_auth`) is scanned
		 * anonymously and therefore yields no tool schemas. The scanner can use a
		 * Descope Token Vault credential, but only when the catalog row carries
		 * `scan_connection_id` + `scan_organization_id`. Nothing could set those on
		 * an existing row until now.
		 *
		 * Platform-admin only: `app_catalog` is GLOBAL, so this points a shared
		 * catalog row at ONE org's credential. Only the discovered schemas are
		 * published (they are not tenant data), but the credential is that org's.
		 */
		setScanConnection: oc
			.route({
				method: "POST",
				path: "/scan-connection",
				summary: "Bind catalog scanner to a connection",
				description:
					"Point a catalog app's scanner at a connection provider and the org whose Token Vault credential it should use, so auth-gated upstreams can be scanned for real tool schemas. Platform-admin only.",
				tags: ["internal"],
			})
			.input(
				z.object({
					catalogAppId: z.uuid().optional(),
					catalogAppSlug: z.string().min(1).optional(),
					/** Connection provider / Descope outbound app id (e.g. "planetscale"). */
					connectionId: z.string().min(1),
					/** Org whose Token Vault credential the scanner borrows. */
					organizationId: z.uuid(),
					/** Header to inject. Defaults to Authorization. */
					connectionHeader: z.string().min(1).optional(),
					/** Header value template; `{token}` is substituted. Defaults to `Bearer {token}`. */
					connectionTemplate: z.string().min(1).optional(),
				}),
			)
			.output(
				z.object({
					updated: z.boolean(),
					catalogAppId: z.string(),
					catalogAppSlug: z.string(),
					connectionId: z.string(),
					organizationId: z.string(),
					connectionHeader: z.string(),
					connectionTemplate: z.string(),
				}),
			),

		// ============================================================
		// Install from Catalog
		// ============================================================

		/**
		 * Install a catalog app as a personalized zero-tool org proxy app
		 * POST /catalog/apps/:catalogAppId/install
		 */
		installFromCatalog: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/apps/{catalogAppId}/install",
				summary: "Install catalog app as org proxy app",
				description:
					"Create a personalized org proxy app from a catalog entry. The proxy keeps zero app_tools rows and inherits platform base app tools through aggregateApps.",
				successStatus: 201,
			})
			.input(InstallFromCatalogInputSchema)
			.output(InstallFromCatalogOutputSchema),

		/**
		 * Tenant-safe OpenAPI creation: tenant-owned generated base app → catalog
		 * row → zero-tool proxy → caller-owned aggregator attachment.
		 */
		createTenantOpenApiMcpApp: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/tenant-openapi-mcp-app",
				summary: "Create tenant OpenAPI MCP app",
				description:
					"Create or reuse a tenant-owned OpenAPI-generated MCP app, register it as a tenant-authored catalog app, create/reuse its zero-tool tenant proxy, and attach that proxy to the caller-owned aggregator app.",
			})
			.input(CreateTenantOpenApiMcpAppInputSchema)
			.output(CreateTenantOpenApiMcpAppOutputSchema),

		// ============================================================
		// Changelog Endpoints
		// ============================================================

		/**
		 * Get changelog for a specific app
		 * GET /catalog/apps/:id/changelog
		 */
		getAppChangelog: oc
			.route({
				method: "GET",
				path: "/apps/{id}/changelog",
				summary: "Get app changelog",
				description:
					"Get field-level change history for a specific catalog app",
			})
			.input(GetAppChangelogInputSchema)
			.output(GetAppChangelogOutputSchema),

		/**
		 * Get recent changes across all apps
		 * GET /catalog/changes/recent
		 */
		getRecentChanges: oc
			.route({
				method: "GET",
				path: "/changes/recent",
				summary: "Get recent catalog changes",
				description:
					"Get recent changes across all catalog apps, optionally filtered by change type",
			})
			.input(GetRecentChangesInputSchema)
			.output(GetRecentChangesOutputSchema),

		// ============================================================
		// Tool Testing Endpoints
		// ============================================================

		/**
		 * Trigger tool test workflow
		 * POST /catalog/test-tools
		 */
		triggerToolTest: oc
			.route({
				method: "POST",
				path: "/test-tools",
				summary: "Trigger tool test workflow",
				description:
					"Start a Cloudflare Workflow to test MCP tools. Supports programmatic (free) or AI-powered (with Workers AI) testing.",
				tags: ["service", "internal"],
			})
			.input(TriggerToolTestInputSchema)
			.output(TriggerToolTestOutputSchema),

		/**
		 * Get tool test history
		 * GET /catalog/tool-tests
		 */
		getToolTests: oc
			.route({
				method: "GET",
				path: "/tool-tests",
				tags: ["internal"],
				summary: "Get tool test history",
				description:
					"Get test results for MCP tools with filtering and pagination.",
			})
			.input(GetToolTestsInputSchema)
			.output(GetToolTestsOutputSchema),

		/**
		 * Get tool test statistics
		 * GET /catalog/tool-test-stats
		 */
		getToolTestStats: oc
			.route({
				method: "GET",
				path: "/tool-test-stats",
				tags: ["internal"],
				summary: "Get tool test statistics",
				description:
					"Get overall statistics for tool testing including success rates, latency, and AI eval metrics.",
			})
			.input(z.object({}))
			.output(ToolTestStatsSchema),

		// ============================================================
		// Upstream Drift Reports
		// ============================================================

		/**
		 * Get upstream drift reports for the org
		 * GET /catalog/drift-reports
		 */
		getDriftReports: oc
			.route({
				method: "GET",
				path: "/drift-reports",
				tags: ["internal"],
				summary: "Get upstream drift reports",
				description:
					"Get latest upstream drift detection results for all apps in the org. Optionally filter by a specific app.",
			})
			.input(GetDriftReportsInputSchema)
			.output(GetDriftReportsOutputSchema),

		/**
		 * Backfill schema provenance on catalog tool snapshots.
		 * POST /catalog/tools/backfill-provenance
		 */
		backfillToolProvenance: oc
			.route({
				method: "POST",
				path: "/tools/backfill-provenance",
				summary: "Backfill catalog tool schema provenance",
				description:
					"Fill missing schema provenance columns on app_catalog_mcp_tools snapshots. Existing Tedix/OpenAPI projections prefer linked base-app app_tools provenance; upstream MCP snapshots get deterministic MCP provenance.",
				tags: ["service", "internal"],
			})
			.input(BackfillCatalogToolProvenanceInputSchema)
			.output(BackfillCatalogToolProvenanceOutputSchema),

		/**
		 * Check catalog lifecycle integrity and optionally apply safe repairs.
		 * POST /catalog/integrity/check
		 */
		checkIntegrity: oc
			.route({
				method: "POST",
				path: "/integrity/check",
				summary: "Check catalog integrity",
				description:
					"Check catalog apps for source linkage, snapshot count drift, schema provenance coverage, generated outputSchema/annotation gaps, and unresolved upstream drift. Apply mode only runs safe repairs: provenance backfill and mcpToolCount reconciliation.",
				tags: ["service", "internal"],
			})
			.input(CheckCatalogIntegrityInputSchema)
			.output(CheckCatalogIntegrityOutputSchema),

		// ============================================================
		// Custom Fork Propagation
		// ============================================================

		/**
		 * Propagate tools from a base app to explicit custom forks
		 * POST /catalog/propagate-tools
		 */
		propagateTools: oc
			.route({
				method: "POST",
				path: "/propagate-tools",
				tags: ["internal"],
				summary: "Propagate tools from base app to custom forks",
				description:
					"Compare tool definitions between a base app and explicit custom-fork target apps, then propagate changes. Tenant/project proxy apps inherit through aggregateApps and should not be propagation targets.",
			})
			.input(PropagateToolsInputSchema)
			.output(PropagateToolsOutputSchema),

		// ============================================================
		// Sync Catalog Tools To App
		// ============================================================

		/**
		 * Create the platform base app for a catalog entry and sync its MCP tools.
		 * Idempotent: if a base app already exists (same catalogAppId), syncs tools instead.
		 * POST /catalog/create-base-app
		 */
		createBaseAppFromCatalog: oc
			.route({
				method: "POST",
				path: "/create-base-app",
				summary: "Create platform base app from catalog entry",
				description:
					"Creates a base app owned by the platform org (slug = catalogApp.slug) and syncs all catalog MCP tools as D1 app_tools rows. Idempotent — safe to re-run if tools change upstream.",
				tags: ["service", "internal"],
			})
			.input(CreateBaseAppFromCatalogInputSchema)
			.output(CreateBaseAppFromCatalogOutputSchema),

		/**
		 * Sync catalog-scanned MCP tools into a base/custom app's D1 app_tools rows.
		 * Proxy apps are zero-tool overlays and are rejected by the implementation.
		 * POST /catalog/sync-tools-to-app
		 */
		syncCatalogToolsToApp: oc
			.route({
				method: "POST",
				path: "/sync-tools-to-app",
				summary: "Sync catalog MCP tools to app",
				description:
					"Read active tools from a catalog entry and create/update corresponding app_tools rows on a base/custom app with transport: mcp. Deterministic sync from catalog → app_tools; proxy apps inherit through aggregateApps and are rejected.",
				tags: ["service", "internal"],
			})
			.input(SyncCatalogToolsToAppInputSchema)
			.output(SyncCatalogToolsToAppOutputSchema),

		/**
		 * Run OpenAPI tool import.
		 * POST /catalog/openapi-import/run
		 */
		runOpenApiImport: oc
			.route({
				method: "POST",
				path: "/openapi-import/run",
				summary: "Run OpenAPI tool import",
				description:
					"Queue OpenApiSyncWorkflow to create or update external app_tools generated from an OpenAPI JSON specification. Catalog-owned canonical REST import surface.",
				tags: ["service", "internal"],
			})
			.input(OpenApiImportInputSchema)
			.output(OpenApiImportWorkflowOutputSchema),

		/**
		 * Reconcile one catalog app end-to-end.
		 * POST /catalog/reconcile-app
		 */
		reconcileApp: oc
			.route({
				method: "POST",
				path: "/reconcile-app",
				summary: "Reconcile catalog app",
				description:
					"One-shot catalog lifecycle operation. Scans or imports the source of truth, refreshes catalog snapshots, syncs base/custom app tool rows where applicable, and can propagate to explicit custom forks.",
				tags: ["service", "internal"],
			})
			.input(ReconcileCatalogAppInputSchema)
			.output(ReconcileCatalogAppOutputSchema),

		// ============================================================
		// Update / Delete Catalog App
		// ============================================================

		/**
		 * Update a catalog app's metadata
		 * PATCH /catalog/apps/:id
		 */
		updateApp: oc
			.route({
				method: "PATCH",
				path: "/apps/{id}",
				summary: "Update catalog app",
				description:
					"Update catalog app metadata such as status, description, keywords, category, or developer info. Use to enable/disable apps, improve discoverability, or correct metadata.",
				tags: ["service", "internal"],
			})
			.input(UpdateCatalogAppInputSchema)
			.output(UpdateCatalogAppOutputSchema),

		/**
		 * Update one catalog app store listing's per-source metadata
		 * PATCH /catalog/store-listings/:id
		 */
		updateStoreListing: oc
			.route({
				method: "PATCH",
				path: "/store-listings/{id}",
				summary: "Update catalog store listing",
				description:
					"Update per-source catalog listing metadata such as store URL, source app id, auth flag, logo, description, regions, or review status.",
				tags: ["service", "internal"],
			})
			.input(UpdateCatalogStoreListingInputSchema)
			.output(UpdateCatalogStoreListingOutputSchema),

		/**
		 * Delete a catalog app and all related data (cascading)
		 * DELETE /catalog/apps/:id
		 */
		deleteApp: oc
			.route({
				method: "DELETE",
				path: "/apps/{id}",
				summary: "Delete catalog app",
				description:
					"Permanently delete a catalog app and all related data (store listings, MCP tools, health history, drift reports). This action is irreversible.",
				tags: ["service", "internal"],
			})
			.input(DeleteCatalogAppInputSchema)
			.output(DeleteCatalogAppOutputSchema),

		/**
		 * Merge an orphan/duplicate catalog app into a canonical one
		 * POST /catalog/apps/merge
		 */
		mergeApps: oc
			.route({
				method: "POST",
				path: "/apps/merge",
				// Pin the MCP tool id to the catalog `_catalog_` convention
				// (delete_catalog_app, update_catalog_app, sync_catalog_tools_to_app)
				// instead of the auto-derived `merge_apps`.
				operationId: "merge_catalog_apps",
				summary: "Merge catalog apps",
				description:
					"Merge a duplicate/orphan catalog app (typically a store-brokered SERVICE connector with no MCP endpoint) into its canonical runnable entry: re-parent its store listings as listing facets, move its change history, drop redundant snapshots, and delete the orphan row. Defaults to a dry run.",
				tags: ["service", "internal"],
			})
			.input(MergeCatalogAppsInputSchema)
			.output(MergeCatalogAppsOutputSchema),

		// ============================================================
		// Create from MCP Endpoint
		// ============================================================

		/**
		 * Create a catalog app by connecting to an MCP endpoint directly
		 * POST /catalog/create-from-endpoint
		 */
		createFromEndpoint: oc
			.route({
				method: "POST",
				path: "/create-from-endpoint",
				summary: "Create catalog app from MCP endpoint",
				description:
					"Connect to an MCP server endpoint, discover tools/resources/prompts, and create a catalog entry with source 'official'. Deduplicates by normalized endpoint hash.",
				successStatus: 201,
				tags: ["service", "internal"],
			})
			.input(CreateFromEndpointInputSchema)
			.output(CreateFromEndpointOutputSchema),
	});

export type CatalogContract = typeof catalogContract;
