/**
 * App Catalog Queries — MCP endpoint normalization.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { appCatalog, type CatalogApp } from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// MCP ENDPOINT NORMALIZATION
// =============================================================================

export function normalizeMcpEndpoint(url: string | null): string | null {
	if (!url) return null;

	try {
		const parsed = new URL(url);

		// 1. Force HTTPS
		parsed.protocol = "https:";

		// 2. Lowercase hostname
		parsed.hostname = parsed.hostname.toLowerCase();

		// 3. Remove trailing slashes from path (but don't force /mcp)
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");

		// 4. Query parameters can be part of MCP routing identity (for example a
		// tenant or organization selector). Preserve them and sort deterministically
		// so equivalent parameter order hashes to one endpoint. Credentials belong
		// in headers, never here. Fragments are client-side and are not transmitted.
		parsed.searchParams.sort();
		parsed.hash = "";

		return parsed.toString();
	} catch {
		return null;
	}
}

/**
 * Generate SHA256 hash of normalized endpoint for fast lookups
 */
export async function hashMcpEndpoint(endpoint: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(endpoint);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get catalog app by normalized MCP endpoint hash
 */
export async function getCatalogAppByMcpEndpointHash(
	db: Database,
	hash: string,
): Promise<CatalogApp | null> {
	const result = await db
		.select()
		.from(appCatalog)
		.where(eq(appCatalog.mcpEndpointHash, hash))
		.limit(1);

	return result[0] ?? null;
}

// =============================================================================
// VENDOR-IDENTITY CANONICALIZATION
// =============================================================================
//
// Store-brokered connectors (ChatGPT SERVICE connectors, Claude enterprise
// connectors) are published WITHOUT a public MCP endpoint. They cannot be
// deduplicated by endpoint hash, so a naive sync spawns a fresh `app_catalog`
// row for each one — even when the vendor's real remote MCP server is already
// registered as an `official` row (e.g. GitHub's ChatGPT SERVICE connector vs
// the `github` official row at api.githubcopilot.com/mcp/). To stop that
// duplication, a no-endpoint connector is matched to an existing canonical row
// by VENDOR IDENTITY (registrable website domain + normalized display name) and
// attached as a store listing instead of creating a standalone row.
//
// Matching is intentionally conservative to avoid mis-merging multi-product
// vendors (e.g. one google.com vendor with several distinct products): a match
// requires BOTH the same registrable domain AND an exact normalized-name match,
// and the canonical candidate must itself be a runnable MCP row (has an
// endpoint) so we only ever fold a brokered card onto a real server.

/**
 * Extract the registrable domain (host minus a leading `www.`) from a URL or
 * bare hostname. Returns a lowercased host string, or null when unparseable.
 */
export function extractVendorDomain(
	websiteOrHost: string | null | undefined,
): string | null {
	if (!websiteOrHost) return null;
	const raw = websiteOrHost.trim();
	if (!raw) return null;
	let host: string | null = null;
	try {
		const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		host = new URL(withProtocol).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (!host) return null;
	return host.replace(/^www\./, "");
}

/**
 * Normalize a display name for exact vendor-identity comparison: trimmed,
 * lowercased, collapsed internal whitespace.
 */
export function normalizeVendorName(name: string | null | undefined): string {
	return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Find the canonical runnable catalog row a no-endpoint connector should fold
 * onto, matched by registrable domain + exact normalized name. Only returns a
 * candidate that is itself a runnable MCP row (has `mcpEndpointNormalized`), so
 * a brokered listing is never attached to another brokered listing. Returns
 * null when there is no safe, unambiguous match.
 */
export async function getCanonicalCatalogAppForConnector(
	db: Database,
	input: {
		website: string | null | undefined;
		name: string | null | undefined;
	},
): Promise<CatalogApp | null> {
	const domain = extractVendorDomain(input.website);
	const name = normalizeVendorName(input.name);
	if (!domain || !name) return null;

	// Candidate canonical rows: runnable (endpoint present) and sharing the same
	// registrable domain. Domain is compared with the same www-stripping applied
	// on both sides so `www.github.com` and `github.com` match.
	const candidates = await db
		.select()
		.from(appCatalog)
		.where(
			and(
				isNotNull(appCatalog.mcpEndpointNormalized),
				isNotNull(appCatalog.website),
				sql`lower(replace(replace(${appCatalog.website}, 'https://', ''), 'http://', '')) LIKE ${`%${domain}%`}`,
			),
		)
		.limit(25);

	const matches = candidates.filter((row) => {
		if (extractVendorDomain(row.website) !== domain) return false;
		return normalizeVendorName(row.name) === name;
	});

	// Only canonicalize on a single unambiguous match.
	return matches.length === 1 ? (matches[0] ?? null) : null;
}
