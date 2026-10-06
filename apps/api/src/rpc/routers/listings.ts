/**
 * Listings Search oRPC Router
 *
 * AUTHENTICATED ROUTER - Uses withAuth middleware.
 * Called by apps/mcp (MCP service) for listing search functionality.
 *
 * Unified search endpoint that routes queries through app-configured adapters.
 * Supports multiple data sources: Klarna Shopping MCP, Shopify, Custom REST, Vector store.
 *
 * Endpoints:
 * - GET /apps/{appId}/listings/search - Search listings via app's configured adapter
 * - GET /apps/{appId}/listings/adapters - List configured adapters for an app
 * - GET /listings/markets - List supported markets
 *
 * The adapter configuration is read from D1 (app_adapters table) and determines
 * which data source to query (federation over ingestion principle).
 *
 * This router uses contract-first development with oRPC.
 * Contracts are imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import { listingsContract } from "@tedix/api-contract/contracts/listings";
import {
	type LayoutItemSchemaType as LayoutItem,
	LayoutItemSchema,
} from "@tedix/api-contract/schemas/layout";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import { getEnabledAdapters } from "@tedix/db/queries/adapters";
import { AdapterRegistry } from "../../adapters/registry";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";

// =============================================================================
// CONSTANTS
// =============================================================================
// Note: Sort mapping now handled within adapter implementations

// =============================================================================
// NOTE: Old adapter search functions removed
// All adapter logic now handled by AdapterRegistry and adapter implementations
// in apps/api/src/adapters/* (KlarnaAdapter, ShopifyAdapter, etc.)
// =============================================================================

// =============================================================================
// CONTRACT IMPLEMENTATION
// =============================================================================

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const listingsOs = implement(listingsContract)
	.$context<BaseContext>()
	.use(withAuth);

// =============================================================================
// MIDDLEWARE
// =============================================================================

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based search procedure implementation
 */
export const searchListings = listingsOs.search
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const {
			appId,
			q,
			limit,
			country,
			minPrice,
			maxPrice,
			category,
			queries,
			sort,
			includeOffers,
			priceDrop,
			adapterScope,
			resultStrategy,
		} = input;
		const orgId = requireOrgId(context);

		const app = await getAppByIdForOrganization(db, appId, orgId);
		if (!app) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`App not found with UUID: ${appId}. Internal APIs require app UUID, not slug.`,
			);
		}

		// Initialize AdapterRegistry and load adapters for this app
		const registry = new AdapterRegistry(
			db,
			env as unknown as Record<string, string>,
		);
		await registry.loadAdaptersForApp(app.id);

		if (!registry.isLoaded || registry.adapterCount === 0) {
			return {
				data: [],
				query: q ?? queries?.join(" vs ") ?? "",
				source: "none",
				market: country,
				pagination: { limit, offset: 0, total: 0, hasMore: false },
				error: "No adapters configured for this app",
			};
		}

		console.log(
			`[Listings Search] App "${app.slug}" has ${registry.adapterCount} enabled adapter(s)`,
		);

		// Build adapter context
		const adapterCtx = {
			env: env as unknown as Record<string, string>,
			db,
			signal: undefined,
		};

		// Determine which adapters to use based on adapterScope
		let includeAdapters: string[] | undefined;
		if (adapterScope) {
			if (typeof adapterScope === "string") {
				if (adapterScope === "primary") {
					// Use only primary adapter
					const primaryAdapter = registry.getPrimaryAdapter();
					if (primaryAdapter) {
						includeAdapters = [primaryAdapter.id];
					}
				}
				// "all" means use all adapters (no filter needed)
			} else {
				// Array of specific adapter IDs
				includeAdapters = adapterScope;
			}
		}

		// Build registry search options
		const registryOptions = {
			limit,
			country,
			minPrice,
			maxPrice,
			category,
			queries,
			sort,
			includeOffers,
			priceDrop,
			includeAdapters,
		};

		// Resolve effective single query: explicit q, or single-item queries array
		const effectiveQ = q ?? queries?.[0] ?? "";

		// Batch mode: parallel search per query when multiple queries provided
		if (queries && queries.length > 1) {
			const batchQueries = queries.slice(0, 8);
			console.log(
				`[Listings Search] Batch mode: ${batchQueries.length} queries for app "${app.slug}"`,
			);

			// Sequential execution: SSE-based adapters (Klarna MCP) fail with
			// concurrent outbound streams in Workers. Run queries one at a time.
			const batchResults: PromiseSettledResult<
				Awaited<ReturnType<typeof registry.searchAll>>
			>[] = [];
			for (const batchQuery of batchQueries) {
				try {
					const result = await registry.searchAll(
						batchQuery,
						registryOptions,
						adapterCtx,
					);
					batchResults.push({ status: "fulfilled", value: result });
				} catch (error) {
					batchResults.push({ status: "rejected", reason: error });
				}
			}

			const listingGroups = batchQueries.map((batchQuery, i) => {
				const result = batchResults[i];
				if (!result || result.status === "rejected") {
					return {
						query: batchQuery,
						items: [] as LayoutItem[],
						totalResults: 0,
						error:
							result?.status === "rejected"
								? String(result.reason)
								: "Unknown error",
					};
				}
				return {
					query: batchQuery,
					items: result.value.items,
					totalResults: result.value.totalResults,
					...(result.value.errors.length > 0 && {
						error: result.value.errors
							.map((e) => `${e.adapter}: ${e.error}`)
							.join("; "),
					}),
				};
			});

			const allItems = listingGroups.flatMap((g) => g.items);
			const totalResults = listingGroups.reduce(
				(sum, g) => sum + g.totalResults,
				0,
			);

			return {
				data: allItems,
				query: batchQueries.join(" vs "),
				source: "batch",
				market: country,
				pagination: {
					limit,
					offset: 0,
					total: totalResults,
					hasMore: false,
				},
				batchMode: true,
				listingGroups,
			};
		}

		// Execute search based on resultStrategy
		const strategy = resultStrategy ?? "merge";

		if (strategy === "first_success") {
			// Use fallback chain - try each adapter until one succeeds
			console.log(
				`[Listings Search] Using first_success strategy (fallback chain)`,
			);

			const result = await registry.searchWithFallback(
				effectiveQ,
				registryOptions,
				adapterCtx,
			);

			return {
				data: result.items,
				query: effectiveQ,
				source: result.source,
				market: country,
				pagination: {
					limit,
					offset: 0,
					total: result.totalResults ?? result.items.length,
					hasMore:
						result.items.length < (result.totalResults ?? result.items.length),
				},
				...(result.error && { error: result.error }),
			};
		}

		if (strategy === "merge" || strategy === "parallel_all") {
			// Use parallel search across all matching adapters
			console.log(
				`[Listings Search] Using ${strategy} strategy (parallel search)`,
			);

			const aggregatedResult = await registry.searchAll(
				effectiveQ,
				registryOptions,
				adapterCtx,
			);

			// Format sources as comma-separated list
			const sources = Array.from(
				new Set(aggregatedResult.adapterResults.map((r) => r.source)),
			).join("+");

			// Collect all errors
			const errorMessages =
				aggregatedResult.errors.length > 0
					? aggregatedResult.errors
							.map((e) => `${e.adapter}: ${e.error}`)
							.join("; ")
					: undefined;

			const items = aggregatedResult.items;
			// Note: Enrichment disabled until extractionConfig is set in D1 for all apps.
			// Intentionally removed for now to keep type-safety intact.

			// Debug: Validate items before returning to catch schema mismatches
			if (items.length > 0) {
				for (let i = 0; i < Math.min(items.length, 2); i++) {
					const item = items[i];
					if (!item) {
						continue;
					}
					const result = LayoutItemSchema.safeParse(item);
					if (!result.success) {
						console.error(`[Listings Search] Item ${i} validation failed:`, {
							itemId: item.id,
							errors: result.error.issues.map((e) => ({
								path: e.path.join("."),
								message: e.message,
								received:
									e.code === "invalid_type"
										? (e as { received?: unknown }).received
										: undefined,
							})),
						});
					}
				}
			}

			return {
				data: items,
				query: effectiveQ,
				source: sources || "none",
				market: country,
				pagination: {
					limit,
					offset: 0,
					total: aggregatedResult.totalResults,
					hasMore:
						aggregatedResult.items.length < aggregatedResult.totalResults,
				},
				...(errorMessages && { error: errorMessages }),
			};
		}

		// Fallback: shouldn't reach here but handle gracefully
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Unknown result strategy: ${strategy}`,
		);
	});

/**
 * Contract-based adapters list procedure implementation
 */
export const getAdapters = listingsOs.adapters
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;
		const orgId = requireOrgId(context);

		const app = await getAppByIdForOrganization(db, appId, orgId);
		if (!app) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`App not found with UUID: ${appId}. Use app UUID, not slug.`,
			);
		}

		const adapters = await getEnabledAdapters(db, app.id);

		return {
			data: adapters.map((a) => ({
				id: a.id,
				name: a.name,
				displayName: a.displayName,
				type: a.adapterType,
				enabled: a.enabled ?? false,
				priority: a.priority ?? 0,
				verticals: a.verticals,
				hasConfig: !!a.config,
			})),
			appSlug: app.slug,
		};
	});

/**
 * Contract-based markets list procedure implementation
 */
export const listMarkets = listingsOs.markets
	.use(AUTHZ.appsRead)
	.handler(async () => {
		const markets = [
			{ code: "DE", name: "Germany", currency: "EUR" },
			{ code: "SE", name: "Sweden", currency: "SEK" },
			{ code: "DK", name: "Denmark", currency: "DKK" },
			{ code: "NO", name: "Norway", currency: "NOK" },
			{ code: "FI", name: "Finland", currency: "EUR" },
			{ code: "UK", name: "United Kingdom", currency: "GBP" },
			{ code: "FR", name: "France", currency: "EUR" },
			{ code: "AT", name: "Austria", currency: "EUR" },
			{ code: "US", name: "United States", currency: "USD" },
			{ code: "IE", name: "Ireland", currency: "EUR" },
			{ code: "ES", name: "Spain", currency: "EUR" },
			{ code: "IT", name: "Italy", currency: "EUR" },
			{ code: "NL", name: "Netherlands", currency: "EUR" },
		];

		const sortOptions = [
			"relevance",
			"price_asc",
			"price_desc",
			"popularity",
			"rating",
			"name",
			"trending",
			"hot",
		].map((opt) => ({
			value: opt,
			label: opt
				.split("_")
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(" "),
		}));

		return { markets, sortOptions };
	});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const listingsContractRouter = listingsOs.router({
	search: searchListings,
	adapters: skipOutputValidation(getAdapters),
	markets: skipOutputValidation(listMarkets),
});
