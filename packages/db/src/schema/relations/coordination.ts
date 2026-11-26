/**
 * Drizzle Relations v2: coordination domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const coordinationRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// EXTERNAL AGENT IDENTITY (composite org-scoped FKs)
	// =========================================================================

	externalAgentPrincipals: {
		organization: r.one.organizations({
			from: r.externalAgentPrincipals.organizationId,
			to: r.organizations.id,
		}),
		sessions: r.many.externalAgentSessions({
			from: [
				r.externalAgentPrincipals.organizationId,
				r.externalAgentPrincipals.id,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
			],
		}),
	},

	externalAgentSessions: {
		organization: r.one.organizations({
			from: r.externalAgentSessions.organizationId,
			to: r.organizations.id,
		}),
		principal: r.one.externalAgentPrincipals({
			from: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
			],
			to: [
				r.externalAgentPrincipals.organizationId,
				r.externalAgentPrincipals.id,
			],
		}),
		mcpCredentials: r.many.externalAgentMcpCredentials({
			from: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			to: [
				r.externalAgentMcpCredentials.organizationId,
				r.externalAgentMcpCredentials.principalId,
				r.externalAgentMcpCredentials.sessionId,
			],
		}),
		attributions: r.many.externalAgentAttributions({
			from: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			to: [
				r.externalAgentAttributions.organizationId,
				r.externalAgentAttributions.principalId,
				r.externalAgentAttributions.sessionId,
			],
		}),
		subjectReviewEvidence: r.many.externalAgentReviewEvidence({
			from: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			to: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.subjectPrincipalId,
				r.externalAgentReviewEvidence.subjectSessionId,
			],
			alias: "externalAgentReviewSubjectSession",
		}),
		reviewerReviewEvidence: r.many.externalAgentReviewEvidence({
			from: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			to: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.reviewerPrincipalId,
				r.externalAgentReviewEvidence.reviewerSessionId,
			],
			alias: "externalAgentReviewReviewerSession",
		}),
	},

	externalAgentMcpCredentials: {
		organization: r.one.organizations({
			from: r.externalAgentMcpCredentials.organizationId,
			to: r.organizations.id,
		}),
		session: r.one.externalAgentSessions({
			from: [
				r.externalAgentMcpCredentials.organizationId,
				r.externalAgentMcpCredentials.principalId,
				r.externalAgentMcpCredentials.sessionId,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
		}),
	},

	externalAgentAttributions: {
		organization: r.one.organizations({
			from: r.externalAgentAttributions.organizationId,
			to: r.organizations.id,
		}),
		session: r.one.externalAgentSessions({
			from: [
				r.externalAgentAttributions.organizationId,
				r.externalAgentAttributions.principalId,
				r.externalAgentAttributions.sessionId,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
		}),
		workItem: r.one.workItems({
			from: [
				r.externalAgentAttributions.organizationId,
				r.externalAgentAttributions.workItemId,
			],
			to: [r.workItems.orgId, r.workItems.id],
		}),
		reviewEvidence: r.many.externalAgentReviewEvidence({
			from: [
				r.externalAgentAttributions.organizationId,
				r.externalAgentAttributions.id,
			],
			to: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.executionAttributionId,
			],
		}),
	},

	externalAgentReviewEvidence: {
		organization: r.one.organizations({
			from: r.externalAgentReviewEvidence.organizationId,
			to: r.organizations.id,
		}),
		executionAttribution: r.one.externalAgentAttributions({
			from: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.executionAttributionId,
			],
			to: [
				r.externalAgentAttributions.organizationId,
				r.externalAgentAttributions.id,
			],
		}),
		subjectSession: r.one.externalAgentSessions({
			from: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.subjectPrincipalId,
				r.externalAgentReviewEvidence.subjectSessionId,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			alias: "externalAgentReviewSubjectSession",
		}),
		reviewerSession: r.one.externalAgentSessions({
			from: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.reviewerPrincipalId,
				r.externalAgentReviewEvidence.reviewerSessionId,
			],
			to: [
				r.externalAgentSessions.organizationId,
				r.externalAgentSessions.principalId,
				r.externalAgentSessions.id,
			],
			alias: "externalAgentReviewReviewerSession",
		}),
		workItem: r.one.workItems({
			from: [
				r.externalAgentReviewEvidence.organizationId,
				r.externalAgentReviewEvidence.workItemId,
			],
			to: [r.workItems.orgId, r.workItems.id],
		}),
	},
}));
