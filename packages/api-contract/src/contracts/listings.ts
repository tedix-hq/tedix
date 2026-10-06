import "@orpc/openapi/extensions/route";
/**
 * Listings Contract for oRPC
 * Type-safe API contract for Listing search and adapter endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { AppIdParamSchema, PaginationMetaSchema } from "../schemas/common";
import { LayoutItemSchema } from "../schemas/layout";

// =============================================================================
// LOCAL SCHEMAS
// =============================================================================

/**
 * Supported shopping-provider market codes
 */
export const MarketCodeSchema = z.enum([
	"DE",
	"SE",
	"DK",
	"NO",
	"FI",
	"UK",
	"FR",
	"AT",
	"US",
	"IE",
	"ES",
	"IT",
	"NL",
]);
export type MarketCode = z.infer<typeof MarketCodeSchema>;

/**
 * Sort options for listing search
 */
export const SortOptionSchema = z.enum([
	"relevance",
	"price_asc",
	"price_desc",
	"popularity",
	"rating",
	"name",
	"trending",
	"hot",
]);
export type SortOption = z.infer<typeof SortOptionSchema>;

// Note: Using standardized PaginationMetaSchema from common schemas
// which includes: limit, offset, total, hasMore

/**
 * Adapter info schema for list response
 */
const AdapterInfoSchema = z.object({
	id: z.string(),
	name: z.string(),
	displayName: z.string().nullable(),
	type: z.string(),
	enabled: z.boolean(),
	priority: z.number(),
	verticals: z.array(z.string()).nullable(),
	hasConfig: z.boolean(),
});

/**
 * Market info schema
 */
const MarketInfoSchema = z.object({
	code: z.string(),
	name: z.string(),
	currency: z.string(),
});

/**
 * Sort option info schema
 */
const SortOptionInfoSchema = z.object({
	value: z.string(),
	label: z.string(),
});

// =============================================================================
// CONTRACT DEFINITION
// =============================================================================

/**
 * Listings contract defining all listing-related endpoints
 *
 * Endpoints:
 * - GET /apps/{appId}/listings/search - Search listings via app's configured adapter
 * - GET /apps/{appId}/listings/adapters - List configured adapters for an app
 * - GET /listings/markets - List supported markets
 */
export const listingsContract = oc.route({ tags: ["listings"] }).router({
	/**
	 * GET /apps/{appId}/listings/search - Search listings via app's configured adapter
	 */
	search: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/listings/search",
			summary: "Search listings",
			description:
				"Search listings via the app's configured adapter (Klarna, Shopify, etc.)",
		})
		.input(
			AppIdParamSchema.extend({
				q: z.string().min(1).max(200).optional(),
				limit: z.coerce.number().min(1).max(100).default(10),
				country: MarketCodeSchema.optional(),
				minPrice: z.coerce.number().min(0).optional(),
				maxPrice: z.coerce.number().min(0).optional(),
				category: z.string().optional(),
				queries: z.array(z.string()).min(1).optional(),
				enrich: z
					.object({
						provider: z.enum(["firecrawl"]).optional(),
						mode: z.enum(["none", "top_n"]).optional(),
						maxItems: z.coerce.number().min(1).max(10).optional(),
						method: z.enum(["extract", "agent"]).optional(),
						timeoutMs: z.coerce.number().min(1000).max(120000).optional(),
						vertical: z.string().optional(),
						priceFormat: z.enum(["german", "english"]).optional(),
					})
					.optional(),
				sort: SortOptionSchema.optional().default("relevance"),
				includeOffers: z.coerce.boolean().optional().default(true),
				priceDrop: z.coerce
					.boolean()
					.optional()
					.describe("Filter to products with active price drops or sales"),
				adapterScope: z
					.union([z.literal("all"), z.literal("primary"), z.array(z.string())])
					.optional()
					.describe(
						"Adapter scope: 'all' for all adapters, 'primary' for primary only, or array of adapter IDs",
					),
				resultStrategy: z
					.enum(["merge", "first_success", "parallel_all"])
					.optional()
					.default("merge")
					.describe(
						"Result strategy: 'merge' combines all results, 'first_success' returns first successful result, 'parallel_all' runs all in parallel",
					),
			}).superRefine((data, ctx) => {
				if (!data.q && (!data.queries || data.queries.length === 0)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"Either 'q' (single query) or 'queries' (batch mode) must be provided",
						path: ["q"],
					});
				}
			}),
		)
		.output(
			z.object({
				data: z.array(LayoutItemSchema),
				query: z.string(),
				source: z.string(),
				market: MarketCodeSchema.optional(),
				pagination: PaginationMetaSchema,
				fallbackUsed: z.boolean().optional(),
				originalError: z.string().optional(),
				error: z.string().optional(),
				warning: z.string().optional(),
				batchMode: z.boolean().optional(),
				listingGroups: z
					.array(
						z.object({
							query: z.string(),
							items: z.array(LayoutItemSchema),
							totalResults: z.number(),
							error: z.string().optional(),
						}),
					)
					.optional(),
			}),
		),

	/**
	 * GET /apps/{appId}/listings/adapters - List configured adapters for an app
	 */
	adapters: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/listings/adapters",
			summary: "List listing adapters",
			description: "List all configured adapters for an app",
		})
		.input(AppIdParamSchema)
		.output(
			z.object({
				data: z.array(AdapterInfoSchema),
				appSlug: z.string(),
			}),
		),

	/**
	 * GET /listings/markets - List supported markets
	 */
	markets: oc
		.route({
			method: "GET",
			path: "/listings/markets",
			summary: "List supported markets",
			description: "List all supported markets and sort options",
		})
		.output(
			z.object({
				markets: z.array(MarketInfoSchema),
				sortOptions: z.array(SortOptionInfoSchema),
			}),
		),
});

export type ListingsContract = typeof listingsContract;
