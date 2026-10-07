import type { BaseContext } from "../orpc";

/**
 * Best-effort: purge apps/mcp's Workers Cache entries for this app's
 * `.well-known/*` discovery documents (see apps/mcp/src/well-known.ts, which
 * stamps `Cache-Tag: app:{id}` on the two cacheable responses) so an
 * mcpConfig change is visible immediately rather than waiting out the TTL.
 * Failure is non-fatal — the TTL/stale-while-revalidate backstop covers it.
 */
export type AppResolutionIdentity = {
	slug: string;
	primaryDomain?: string | null;
	customMcpDomain?: string | null;
};

function appResolutionCacheKeys(apps: AppResolutionIdentity[]): string[] {
	const keys = new Set<string>();
	for (const app of apps) {
		if (app.slug) keys.add(`mcp-subdomain:${app.slug}`);
		for (const domain of [app.primaryDomain, app.customMcpDomain]) {
			if (domain) keys.add(`custom:${domain}`);
		}
	}
	return [...keys];
}

export async function purgeMcpDiscoveryCache(
	env: BaseContext["env"],
	appId: string,
	apps: AppResolutionIdentity[],
) {
	if (!env.MCP_SERVICE) return;
	try {
		await env.MCP_SERVICE.fetch(
			new Request("https://internal/__internal/purge-discovery-cache", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({
					appId,
					appResolutionKeys: appResolutionCacheKeys(apps),
				}),
			}),
		);
	} catch (err) {
		console.error(
			"[purgeMcpDiscoveryCache] purge failed (non-fatal):",
			err instanceof Error ? err.message : String(err),
		);
	}
}
