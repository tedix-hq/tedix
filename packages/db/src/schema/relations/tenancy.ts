/**
 * Drizzle Relations v2: tenancy domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const tenancyRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// ORGANIZATIONS
	// =========================================================================

	organizations: {
		apps: r.many.apps({
			from: r.organizations.id,
			to: r.apps.organizationId,
		}),
		tedis: r.many.tedis({
			from: r.organizations.id,
			to: r.tedis.organizationId,
		}),
		members: r.many.organizationMembers({
			from: r.organizations.id,
			to: r.organizationMembers.organizationId,
		}),
		apiKeys: r.many.apiKeys({
			from: r.organizations.id,
			to: r.apiKeys.organizationId,
		}),
		secrets: r.many.organizationSecrets({
			from: r.organizations.id,
			to: r.organizationSecrets.organizationId,
		}),
		widgetEvents: r.many.widgetEvents({
			from: r.organizations.id,
			to: r.widgetEvents.organizationId,
		}),
		knowledgeEntries: r.many.knowledgeEntries({
			from: r.organizations.id,
			to: r.knowledgeEntries.organizationId,
		}),
		skillEntries: r.many.skillEntries({
			from: r.organizations.id,
			to: r.skillEntries.organizationId,
		}),
		skillRuns: r.many.skillRuns({
			from: r.organizations.id,
			to: r.skillRuns.organizationId,
		}),
		memoryFacts: r.many.memoryFacts({
			from: r.organizations.id,
			to: r.memoryFacts.organizationId,
		}),
		tediMuscleMemory: r.many.tediMuscleMemory({
			from: r.organizations.id,
			to: r.tediMuscleMemory.organizationId,
		}),
		tediCuriosityQueue: r.many.tediCuriosityQueue({
			from: r.organizations.id,
			to: r.tediCuriosityQueue.organizationId,
		}),
		tediOptimizationSignals: r.many.tediOptimizationSignals({
			from: r.organizations.id,
			to: r.tediOptimizationSignals.organizationId,
		}),
		memoryDomains: r.many.memoryDomains({
			from: r.organizations.id,
			to: r.memoryDomains.organizationId,
		}),
		runtimeProfiles: r.many.runtimeProfiles({
			from: r.organizations.id,
			to: r.runtimeProfiles.organizationId,
		}),
		policyPacks: r.many.policyPacks({
			from: r.organizations.id,
			to: r.policyPacks.organizationId,
		}),
		workspaceTemplateSets: r.many.workspaceTemplateSets({
			from: r.organizations.id,
			to: r.workspaceTemplateSets.organizationId,
		}),
		widgetTestRuns: r.many.widgetTestRuns({
			from: r.organizations.id,
			to: r.widgetTestRuns.organizationId,
		}),
		generatedWidgetArtifacts: r.many.generatedWidgetArtifacts({
			from: r.organizations.id,
			to: r.generatedWidgetArtifacts.organizationId,
		}),
		tediApprovalRequests: r.many.tediApprovalRequests({
			from: r.organizations.id,
			to: r.tediApprovalRequests.orgId,
		}),
		tediRationaleRecords: r.many.tediRationaleRecords({
			from: r.organizations.id,
			to: r.tediRationaleRecords.orgId,
		}),
		tediGrowthSnapshots: r.many.tediGrowthSnapshots({
			from: r.organizations.id,
			to: r.tediGrowthSnapshots.orgId,
		}),
		tediObjectives: r.many.tediObjectives({
			from: r.organizations.id,
			to: r.tediObjectives.orgId,
		}),
		tediTasks: r.many.tediTasks({
			from: r.organizations.id,
			to: r.tediTasks.orgId,
		}),
		tediPlugins: r.many.tediPlugins({
			from: r.organizations.id,
			to: r.tediPlugins.authorOrgId,
		}),
		tediPluginInstalls: r.many.tediPluginInstalls({
			from: r.organizations.id,
			to: r.tediPluginInstalls.orgId,
		}),
		tediPluginEvents: r.many.tediPluginEvents({
			from: r.organizations.id,
			to: r.tediPluginEvents.orgId,
		}),
		tediSessionStates: r.many.tediSessionStates({
			from: r.organizations.id,
			to: r.tediSessionStates.organizationId,
		}),
		tediEmailAddresses: r.many.tediEmailAddresses({
			from: r.organizations.id,
			to: r.tediEmailAddresses.organizationId,
		}),
		tediEmailThreads: r.many.tediEmailThreads({
			from: r.organizations.id,
			to: r.tediEmailThreads.organizationId,
		}),
		tediEmailMessages: r.many.tediEmailMessages({
			from: r.organizations.id,
			to: r.tediEmailMessages.organizationId,
		}),
		tediEmailEvents: r.many.tediEmailEvents({
			from: r.organizations.id,
			to: r.tediEmailEvents.organizationId,
		}),
		projects: r.many.projects({
			from: r.organizations.id,
			to: r.projects.orgId,
		}),
		workItems: r.many.workItems({
			from: r.organizations.id,
			to: r.workItems.orgId,
		}),
		workItemComments: r.many.workItemComments({
			from: r.organizations.id,
			to: r.workItemComments.orgId,
		}),
		workItemRelations: r.many.workItemRelations({
			from: r.organizations.id,
			to: r.workItemRelations.orgId,
		}),
		workAttempts: r.many.workAttempts({
			from: r.organizations.id,
			to: r.workAttempts.orgId,
		}),
		workEvidence: r.many.workEvidence({
			from: r.organizations.id,
			to: r.workEvidence.orgId,
		}),
		workEvents: r.many.workEvents({
			from: r.organizations.id,
			to: r.workEvents.orgId,
		}),
		workItemProjections: r.many.workItemProjections({
			from: r.organizations.id,
			to: r.workItemProjections.orgId,
		}),
		docsSites: r.many.docsSites({
			from: r.organizations.slug,
			to: r.docsSites.orgSlug,
		}),
		billingServiceCreditControls: r.many.billingServiceCreditControls({
			from: r.organizations.id,
			to: r.billingServiceCreditControls.organizationId,
		}),
		billingServiceCreditEntries: r.many.billingServiceCreditEntries({
			from: r.organizations.id,
			to: r.billingServiceCreditEntries.organizationId,
		}),
		billingServiceCreditReservations: r.many.billingServiceCreditReservations({
			from: r.organizations.id,
			to: r.billingServiceCreditReservations.organizationId,
		}),
	},

	organizationMembers: {
		organization: r.one.organizations({
			from: r.organizationMembers.organizationId,
			to: r.organizations.id,
		}),
		user: r.one.users({
			from: r.organizationMembers.userId,
			to: r.users.id,
		}),
	},

	users: {
		memberships: r.many.organizationMembers({
			from: r.users.id,
			to: r.organizationMembers.userId,
		}),
		configs: r.many.userConfigs({
			from: r.users.id,
			to: r.userConfigs.userId,
		}),
	},

	userConfigs: {
		user: r.one.users({
			from: r.userConfigs.userId,
			to: r.users.id,
		}),
	},

	docsSites: {
		organization: r.one.organizations({
			from: r.docsSites.orgSlug,
			to: r.organizations.slug,
		}),
		builds: r.many.docsBuilds({
			from: r.docsSites.id,
			to: r.docsBuilds.siteId,
		}),
	},

	docsBuilds: {
		site: r.one.docsSites({
			from: r.docsBuilds.siteId,
			to: r.docsSites.id,
		}),
	},

	apiKeys: {
		organization: r.one.organizations({
			from: r.apiKeys.organizationId,
			to: r.organizations.id,
		}),
	},

	organizationSecrets: {
		organization: r.one.organizations({
			from: r.organizationSecrets.organizationId,
			to: r.organizations.id,
		}),
	},
}));
