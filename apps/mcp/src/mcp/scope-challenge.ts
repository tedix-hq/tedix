import { buildWwwAuthenticate } from "@tedix/mcp-shared/auth";

/** Tool-result `_meta` key carrying the RFC 6750 challenge (SEP-2350). */
export const MCP_WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate";

/**
 * Internal gate labels that name a denial reason, not a permission a client
 * can be granted. `configured-endpoint` is the tedi endpoint ceiling; no
 * consent screen can issue it, so it never belongs in a scope challenge.
 */
export function isGrantablePermissionScope(scope: string): boolean {
	return scope !== "configured-endpoint";
}

/**
 * The `scope=` list for an `insufficient_scope` challenge: every scope the
 * caller already holds plus the missing ones. The spec makes accumulating
 * scopes the client's job, but Codex re-authorizes with exactly the
 * challenged scopes and a new grant replaces the old one — naming only the
 * missing scope would silently drop the rest (the same reason Cloudflare's
 * `src/scope-challenge.ts` lists held scopes). Held scopes that satisfy a
 * required scope via `hasScope` never appear here as missing.
 */
export function scopeChallengeScopeList(
	heldScopes: readonly string[],
	missingScopes: readonly string[],
): string[] {
	return [
		...new Set(
			[...heldScopes, ...missingScopes].filter(isGrantablePermissionScope),
		),
	];
}

/** RFC 9110 §5.6.4 quoted-string content: escape backslash and DQUOTE. */
function quotedStringContent(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

/**
 * The `WWW-Authenticate` value for an `insufficient_scope` refusal.
 *
 * `hostname` produces the RFC 9728 `resource_metadata` pointer the transport
 * challenges carry; dispatch-time gates have no request hostname and emit the
 * bare challenge instead — clients that need the metadata URL discover it
 * from the transport-level 401/403.
 */
export function insufficientScopeChallenge(params: {
	heldScopes?: readonly string[];
	missingScopes: readonly string[];
	hostname?: string;
	errorDescription?: string;
}): string {
	const scopes = scopeChallengeScopeList(
		params.heldScopes ?? [],
		params.missingScopes,
	);
	if (params.hostname) {
		return buildWwwAuthenticate(
			params.hostname,
			"insufficient_scope",
			params.errorDescription,
			scopes,
		);
	}
	let value = `Bearer error="insufficient_scope"`;
	if (params.errorDescription) {
		value += `, error_description="${quotedStringContent(params.errorDescription)}"`;
	}
	if (scopes.length > 0) {
		value += `, scope="${quotedStringContent(scopes.join(" "))}"`;
	}
	return value;
}

/**
 * Plain-words fallback for agents that cannot step up: name the permission to
 * allow when reconnecting. Non-grantable gate labels are omitted — they are
 * not permissions a person can approve.
 */
export function missingPermissionPlainText(
	missingScopes: readonly string[],
): string {
	const grantable = missingScopes.filter(isGrantablePermissionScope);
	if (grantable.length === 0) return "";
	const names = grantable.map((scope) => `"${scope}"`).join(", ");
	return grantable.length === 1
		? `Allow the ${names} permission when reconnecting.`
		: `Allow the ${names} permissions when reconnecting.`;
}

const TOOL_CHALLENGE_CLIENT_HOSTS = ["chatgpt.com", "codex.openai.com"];

/**
 * Whether this OAuth client reads the step-up challenge from a tool result's
 * `_meta["mcp/www_authenticate"]` instead of the HTTP 403. Codex and ChatGPT
 * fail their tool call on an HTTP 403 before they can re-authorize
 * (openai/codex#20518; Cloudflare `src/clients.ts` maps the same clients).
 * Their client IDs are Client ID Metadata Document URLs on these hosts;
 * dynamically registered clients cannot be identified without a lookup and
 * keep the spec HTTP challenge.
 */
export function clientReadsToolScopeChallenge(
	clientId: string | null | undefined,
): boolean {
	if (!clientId || !URL.canParse(clientId)) return false;
	const host = new URL(clientId).hostname;
	return TOOL_CHALLENGE_CLIENT_HOSTS.some(
		(base) => host === base || host.endsWith(`.${base}`),
	);
}
