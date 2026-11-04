import { ORPCError } from "@orpc/server";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import type { BaseContext } from "./context";
import type { BrowserAgentSeat } from "@tedix/api-contract/schemas/browser-agent-seat";

/** Resolve every request from live membership, never from a browser claim. */
export async function bindBrowserAgentSeat(
	context: BaseContext,
): Promise<void> {
	context.browserAgentSeat = undefined;
	if (
		context.authType !== "user" ||
		!context.organizationId ||
		!context.user?.sub
	)
		return;
	const canonicalMember = context.userId
		? await getMemberByCanonicalUserId(
				context.db,
				context.organizationId,
				context.userId,
			)
		: undefined;
	const member =
		canonicalMember ??
		(await getMemberByUserId(
			context.db,
			context.organizationId,
			context.user.sub,
		));
	if (!member) return;
	if (member.status !== "active")
		throw new ORPCError("FORBIDDEN", {
			message: "Organization membership is not active",
		});
	if (member.kind !== "browser_agent") return;
	const owner = member.representedUserId
		? await getMemberByCanonicalUserId(
				context.db,
				context.organizationId,
				member.representedUserId,
			)
		: undefined;
	if (
		!member.userId ||
		(context.userId && member.userId !== context.userId) ||
		!owner ||
		owner.status !== "active" ||
		owner.kind !== "human" ||
		owner.userId === member.userId
	)
		throw new ORPCError("FORBIDDEN", {
			message: "Browser agent requires a different active human owner",
		});
	// An agent seat must not inherit elevated roles, grants or stale JWT claims.
	if (member.role !== "member" && member.role !== "viewer")
		throw new ORPCError("FORBIDDEN", {
			message: "Browser agent seats require member or viewer access",
		});
	context.userRole = member.role;
	context.userPermissionOverrides = [];
	context.browserAgentSeat = {
		userId: member.userId,
		memberId: member.id,
		displayName: member.name || member.email,
		representedUserId: owner.userId!,
		representedUserName: owner.name || owner.email,
	};
}

export function browserAgentMetadata(seat: BrowserAgentSeat) {
	return { browserAgentSeat: { ...seat } };
}
