/**
 * App Catalog Queries — MCP endpoint normalization.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, eq, isNotNull, isNull, like, sql } from "drizzle-orm";
import { appCatalog, type CatalogApp } from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// MCP ENDPOINT NORMALIZATION
// =============================================================================

/**
 * True when a base URL is a placeholder the installer fills in (`{url}`,
 * `https://{tenant}.example.com/mcp`), not a server anyone can reach. Such a URL
 * identifies no endpoint, so it must never be hashed for endpoint dedup.
 */
export function isTemplatedMcpEndpoint(
	url: string | null | undefined,
): boolean {
	return typeof url === "string" && /[{}]/.test(url);
}

export function normalizeMcpEndpoint(url: string | null): string | null {
	if (!url || isTemplatedMcpEndpoint(url)) return null;

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
 * Find the canonical catalog row an endpoint-less connector should fold onto,
 * matched by registrable domain + exact normalized name. By default only a
 * runnable MCP row (has `mcpEndpointNormalized`) qualifies, so a brokered
 * listing is never attached to another brokered listing. With
 * `templateEndpoint`, the candidate must instead be a row whose own endpoint is
 * a template (`{url}`) — the same user-supplied-server listing seen again in
 * another directory entry. Returns null when there is no safe, unambiguous
 * match.
 */
export async function getCanonicalCatalogAppForConnector(
	db: Database,
	input: {
		website: string | null | undefined;
		name: string | null | undefined;
		templateEndpoint?: boolean;
	},
): Promise<CatalogApp | null> {
	const domain = extractVendorDomain(input.website);
	const name = normalizeVendorName(input.name);
	if (!domain || !name) return null;

	// Domain is compared with the same www-stripping applied on both sides so
	// `www.github.com` and `github.com` match.
	const endpointShape = input.templateEndpoint
		? and(
				isNull(appCatalog.mcpEndpointNormalized),
				like(appCatalog.baseUrl, "%{%"),
			)
		: isNotNull(appCatalog.mcpEndpointNormalized);
	const candidates = await db
		.select()
		.from(appCatalog)
		.where(
			and(
				endpointShape,
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

const SECOND_LEVEL_LABELS = new Set([
	"co",
	"com",
	"net",
	"org",
	"ac",
	"gov",
	"edu",
	"ne",
	"or",
]);

/**
 * The registrable domain of a vendor website (`app.breezesec.com` →
 * `breezesec.com`, `shop.example.co.jp` → `example.co.jp`). A heuristic, not a
 * public-suffix lookup: it only names a slug, never decides identity.
 */
export function registrableVendorDomain(
	websiteOrHost: string | null | undefined,
): string | null {
	const host = extractVendorDomain(websiteOrHost);
	if (!host) return null;
	const labels = host.split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const tld = labels[labels.length - 1] ?? "";
	const second = labels[labels.length - 2] ?? "";
	const keep = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2;
	return labels.slice(-keep).join(".");
}
