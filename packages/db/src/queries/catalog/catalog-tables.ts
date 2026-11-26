import { apps as schemaApps } from "../../schema/apps";
import {
	appCatalog as schemaAppCatalog,
	appCatalogBrowseTotals as schemaAppCatalogBrowseTotals,
	appCatalogCategoryTotals as schemaAppCatalogCategoryTotals,
	appCatalogChanges as schemaAppCatalogChanges,
	appCatalogHealthHistory as schemaAppCatalogHealthHistory,
	appCatalogMcpPrompts as schemaAppCatalogMcpPrompts,
	appCatalogMcpResourceTemplates as schemaAppCatalogMcpResourceTemplates,
	appCatalogMcpResources as schemaAppCatalogMcpResources,
	appCatalogMcpSkills as schemaAppCatalogMcpSkills,
	appCatalogMcpTools as schemaAppCatalogMcpTools,
	appCatalogStoreListings as schemaAppCatalogStoreListings,
	appCatalogSyncLogs as schemaAppCatalogSyncLogs,
	appCatalogToolTests as schemaAppCatalogToolTests,
	upstreamDriftReports as schemaUpstreamDriftReports,
} from "../../schema/catalog";
import { skillEntries as schemaSkillEntries } from "../../schema/cognitive";
import { appTools as schemaAppTools } from "../../schema/tools";
import { coreTable } from "../../core-store/client";

/** Catalog and catalog-sync tables on the active core store. */
export function catalogTables(db: object) {
	return {
		appCatalog: coreTable(db, schemaAppCatalog),
		appCatalogBrowseTotals: coreTable(db, schemaAppCatalogBrowseTotals),
		appCatalogCategoryTotals: coreTable(db, schemaAppCatalogCategoryTotals),
		appCatalogChanges: coreTable(db, schemaAppCatalogChanges),
		appCatalogHealthHistory: coreTable(db, schemaAppCatalogHealthHistory),
		appCatalogMcpPrompts: coreTable(db, schemaAppCatalogMcpPrompts),
		appCatalogMcpResourceTemplates: coreTable(
			db,
			schemaAppCatalogMcpResourceTemplates,
		),
		appCatalogMcpResources: coreTable(db, schemaAppCatalogMcpResources),
		appCatalogMcpSkills: coreTable(db, schemaAppCatalogMcpSkills),
		appCatalogMcpTools: coreTable(db, schemaAppCatalogMcpTools),
		appCatalogStoreListings: coreTable(db, schemaAppCatalogStoreListings),
		appCatalogSyncLogs: coreTable(db, schemaAppCatalogSyncLogs),
		appCatalogToolTests: coreTable(db, schemaAppCatalogToolTests),
		upstreamDriftReports: coreTable(db, schemaUpstreamDriftReports),
		apps: coreTable(db, schemaApps),
		appTools: coreTable(db, schemaAppTools),
		skillEntries: coreTable(db, schemaSkillEntries),
	};
}
