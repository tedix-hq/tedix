/**
 * App Adapters Schema
 * Configuration for data source adapters (Klarna, Shopify, custom REST APIs, etc.)
 * Enables multi-tenant MCP engine where apps configure their own data sources
 *
 * IMPORTANT: Secrets are NOT stored in adapter config.
 * Secrets are stored in app_secrets/organization_secrets tables and
 * linked via app_adapter_secret_bindings. The AdapterRegistry hydrates
 * secrets at runtime using explicit bindings.
 *
 * RENAMED FROM: brand_adapters -> app_adapters
 */

// Import canonical AdapterType from api-contract to prevent drift
import {
	ADAPTER_TYPES,
	type AdapterType,
} from "@tedix/api-contract/schemas/adapters";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

// Re-export for convenience
export { ADAPTER_TYPES, type AdapterType };

export const appAdapters = sqliteTable(
	"app_adapters",
	{
		id: text("id").primaryKey(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		// Adapter identification
		name: text("name").notNull(), // "klarna", "mobile-de"
		displayName: text("display_name"), // "Klarna Shopping MCP"

		// Adapter type determines which handler to use
		adapterType: text("adapter_type", {
			enum: ["klarna", "shopify", "custom", "webhook", "mcp", "internal"],
		}).notNull(),

		// Type-specific configuration (JSON)
		// NOTE: Secrets are NOT stored here. They are linked via app_adapter_secret_bindings
		// and hydrated at runtime by AdapterRegistry.
		// Structure varies by adapter_type:
		// - klarna: { markets: ["DE", "SE"], defaultMarket, fetchOffers }
		// - shopify: { storeDomain, apiVersion, includeVariants }
		// - custom: { baseUrl, endpoints: { search, detail }, auth: { type, headerName } }
		// - webhook: { webhookUrl, events: ["product.updated"] }
		// - mcp: { serverUrl, toolMap, itemsPath, totalPath }
		// - internal: { endpoint, transport, paramMap, itemsPath, totalPath }
		config: text("config", { mode: "json" }).$type<AdapterConfig>(),

		// Field mappings: Their API fields -> LayoutItem fields (JSON)
		// e.g., { "product_name": "title", "price.amount": "price.amount" }
		fieldMappings: text("field_mappings", { mode: "json" }).$type<
			Record<string, string>
		>(),

		// Verticals this adapter is suitable for (JSON array)
		// e.g., ["automotive", "ecommerce"]
		verticals: text("verticals", { mode: "json" }).$type<string[]>(),

		// Status and ordering
		enabled: integer("enabled", { mode: "boolean" }).default(true),
		priority: integer("priority").default(0), // For fallback chain ordering (higher = preferred)

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_app_adapters_type").on(table.adapterType),
		index("idx_app_adapters_enabled").on(table.appId, table.enabled),
	],
);

export type AppAdapter = typeof appAdapters.$inferSelect;
export type NewAppAdapter = typeof appAdapters.$inferInsert;

// =============================================================================
// ADAPTER CONFIGURATION TYPES
// =============================================================================

/**
 * Base adapter configuration
 */
export interface BaseAdapterConfig {
	/** Optional rate limiting */
	rateLimit?: {
		requestsPerMinute?: number;
		requestsPerHour?: number;
	};
	/** Cache TTL in seconds (0 = no cache) */
	cacheTtl?: number;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Maximum items to return per search (adapter-specific limits still apply as upper bounds) */
	limit?: number;
	/** Retry configuration */
	retry?: {
		maxRetries?: number;
		backoffMs?: number;
	};
}

/**
 * Klarna Shopping MCP adapter configuration
 * Public MCP-backed provider; no direct Klarna backend credential is stored.
 */
export interface KlarnaAdapterConfig extends BaseAdapterConfig {
	/** Supported markets (e.g., ["DE", "SE", "DK"]) */
	markets?: string[];
	/** Default market for searches */
	defaultMarket?: string;
	/** Whether to read offer data when the upstream MCP response includes it */
	fetchOffers?: boolean;
	/** Max products per search */
	maxProducts?: number;
}

/**
 * Shopify Storefront API adapter configuration
 * NOTE: storefrontToken is stored via bindings, not in config
 */
export interface ShopifyAdapterConfig extends BaseAdapterConfig {
	/** Shopify store domain (e.g., "mystore.myshopify.com") - NOT a secret */
	storeDomain: string;
	/** API version (e.g., "2024-01") */
	apiVersion?: string;
	/** Whether to include product variants */
	includeVariants?: boolean;
	/** Collection IDs to include (empty = all) */
	collectionIds?: string[];
}

/**
 * Custom REST API adapter configuration
 * NOTE: Auth credentials (token, username, password, clientId, clientSecret)
 * are stored via bindings, not in config
 */
export interface CustomAdapterConfig extends BaseAdapterConfig {
	/** Base URL for API requests */
	baseUrl: string;
	/** Endpoint paths */
	endpoints?: {
		search?: string; // e.g., "/api/search"
		detail?: string; // e.g., "/api/products/:id"
		categories?: string;
	};
	/** Authentication configuration (credentials via bindings) */
	auth?: {
		type: "none" | "bearer" | "api_key" | "basic" | "oauth2";
		/** Header name for API key auth */
		headerName?: string;
		/** OAuth2 configuration (clientId/clientSecret via bindings) */
		oauth2?: {
			tokenUrl?: string;
			scopes?: string[];
		};
	};
	/** Custom headers to include (non-sensitive only) */
	headers?: Record<string, string>;
	/** Request body format */
	requestFormat?: "json" | "form" | "query";
	/** Response format */
	responseFormat?: "json" | "xml";
	/** Path to items array in response */
	itemsPath?: string; // e.g., "data.products"
	/** Path to total count in response */
	totalPath?: string; // e.g., "meta.total"
}

/**
 * Webhook adapter configuration
 * NOTE: secret for signature verification is stored via bindings, not in config
 */
export interface WebhookAdapterConfig extends BaseAdapterConfig {
	/** Webhook endpoint URL (our endpoint that receives data) */
	webhookUrl?: string;
	/** Events to subscribe to */
	events?: string[]; // e.g., ["product.created", "product.updated"]
	/** Source webhook URL (their endpoint to register with) */
	registrationUrl?: string;
}

/**
 * MCP adapter configuration
 * NOTE: Secrets are stored via bindings, not in config
 */
export interface McpAdapterConfig extends BaseAdapterConfig {
	/** Remote MCP server URL */
	serverUrl: string;
	/** Tool names on the remote MCP server */
	toolMap: {
		search: string;
		categoryRef?: string;
	};
	/** Whether to always call category reference when available */
	categoryRefRequired?: boolean;
	/** Allow search without category reference */
	allowGeneric?: boolean;
	/** Include userText in search args */
	includeUserText?: boolean;
	/** MCP tool input mapping for category reference calls */
	categoryRefInput?: {
		categoryKey?: string;
		categoryHintKey?: string;
		userTextKey?: string;
	};
	/** MCP tool input mapping for search calls */
	searchInput?: {
		queryKey?: string;
		queriesKey?: string;
		useQueries?: boolean;
		userTextKey?: string;
	};
	/** Extra args to merge into search tool call */
	searchArgs?: Record<string, JsonValue>;
	/** Extra args to merge into category reference tool call */
	categoryRefArgs?: Record<string, JsonValue>;
	/** Path to items array in response */
	itemsPath?: string;
	/** Path to total count in response */
	totalPath?: string;
	/** Paths for category reference response fields */
	categoryRefIdPath?: string;
	categoryPath?: string;
	attributesPath?: string;
	/**
	 * Optional auth for MCP servers that require it. `service-binding` proxies
	 * through Tedix's OWN mcp gateway (apps/mcp) over the Cloudflare
	 * MCP_SERVICE binding instead of calling a third-party server directly —
	 * for internal client_credentials/OAuth-gated catalog apps
	 * that are already wired into a tedix-unified aggregate. No secret is
	 * stored in config or bindings; PLATFORM_SERVICE_TOKEN comes from the
	 * Worker env, and the binding itself is the trust boundary.
	 */
	auth?: {
		type: "service-binding";
		/** Organization to scope the call to (sent as X-Tedix-Org-Id) */
		organizationId: string;
		/** Aggregator app slug used to build X-Tedix-Host (e.g. "tedix-unified") */
		mcpSlug: string;
	};
}

/**
 * Internal API adapter configuration
 * NOTE: auth token should be hydrated via bindings into auth.token
 */
export interface InternalAdapterConfig extends BaseAdapterConfig {
	/** Optional override for API base URL */
	baseUrl?: string;
	/** Endpoint path */
	endpoint: string;
	/** Transport style */
	transport?: "rpc" | "rest";
	/** REST method when transport=rest */
	method?: "GET" | "POST";
	/** Optional auth configuration */
	auth?: {
		type: "none" | "bearer" | "api_key";
		headerName?: string;
		token?: string;
	};
	/** Optional static headers */
	headers?: Record<string, string>;
	/** Optional static params merged into each request */
	staticParams?: Record<string, JsonValue>;
	/** Optional mapping from standard param names to endpoint-specific names */
	paramMap?: Record<string, string>;
	/** Path to items array in response */
	itemsPath?: string;
	/** Path to total count in response */
	totalPath?: string;
	/** Path to source in response */
	sourcePath?: string;
	/** Static source label override */
	sourceLabel?: string;
}

/**
 * Union type for all adapter configurations
 */
export type AdapterConfig =
	| KlarnaAdapterConfig
	| ShopifyAdapterConfig
	| CustomAdapterConfig
	| WebhookAdapterConfig
	| McpAdapterConfig
	| InternalAdapterConfig;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Type guard to check if config is Klarna adapter config
 */
export function isKlarnaConfig(
	config: AdapterConfig | null | undefined,
): config is KlarnaAdapterConfig {
	return config !== null && config !== undefined && "markets" in config;
}

/**
 * Type guard to check if config is Shopify adapter config
 */
export function isShopifyConfig(
	config: AdapterConfig | null | undefined,
): config is ShopifyAdapterConfig {
	return config !== null && config !== undefined && "storeDomain" in config;
}

/**
 * Type guard to check if config is Custom adapter config
 */
export function isCustomConfig(
	config: AdapterConfig | null | undefined,
): config is CustomAdapterConfig {
	return (
		config !== null &&
		config !== undefined &&
		"baseUrl" in config &&
		!("endpoint" in config)
	);
}

/**
 * Type guard to check if config is Webhook adapter config
 */
export function isWebhookConfig(
	config: AdapterConfig | null | undefined,
): config is WebhookAdapterConfig {
	return config !== null && config !== undefined && "webhookUrl" in config;
}

/**
 * Type guard to check if config is MCP adapter config
 */
export function isMcpConfig(
	config: AdapterConfig | null | undefined,
): config is McpAdapterConfig {
	return config !== null && config !== undefined && "serverUrl" in config;
}

/**
 * Type guard to check if config is internal adapter config
 */
export function isInternalConfig(
	config: AdapterConfig | null | undefined,
): config is InternalAdapterConfig {
	return config !== null && config !== undefined && "endpoint" in config;
}
