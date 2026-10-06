import "@orpc/openapi/extensions/route";
/**
 * Items Contract for oRPC
 * Type-safe API contract for Item CRUD endpoints
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	AppIdParamSchema,
	JsonValueSchema,
	PaginationMetaSchema,
} from "../schemas/common";

// =============================================================================
// ITEM-SPECIFIC SCHEMAS
// =============================================================================

/**
 * Item ID parameter schema
 */
export const ItemIdParamSchema = z.object({
	itemId: z.uuid("Item ID must be a valid UUID"),
});

export type ItemIdParam = z.infer<typeof ItemIdParamSchema>;

/**
 * Item input schema (camelCase - consistent with output)
 */
export const ItemInputSchema = z.object({
	id: z.string().optional(),
	externalId: z.string().optional(),
	vertical: z.string(),
	title: z.string(),
	description: z.string().optional(),
	price: z.number().optional(),
	currency: z.string().optional(),
	imageUrl: z.string().optional(),
	url: z.string().optional(),
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export type ItemInput = z.infer<typeof ItemInputSchema>;

/**
 * Item response schema (database format)
 * Must include all fields from items table schema for type safety
 */
export const ItemResponseSchema = z.object({
	id: z.string(),
	appId: z.string(),
	externalId: z.string().nullable(),
	vertical: z.string(),
	title: z.string(),
	subtitle: z.string().nullable(),
	description: z.string().nullable(),
	image: z.string().nullable(),
	images: z.string().nullable(),
	priceAmount: z.number().nullable(),
	priceCurrency: z.string().nullable(),
	priceOriginal: z.number().nullable(),
	priceFormatted: z.string().nullable(),
	ratingValue: z.number().nullable(),
	ratingCount: z.string().nullable(),
	ratingMax: z.number().nullable(),
	badgeText: z.string().nullable(),
	badgeVariant: z.string().nullable(),
	locationLat: z.number().nullable(),
	locationLng: z.number().nullable(),
	locationAddress: z.string().nullable(),
	locationCity: z.string().nullable(),
	locationCountry: z.string().nullable(),
	sellerId: z.string().nullable(),
	sellerName: z.string().nullable(),
	sellerAvatar: z.string().nullable(),
	sellerVerified: z.string().nullable(),
	sellerRating: z.number().nullable(),
	features: z.string().nullable(),
	actions: z.string().nullable(),
	url: z.string().nullable(),
	metadata: JsonValueSchema.nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

export type ItemResponse = z.infer<typeof ItemResponseSchema>;

/** Vertical enum for vector sync (canonical Vertical type; e-commerce is "ecommerce"). */
export const VectorVerticalSchema = z.enum([
	"automotive",
	"marketplace",
	"ecommerce",
	"jobs",
	"real_estate",
	"travel",
	"crypto",
	"services",
	"content",
]);

export type VectorVertical = z.infer<typeof VectorVerticalSchema>;

// =============================================================================
// CONTRACT DEFINITION
// =============================================================================

/**
 * Items Contract - defines the shape of all item-related endpoints
 *
 * All endpoints are org-scoped via JWT context and app-scoped via path parameter
 */
export const itemsContract = oc.route({ tags: ["items"] }).router({
	/**
	 * GET /apps/{appId}/items - List items for an app with pagination
	 */
	list: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/items",
			summary: "List items",
			description: "List all items for an app with pagination",
		})
		.input(
			AppIdParamSchema.extend({
				limit: z.coerce.number().min(1).max(100).default(50),
				offset: z.coerce.number().min(0).default(0),
			}),
		)
		.output(
			z.object({
				data: z.array(ItemResponseSchema),
				pagination: PaginationMetaSchema,
			}),
		),

	/**
	 * GET /apps/{appId}/items/{itemId} - Get a specific item by ID
	 */
	get: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/items/{itemId}",
			summary: "Get item by ID",
			description: "Get detailed information about a specific item",
		})
		.input(AppIdParamSchema.extend(ItemIdParamSchema.shape))
		.output(
			z.object({
				data: ItemResponseSchema,
			}),
		),

	/**
	 * GET /apps/{appId}/items/search - Search items by query
	 */
	search: oc
		.route({
			method: "GET",
			path: "/apps/{appId}/items/search",
			summary: "Search items",
			description: "Search items by query string",
		})
		.input(
			AppIdParamSchema.extend({
				q: z.string().min(1, "Search query is required"),
				limit: z.coerce.number().min(1).max(100).default(20),
			}),
		)
		.output(
			z.object({
				data: z.array(ItemResponseSchema),
				query: z.string(),
				pagination: PaginationMetaSchema,
			}),
		),

	/**
	 * POST /apps/{appId}/items - Create/upsert items
	 */
	create: oc
		.route({
			method: "POST",
			path: "/apps/{appId}/items",
			summary: "Create or upsert items",
			description: "Create new items or update existing items by ID",
			successStatus: 201,
		})
		.input(
			AppIdParamSchema.extend({
				items: z.array(ItemInputSchema),
			}),
		)
		.output(
			z.object({
				data: z.object({
					inserted: z.number(),
					updated: z.number(),
					errors: z.array(z.string()),
				}),
			}),
		),

	/**
	 * DELETE /apps/{appId}/items - Delete all items for an app
	 */
	deleteAll: oc
		.route({
			method: "DELETE",
			path: "/apps/{appId}/items",
			summary: "Delete all items",
			description: "Delete all items for an app",
		})
		.input(AppIdParamSchema)
		.output(
			z.object({
				message: z.string(),
				count: z.number(),
			}),
		),

	/**
	 * DELETE /apps/{appId}/items/{itemId} - Delete a specific item
	 */
	delete: oc
		.route({
			method: "DELETE",
			path: "/apps/{appId}/items/{itemId}",
			summary: "Delete item",
			description: "Delete a specific item by ID",
		})
		.input(AppIdParamSchema.extend(ItemIdParamSchema.shape))
		.output(
			z.object({
				message: z.string(),
				deletedId: z.string(),
			}),
		),

	/**
	 * POST /apps/{appId}/items/import - Start import workflow (internal only)
	 *
	 * Starts a Cloudflare Workflow for durable item import processing.
	 * The workflow handles:
	 * 1. Parse items from data using arrayKey
	 * 2. Normalize items (field mapping, SKU generation, image normalization)
	 * 3. Convert to DB format with toItemInsert()
	 * 4. Upsert to database (idempotent via externalId)
	 * 5. Generate quality report
	 *
	 * Auth: Requires apps:write scope and app ownership
	 * Rate limit: Max 500 items per request
	 *
	 * @internal - Not exposed via OpenAPI/REST
	 */
	import: oc
		.route({
			method: "POST",
			path: "/apps/{appId}/items/import",
			summary: "Start import workflow",
			description:
				"Start a Cloudflare Workflow to import raw extraction data (e.g., from Firecrawl) through normalization pipeline",
			successStatus: 202,
			tags: ["internal"],
		})
		.input(
			AppIdParamSchema.extend({
				/** Raw extraction data object containing the items array */
				data: z.record(z.string(), JsonValueSchema),
				/** Key in data object containing the items array (e.g., "vehicles", "products") */
				arrayKey: z.string().min(1),
				/** Vertical for item processing */
				vertical: VectorVerticalSchema,
				/** Source URL for item attribution */
				sourceUrl: z.url().optional(),
				/** Optional field mappings override */
				fieldMappings: z.record(z.string(), z.array(z.string())).optional(),
				/** Max items to import (default 500, max 500) */
				limit: z.coerce.number().min(1).max(500).default(500),
				/** Dry run mode - validate and return quality report without writing */
				dryRun: z.boolean().default(false),
			}),
		)
		.output(
			z.object({
				/** Workflow instance ID for status tracking */
				workflowId: z.string(),
				/** User-friendly message */
				message: z.string(),
				/** Initial workflow status */
				status: z.literal("queued"),
			}),
		),
});

export type ItemsContract = typeof itemsContract;
