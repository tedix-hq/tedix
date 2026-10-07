/**
 * Drizzle Relations v2: apps domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const appRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// APPS
	// =========================================================================

	apps: {
		organization: r.one.organizations({
			from: r.apps.organizationId,
			to: r.organizations.id,
		}),
		sourceApp: r.one.apps({
			from: r.apps.sourceAppId,
			to: r.apps.id,
			alias: "appLineage",
		}),
		catalogApp: r.one.appCatalog({
			from: r.apps.catalogAppId,
			to: r.appCatalog.id,
		}),
		activeConfigVersion: r.one.appConfigVersions({
			from: r.apps.activeConfigVersionId,
			to: r.appConfigVersions.id,
			alias: "activeAppConfigVersion",
		}),
		tools: r.many.appTools({
			from: r.apps.id,
			to: r.appTools.appId,
		}),
		adapters: r.many.appAdapters({
			from: r.apps.id,
			to: r.appAdapters.appId,
		}),
		adapterSecretBindings: r.many.appAdapterSecretBindings({
			from: r.apps.id,
			to: r.appAdapterSecretBindings.appId,
		}),
		items: r.many.items({
			from: r.apps.id,
			to: r.items.appId,
		}),
		secrets: r.many.appSecrets({
			from: r.apps.id,
			to: r.appSecrets.appId,
		}),
		widgetEvents: r.many.widgetEvents({
			from: r.apps.id,
			to: r.widgetEvents.appId,
		}),
		contentSources: r.many.contentSources({
			from: r.apps.id,
			to: r.contentSources.appId,
		}),
		contentSourceDocuments: r.many.contentSourceDocuments({
			from: r.apps.id,
			to: r.contentSourceDocuments.appId,
		}),
		configVersions: r.many.appConfigVersions({
			from: r.apps.id,
			to: r.appConfigVersions.appId,
		}),
		derivedApps: r.many.apps({
			from: r.apps.id,
			to: r.apps.sourceAppId,
			alias: "appLineage",
		}),
		skillEntries: r.many.skillEntries({
			from: r.apps.id,
			to: r.skillEntries.appId,
		}),
		jobs: r.many.jobs({
			from: r.apps.id,
			to: r.jobs.appId,
		}),
	},

	appAdapters: {
		app: r.one.apps({
			from: r.appAdapters.appId,
			to: r.apps.id,
		}),
		secretBindings: r.many.appAdapterSecretBindings({
			from: r.appAdapters.id,
			to: r.appAdapterSecretBindings.adapterId,
		}),
	},

	appAdapterSecretBindings: {
		adapter: r.one.appAdapters({
			from: r.appAdapterSecretBindings.adapterId,
			to: r.appAdapters.id,
		}),
		app: r.one.apps({
			from: r.appAdapterSecretBindings.appId,
			to: r.apps.id,
		}),
	},

	appSecrets: {
		app: r.one.apps({
			from: r.appSecrets.appId,
			to: r.apps.id,
		}),
	},

	appTools: {
		app: r.one.apps({
			from: r.appTools.appId,
			to: r.apps.id,
		}),
		cspDomains: r.many.appToolCspDomains({
			from: r.appTools.id,
			to: r.appToolCspDomains.appToolId,
		}),
	},

	appToolCspDomains: {
		tool: r.one.appTools({
			from: r.appToolCspDomains.appToolId,
			to: r.appTools.id,
		}),
	},

	appConfigVersions: {
		app: r.one.apps({
			from: r.appConfigVersions.appId,
			to: r.apps.id,
		}),
		activeForApps: r.many.apps({
			from: r.appConfigVersions.id,
			to: r.apps.activeConfigVersionId,
			alias: "activeAppConfigVersion",
		}),
	},

	items: {
		app: r.one.apps({
			from: r.items.appId,
			to: r.apps.id,
		}),
		widgetEvents: r.many.widgetEvents({
			from: r.items.id,
			to: r.widgetEvents.itemId,
		}),
	},

	// =========================================================================
	// ANALYTICS
	// =========================================================================

	widgetEvents: {
		organization: r.one.organizations({
			from: r.widgetEvents.organizationId,
			to: r.organizations.id,
		}),
		app: r.one.apps({
			from: r.widgetEvents.appId,
			to: r.apps.id,
		}),
		item: r.one.items({
			from: r.widgetEvents.itemId,
			to: r.items.id,
		}),
	},
}));
