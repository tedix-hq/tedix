/**
 * Widget Configuration Schemas
 * Controls layout, features, and localization for app widgets
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// WIDGET STRINGS SCHEMA
// =============================================================================

/**
 * Widget UI strings configuration
 * Enables per-app localization without code changes
 */
export const WidgetStringsSchema = z.object({
	freeShipping: z.string().optional(),
	inStock: z.string().optional(),
	topRated: z.string().optional(),
	clearAll: z.string().optional(),
	emptyTitle: z.string().optional(),
	emptyDescription: z.string().optional(),
	errorTitle: z.string().optional(),
	retryButton: z.string().optional(),
	addToCart: z.string().optional(),
	viewDetails: z.string().optional(),
	loadMore: z.string().optional(),
	compareNow: z.string().optional(),
	viewAll: z.string().optional(),
	backToResults: z.string().optional(),
	cartTitle: z.string().optional(),
	checkout: z.string().optional(),
	continueShopping: z.string().optional(),
	remove: z.string().optional(),
	selectedForComparison: z.string().optional(),
	bestPrice: z.string().optional(),
	comparingItems: z.string().optional(),
	askAIToCompare: z.string().optional(),
	noItemsSelected: z.string().optional(),
	clear: z.string().optional(),
});
export type WidgetStrings = z.infer<typeof WidgetStringsSchema>;

// =============================================================================
// WIDGET GRID CONFIG SCHEMA
// =============================================================================

/**
 * Widget grid configuration
 * Controls product grid layout defaults
 */
export const WidgetGridConfigSchema = z.object({
	columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
	gap: z.enum(["sm", "md", "lg"]).optional(),
	maxRowsInline: z.number().optional(),
	maxRowsFullscreen: z.number().optional(),
});
export type WidgetGridConfig = z.infer<typeof WidgetGridConfigSchema>;

/** Closed MCP Apps sandbox capabilities requested by one tool UI resource. */
export const McpAppPermissionsSchema = z
	.object({
		camera: z
			.object({})
			.strict()
			.optional()
			.describe("Absent unless this tool explicitly requests camera access."),
		microphone: z
			.object({})
			.strict()
			.optional()
			.describe(
				"Absent unless this tool explicitly requests microphone access.",
			),
		geolocation: z
			.object({})
			.strict()
			.optional()
			.describe("Absent unless this tool explicitly requests location access."),
		clipboardWrite: z
			.object({})
			.strict()
			.optional()
			.describe(
				"Absent unless this tool explicitly requests clipboard write access.",
			),
	})
	.strict();
export type McpAppPermissions = z.infer<typeof McpAppPermissionsSchema>;

// =============================================================================
// WIDGET CONFIG SCHEMA
// =============================================================================

/**
 * Widget configuration
 * Controls layout and features for app widgets
 */
export const WidgetConfigSchema = z.object({
	/** View configurations */
	views: z
		.object({
			browse: z
				.object({
					type: z.enum(["grid", "list", "map"]).optional(),
					columns: z.number().optional(),
					itemsPerPage: z.number().optional(),
					enableFilters: z.boolean().optional(),
					enableSort: z.boolean().optional(),
				})
				.optional(),
			detail: z
				.object({
					showReviews: z.boolean().optional(),
					showRelated: z.boolean().optional(),
					showSimilar: z.boolean().optional(),
					showSpecs: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),

	/** Feature toggles */
	features: z
		.object({
			cart: z
				.object({
					enabled: z.boolean().optional(),
					persistent: z.boolean().optional(),
					maxItems: z.number().optional(),
				})
				.optional(),
			checkout: z
				.object({
					enabled: z.boolean().optional(),
					steps: z
						.array(z.enum(["cart", "shipping", "payment", "confirmation"]))
						.optional(),
					requiresAuth: z.boolean().optional(),
				})
				.optional(),
			compare: z
				.object({
					enabled: z.boolean().optional(),
					maxItems: z.number().optional(),
				})
				.optional(),
			wishlist: z
				.object({
					enabled: z.boolean().optional(),
					requiresAuth: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),

	/** Component slot overrides */
	slots: z.record(z.string(), z.string()).optional(),

	/** Additional props for customization */
	props: z.record(z.string(), JsonValueSchema).optional(),

	/** Default currency code (ISO 4217) - e.g., "EUR", "USD", "GBP" */
	defaultCurrency: z.string().optional(),

	/** Default locale (BCP 47) - e.g., "de-DE", "en-US" */
	defaultLocale: z.string().optional(),

	/** Configurable UI strings for localization */
	strings: WidgetStringsSchema.optional(),

	/** Grid layout configuration for product grids */
	gridConfig: WidgetGridConfigSchema.optional(),
});
export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;
