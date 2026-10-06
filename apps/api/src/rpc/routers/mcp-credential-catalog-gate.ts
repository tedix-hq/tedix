/**
 * Catalog-allowlist gate for tedi-initiated MCP connections.
 *
 * ADR docs/decisions/tedi-client-oauth-cimd.md (phase 1 — "Enforce the
 * catalog gate in the tedi-facing connect path"): the app catalog IS the
 * connection allowlist for external MCP servers. A tedi-facing connection to
 * an endpoint that resolves to no `app_catalog` row refuses fail-closed with
 * a typed reason before any credential resolution or OAuth/discovery traffic
 * is sent. It never degrades to a direct connection.
 *
 * Tedix-internal servers are not "external" and bypass the gate explicitly:
 * platform app/tedi subdomains (`*.mcp.*` / `*.tedi.*` on the platform base
 * domains and localhost) and service-bound targets, which never reach this
 * path as arbitrary URLs. Matching is by normalized endpoint hash
 * (`app_catalog.mcp_endpoint_hash`), reusing the ingestion-side
 * normalization so gate lookups and catalog rows agree byte-for-byte.
 */

import {
	hashMcpEndpoint,
	normalizeMcpEndpoint,
} from "@tedix/db/queries/catalog/endpoint-normalization";

export type CatalogRefusalReason = "invalid_url" | "not_in_catalog";

export interface CatalogRefusal {
	/** Normalized endpoint (or raw input when unparseable) that was refused */
	endpoint: string;
	reason: CatalogRefusalReason;
}

export type CatalogGateDecision =
	/** Tedix-internal target — the gate does not apply */
	| { kind: "internal" }
	/** External endpoint with a catalog row — connection may proceed */
	| { kind: "allowed"; catalogAppId: string; normalizedEndpoint: string }
	/** External endpoint with no catalog row — fail closed */
	| { kind: "refused"; refusal: CatalogRefusal };

/**
 * Platform-internal MCP/tedi subdomain hosts. Mirrors the host patterns in
 * mcp-credentials.ts (`resolveAppForServerUrl` / `resolveTediForServerUrl`):
 * `{slug}.mcp.{base}` and `{slug}.tedi.{base}` for the production and
 * development base domains plus localhost.
 */
const TEDIX_INTERNAL_HOST_PATTERN =
	/^[^.]+\.(?:mcp|tedi)\.(?:tedix\.dev|tedix\.tech|localhost)$/;

export function isTedixInternalMcpHost(hostname: string): boolean {
	return TEDIX_INTERNAL_HOST_PATTERN.test(hostname.toLowerCase());
}

/**
 * Evaluate the catalog-allowlist gate for a server URL that did not resolve
 * to a Tedix-managed app or peer tedi.
 *
 * `lookupCatalogAppIdByEndpointHash` receives the SHA-256 hash of the
 * normalized endpoint and returns the matching `app_catalog.id`, or null.
 */
export async function evaluateExternalMcpCatalogGate(
	serverUrl: string,
	lookupCatalogAppIdByEndpointHash: (hash: string) => Promise<string | null>,
): Promise<CatalogGateDecision> {
	let hostname: string;
	try {
		hostname = new URL(serverUrl).hostname;
	} catch {
		return {
			kind: "refused",
			refusal: { endpoint: serverUrl, reason: "invalid_url" },
		};
	}

	if (isTedixInternalMcpHost(hostname)) {
		return { kind: "internal" };
	}

	const normalizedEndpoint = normalizeMcpEndpoint(serverUrl);
	if (!normalizedEndpoint) {
		return {
			kind: "refused",
			refusal: { endpoint: serverUrl, reason: "invalid_url" },
		};
	}

	const hash = await hashMcpEndpoint(normalizedEndpoint);
	const catalogAppId = await lookupCatalogAppIdByEndpointHash(hash);
	if (!catalogAppId) {
		return {
			kind: "refused",
			refusal: { endpoint: normalizedEndpoint, reason: "not_in_catalog" },
		};
	}

	return { kind: "allowed", catalogAppId, normalizedEndpoint };
}
