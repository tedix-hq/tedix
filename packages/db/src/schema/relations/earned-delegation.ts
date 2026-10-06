/**
 * Drizzle Relations v2: earned-delegation domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const earnedDelegationRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// EARNED DELEGATION
	// =========================================================================

	entrustableActivities: {
		// Nullable: a null organizationId is a platform-wide activity definition.
		organization: r.one.organizations({
			from: r.entrustableActivities.organizationId,
			to: r.organizations.id,
		}),
		// Version lineage: each row may supersede exactly one earlier version.
		supersedes: r.one.entrustableActivities({
			from: r.entrustableActivities.supersedesId,
			to: r.entrustableActivities.id,
			alias: "entrustableActivityLineage",
		}),
		supersededBy: r.many.entrustableActivities({
			from: r.entrustableActivities.id,
			to: r.entrustableActivities.supersedesId,
			alias: "entrustableActivityLineage",
		}),
		roleTemplate: r.one.roleTemplates({
			from: r.entrustableActivities.roleTemplateId,
			to: r.roleTemplates.id,
		}),
		observations: r.many.competencyObservations({
			from: r.entrustableActivities.id,
			to: r.competencyObservations.activityId,
		}),
		entrustmentGrants: r.many.tediEntrustmentGrants({
			from: r.entrustableActivities.id,
			to: r.tediEntrustmentGrants.activityId,
		}),
	},

	competencyObservations: {
		organization: r.one.organizations({
			from: r.competencyObservations.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.competencyObservations.tediId,
			to: r.tedis.id,
		}),
		activity: r.one.entrustableActivities({
			from: r.competencyObservations.activityId,
			to: r.entrustableActivities.id,
		}),
		workItem: r.one.workItems({
			from: r.competencyObservations.workItemId,
			to: r.workItems.id,
		}),
		attestations: r.many.competencyObservationAttestations({
			from: r.competencyObservations.id,
			to: r.competencyObservationAttestations.observationId,
		}),
		valueClaims: r.many.delegationValueClaims({
			from: r.competencyObservations.id,
			to: r.delegationValueClaims.observationId,
		}),
	},

	competencyObservationAttestations: {
		organization: r.one.organizations({
			from: r.competencyObservationAttestations.organizationId,
			to: r.organizations.id,
		}),
		observation: r.one.competencyObservations({
			from: r.competencyObservationAttestations.observationId,
			to: r.competencyObservations.id,
		}),
	},

	delegationValueClaims: {
		organization: r.one.organizations({
			from: r.delegationValueClaims.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.delegationValueClaims.tediId,
			to: r.tedis.id,
		}),
		observation: r.one.competencyObservations({
			from: r.delegationValueClaims.observationId,
			to: r.competencyObservations.id,
		}),
		workItem: r.one.workItems({
			from: r.delegationValueClaims.workItemId,
			to: r.workItems.id,
		}),
	},

	// The tedi's career row: at most one active assignment per tedi
	// (uniq_tedi_role_assignment_active). roleTemplateId is nullable — an
	// ad-hoc role has no template.
	tediRoleAssignments: {
		organization: r.one.organizations({
			from: r.tediRoleAssignments.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediRoleAssignments.tediId,
			to: r.tedis.id,
		}),
		roleTemplate: r.one.roleTemplates({
			from: r.tediRoleAssignments.roleTemplateId,
			to: r.roleTemplates.id,
		}),
		// ORM-level: lastDecisionId is a plain column (the decision is what
		// carries the enforced FK back here), backed by the promotion_decisions
		// primary key.
		lastDecision: r.one.promotionDecisions({
			from: r.tediRoleAssignments.lastDecisionId,
			to: r.promotionDecisions.id,
		}),
		entrustmentGrants: r.many.tediEntrustmentGrants({
			from: r.tediRoleAssignments.id,
			to: r.tediEntrustmentGrants.roleAssignmentId,
		}),
	},

	// One live grant per (tedi, activity): what this tedi is currently trusted
	// to do, and the decision that last moved it.
	tediEntrustmentGrants: {
		organization: r.one.organizations({
			from: r.tediEntrustmentGrants.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.tediEntrustmentGrants.tediId,
			to: r.tedis.id,
		}),
		roleAssignment: r.one.tediRoleAssignments({
			from: r.tediEntrustmentGrants.roleAssignmentId,
			to: r.tediRoleAssignments.id,
		}),
		activity: r.one.entrustableActivities({
			from: r.tediEntrustmentGrants.activityId,
			to: r.entrustableActivities.id,
		}),
		lastDecision: r.one.promotionDecisions({
			from: r.tediEntrustmentGrants.lastDecisionId,
			to: r.promotionDecisions.id,
		}),
	},

	// Composite-keyed fence row: one revision per (organization, tedi).
	earnedDelegationEvidenceRevisions: {
		organization: r.one.organizations({
			from: r.earnedDelegationEvidenceRevisions.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.earnedDelegationEvidenceRevisions.tediId,
			to: r.tedis.id,
		}),
	},

	// =========================================================================
}));
