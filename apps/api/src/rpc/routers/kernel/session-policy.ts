import type { DbClient } from "@tedix/db/client";
import { listConversationSessionPolicies } from "@tedix/db/queries/conversation-session-policies";
import type { DispatchPolicyLayer } from "./dispatch-policy";

/**
 * Scope key of a standing "allow hand-offs to this tedi" decision. The chat
 * card builds the same key for its in-memory session approvals, so a stored
 * row and the browser's optimistic auto-approve name the same thing.
 */
export function delegationSessionScopeKey(tediId: string): string {
	return `delegate:${tediId}`;
}

/**
 * The session layer of the dispatch gate, read from the conversation's stored
 * standing decisions. Only a row naming the route's exact target produces a
 * layer, so an allow for one tedi never loosens a hand-off to another.
 * Fail-soft: a read error leaves the layer absent, which keeps the gate's
 * existing holds.
 */
export async function readConversationSessionPolicyLayer(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string | undefined;
		targetTediId: string | null | undefined;
	},
): Promise<DispatchPolicyLayer | null> {
	if (!input.conversationId || !input.targetTediId) return null;
	try {
		const rows = await listConversationSessionPolicies(db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
		});
		const scopeKey = delegationSessionScopeKey(input.targetTediId);
		const match = rows.find(
			(row) => row.scopeKey === scopeKey && row.effect === "allow",
		);
		if (!match) return null;
		return {
			effect: "allow",
			reason: `operator allowed hand-offs to this tedi for the rest of this conversation on ${match.createdAt}`,
		};
	} catch {
		return null;
	}
}
