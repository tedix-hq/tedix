/**
 * Step-up re-authentication guard for irreversible mutations.
 *
 * Ownership is not intent. An org owner's live session is exactly what a
 * hijacked browser or a stolen session token already holds, so a role check
 * alone cannot show that a human meant *this* destruction.
 *
 * Descope re-issues the session token with `su: true` when a step-up flow
 * succeeds and bounds that token's life by the project's Step Up Token Timeout,
 * so a validated token still carrying the claim is proof of a recent
 * re-authentication. See `docs/engineering/platform/auth.md` (Security properties) for
 * the full contract, including the client half that must forward the token.
 *
 * Lives here rather than beside each caller for the reason `org-scope.ts`
 * exists: the org-scope guard was reimplemented 31 times and drifted into three
 * different status codes for one condition. A security check copied per router
 * is a security check that will disagree with itself.
 */

import { hasStepUpClaim } from "@tedix/auth/types";
import { type BaseContext, createError, ErrorCodes } from "./orpc";

/**
 * Require proof of recent re-authentication from an interactive caller.
 *
 * Only interactive user JWTs are held to this. API keys, M2M tokens, service
 * bindings and tedi access keys cannot run a step-up flow at all — they are
 * gated at credential issuance instead, and demanding the claim from them would
 * break automation without proving anything about human intent. Callers that
 * exempt platform principals should do so before calling this.
 *
 * @param action Human-readable phrase completing "…requires re-authentication",
 *   surfaced to the operator, e.g. `"Deleting an organization"`.
 */
export function requireStepUp(context: BaseContext, action: string): void {
	if (!context.user) return;
	if (hasStepUpClaim(context.user)) return;

	throw createError(
		ErrorCodes.FORBIDDEN,
		`${action} requires re-authentication. Complete the step-up prompt and retry with the stepped-up session token.`,
	);
}
