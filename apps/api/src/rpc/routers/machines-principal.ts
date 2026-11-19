import { getExternalAgentPrincipal } from "@tedix/db/queries/external-agent-identity/principals";
import type { BaseContext } from "../orpc";
import {
	verifiedActiveUserMembership,
	verifiedExternalAgent,
} from "./work-items-principal";

/**
 * The account behind a runner: the person whose sign-in the runner uses. A
 * health report stores it, and a claim must come from the same account. An
 * agent session counts as the person who owns or created it, so a runner's
 * health reports and its claims match whichever of the two it sends them as.
 * Returns null for a caller that is no such account.
 */
export async function machineReporterAccount(
	context: BaseContext,
	orgId: string,
): Promise<string | null> {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) {
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId: orgId,
			principalId: external.executor.id,
		});
		if (!principal) return null;
		if (principal.credentialBindingType === "owner_user")
			return `user:${principal.credentialBindingId}`;
		if (principal.createdByType === "user")
			return `user:${principal.createdById}`;
		return `external_agent:${principal.id}`;
	}
	if (context.tediId) return null;
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		const membership = await verifiedActiveUserMembership(context, orgId);
		return `user:${membership.userId}`;
	}
	return null;
}
