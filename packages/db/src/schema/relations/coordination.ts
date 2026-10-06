/**
 * Drizzle Relations v2: coordination domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const coordinationRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// WORK ITEM COORDINATION LEDGERS
	//
	// The credential-derived half of the board: notification fan-out, evidence,
	// leases and shipment certification. Every table is org-scoped, and the three
	// carrying the real composite FK to (work_items.org_id, work_items.id)
	// declare it as a full two-column relation, so no relation can reach a work
	// item in another org.
	// =========================================================================

	workItemOutboxEvents: {
		organization: r.one.organizations({
			from: r.workItemOutboxEvents.orgId,
			to: r.organizations.id,
		}),
		workItem: r.one.workItems({
			from: r.workItemOutboxEvents.workItemId,
			to: r.workItems.id,
		}),
		// Deliveries key on the autoincrement `sequence` cursor, not on `id`.
		deliveries: r.many.workItemInboxDeliveries({
			from: r.workItemOutboxEvents.sequence,
			to: r.workItemInboxDeliveries.eventSequence,
		}),
	},

	workItemInboxDeliveries: {
		organization: r.one.organizations({
			from: r.workItemInboxDeliveries.orgId,
			to: r.organizations.id,
		}),
		outboxEvent: r.one.workItemOutboxEvents({
			from: r.workItemInboxDeliveries.eventSequence,
			to: r.workItemOutboxEvents.sequence,
		}),
		// recipientType/recipientId is polymorphic (agent_session | tedi | user),
		// so the recipient itself is not declared as a relation.
	},

	workItemCorroborations: {
		organization: r.one.organizations({
			from: r.workItemCorroborations.orgId,
			to: r.organizations.id,
		}),
		// fk_work_item_corroboration_item_org is the org-scoped composite. The
		// single-column work_item_id FK describes the same edge and is deliberately
		// not declared a second time: two legs to work_items would make an
		// argument-less reverse `many` ambiguous.
		workItem: r.one.workItems({
			from: [
				r.workItemCorroborations.orgId,
				r.workItemCorroborations.workItemId,
			],
			to: [r.workItems.orgId, r.workItems.id],
		}),
		// principalType/principalId is polymorphic (user | organization | tedi |
		// external_agent) and sessionId is audit provenance that never
		// participates in dedup, so neither is declared.
	},

	workItemCommitCertifications: {
		organization: r.one.organizations({
			from: r.workItemCommitCertifications.orgId,
			to: r.organizations.id,
		}),
		workItem: r.one.workItems({
			from: [
				r.workItemCommitCertifications.orgId,
				r.workItemCommitCertifications.workItemId,
			],
			to: [r.workItems.orgId, r.workItems.id],
		}),
		// The operator-override authorization the deploy gate re-reads before
		// admitting a shipment. ORM-level and org-scoped, mirroring
		// getWorkItemCommentById's (id, orgId) lookup; the column holds no db FK on
		// purpose, so a swept comment can never invalidate a write-once
		// certification.
		operatorOverrideComment: r.one.workItemComments({
			from: [
				r.workItemCommitCertifications.orgId,
				r.workItemCommitCertifications.operatorOverrideCommentId,
			],
			to: [r.workItemComments.orgId, r.workItemComments.id],
		}),
		// agentSession is the harness-prefixed composite key (`claude-code:<uuid>`),
		// not external_agent_sessions.external_session_key, so it is not related.
	},

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
