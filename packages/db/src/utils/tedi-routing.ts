/**
 * Tedi Runtime Routing Utilities
 *
 * Handles hostname lookup for the flat slug URL architecture:
 * 1. Subdomain-based: {slug}.tedi.tedix.dev
 * 2. Custom domains: ai.acme.com → CNAME to subdomain
 *
 * Hostname grammar, normalization, the slug regex, and URL construction all
 * live in the single authority `@tedix/tenant-directory`; this module only owns
 * the DB lookups layered on top of its verdict.
 */

import {
	buildSurfaceUrl,
	normalizeSurfaceHostname,
	resolveSurfaceTenant,
} from "@tedix/tenant-directory";
import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import { tedis, tediCustomDomains } from "../schema/tedis";
import type { Tedi } from "../schema/tedis";

/**
 * Platform domain for subdomain routing.
 *
 * NOTE: This package is used in Worker runtimes (no Node.js `process` global).
 * Callers should pass `platformDomain` explicitly when needed (dev/local).
 */
export const PLATFORM_DOMAIN = "tedix.dev";

export interface ParsedTediHostname {
	tediSlug: string;
}

/**
 * Parse a subdomain hostname into a tedi slug via the shared authority.
 * Expected format: {slug}.tedi.{platformDomain}. Returns null when the host is
 * not a tenant subdomain (apex, custom domain, or non-DNS-legal label).
 */
export function parseTediHostname(
	hostname: string,
	platformDomain: string = PLATFORM_DOMAIN,
): ParsedTediHostname | null {
	const resolved = resolveSurfaceTenant(hostname, {
		platformDomain,
		expectedSurface: "tedi",
	});
	return resolved.surface === "tedi" &&
		resolved.kind === "tenant" &&
		resolved.slug
		? { tediSlug: resolved.slug }
		: null;
}

/**
 * Look up a live tedi by hostname. Tries custom domains first,
 * then falls back to subdomain pattern parsing.
 *
 * Both branches exclude retired tedis. `tedi_custom_domains` used to be swept
 * away by the tedis cascade on delete; retirement keeps the row alive so the
 * worker's memory survives, which means an `active` custom domain would keep
 * routing to a retired worker unless it is filtered here.
 */
export async function lookupTediByHostname(
	db: DbClient,
	hostname: string,
	platformDomain: string = PLATFORM_DOMAIN,
): Promise<Tedi | undefined> {
	const host = normalizeSurfaceHostname(hostname);

	// 1. Try custom domain lookup first
	const customDomain = await db
		.select({ tediId: tediCustomDomains.tediId })
		.from(tediCustomDomains)
		.where(
			and(
				eq(tediCustomDomains.hostname, host),
				eq(tediCustomDomains.status, "active"),
			),
		)
		.then((rows) => rows[0]);

	if (customDomain) {
		const results = await db
			.select()
			.from(tedis)
			.where(and(eq(tedis.id, customDomain.tediId), isNull(tedis.retiredAt)));
		return results[0];
	}

	// 2. Try subdomain pattern — slug is globally unique
	const parsed = parseTediHostname(host, platformDomain);
	if (!parsed) {
		return undefined;
	}

	const results = await db
		.select()
		.from(tedis)
		.where(and(eq(tedis.slug, parsed.tediSlug), isNull(tedis.retiredAt)));

	return results[0];
}

/**
 * Build the runtime URL for a tedi using its globally-unique slug.
 */
export function buildRuntimeUrl(
	tedi: {
		slug: string | null;
	},
	platformDomain: string = PLATFORM_DOMAIN,
): string | null {
	return buildSurfaceUrl("tedi", tedi.slug, { platformDomain });
}
