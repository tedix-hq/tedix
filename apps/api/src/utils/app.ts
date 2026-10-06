/**
 * Slugify a string into a URL-safe format
 * Examples:
 * - "MediaMarkt" -> "mediamarkt"
 * - "Mobile.de" -> "mobile-de"
 * - "eBay Kleinanzeigen" -> "ebay-kleinanzeigen"
 */
export function slugify(input: string, maxLength = 50): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, maxLength);
}

/**
 * Generate an org-prefixed slug for an app.
 *
 * Convention: {org-slug}-{app-name-slug}
 * This prevents MCP subdomain collisions across organizations.
 *
 * Examples (orgSlug = "acme"):
 * - "Admin Dashboard" -> "acme-admin-dashboard"
 * - "MCP Server" -> "acme-mcp-server"
 *
 * If no orgSlug is provided, falls back to app name only (legacy).
 */
export function generateAppSlug(name: string, orgSlug?: string): string {
	const appPart = slugify(name);
	if (!appPart) return orgSlug ? `${slugify(orgSlug)}-app` : "app";
	if (!orgSlug) return appPart;

	const orgPart = slugify(orgSlug);
	if (!orgPart) return appPart;

	// If app name already starts with org prefix, don't double-prefix
	if (appPart.startsWith(`${orgPart}-`)) return appPart;

	// Combine: {org}-{app}, capped at 100 chars (slug column max)
	return `${orgPart}-${appPart}`.substring(0, 100);
}

/**
 * Slugs reserved for platform routing. The kernel/home aggregate surface lives
 * at the `tedix-unified` server under the `home`/`kernel` namespaces (see
 * `AGGREGATE_NAMESPACES` / `resolveMcpTarget` in the skill-runtime bridge). A
 * tenant app must never claim one of these — it would let a tenant-created app
 * shadow the aggregate surface and intercept kernel/home tool calls. Platform
 * provisioning (which actually creates `tedix-unified`) is exempt.
 */
export const RESERVED_APP_SLUGS = new Set(["home", "kernel", "tedix-unified"]);

export function isReservedAppSlug(slug: string): boolean {
	return RESERVED_APP_SLUGS.has(slug.toLowerCase());
}
