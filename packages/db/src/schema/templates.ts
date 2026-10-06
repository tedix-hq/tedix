/**
 * App Templates Schema
 * Pre-configured templates for rapid app onboarding
 *
 * Templates provide a starting point for apps to get up and running quickly.
 * Each template defines:
 * - Default capabilities (checkout, cart, etc.)
 * - Pre-configured adapters (Klarna, Shopify, etc.)
 * - Pre-configured MCP tools (search_listings, etc.)
 * - Field mappings for data normalization
 * - Required and optional fields for admin customization
 *
 * RENAMED FROM: brand_templates -> app_templates
 */

import type {
	AppCapabilities,
	Vertical,
} from "@tedix/api-contract/schemas/app";
import type { ExtractionConfigExpanded } from "@tedix/api-contract/schemas/extraction-config";
import type {
	AnyToolConfig,
	ToolAnnotations,
	ToolInputJsonSchema,
	ToolInvocationStatus,
	ToolTypeId,
} from "@tedix/api-contract/schemas/tools";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AdapterConfig, AdapterType } from "./adapters";

// =============================================================================
// TEMPLATE ADAPTER CONFIGURATION
// =============================================================================

/**
 * Template adapter configuration
 * Defines a pre-configured adapter that can be instantiated for an app
 */
export interface TemplateAdapter {
	/** Display name for the adapter (e.g., "Klarna Price Comparison") */
	name: string;

	/** Adapter type - determines which handler to use */
	adapterType: AdapterType;

	/** Type-specific configuration (apiKey, storeDomain, etc.) */
	config?: AdapterConfig;

	/** Field mappings: source API fields -> LayoutItem fields */
	fieldMappings?: Record<string, string>;

	/** Verticals this adapter is suitable for */
	verticals?: Vertical[];

	/** Priority in fallback chain (higher = preferred) */
	priority?: number;

	/** Whether adapter is enabled by default */
	enabled?: boolean;

	/**
	 * Placeholder markers for fields that must be filled by admin
	 * e.g., ["config.apiKey", "config.storeDomain"]
	 */
	requiredPlaceholders?: string[];
}

// =============================================================================
// TEMPLATE TOOL CONFIGURATION
// =============================================================================

/**
 * Template tool configuration
 * Defines a pre-configured MCP tool that can be instantiated for an app
 */
export interface TemplateTool {
	/** MCP tool identifier (e.g., "search_listings") */
	toolId: string;

	/** Display title (e.g., "Search Products") */
	title: string;

	/** Tool description for Apps SDK */
	description?: string;

	/** Tool type reference (determines handler) */
	toolTypeId: ToolTypeId;

	/** MCP input schema (root-object JSON Schema for named arguments) */
	inputSchema?: ToolInputJsonSchema;

	/** Adapter scope: "all", "primary", or specific adapter names */
	adapterScope?: "all" | "primary" | string[];

	/** Result strategy for multi-adapter queries */
	resultStrategy?: "parallel_all" | "first_success" | "merge";

	/** MCP resource URI for output template */
	outputTemplate?: string;

	/** Widget registry key (e.g., "searchListings") */
	widgetKey: import("@tedix/api-contract/schemas/config").WidgetRouteId;

	/** Apps SDK tool visibility */
	visibility?: "public" | "private";

	/** MCP tool annotations */
	annotations?: ToolAnnotations;

	/** Apps SDK tool invocation status strings */
	invocationStatus?: ToolInvocationStatus;

	/** Apps SDK file params */
	fileParams?: string[];

	/** Resource metadata overrides */
	widgetDescription?: string;
	widgetPrefersBorder?: boolean;
	widgetDomain?: string;

	/** Whether widget is accessible via URL */
	widgetAccessible?: boolean;

	/** Tool-type-specific configuration */
	config?: AnyToolConfig;

	/** Display order in tool listings */
	sortOrder?: number;

	/** Whether tool is enabled by default */
	enabled?: boolean;
}

// =============================================================================
// APP TEMPLATES TABLE
// =============================================================================

/**
 * App Templates table
 * Stores pre-configured templates for rapid app onboarding.
 *
 * Templates are versioned to support updates while maintaining
 * backward compatibility for apps created from older versions.
 */
export const appTemplates = sqliteTable("app_templates", {
	// Primary key - UUID generated at insert time
	id: text("id").primaryKey(),

	// Versioning for template updates
	version: integer("version").notNull().default(1),

	// Template identity
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	description: text("description"),

	// Target vertical for this template
	vertical: text("vertical", {
		enum: [
			"ecommerce",
			"marketplace",
			"automotive",
			"real_estate",
			"jobs",
			"travel",
			"crypto",
			"content",
			"services",
		],
	}).notNull(),

	// ==========================================================================
	// TEMPLATE CONFIGURATIONS (JSON columns)
	// ==========================================================================

	/**
	 * Default app capabilities
	 * Checkout, cart, wishlist, compare, map, externalCta configurations
	 */
	capabilities: text("capabilities", { mode: "json" }).$type<AppCapabilities>(),

	/**
	 * Pre-configured adapter templates
	 * Array of TemplateAdapter objects
	 */
	adapters: text("adapters", { mode: "json" }).$type<TemplateAdapter[]>(),

	/**
	 * Pre-configured MCP tool templates
	 * Array of TemplateTool objects
	 */
	tools: text("tools", { mode: "json" }).$type<TemplateTool[]>(),

	/**
	 * Default field mappings for data normalization
	 * Maps source API fields to LayoutItem fields
	 * e.g., { "product_name": "title", "list_price": "price.amount" }
	 */
	fieldMappings: text("field_mappings", { mode: "json" }).$type<
		Record<string, string>
	>(),

	/**
	 * Default extraction configuration for AI agent-based content extraction
	 * Includes JSON schema, prompt, field mappings, normalization rules, quality checks
	 * Uses placeholders like {siteName}, {siteContext}, {siteSearchInstructions}
	 * that get replaced during app creation
	 */
	extractionConfig: text("extraction_config", {
		mode: "json",
	}).$type<ExtractionConfigExpanded>(),

	// ==========================================================================
	// ADMIN FORM CONFIGURATION
	// ==========================================================================

	/**
	 * Required fields that admin must fill in during app creation
	 * e.g., ["name", "primaryDomain", "adapters[0].config.apiKey"]
	 */
	requiredFields: text("required_fields", { mode: "json" }).$type<string[]>(),

	/**
	 * Optional fields that admin can customize during app creation
	 * e.g., ["description", "logoUrl", "capabilities.cart.maxItems"]
	 */
	optionalFields: text("optional_fields", { mode: "json" }).$type<string[]>(),

	// ==========================================================================
	// STATUS & METADATA
	// ==========================================================================

	/** Whether template is active and available for use */
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

	// Timestamps
	createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
});

export type AppTemplate = typeof appTemplates.$inferSelect;
export type NewAppTemplate = typeof appTemplates.$inferInsert;

// =============================================================================
// VERTICAL ENUM VALUES (for validation)
// Imported from @tedix/api-contract - canonical source
// =============================================================================

export { VERTICAL_VALUES } from "@tedix/api-contract/schemas/config";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate a UUID v4 for template IDs
 * Use this at insert time: { id: generateTemplateId(), ... }
 */
export function generateTemplateId(): string {
	return crypto.randomUUID();
}

/**
 * Create a slug from a template name
 * e.g., "E-Commerce Storefront" -> "ecommerce-storefront"
 */
export function createTemplateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
