/**
 * App Catalog Queries — Semantic search.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import {
	type CatalogAiSearchInstance,
	type CatalogSearchOptions,
	searchCatalogApps as vectorSearchCatalogApps,
} from "../../vector/catalog-vector";

// =============================================================================
// SEMANTIC SEARCH
// =============================================================================

/**
 * Semantic search over catalog apps using Cloudflare AI Search.
 *
 * Returns matched app IDs with relevance scores. The caller can then
 * fetch full app details from D1 by ID.
 *
 * @param vectorClient - AI Search instance (catalog index)
 * @param query - Natural language search query
 * @param options - Optional filters (health, minToolCount, source, etc.)
 * @returns Array of { id, score } ordered by relevance
 */
export async function semanticSearchCatalogApps(
	vectorClient: CatalogAiSearchInstance,
	query: string,
	options: CatalogSearchOptions = {},
): Promise<Array<{ id: string; score: number }>> {
	const results = await vectorSearchCatalogApps(vectorClient, query, options);

	return results.map((r) => ({
		id: r.id,
		score: r.score,
	}));
}
