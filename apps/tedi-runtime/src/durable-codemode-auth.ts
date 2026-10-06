export interface DurableCodeAuthContext {
	scopes: readonly string[];
	tediId?: string;
	/** How the caller authenticated. An org-scoped `sk_` key is an operator credential. */
	authMethod?: "jwt" | "gateway-token" | "api-key" | "none";
	/** Human email claim. A machine `client_credentials` token never carries one. */
	email?: string;
}

/**
 * Only a human/admin caller may resolve a tedi's durable-code approval.
 *
 * This is an ALLOWLIST that proves presence-of-human. It must never infer a
 * human from the mere ABSENCE of a tedi identity.
 *
 * The earlier form was `(tedi:admin | platform:admin) && !tediId`, and it was
 * exploitable: a tedi ASSIGNED a peer tedi's MCP server authenticates to that
 * peer with a Descope AIH **client_credentials** token, which
 *   (a) defaults to the `tedi:admin` connection scope (packages/auth/src/aih-client.ts),
 *   (b) carries NO `tediId` claim — apps/mcp derives a tedi id from the Descope
 *       client's TAGS, not from any token claim, and
 *   (c) carries no human `email`.
 * Conditions (a) and (b) alone satisfied the old check, so a PEER TEDI was
 * treated as an OPERATOR on another tedi and could approve, reject, or roll back
 * that tedi's durable code.
 *
 * The `email` claim is the discriminator, mirroring the codebase's own
 * established machine-token signal (`client_id` present + `email` absent) used
 * by `shouldAttemptAihM2mScopeHydration` (apps/mcp/src/auth-helpers.ts) and
 * `isUserToken` (packages/auth/src/jwt.ts). This is the same failure class the
 * capability-mutation gate closes: a gate keyed on the
 * absence of an agent signal fails OPEN precisely where that signal is absent
 * for a non-human reason.
 */
export function canManageDurableCode(
	auth: DurableCodeAuthContext | undefined,
): boolean {
	if (!auth) return false;
	// Any caller carrying a tedi identity is an agent, never an operator.
	if (auth.tediId) return false;

	const hasAdminScope =
		auth.scopes.includes("tedi:admin") ||
		auth.scopes.includes("platform:admin");
	if (!hasAdminScope) return false;

	// An org-scoped `sk_` API key is a trusted operator credential: it is issued
	// to the org by a human and carries no token claims at all.
	if (auth.authMethod === "api-key") return true;

	// Otherwise demand POSITIVE proof of a human — an email claim. The peer-MCP
	// AIH client_credentials token above has none.
	return Boolean(auth.email);
}
