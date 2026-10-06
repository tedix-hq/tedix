/**
 * Drizzle Relations v2: work-items domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const workItemRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// TEDI COGNITIVE & GOVERNANCE
	// =========================================================================

	tediApprovalRequests: {
		tedi: r.one.tedis({
			from: r.tediApprovalRequests.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediApprovalRequests.orgId,
			to: r.organizations.id,
		}),
	},

	tediRationaleRecords: {
		tedi: r.one.tedis({
			from: r.tediRationaleRecords.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediRationaleRecords.orgId,
			to: r.organizations.id,
		}),
	},

	tediGrowthSnapshots: {
		tedi: r.one.tedis({
			from: r.tediGrowthSnapshots.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediGrowthSnapshots.orgId,
			to: r.organizations.id,
		}),
	},

	tediObjectives: {
		tedi: r.one.tedis({
			from: r.tediObjectives.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediObjectives.orgId,
			to: r.organizations.id,
		}),
		tasks: r.many.tediTasks({
			from: r.tediObjectives.id,
			to: r.tediTasks.objectiveId,
		}),
		workItems: r.many.workItems({
			from: r.tediObjectives.id,
			to: r.workItems.objectiveId,
		}),
		projects: r.many.projects({
			from: r.tediObjectives.id,
			to: r.projects.objectiveId,
		}),
	},

	tediTasks: {
		objective: r.one.tediObjectives({
			from: r.tediTasks.objectiveId,
			to: r.tediObjectives.id,
		}),
		tedi: r.one.tedis({
			from: r.tediTasks.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediTasks.orgId,
			to: r.organizations.id,
		}),
	},

	projects: {
		organization: r.one.organizations({
			from: r.projects.orgId,
			to: r.organizations.id,
		}),
		leadTedi: r.one.tedis({
			from: r.projects.leadTediId,
			to: r.tedis.id,
			alias: "projectLead",
		}),
		objective: r.one.tediObjectives({
			from: r.projects.objectiveId,
			to: r.tediObjectives.id,
		}),
		workItems: r.many.workItems({
			from: r.projects.id,
			to: r.workItems.projectId,
		}),
	},

	workItems: {
		organization: r.one.organizations({
			from: r.workItems.orgId,
			to: r.organizations.id,
		}),
		// Self-referential hierarchy — ORM-level only; parentWorkItemId carries NO
		// db FK (a db self-FK would force a destructive work_items table recreate).
		parent: r.one.workItems({
			from: r.workItems.parentWorkItemId,
			to: r.workItems.id,
			alias: "workItemParent",
		}),
		children: r.many.workItems({
			from: r.workItems.id,
			to: r.workItems.parentWorkItemId,
			alias: "workItemParent",
		}),
		project: r.one.projects({
			from: r.workItems.projectId,
			to: r.projects.id,
		}),
		objective: r.one.tediObjectives({
			from: r.workItems.objectiveId,
			to: r.tediObjectives.id,
		}),
		comments: r.many.workItemComments({
			from: r.workItems.id,
			to: r.workItemComments.workItemId,
		}),
		outgoingRelations: r.many.workItemRelations({
			from: r.workItems.id,
			to: r.workItemRelations.fromWorkItemId,
			alias: "sourceWorkItemRelation",
		}),
		incomingRelations: r.many.workItemRelations({
			from: r.workItems.id,
			to: r.workItemRelations.toWorkItemId,
			alias: "targetWorkItemRelation",
		}),
		attempts: r.many.workAttempts({
			from: r.workItems.id,
			to: r.workAttempts.workItemId,
		}),
		evidence: r.many.workEvidence({
			from: r.workItems.id,
			to: r.workEvidence.workItemId,
		}),
		events: r.many.workEvents({
			from: r.workItems.id,
			to: r.workEvents.workItemId,
		}),
		projections: r.many.workItemProjections({
			from: r.workItems.id,
			to: r.workItemProjections.workItemId,
		}),
	},

	workItemComments: {
		organization: r.one.organizations({
			from: r.workItemComments.orgId,
			to: r.organizations.id,
		}),
		workItem: r.one.workItems({
			from: r.workItemComments.workItemId,
			to: r.workItems.id,
		}),
	},

	workItemRelations: {
		organization: r.one.organizations({
			from: r.workItemRelations.orgId,
			to: r.organizations.id,
		}),
		fromWorkItem: r.one.workItems({
			from: r.workItemRelations.fromWorkItemId,
			to: r.workItems.id,
			alias: "sourceWorkItemRelation",
		}),
		toWorkItem: r.one.workItems({
			from: r.workItemRelations.toWorkItemId,
			to: r.workItems.id,
			alias: "targetWorkItemRelation",
		}),
	},

	workAttempts: {
		organization: r.one.organizations({
			from: r.workAttempts.orgId,
			to: r.organizations.id,
		}),
		workItem: r.one.workItems({
			from: r.workAttempts.workItemId,
			to: r.workItems.id,
		}),
		executorSession: r.one.externalAgentSessions({
			from: [
				r.workAttempts.orgId,
				r.workAttempts.executorId,
				r.workAttempts.executorSessionId,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
		}),
	},

	workEvidence: {
		workItem: r.one.workItems({
			from: r.workEvidence.workItemId,
			to: r.workItems.id,
		}),
		attempt: r.one.workAttempts({
			from: r.workEvidence.attemptId,
			to: r.workAttempts.id,
		}),
	},

	workEvents: {
		workItem: r.one.workItems({
			from: r.workEvents.workItemId,
			to: r.workItems.id,
		}),
		attempt: r.one.workAttempts({
			from: r.workEvents.attemptId,
			to: r.workAttempts.id,
		}),
	},

	workItemProjections: {
		organization: r.one.organizations({
			from: r.workItemProjections.orgId,
			to: r.organizations.id,
		}),
		workItem: r.one.workItems({
			from: r.workItemProjections.workItemId,
			to: r.workItems.id,
		}),
	},
}));
