/**
 * Drizzle Relations v2: kernel domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const kernelRelations = defineRelationsPart(schema, (r) => ({
	// =========================================================================
	// KERNEL RUNTIME (Home run/event ledger)
	//
	// `kernel_conversations` is the indexed projection keyed by
	// (organization_id, conversation_id) — a uniqueIndex, not a db FK target.
	// Every sibling kernel table carries that same pair, so the conversation
	// links below are composite ORM-level relations; no migration is implied.
	// =========================================================================

	kernelConversations: {
		organization: r.one.organizations({
			from: r.kernelConversations.organizationId,
			to: r.organizations.id,
		}),
		events: r.many.kernelRuntimeEvents({
			from: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
			to: [
				r.kernelRuntimeEvents.organizationId,
				r.kernelRuntimeEvents.conversationId,
			],
		}),
		runs: r.many.kernelRuntimeRuns({
			from: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
			to: [
				r.kernelRuntimeRuns.organizationId,
				r.kernelRuntimeRuns.conversationId,
			],
		}),
		grants: r.many.kernelConversationGrants({
			from: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
			to: [
				r.kernelConversationGrants.organizationId,
				r.kernelConversationGrants.conversationId,
			],
		}),
		approvalMirrors: r.many.kernelHomeApprovalMirrors({
			from: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
			to: [
				r.kernelHomeApprovalMirrors.organizationId,
				r.kernelHomeApprovalMirrors.parentConversationId,
			],
		}),
		wakeEntries: r.many.kernelWakeQueue({
			from: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
			to: [
				r.kernelWakeQueue.organizationId,
				r.kernelWakeQueue.parentConversationId,
			],
		}),
	},

	kernelRuntimeRuns: {
		organization: r.one.organizations({
			from: r.kernelRuntimeRuns.organizationId,
			to: r.organizations.id,
		}),
		conversation: r.one.kernelConversations({
			from: [
				r.kernelRuntimeRuns.organizationId,
				r.kernelRuntimeRuns.conversationId,
			],
			to: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
		}),
		delegatedTedi: r.one.tedis({
			from: r.kernelRuntimeRuns.delegatedTediId,
			to: r.tedis.id,
		}),
		events: r.many.kernelRuntimeEvents({
			from: [r.kernelRuntimeRuns.organizationId, r.kernelRuntimeRuns.id],
			to: [r.kernelRuntimeEvents.organizationId, r.kernelRuntimeEvents.runId],
		}),
	},

	kernelRuntimeEvents: {
		organization: r.one.organizations({
			from: r.kernelRuntimeEvents.organizationId,
			to: r.organizations.id,
		}),
		conversation: r.one.kernelConversations({
			from: [
				r.kernelRuntimeEvents.organizationId,
				r.kernelRuntimeEvents.conversationId,
			],
			to: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
		}),
		// runId is nullable (pre-run conversation events), so this is optional.
		run: r.one.kernelRuntimeRuns({
			from: [r.kernelRuntimeEvents.organizationId, r.kernelRuntimeEvents.runId],
			to: [r.kernelRuntimeRuns.organizationId, r.kernelRuntimeRuns.id],
		}),
		delegatedTedi: r.one.tedis({
			from: r.kernelRuntimeEvents.delegatedTediId,
			to: r.tedis.id,
		}),
	},

	kernelConversationGrants: {
		organization: r.one.organizations({
			from: r.kernelConversationGrants.organizationId,
			to: r.organizations.id,
		}),
		conversation: r.one.kernelConversations({
			from: [
				r.kernelConversationGrants.organizationId,
				r.kernelConversationGrants.conversationId,
			],
			to: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
		}),
		grantee: r.one.users({
			from: r.kernelConversationGrants.granteeDescopeUserId,
			to: r.users.id,
			alias: "kernelGrantGrantee",
		}),
		createdByUser: r.one.users({
			from: r.kernelConversationGrants.createdByDescopeUserId,
			to: r.users.id,
			alias: "kernelGrantCreator",
		}),
	},

	kernelWakeQueue: {
		organization: r.one.organizations({
			from: r.kernelWakeQueue.organizationId,
			to: r.organizations.id,
		}),
		parentConversation: r.one.kernelConversations({
			from: [
				r.kernelWakeQueue.organizationId,
				r.kernelWakeQueue.parentConversationId,
			],
			to: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
		}),
	},

	kernelHomeApprovalMirrors: {
		organization: r.one.organizations({
			from: r.kernelHomeApprovalMirrors.organizationId,
			to: r.organizations.id,
		}),
		parentConversation: r.one.kernelConversations({
			from: [
				r.kernelHomeApprovalMirrors.organizationId,
				r.kernelHomeApprovalMirrors.parentConversationId,
			],
			to: [
				r.kernelConversations.organizationId,
				r.kernelConversations.conversationId,
			],
		}),
		// Canonical approval state — the mirror is only a rendering projection.
		approvalRequest: r.one.tediApprovalRequests({
			from: r.kernelHomeApprovalMirrors.approvalRequestId,
			to: r.tediApprovalRequests.id,
		}),
		delegatedTedi: r.one.tedis({
			from: r.kernelHomeApprovalMirrors.delegatedTediId,
			to: r.tedis.id,
		}),
	},
}));
