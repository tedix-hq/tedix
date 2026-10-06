/**
 * Layout Schemas for oRPC Contracts
 * Zod schemas for LayoutItem and related types validation
 *
 * This is the canonical source for LayoutItem types. Use these for API request/response validation.
 *
 * @example
 * ```typescript
 * import { LayoutItemSchema, type LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
 *
 * // Validate API response
 * const validated = LayoutItemSchema.parse(apiResponse);
 * ```
 */

import * as z from "zod";

import {
	BadgeVariantSchema,
	JsonValueSchema,
	StockStatusSchema,
} from "./common";

// =============================================================================
// LAYOUT ITEM OFFER SCHEMA
// =============================================================================

/**
 * Layout item offer schema (for price comparison)
 * Represents a single merchant's offer for a product
 */
export const LayoutItemOfferSchema = z.object({
	merchantId: z.string().optional(),
	merchantName: z.string(),
	merchantLogo: z.string().optional(),
	price: z.number(),
	currency: z.string(),
	url: z.string().optional(),
	shippingCost: z.number().optional(),
	deliveryDays: z.number().optional(),
	stockStatus: StockStatusSchema.optional(),
	verified: z.boolean().optional(),
	paymentMethods: z.array(z.string()).optional(),
});
export type LayoutItemOfferSchemaType = z.infer<typeof LayoutItemOfferSchema>;

// =============================================================================
// LAYOUT ITEM SHIPPING SCHEMA
// =============================================================================

/**
 * Layout item shipping schema
 */
export const LayoutItemShippingSchema = z.object({
	cost: z.number().optional(),
	free: z.boolean().optional(),
	currency: z.string().optional(),
	minDays: z.number().optional(),
	maxDays: z.number().optional(),
	method: z.string().optional(),
});
export type LayoutItemShippingSchemaType = z.infer<
	typeof LayoutItemShippingSchema
>;

// =============================================================================
// LAYOUT ITEM STOCK SCHEMA
// =============================================================================

/**
 * Layout item stock schema
 */
export const LayoutItemStockSchema = z.object({
	status: StockStatusSchema,
	quantity: z.number().optional(),
	lowStockThreshold: z.number().optional(),
});
export type LayoutItemStockSchemaType = z.infer<typeof LayoutItemStockSchema>;

// =============================================================================
// LAYOUT ITEM SAVINGS SCHEMA
// =============================================================================

/**
 * Layout item savings schema (for strikethrough pricing)
 */
export const LayoutItemSavingsSchema = z.object({
	amount: z.number(),
	percentage: z.number(),
	originalPrice: z.number(),
});
export type LayoutItemSavingsSchemaType = z.infer<
	typeof LayoutItemSavingsSchema
>;

// =============================================================================
// LAYOUT ITEM PRICE POINT SCHEMA
// =============================================================================

/**
 * Layout item price point schema (for price history)
 */
export const LayoutItemPricePointSchema = z.object({
	timestamp: z.string(),
	amount: z.number(),
});
export type LayoutItemPricePointSchemaType = z.infer<
	typeof LayoutItemPricePointSchema
>;

// =============================================================================
// LAYOUT ITEM SCHEMA
// =============================================================================

/**
 * LayoutItem schema - canonical definition
 * Universal format across all verticals with metadata escape hatch
 *
 * This IS the canonical source. All apps should import from here.
 */
export const LayoutItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	subtitle: z.string().optional(),
	description: z.string().optional(),
	image: z.string().optional(),
	images: z.array(z.string()).optional(),
	price: z
		.object({
			amount: z.number(),
			currency: z.string(),
			original: z.number().optional(),
			formatted: z.string().optional(),
		})
		.optional(),
	rating: z
		.object({
			value: z.number(),
			count: z.number().optional(),
			max: z.number().optional(),
		})
		.optional(),
	badge: z
		.object({
			text: z.string(),
			variant: BadgeVariantSchema,
		})
		.optional(),
	location: z
		.object({
			lat: z.number().optional(),
			lng: z.number().optional(),
			address: z.string().optional(),
			city: z.string().optional(),
			country: z.string().optional(),
		})
		.optional(),
	seller: z
		.object({
			id: z.string().optional(),
			name: z.string(),
			avatar: z.string().optional(),
			verified: z.boolean().optional(),
			rating: z.number().optional(),
		})
		.optional(),
	features: z
		.array(
			z.object({
				label: z.string(),
				value: z.string(),
				icon: z.string().optional(),
			}),
		)
		.optional(),
	actions: z
		.array(
			z.object({
				label: z.string(),
				action: z.string(),
				primary: z.boolean().optional(),
				icon: z.string().optional(),
			}),
		)
		.optional(),
	url: z.string().optional(),
	// Price comparison fields
	offers: z.array(LayoutItemOfferSchema).optional(),
	shipping: LayoutItemShippingSchema.optional(),
	stock: LayoutItemStockSchema.optional(),
	savings: LayoutItemSavingsSchema.optional(),
	priceHistory: z.array(LayoutItemPricePointSchema).optional(),
	offerCount: z.number().optional(),
	// Metadata escape hatch
	metadata: z.record(z.string(), JsonValueSchema).optional(),
});
export type LayoutItemSchemaType = z.infer<typeof LayoutItemSchema>;
