import { importCatalogSnapshot } from "./catalog/snapshot-import";
/**
 * catalog router composition.
 * Capability handlers and shared policy live in ./catalog/.
 */
import { triggerSyncCatalog } from "./catalog/discovery-sync";
import {
	backfillToolProvenanceCatalog,
	checkIntegrityCatalog,
	createTenantOpenApiMcpAppProcedure,
	propagateToolsCatalog,
	runOpenApiImportCatalog,
	syncCatalogToolsToAppCatalog,
	triggerToolTestCatalog,
} from "./catalog/quality-governance";
import {
	CATALOG_ID_LOOKUP_BATCH_SIZE,
	catalogOs,
	selectByCatalogAppIds,
} from "./catalog/policy-quality";
import {
	generatedTenantOpenApiProviderId,
	openApiSyncMetadataFromInput,
	parseOpenApiSpecText,
	tenantOpenApiConnectionProviderPlan,
	tenantOpenApiImportInput,
} from "./catalog/install-scan";
import {
	createBaseAppFromCatalogProcedure,
	createFromEndpointCatalog,
	deleteCatalogAppProcedure,
	getAppChangelogRoute,
	getBySlugRoute,
	getCategoriesRoute,
	getDriftReportsRoute,
	getHealthSummaryRoute,
	getRecentChangesRoute,
	getStatsRoute,
	getSyncLogsRoute,
	getToolTestStatsRoute,
	getToolTestsRoute,
	listRoute,
	mergeCatalogAppsProcedure,
	reconcileCatalogAppProcedure,
	syncClaudeRegistryCatalog,
	updateCatalogAppProcedure,
	updateCatalogStoreListingProcedure,
} from "./catalog/source-administration";
import {
	installFromCatalogProcedure,
	setScanConnectionCatalog,
	triggerScanCatalog,
} from "./catalog/tenant-install";
export { calculateCatalogInstallability } from "./catalog/policy-quality";
export { createFromEndpointCatalog } from "./catalog/source-administration";
export { createTenantOpenApiMcpAppProcedure } from "./catalog/quality-governance";
export { fetchClaudeRegistry } from "./catalog/install-scan";
export { getAppChangelogCatalog } from "./catalog/quality-governance";
export { getBySlugCatalog } from "./catalog/discovery-sync";
export { getCategoriesCatalog } from "./catalog/discovery-sync";
export { getHealthSummaryCatalog } from "./catalog/discovery-sync";
export { getRecentChangesCatalog } from "./catalog/quality-governance";
export { getStatsCatalog } from "./catalog/discovery-sync";
export { getSyncLogsCatalog } from "./catalog/discovery-sync";
export { getToolTestsCatalog } from "./catalog/quality-governance";
export { getToolTestStatsCatalog } from "./catalog/quality-governance";
export { installFromCatalogProcedure } from "./catalog/tenant-install";
export { listCatalog } from "./catalog/discovery-sync";
export { setScanConnectionCatalog } from "./catalog/tenant-install";
export { syncClaudeRegistryCatalog } from "./catalog/source-administration";
export { triggerScanCatalog } from "./catalog/tenant-install";
export { triggerSyncCatalog } from "./catalog/discovery-sync";
export { triggerToolTestCatalog } from "./catalog/quality-governance";

// =============================================================================
// ROUTER EXPORT
// =============================================================================

/**
 * Contract-based router using os.router() pattern
 */
export const catalogContractRouter = catalogOs.router({
	importSnapshot: importCatalogSnapshot,
	list: listRoute,
	getBySlug: getBySlugRoute,
	getCategories: getCategoriesRoute,
	getStats: getStatsRoute,
	getHealthSummary: getHealthSummaryRoute,
	getSyncLogs: getSyncLogsRoute,
	triggerSync: triggerSyncCatalog,
	syncClaudeRegistry: syncClaudeRegistryCatalog,
	setScanConnection: setScanConnectionCatalog,
	triggerScan: triggerScanCatalog,
	// Install from catalog
	installFromCatalog: installFromCatalogProcedure,
	createTenantOpenApiMcpApp: createTenantOpenApiMcpAppProcedure,
	// Changelog endpoints
	getAppChangelog: getAppChangelogRoute,
	getRecentChanges: getRecentChangesRoute,
	// Tool testing endpoints
	triggerToolTest: triggerToolTestCatalog,
	getToolTests: getToolTestsRoute,
	getToolTestStats: getToolTestStatsRoute,
	// Drift reports
	getDriftReports: getDriftReportsRoute,
	backfillToolProvenance: backfillToolProvenanceCatalog,
	checkIntegrity: checkIntegrityCatalog,
	// Template propagation
	propagateTools: propagateToolsCatalog,
	// Catalog → base/custom app tool sync
	syncCatalogToolsToApp: syncCatalogToolsToAppCatalog,
	// OpenAPI → app tools
	runOpenApiImport: runOpenApiImportCatalog,
	// End-to-end catalog lifecycle
	reconcileApp: reconcileCatalogAppProcedure,
	// Create platform base app from catalog (create + sync in one step)
	createBaseAppFromCatalog: createBaseAppFromCatalogProcedure,
	// Create from MCP endpoint
	createFromEndpoint: createFromEndpointCatalog,
	// Update / Delete
	updateApp: updateCatalogAppProcedure,
	updateStoreListing: updateCatalogStoreListingProcedure,
	deleteApp: deleteCatalogAppProcedure,
	mergeApps: mergeCatalogAppsProcedure,
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export const catalogRouterTestInternals = {
	CATALOG_ID_LOOKUP_BATCH_SIZE,
	selectByCatalogAppIds,
	generatedTenantOpenApiProviderId,
	openApiSyncMetadataFromInput,
	parseOpenApiSpecText,
	tenantOpenApiConnectionProviderPlan,
	tenantOpenApiImportInput,
};
