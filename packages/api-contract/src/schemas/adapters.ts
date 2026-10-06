/**
 * Adapter Schemas for oRPC Contracts
 * Zod schemas for Adapter entity validation
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

// =============================================================================
// ADAPTER TYPE ENUM
// =============================================================================

/**
 * Adapter types supported by the platform
 * - klarna: Klarna Shopping MCP integration
 * - shopify: Shopify Storefront API integration
 * - custom: Custom REST API with configurable endpoints
 * - webhook: Webhook-based data ingestion
 */
export const AdapterTypeSchema = z.enum([
	"klarna",
	"shopify",
	"custom",
	"webhook",
	"mcp",
	"internal",
]);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

export const ADAPTER_TYPES = [
	"klarna",
	"shopify",
	"custom",
	"webhook",
	"mcp",
	"internal",
] as const;

// =============================================================================
// ADAPTER CONFIGURATION SCHEMAS
// =============================================================================

/**
 * Base adapter configuration
 */
export const BaseAdapterConfigSchema = z.object({
	rateLimit: z
		.object({
			requestsPerMinute: z.number().optional(),
			requestsPerHour: z.number().optional(),
		})
		.optional(),
	cacheTtl: z.number().optional(),
	timeout: z.number().optional(),
	limit: z.number().optional(),
	retry: z
		.object({
			maxRetries: z.number().optional(),
			backoffMs: z.number().optional(),
		})
		.optional(),
});
export type BaseAdapterConfig = z.infer<typeof BaseAdapterConfigSchema>;

/**
 * Klarna Shopping MCP adapter configuration
 *
 * Public MCP-backed provider; no direct Klarna backend credential is stored.
 */
export const KlarnaAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	markets: z.array(z.string()).optional(),
	defaultMarket: z.string().optional(),
	fetchOffers: z.boolean().optional(),
	maxProducts: z.number().optional(),
});
export type KlarnaAdapterConfig = z.infer<typeof KlarnaAdapterConfigSchema>;

/**
 * Shopify Storefront API adapter configuration
 *
 * NOTE: storefrontToken has been removed - use the bindings system instead.
 * Secrets should be stored via app_adapter_secret_bindings table.
 */
export const ShopifyAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	storeDomain: z.string(),
	apiVersion: z.string().optional(),
	includeVariants: z.boolean().optional(),
	collectionIds: z.array(z.string()).optional(),
});
export type ShopifyAdapterConfig = z.infer<typeof ShopifyAdapterConfigSchema>;

/**
 * Custom REST API adapter configuration
 *
 * NOTE: Sensitive auth fields (token, username, password, clientId, clientSecret)
 * have been removed - use the bindings system instead.
 * Secrets should be stored via app_adapter_secret_bindings table.
 */
export const CustomAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	baseUrl: z.string(),
	endpoints: z
		.object({
			search: z.string().optional(),
			detail: z.string().optional(),
			categories: z.string().optional(),
		})
		.optional(),
	auth: z
		.object({
			type: z.enum(["none", "bearer", "api_key", "basic", "oauth2"]),
			headerName: z.string().optional(),
			// NOTE: token, username, password removed - use bindings
			oauth2: z
				.object({
					// NOTE: clientId, clientSecret removed - use bindings
					tokenUrl: z.string().optional(),
					scopes: z.array(z.string()).optional(),
				})
				.optional(),
		})
		.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	requestFormat: z.enum(["json", "form", "query"]).optional(),
	responseFormat: z.enum(["json", "xml"]).optional(),
	itemsPath: z.string().optional(),
	totalPath: z.string().optional(),
});
export type CustomAdapterConfig = z.infer<typeof CustomAdapterConfigSchema>;

/**
 * Webhook adapter configuration
 *
 * NOTE: secret has been removed - use the bindings system instead.
 * The webhook secret should be stored via app_adapter_secret_bindings table.
 */
export const WebhookAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	webhookUrl: z.string().optional(),
	events: z.array(z.string()).optional(),
	registrationUrl: z.string().optional(),
});
export type WebhookAdapterConfig = z.infer<typeof WebhookAdapterConfigSchema>;

/**
 * MCP adapter configuration (external MCP server as data source)
 */
export const McpAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	/** Remote MCP server URL (e.g., https://gateway.kleinanzeigen.de/openai-app/mcp) */
	serverUrl: z.url(),
	/** Tool names on the remote MCP server */
	toolMap: z.object({
		search: z.string().min(1),
		categoryRef: z.string().min(1).optional(),
	}),
	/** Whether to always call category reference when available */
	categoryRefRequired: z.boolean().optional(),
	/** If true, include allowGeneric=true in search args */
	allowGeneric: z.boolean().optional(),
	/** Include userText verbatim in search args */
	includeUserText: z.boolean().optional(),
	/** MCP tool input mapping for category reference calls */
	categoryRefInput: z
		.object({
			categoryKey: z.string().min(1).optional(),
			categoryHintKey: z.string().min(1).optional(),
			userTextKey: z.string().min(1).optional(),
		})
		.optional(),
	/** MCP tool input mapping for search calls */
	searchInput: z
		.object({
			queryKey: z.string().min(1).optional(),
			queriesKey: z.string().min(1).optional(),
			useQueries: z.boolean().optional(),
			userTextKey: z.string().min(1).optional(),
		})
		.optional(),
	/** Extra args to merge into search tool call */
	searchArgs: z.record(z.string(), JsonValueSchema).optional(),
	/** Extra args to merge into category reference tool call */
	categoryRefArgs: z.record(z.string(), JsonValueSchema).optional(),
	/** Path to items array in structured response (e.g., "items", "data.results") */
	itemsPath: z.string().optional(),
	/** Path to total count in structured response (e.g., "totalResults") */
	totalPath: z.string().optional(),
	/** Paths to extract category reference values (defaults are top-level keys) */
	categoryRefIdPath: z.string().optional(),
	categoryPath: z.string().optional(),
	attributesPath: z.string().optional(),
	/**
	 * Optional auth for MCP servers that require it. `service-binding` routes
	 * through Tedix's own mcp gateway over the Cloudflare MCP_SERVICE binding
	 * instead of calling serverUrl directly — for internal aggregate entries
	 * already gated by their own auth (e.g. a client_credentials-backed
	 * catalog app). No secret is stored in config or bindings.
	 */
	auth: z
		.object({
			type: z.literal("service-binding"),
			organizationId: z.string().min(1),
			mcpSlug: z.string().min(1),
		})
		.optional(),
});
export type McpAdapterConfig = z.infer<typeof McpAdapterConfigSchema>;

/**
 * Internal API adapter configuration
 * Uses Tedix API RPC/REST endpoints as an adapter data source.
 */
export const InternalAdapterConfigSchema = BaseAdapterConfigSchema.extend({
	/** Optional override for API base URL (defaults to env.API_URL at runtime) */
	baseUrl: z.url().optional(),
	/** Endpoint path (e.g., "/rpc/catalog/apps" or "/catalog/apps") */
	endpoint: z.string().min(1),
	/** Transport style for endpoint invocation */
	transport: z.enum(["rpc", "rest"]).optional(),
	/** REST method when transport=rest (GET default, POST optional) */
	method: z.enum(["GET", "POST"]).optional(),
	/** Auth config (token is hydrated from secret bindings at runtime) */
	auth: z
		.object({
			type: z.enum(["none", "bearer", "api_key"]).default("none"),
			headerName: z.string().optional(),
			token: z.string().optional(),
		})
		.optional(),
	/** Static headers for all requests (non-sensitive) */
	headers: z.record(z.string(), z.string()).optional(),
	/** Static params merged into each request */
	staticParams: z.record(z.string(), JsonValueSchema).optional(),
	/** Optional param-name mapping (e.g., { q: "query" }) */
	paramMap: z.record(z.string(), z.string()).optional(),
	/** Path to items array in response */
	itemsPath: z.string().optional(),
	/** Path to total count in response */
	totalPath: z.string().optional(),
	/** Path to source label in response */
	sourcePath: z.string().optional(),
	/** Optional static source label override */
	sourceLabel: z.string().optional(),
});
export type InternalAdapterConfig = z.infer<typeof InternalAdapterConfigSchema>;

/**
 * Union type for all adapter configurations
 */
export const AdapterConfigSchema = z.union([
	KlarnaAdapterConfigSchema,
	ShopifyAdapterConfigSchema,
	CustomAdapterConfigSchema,
	WebhookAdapterConfigSchema,
	McpAdapterConfigSchema,
	InternalAdapterConfigSchema,
]);
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

// =============================================================================
// APP ADAPTER SCHEMA
// =============================================================================

/**
 * Full App Adapter schema (response)
 */
export const AppAdapterSchema = z.object({
	id: z.string(),
	appId: z.string(),
	name: z.string(),
	displayName: z.string().nullable(),
	adapterType: AdapterTypeSchema,
	config: AdapterConfigSchema.nullable(),
	fieldMappings: z.record(z.string(), z.string()).nullable(),
	verticals: z.array(z.string()).nullable(),
	enabled: z.boolean().nullable(),
	priority: z.number().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type AppAdapter = z.infer<typeof AppAdapterSchema>;
