/**
 * Tenant slug resolution for the tedi Agent runtime edge.
 *
 * The runtime serves one tedi per request and must resolve which tedi from the
 * incoming request. The HOSTNAME is the authoritative source: public ingress
 * arrives at `{slug}.tedi.{platformDomain}` and the slug is parsed from it.
 */

export const PLATFORM_DOMAINS = ["tedix.dev", "tedix.tech"];

/**
 * Parse `{slug}.tedi.{platformDomain}` → slug. Returns null if the hostname
 * does not match the expected isolate tedi pattern. Bare `tedi.{domain}` →
 * null (no slug, admin endpoints don't live here).
 *
 * SECURITY: the HOSTNAME is authoritative. When the hostname resolves to a
 * slug, that slug wins and any client-supplied `?slug=` query parameter is
 * ignored. Honoring the query param over the hostname would let a client
 * override hostname-based tenant routing and reach another tenant's isolate
 * (confused-deputy cross-tenant routing).
 *
 * The `?slug=` fallback exists ONLY for the internal service-binding self-call /
 * smoke-test path, where the forwarded URL host is a neutral internal host that
 * does not match the public `{slug}.tedi.{domain}` pattern. It is therefore
 * used only when (a) the hostname yields no slug AND (b) the caller is a trusted
 * service binding (`allowQueryFallback`). Untrusted public ingress can never
 * reach the query fallback.
 */
export function resolveSlugFromHost(
	hostname: string,
	url: URL,
	allowQueryFallback: boolean,
): string | null {
	const host = hostname.toLowerCase();
	for (const domain of PLATFORM_DOMAINS) {
		const suffix = `.tedi.${domain}`;
		if (host.endsWith(suffix)) {
			const prefix = host.slice(0, -suffix.length);
			if (!prefix || prefix.includes(".")) return null;
			return prefix;
		}
	}
	// Hostname yielded no slug. Only a trusted service-binding caller may fall
	// back to the explicit `?slug=` query parameter.
	if (allowQueryFallback) {
		return url.searchParams.get("slug");
	}
	return null;
}
