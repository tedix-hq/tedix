/**
 * Drizzle Relations v2: catalog domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const catalogRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// CATALOG
	// =========================================================================

	appCatalog: {
		storeListings: r.many.appCatalogStoreListings({
			from: r.appCatalog.id,
			to: r.appCatalogStoreListings.catalogAppId,
		}),
		mcpTools: r.many.appCatalogMcpTools({
			from: r.appCatalog.id,
			to: r.appCatalogMcpTools.catalogAppId,
		}),
		mcpResources: r.many.appCatalogMcpResources({
			from: r.appCatalog.id,
			to: r.appCatalogMcpResources.catalogAppId,
		}),
		mcpResourceTemplates: r.many.appCatalogMcpResourceTemplates({
			from: r.appCatalog.id,
			to: r.appCatalogMcpResourceTemplates.catalogAppId,
		}),
		mcpPrompts: r.many.appCatalogMcpPrompts({
			from: r.appCatalog.id,
			to: r.appCatalogMcpPrompts.catalogAppId,
		}),
		mcpSkills: r.many.appCatalogMcpSkills({
			from: r.appCatalog.id,
			to: r.appCatalogMcpSkills.catalogAppId,
		}),
		healthHistory: r.many.appCatalogHealthHistory({
			from: r.appCatalog.id,
			to: r.appCatalogHealthHistory.catalogAppId,
		}),
		toolTests: r.many.appCatalogToolTests({
			from: r.appCatalog.id,
			to: r.appCatalogToolTests.catalogAppId,
		}),
		changes: r.many.appCatalogChanges({
			from: r.appCatalog.id,
			to: r.appCatalogChanges.catalogAppId,
		}),
		driftReports: r.many.upstreamDriftReports({
			from: r.appCatalog.id,
			to: r.upstreamDriftReports.catalogAppId,
		}),
		installedApps: r.many.apps({
			from: r.appCatalog.id,
			to: r.apps.catalogAppId,
		}),
	},

	appCatalogStoreListings: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogStoreListings.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogMcpTools: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogMcpTools.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogMcpResources: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogMcpResources.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogMcpResourceTemplates: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogMcpResourceTemplates.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogMcpPrompts: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogMcpPrompts.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogMcpSkills: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogMcpSkills.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogHealthHistory: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogHealthHistory.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogToolTests: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogToolTests.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	appCatalogSyncLogs: {},

	appCatalogChanges: {
		catalogApp: r.one.appCatalog({
			from: r.appCatalogChanges.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	upstreamDriftReports: {
		catalogApp: r.one.appCatalog({
			from: r.upstreamDriftReports.catalogAppId,
			to: r.appCatalog.id,
		}),
	},

	// =========================================================================
}));
