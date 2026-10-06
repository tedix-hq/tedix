/**
 * @tedix/tenant-directory — the single hostname-grammar authority.
 *
 * Every Tedix surface (OS, MCP, Tedi, CMS) routes tenants off a subdomain of a
 * shared platform domain (`{slug}.{surface}.{platformDomain}`). Historically
 * each surface carried its own parser, its own slug regex, and its own
 * normalization, which drifted apart. This module is the one place that:
 *
 *   1. Normalizes a raw `Host` header into a canonical hostname.
 *   2. Resolves it to `{ surface, slug, kind }`.
 *   3. Builds the canonical URL back from `{ surface, slug }`.
 *
 * It is runtime-neutral: no React, no Cloudflare bindings, no persistence, no
 * network. Surfaces adapt their own DB lookups on top of the `custom-domain`
 * verdict; this module never touches a database.
 *
 * The slug grammar is deliberately the RFC-1035 DNS-label form used by the
 * provisioning gate (`organizations` create input). Provisioning has only ever
 * minted slugs satisfying it, so adopting it as the one canonical regex drops
 * zero real tenants while unifying the four historically-drifting parsers. The
 * looser historical MCP/Tedi/CMS forms only ever admitted additional
 * NON-provisionable labels that DB/API existence checks reject either way.
 */

/** A first-class Tedix surface reachable at `{surface}.{platformDomain}`. */
export type Surface = "os" | "mcp" | "tedi" | "cms";

/**
 * The resolution verdict.
 *
 * - `tenant` — a provisionable `{slug}.{surface}.{pd}` subdomain.
 * - `apex` — the surface root (`os.`/`mcp.`/`cms.`/`studio.` + pd). Not a tenant.
 * - `local` — OS-only dev lane (`localhost`, `127.0.0.1`, `{label}.localhost`).
 * - `custom-domain` — an unrecognized host a surface must resolve via its own
 *   custom-domain DB lookup (MCP/CMS/Tedi). `slug` is null; the caller keys off
 *   the (already-normalized) hostname it passed in.
 * - `invalid` — fails closed (OS has no custom-domain path → edge 404).
 */
export type SurfaceKind =
	| "tenant"
	| "apex"
	| "local"
	| "custom-domain"
	| "invalid";

export interface SurfaceTenant {
	surface: Surface | null;
	slug: string | null;
	kind: SurfaceKind;
}

export interface ResolveSurfaceOptions {
	/**
	 * Platform domain the edge serves. `tedix.dev` (prod) or `tedix.tech` (dev).
	 * Any `tld.tld` value works for separately hosted installations.
	 */
	platformDomain?: string;
	/**
	 * Which surface's fallthrough semantics to apply when no known surface
	 * suffix matches. A single-surface edge (each Worker) passes its own surface
	 * so an unrecognized host either fails closed (`os` → invalid) or becomes a
	 * custom-domain candidate (`mcp`/`cms`/`tedi` → custom-domain).
	 */
	expectedSurface?: Surface;
}

export interface BuildSurfaceUrlOptions {
	platformDomain?: string;
	/** `endpoint` appends the MCP `/mcp` path; ignored by other surfaces. */
	path?: "endpoint";
}

/** Canonical platform domain for a deployed Worker environment. */
export function platformDomainForEnvironment(environment: string): string {
	return environment === "production" ? "tedix.dev" : "tedix.tech";
}

/**
 * THE canonical slug regex — RFC-1035 DNS label character rule: lowercase
 * alphanumeric with internal hyphens, no leading/trailing hyphen, single char
 * allowed. It carries no length cap so provisioning validators can layer their
 * own bound (org labels cap at 63 to stay DNS-legal; app slugs cap at 100 and
 * therefore route only via custom domain, never a subdomain). Hostname routing
 * enforces the DNS 63-char cap via {@link MAX_DNS_LABEL_LENGTH}.
 */
export const SURFACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Maximum length of a DNS label — the cap hostname routing applies. */
const MAX_DNS_LABEL_LENGTH = 63;

const SUBDOMAIN_SURFACES = ["os", "mcp", "tedi", "cms"] as const;
const DEFAULT_PLATFORM_DOMAIN = "tedix.dev";
const LOCALHOST_SUFFIX = ".localhost";

/**
 * Canonicalize a raw hostname: trim, lowercase, strip port (IPv6-bracket
 * aware), strip a trailing FQDN dot. A strict superset of every surface's
 * historical normalization — real hostnames at these edges carry no port or
 * trailing dot, so it changes no positive-match outcome.
 */
export function normalizeSurfaceHostname(hostname: string): string {
	let host = hostname.trim().toLowerCase();
	const bracketEnd = host.indexOf("]");
	const colonIdx = host.indexOf(":", bracketEnd + 1);
	if (colonIdx !== -1) {
		host = host.slice(0, colonIdx);
	}
	if (host.endsWith(".")) {
		host = host.slice(0, -1);
	}
	return host;
}

/** True when `label` is a routable DNS-legal tenant slug. */
function isSurfaceSlug(label: string): boolean {
	return (
		label.length >= 1 &&
		label.length <= MAX_DNS_LABEL_LENGTH &&
		SURFACE_SLUG_PATTERN.test(label)
	);
}

function fallthrough(
	matchedSurface: Surface | null,
	expectedSurface: Surface | undefined,
): SurfaceTenant {
	const surface = matchedSurface ?? expectedSurface ?? null;
	if (surface === "os") {
		return { surface: "os", slug: null, kind: "invalid" };
	}
	if (surface === "mcp" || surface === "cms" || surface === "tedi") {
		return { surface, slug: null, kind: "custom-domain" };
	}
	return { surface: null, slug: null, kind: "invalid" };
}

/**
 * Resolve a hostname to its surface, slug, and kind. See {@link SurfaceKind}
 * for the verdict contract and {@link ResolveSurfaceOptions.expectedSurface}
 * for how a single-surface edge selects its fallthrough behavior.
 */
export function resolveSurfaceTenant(
	hostname: string,
	opts: ResolveSurfaceOptions = {},
): SurfaceTenant {
	const platformDomain = opts.platformDomain ?? DEFAULT_PLATFORM_DOMAIN;
	const expectedSurface = opts.expectedSurface;
	const host = normalizeSurfaceHostname(hostname);

	if (!host) return { surface: null, slug: null, kind: "invalid" };

	// 1. LOCAL lane — OS-only dev hosts. Other surfaces never see localhost.
	if (host === "localhost" || host === "127.0.0.1") {
		return { surface: "os", slug: null, kind: "local" };
	}
	if (host.endsWith(LOCALHOST_SUFFIX)) {
		const label = host.slice(0, -LOCALHOST_SUFFIX.length);
		return label
			? { surface: "os", slug: label, kind: "local" }
			: { surface: null, slug: null, kind: "invalid" };
	}

	// 2. APEX roots. The Site Builder hosts are never tenant hostnames.
	if (host === `os.${platformDomain}`) {
		return { surface: "os", slug: null, kind: "apex" };
	}
	if (host === `mcp.${platformDomain}`) {
		return { surface: "mcp", slug: null, kind: "apex" };
	}
	if (
		host === `builder.${platformDomain}` ||
		host === `studio.${platformDomain}`
	) {
		return { surface: "cms", slug: null, kind: "apex" };
	}
	if (host === `cms.${platformDomain}`) {
		return { surface: "cms", slug: null, kind: "apex" };
	}

	// 3. SUBDOMAIN — {label}.{surface}.{platformDomain}.
	for (const surface of SUBDOMAIN_SURFACES) {
		const suffix = `.${surface}.${platformDomain}`;
		if (host.endsWith(suffix)) {
			const label = host.slice(0, -suffix.length);
			if (label && !label.includes(".") && isSurfaceSlug(label)) {
				return { surface, slug: label, kind: "tenant" };
			}
			// Suffix matched but the label is not a legal DNS slug → the matched
			// surface's fallthrough decides (os fails closed, others → custom).
			return fallthrough(surface, expectedSurface);
		}
	}

	// 4. No known surface suffix matched → expected surface's fallthrough.
	return fallthrough(null, expectedSurface);
}

/**
 * Build the canonical HTTPS URL for a surface tenant. Returns null when `slug`
 * is falsy (parity with the historical `buildRuntimeUrl`). MCP `path:"endpoint"`
 * appends `/mcp`.
 */
export function buildSurfaceUrl(
	surface: Surface,
	slug: string | null | undefined,
	opts: BuildSurfaceUrlOptions = {},
): string | null {
	if (!slug) return null;
	const pd = opts.platformDomain ?? DEFAULT_PLATFORM_DOMAIN;
	switch (surface) {
		case "os":
			return `https://${slug}.os.${pd}/`;
		case "mcp":
			return opts.path === "endpoint"
				? `https://${slug}.mcp.${pd}/mcp`
				: `https://${slug}.mcp.${pd}`;
		case "tedi":
			return `https://${slug}.tedi.${pd}`;
		case "cms":
			return `https://${slug}.cms.${pd}`;
	}
}
