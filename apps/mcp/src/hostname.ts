/**
 * MCP Worker — Hostname-based routing helpers
 *
 * Grammar and slug rules live in the single authority `@tedix/tenant-directory`;
 * this module only adapts its verdict to the MCP `HostnameInfo` shape and
 * derives the platform domain from the env-configured `MCP_URL`.
 */

import {
	normalizeSurfaceHostname,
	platformDomainForEnvironment,
	resolveSurfaceTenant,
	SURFACE_SLUG_PATTERN,
} from "@tedix/tenant-directory";

/**
 * Result of extracting app information from hostname
 */
export interface HostnameInfo {
	type: "subdomain" | "custom" | "base_domain";
	appSlug?: string;
	customDomain?: string;
}

/**
 * Build MCP base domains list from environment
 */
export function getMcpBaseDomains(env: CloudflareEnv): string[] {
	const domains: string[] = [];

	if (env.MCP_URL) {
		try {
			const url = new URL(env.MCP_URL);
			domains.push(url.hostname);
		} catch {
			// Invalid URL, skip
		}
	}

	return domains;
}

/**
 * Derive the platform domain (e.g. `tedix.dev`) from the configured MCP base
 * host (`mcp.tedix.dev`). Returns null when `MCP_URL` is unset/invalid, in
 * which case every host is treated as a custom domain (parity with the old
 * "no base matched" branch).
 */
function mcpPlatformDomain(env: CloudflareEnv): string | null {
	const [base] = getMcpBaseDomains(env);
	if (!base) return null;
	const dot = base.indexOf(".");
	return dot === -1 ? null : base.slice(dot + 1);
}

/**
 * Managed platform domains this Worker may receive in the current lane.
 *
 * Local remote development deliberately keeps the development Worker config
 * (`MCP_URL=https://mcp.tedix.tech`) while the OS service binding forwards the
 * canonical production-shaped target (`{app}.mcp.tedix.dev`). Treating that
 * target as a custom domain sends it down `apps.getByDomain` and produces a
 * false app miss. Development therefore accepts the canonical production
 * platform domain as a routing alias; production remains single-domain and
 * never accepts development hosts.
 *
 * This only selects the app-resolution key. It grants no authority: the same
 * MCP authentication and per-tool scope gates run after resolution.
 */
function mcpPlatformDomains(env: CloudflareEnv): string[] {
	const configured = mcpPlatformDomain(env);
	if (!configured) return [];
	const domains = [configured];
	if (configured === platformDomainForEnvironment("development")) {
		const production = platformDomainForEnvironment("production");
		if (!domains.includes(production)) domains.push(production);
	}
	return domains;
}

/**
 * Extract app information from hostname
 */
export function extractAppFromHostname(
	hostname: string,
	env: CloudflareEnv,
): HostnameInfo {
	const host = normalizeSurfaceHostname(hostname);
	// The isolated launcher uses localhost rather than a managed MCP domain.
	// Resolve only that configured development lane; authentication still runs
	// after app selection, and cloud/custom-domain routing remains unchanged.
	if (
		env.ENVIRONMENT === "development" &&
		getMcpBaseDomains(env)[0] === "localhost"
	) {
		if (host === "localhost") return { type: "base_domain" };
		if (host.endsWith(".localhost")) {
			const slug = host.slice(0, -".localhost".length);
			if (slug.length <= 63 && SURFACE_SLUG_PATTERN.test(slug)) {
				return { type: "subdomain", appSlug: slug };
			}
		}
	}
	const platformDomains = mcpPlatformDomains(env);
	if (platformDomains.length === 0) {
		return { type: "custom", customDomain: host };
	}

	for (const platformDomain of platformDomains) {
		const resolved = resolveSurfaceTenant(hostname, {
			platformDomain,
			expectedSurface: "mcp",
		});
		if (resolved.surface === "mcp" && resolved.kind === "apex") {
			return { type: "base_domain" };
		}
		if (
			resolved.surface === "mcp" &&
			resolved.kind === "tenant" &&
			resolved.slug
		) {
			return { type: "subdomain", appSlug: resolved.slug };
		}
	}
	return { type: "custom", customDomain: host };
}

/**
 * Pick the hostname a request is routed by.
 *
 * Production trusts the proxy chain: `X-Original-Host`, then
 * `X-Forwarded-Host`, then `X-Tedix-Host`, then `Host`, then the URL.
 * In development the documented local override `X-Tedix-Host` wins when it is
 * present, because the Vite dev server (`vp dev`) stamps `X-Forwarded-Host`
 * on every direct request and would otherwise mask the override. Production
 * precedence is unchanged.
 */
export function resolveRequestHostname(
	headers: Headers,
	url: URL,
	env: Pick<CloudflareEnv, "ENVIRONMENT">,
): string {
	const header = (name: string) => headers.get(name)?.split(":")[0] || "";
	const order =
		env.ENVIRONMENT === "development"
			? ["x-tedix-host", "x-original-host", "x-forwarded-host", "host"]
			: ["x-original-host", "x-forwarded-host", "x-tedix-host", "host"];
	for (const name of order) {
		const value = header(name);
		if (value) return value;
	}
	return url.hostname;
}
