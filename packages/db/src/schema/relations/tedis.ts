/**
 * Drizzle Relations v2: tedis domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const tediRelations = defineRelationsPart(schema, (r) => ({
	// TEDIS
	// =========================================================================

	tedis: {
		organization: r.one.organizations({
			from: r.tedis.organizationId,
			to: r.organizations.id,
		}),
		runtimeProfile: r.one.runtimeProfiles({
			from: r.tedis.runtimeProfileId,
			to: r.runtimeProfiles.id,
		}),
		policyPack: r.one.policyPacks({
			from: r.tedis.policyPackId,
			to: r.policyPacks.id,
		}),
		workspaceTemplateSet: r.one.workspaceTemplateSets({
			from: r.tedis.workspaceTemplateSetId,
			to: r.workspaceTemplateSets.id,
		}),
		devices: r.many.tediDevices({
			from: r.tedis.id,
			to: r.tediDevices.tediId,
		}),
		customDomains: r.many.tediCustomDomains({
			from: r.tedis.id,
			to: r.tediCustomDomains.tediId,
		}),
		runtimeSnapshots: r.many.tediRuntimeSnapshots({
			from: r.tedis.id,
			to: r.tediRuntimeSnapshots.tediId,
		}),
		usageEvents: r.many.tediUsageEvents({
			from: r.tedis.id,
			to: r.tediUsageEvents.tediId,
		}),
		callCosts: r.many.tediCallCosts({
			from: r.tedis.id,
			to: r.tediCallCosts.tediId,
		}),
		secrets: r.many.tediSecrets({
			from: r.tedis.id,
			to: r.tediSecrets.tediId,
		}),
		sessionStates: r.many.tediSessionStates({
			from: r.tedis.id,
			to: r.tediSessionStates.tediId,
		}),
		emailAddresses: r.many.tediEmailAddresses({
			from: r.tedis.id,
			to: r.tediEmailAddresses.tediId,
		}),
		emailThreads: r.many.tediEmailThreads({
			from: r.tedis.id,
			to: r.tediEmailThreads.tediId,
		}),
		emailMessages: r.many.tediEmailMessages({
			from: r.tedis.id,
			to: r.tediEmailMessages.tediId,
		}),
		emailEvents: r.many.tediEmailEvents({
			from: r.tedis.id,
			to: r.tediEmailEvents.tediId,
		}),
		knowledgeEntries: r.many.knowledgeEntries({
			from: r.tedis.id,
			to: r.knowledgeEntries.tediId,
		}),
		tediMuscleMemory: r.many.tediMuscleMemory({
			from: r.tedis.id,
			to: r.tediMuscleMemory.tediId,
		}),
		tediExpertise: r.many.tediExpertise({
			from: r.tedis.id,
			to: r.tediExpertise.tediId,
		}),
		tediCuriosityQueue: r.many.tediCuriosityQueue({
			from: r.tedis.id,
			to: r.tediCuriosityQueue.tediId,
		}),
		tediOptimizationSignals: r.many.tediOptimizationSignals({
			from: r.tedis.id,
			to: r.tediOptimizationSignals.tediId,
		}),
		approvalRequests: r.many.tediApprovalRequests({
			from: r.tedis.id,
			to: r.tediApprovalRequests.tediId,
		}),
		rationaleRecords: r.many.tediRationaleRecords({
			from: r.tedis.id,
			to: r.tediRationaleRecords.tediId,
		}),
		growthSnapshots: r.many.tediGrowthSnapshots({
			from: r.tedis.id,
			to: r.tediGrowthSnapshots.tediId,
		}),
		objectives: r.many.tediObjectives({
			from: r.tedis.id,
			to: r.tediObjectives.tediId,
		}),
		tasks: r.many.tediTasks({
			from: r.tedis.id,
			to: r.tediTasks.tediId,
		}),
		ledProjects: r.many.projects({
			from: r.tedis.id,
			to: r.projects.leadTediId,
			alias: "projectLead",
		}),
		pluginInstalls: r.many.tediPluginInstalls({
			from: r.tedis.id,
			to: r.tediPluginInstalls.tediId,
		}),
		pluginEvents: r.many.tediPluginEvents({
			from: r.tedis.id,
			to: r.tediPluginEvents.tediId,
		}),
		memoryFacts: r.many.memoryFacts({
			from: r.tedis.id,
			to: r.memoryFacts.tediId,
		}),
		billingServiceCreditReservations: r.many.billingServiceCreditReservations({
			from: r.tedis.id,
			to: r.billingServiceCreditReservations.tediId,
		}),
	},

	tediCustomDomains: {
		tedi: r.one.tedis({
			from: r.tediCustomDomains.tediId,
			to: r.tedis.id,
		}),
	},

	tediDevices: {
		tedi: r.one.tedis({
			from: r.tediDevices.tediId,
			to: r.tedis.id,
		}),
	},

	tediRuntimeSnapshots: {
		tedi: r.one.tedis({
			from: r.tediRuntimeSnapshots.tediId,
			to: r.tedis.id,
		}),
	},

	tediUsageEvents: {
		tedi: r.one.tedis({
			from: r.tediUsageEvents.tediId,
			to: r.tedis.id,
		}),
	},

	tediCallCosts: {
		tedi: r.one.tedis({
			from: r.tediCallCosts.tediId,
			to: r.tedis.id,
		}),
	},

	tediSecrets: {
		tedi: r.one.tedis({
			from: r.tediSecrets.tediId,
			to: r.tedis.id,
		}),
	},

	tediSessionStates: {
		organization: r.one.organizations({
			from: r.tediSessionStates.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediSessionStates.tediId,
			to: r.tedis.id,
		}),
	},

	tediEmailAddresses: {
		organization: r.one.organizations({
			from: r.tediEmailAddresses.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediEmailAddresses.tediId,
			to: r.tedis.id,
		}),
	},

	tediEmailThreads: {
		organization: r.one.organizations({
			from: r.tediEmailThreads.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediEmailThreads.tediId,
			to: r.tedis.id,
		}),
		messages: r.many.tediEmailMessages({
			from: r.tediEmailThreads.id,
			to: r.tediEmailMessages.threadId,
		}),
		events: r.many.tediEmailEvents({
			from: r.tediEmailThreads.id,
			to: r.tediEmailEvents.threadId,
		}),
	},

	tediEmailMessages: {
		organization: r.one.organizations({
			from: r.tediEmailMessages.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediEmailMessages.tediId,
			to: r.tedis.id,
		}),
		thread: r.one.tediEmailThreads({
			from: r.tediEmailMessages.threadId,
			to: r.tediEmailThreads.id,
		}),
		attachments: r.many.tediEmailAttachments({
			from: r.tediEmailMessages.id,
			to: r.tediEmailAttachments.messageId,
		}),
		events: r.many.tediEmailEvents({
			from: r.tediEmailMessages.id,
			to: r.tediEmailEvents.messageId,
		}),
	},

	tediEmailAttachments: {
		message: r.one.tediEmailMessages({
			from: r.tediEmailAttachments.messageId,
			to: r.tediEmailMessages.id,
		}),
	},

	tediEmailEvents: {
		organization: r.one.organizations({
			from: r.tediEmailEvents.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediEmailEvents.tediId,
			to: r.tedis.id,
		}),
		thread: r.one.tediEmailThreads({
			from: r.tediEmailEvents.threadId,
			to: r.tediEmailThreads.id,
		}),
		message: r.one.tediEmailMessages({
			from: r.tediEmailEvents.messageId,
			to: r.tediEmailMessages.id,
		}),
	},
}));
