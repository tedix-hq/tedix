export const MCP_CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"] as const;

/**
 * Request headers a browser-origin MCP client is allowed to send.
 *
 * MCP 2026-07-28 makes `Mcp-Method` mandatory on every request and `Mcp-Name`
 * mandatory on `tools/call` / `resources/read` / `prompts/get` (SEP-2243
 * request binding), so a preflight that omits them makes a conformant browser
 * client unable to reach the endpoint at all except by downgrading out of
 * modern mode. `Mcp-Session-Id` is deliberately NOT listed: sessions were
 * removed in the same revision and nothing in this codebase reads the header
 * inbound — advertising it invited exactly the downgrade it cannot serve.
 *
 * `Mcp-Param-*` is a variable family, so it cannot be enumerated here; a
 * surface that accepts SEP-2243 param headers must reflect the requested names
 * from `Access-Control-Request-Headers` (see the apps/mcp preflight).
 */
export const MCP_CORS_HEADERS = [
	"Authorization",
	"Content-Type",
	"Accept",
	"Mcp-Protocol-Version",
	"Mcp-Method",
	"Mcp-Name",
] as const;

/** Response headers a browser-origin MCP client may read off the response. */
export const MCP_CORS_EXPOSE_HEADERS = ["Mcp-Protocol-Version"] as const;

export interface CorsOriginPolicy {
	/** Exact serialized origins, including scheme and optional port. */
	exactOrigins?: ReadonlySet<string>;
	/** HTTPS subdomain suffixes. The apex itself is deliberately not matched. */
	httpsSubdomainSuffixes?: readonly string[];
	/** Allow http(s) localhost and loopback origins on any port. */
	allowLocalhost?: boolean;
}

/**
 * Resolve a request origin against explicit, URL-parsed policy. Invalid values
 * and deceptive hostnames such as `localhost.evil.example` fail closed.
 */
export function resolveCorsOrigin(
	origin: string,
	policy: CorsOriginPolicy,
): string | null {
	if (policy.exactOrigins?.has(origin)) return origin;

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}
	if (url.origin !== origin) return null;

	const hostname = url.hostname.toLowerCase();
	if (
		policy.allowLocalhost &&
		(url.protocol === "http:" || url.protocol === "https:") &&
		(hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]")
	) {
		return origin;
	}

	if (url.protocol !== "https:") return null;
	for (const rawSuffix of policy.httpsSubdomainSuffixes ?? []) {
		const suffix = rawSuffix.toLowerCase().replace(/^\./, "");
		if (hostname.endsWith(`.${suffix}`)) return origin;
	}
	return null;
}
