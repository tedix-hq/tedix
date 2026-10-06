/**
 * Pure auth helpers for the MCP catalog scan workflow.
 *
 * Kept free of `cloudflare:workers` imports so the logic is unit-testable in a
 * plain Node/vitest environment (the workflow entrypoint itself pulls in the
 * Workers runtime and cannot be imported by tests).
 */

import { exchangeClientCredentials } from "@tedix/mcp-shared/auth/client-credentials";

/**
 * Exchange a raw `client_id:client_secret` credential for a short-lived Bearer
 * via the OAuth2 `client_credentials` grant, so periodic catalog re-scans of
 * machine-to-machine MCP servers mint a fresh token instead of
 * relying on an expiring stored snapshot. Delegates to the shared
 * `@tedix/mcp-shared` helper (same wire format as the runtime MCP handler's
 * `resolveClientCredentialsToken`), which also SSRF-guards the token URL.
 * Returns null on any failure so the caller falls back to the next credential
 * source.
 */
export async function exchangeScanClientCredentials(
	rawCredential: string,
	tokenUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const result = await exchangeClientCredentials(rawCredential, tokenUrl, {
		fetchFn: fetchImpl,
	});
	if (!result.ok) {
		console.warn(
			`[MCP Scan] client_credentials exchange failed: ${result.error}`,
		);
		return null;
	}
	return result.token.accessToken;
}
