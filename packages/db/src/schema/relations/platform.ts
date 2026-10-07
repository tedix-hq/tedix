/**
 * Drizzle Relations v2: platform domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const platformRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// PLUGINS
	// =========================================================================

	tediPlugins: {
		authorOrg: r.one.organizations({
			from: r.tediPlugins.authorOrgId,
			to: r.organizations.id,
		}),
		installs: r.many.tediPluginInstalls({
			from: r.tediPlugins.id,
			to: r.tediPluginInstalls.pluginId,
		}),
		events: r.many.tediPluginEvents({
			from: r.tediPlugins.id,
			to: r.tediPluginEvents.pluginId,
		}),
	},

	tediPluginInstalls: {
		organization: r.one.organizations({
			from: r.tediPluginInstalls.orgId,
			to: r.organizations.id,
		}),
		plugin: r.one.tediPlugins({
			from: r.tediPluginInstalls.pluginId,
			to: r.tediPlugins.id,
		}),
		tedi: r.one.tedis({
			from: r.tediPluginInstalls.tediId,
			to: r.tedis.id,
		}),
	},

	tediPluginEvents: {
		organization: r.one.organizations({
			from: r.tediPluginEvents.orgId,
			to: r.organizations.id,
		}),
		plugin: r.one.tediPlugins({
			from: r.tediPluginEvents.pluginId,
			to: r.tediPlugins.id,
		}),
		tedi: r.one.tedis({
			from: r.tediPluginEvents.tediId,
			to: r.tedis.id,
		}),
	},

	// =========================================================================
	// CONTENT
	// =========================================================================

	contentSources: {
		app: r.one.apps({
			from: r.contentSources.appId,
			to: r.apps.id,
		}),
	},
	contentSourceDocuments: {
		app: r.one.apps({
			from: r.contentSourceDocuments.appId,
			to: r.apps.id,
		}),
		source: r.one.contentSources({
			from: r.contentSourceDocuments.sourceId,
			to: r.contentSources.id,
		}),
	},

	// =========================================================================
	// CONTROL PLANE
	// =========================================================================

	runtimeProfiles: {
		organization: r.one.organizations({
			from: r.runtimeProfiles.organizationId,
			to: r.organizations.id,
		}),
		tedis: r.many.tedis({
			from: r.runtimeProfiles.id,
			to: r.tedis.runtimeProfileId,
		}),
	},

	policyPacks: {
		organization: r.one.organizations({
			from: r.policyPacks.organizationId,
			to: r.organizations.id,
		}),
		tedis: r.many.tedis({
			from: r.policyPacks.id,
			to: r.tedis.policyPackId,
		}),
	},

	workspaceTemplateSets: {
		organization: r.one.organizations({
			from: r.workspaceTemplateSets.organizationId,
			to: r.organizations.id,
		}),
		tedis: r.many.tedis({
			from: r.workspaceTemplateSets.id,
			to: r.tedis.workspaceTemplateSetId,
		}),
	},

	// =========================================================================
	// TEMPLATES
	// =========================================================================

	appTemplates: {},

	// =========================================================================
	// JOBS
	// =========================================================================

	jobs: {
		app: r.one.apps({
			from: r.jobs.appId,
			to: r.apps.id,
		}),
	},

	// =========================================================================
}));
