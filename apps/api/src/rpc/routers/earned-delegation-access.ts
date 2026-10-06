import { isPlatformPrincipal } from "@tedix/auth/types";
import type { BaseContext } from "../orpc";

/** Dedicated high-authority scope; ordinary org keys and agent keys fail closed. */
export const EARNED_DELEGATION_GOVERN_SCOPE = "earned-delegation:govern";

export function hasEarnedDelegationGovernanceAuthority(
	context: Pick<BaseContext, "apiKey" | "authType" | "user" | "userRole">,
): boolean {
	if (context.authType === "user") {
		return (
			context.userRole === "owner" ||
			context.userRole === "admin" ||
			Boolean(context.user && isPlatformPrincipal({ user: context.user }))
		);
	}
	if (context.authType !== "apikey") return false;
	const scopes = context.apiKey?.scopes ?? [];
	return (
		scopes.includes("*") ||
		scopes.includes("platform:admin") ||
		scopes.includes(EARNED_DELEGATION_GOVERN_SCOPE)
	);
}

/**
 * Canonical ownership root for human/API-key authority. Two keys owned by the
 * same organization are deliberately the same disposer principal, preventing
 * key multiplication from manufacturing proposer/disposer independence.
 */
export function governanceAuthorityActor(
	context: Pick<
		BaseContext,
		"apiKey" | "authType" | "organizationId" | "user" | "userRole"
	>,
): { type: "user" | "api_key"; id: string } | null {
	if (!hasEarnedDelegationGovernanceAuthority(context)) return null;
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		return { type: "user", id: context.user.sub };
	}
	if (context.authType === "apikey") {
		const organizationId =
			context.organizationId ?? context.apiKey?.organizationId;
		if (organizationId) {
			return { type: "api_key", id: `organization:${organizationId}` };
		}
	}
	return null;
}

export function humanDispositionActor(
	context: Pick<
		BaseContext,
		"apiKey" | "authType" | "organizationId" | "user" | "userRole"
	>,
): { type: "user"; id: string } | null {
	const actor = governanceAuthorityActor(context);
	return actor?.type === "user" ? { type: "user", id: actor.id } : null;
}

/**
 * Evidence review is intentionally broader than authority disposition.
 * A gateway-verified external-agent principal may corroborate or reject an
 * observation under its stable principal id, but it still cannot create the
 * rubric, record canonical evaluator evidence, or apply authority.
 */
export function earnedDelegationEvidenceReviewerActor(
	context: Pick<
		BaseContext,
		| "apiKey"
		| "authType"
		| "externalAgentPrincipalId"
		| "organizationId"
		| "user"
		| "userRole"
	>,
): { type: "user" | "api_key" | "external_agent"; id: string } | null {
	if (context.externalAgentPrincipalId) {
		return {
			type: "external_agent",
			id: context.externalAgentPrincipalId,
		};
	}
	return governanceAuthorityActor(context);
}
