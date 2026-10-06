/**
 * Base Adapter Interface and Types
 *
 * Defines the abstract contract for all data source adapters in the
 * unified multi-tenant MCP engine. Each adapter type (Klarna, Shopify,
 * custom, etc.) implements this interface.
 *
 * @module @tedix/api/adapters/base
 */

import type { AppAdapter } from "@tedix/db/schema/adapters";
import type { AdapterConfig } from "@tedix/db/schema/adapters";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";

// =============================================================================
// SEARCH OPTIONS
// =============================================================================

/**
 * Search options passed to adapter search methods
 * These are normalized from MCP tool inputs
 */
export interface SearchOptions {
	/** Maximum number of results to return */
	limit?: number;
	/** Market/country code (e.g., "DE", "US") */
	country?: string;
	/** Minimum price filter */
	minPrice?: number;
	/** Maximum price filter */
	maxPrice?: number;
	/** Sort order */
	sort?:
		| "relevance"
		| "price_asc"
		| "price_desc"
		| "rating"
		| "popularity"
		| "newest"
		| "name"
		| "trending"
		| "hot";
	/** Category filter */
	category?: string;
	/** Brand/manufacturer filter */
	brand?: string;
	/** Stock availability filter */
	inStock?: boolean;
	/** Pagination offset */
	offset?: number;
	/** Optional OR queries (adapter-specific) */
	queries?: string[];
	/** Include detailed offers (for Klarna-style adapters) */
	includeOffers?: boolean;
	/** Filter to products with active price drops / sales */
	priceDrop?: boolean;
}

// =============================================================================
// ADAPTER RESULT
// =============================================================================

/**
 * Result returned from adapter search operations
 * Provides a unified format for all adapter types
 */
export interface AdapterResult {
	/** Whether the search was successful */
	success: boolean;
	/** Array of items in LayoutItem format */
	items: LayoutItem[];
	/** Source adapter name (e.g., "klarna", "shopify") */
	source: string;
	/** Error message if success is false */
	error?: string;
	/** Error code for programmatic handling */
	errorCode?: string;
	/** Total number of results available (for pagination) */
	totalResults?: number;
	/** Whether there are more results available */
	hasMore?: boolean;
	/** Time taken for the search in milliseconds */
	responseTimeMs?: number;
	/** Metadata about the search (for debugging/analytics) */
	meta?: {
		/** Query that was executed */
		query?: string;
		/** Market that was searched */
		market?: string;
		/** Whether results were cached */
		cached?: boolean;
		/** Cache age in seconds if cached */
		cacheAge?: number;
	};
}

// =============================================================================
// ADAPTER CONTEXT
// =============================================================================

/**
 * Context passed to adapter methods
 * Contains environment bindings and shared resources
 */
export interface AdapterContext {
	/** Environment bindings (URLs, tokens, etc.) */
	env: {
		/** OpenAI API key (for embeddings) */
		OPENAI_API_KEY?: string;
		/** Additional environment variables */
		[key: string]: string | undefined;
	};
	/** Optional request ID for tracing */
	requestId?: string;
	/** Optional abort signal for cancellation */
	signal?: AbortSignal;
}

// =============================================================================
// BASE ADAPTER CLASS
// =============================================================================

/**
 * Abstract base class for all data source adapters
 *
 * Implements the Template Method pattern - subclasses implement
 * the abstract methods for their specific data source.
 *
 * @example
 * ```typescript
 * class KlarnaAdapter extends BaseAdapter {
 *   readonly name = "klarna";
 *
 *   async search(query: string, options: SearchOptions, ctx: AdapterContext) {
 *     // Klarna-specific implementation
 *   }
 * }
 * ```
 */
export abstract class BaseAdapter {
	/** Adapter configuration from D1 database */
	protected readonly adapterConfig: AppAdapter;

	/** Typed config for the specific adapter type */
	protected readonly config: AdapterConfig;

	/**
	 * Create a new adapter instance
	 * @param adapterConfig - Full adapter configuration from D1
	 */
	constructor(adapterConfig: AppAdapter) {
		this.adapterConfig = adapterConfig;
		this.config = adapterConfig.config as AdapterConfig;
	}

	// =========================================================================
	// ABSTRACT PROPERTIES
	// =========================================================================

	/**
	 * Unique name for this adapter type
	 * Used in logging, metrics, and result attribution
	 */
	abstract readonly name: string;

	/**
	 * Human-readable description of the adapter
	 */
	abstract readonly description: string;

	/**
	 * Markets/countries supported by this adapter
	 */
	abstract readonly supportedMarkets: string[];

	// =========================================================================
	// ABSTRACT METHODS
	// =========================================================================

	/**
	 * Search for items matching the query
	 *
	 * This is the primary method that all adapters must implement.
	 * Results should be normalized to LayoutItem format.
	 *
	 * @param query - Search query string
	 * @param options - Search options (limit, filters, etc.)
	 * @param ctx - Adapter context with env bindings
	 * @returns Promise resolving to AdapterResult
	 */
	abstract search(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult>;

	// =========================================================================
	// OPTIONAL METHODS (can be overridden by subclasses)
	// =========================================================================

	/**
	 * Get a single item by ID
	 * Override in subclasses that support detail views
	 *
	 * @param id - Item identifier
	 * @param ctx - Adapter context
	 * @returns Promise resolving to item or null
	 */
	async getById(_id: string, _ctx: AdapterContext): Promise<LayoutItem | null> {
		return null;
	}

	/**
	 * Get multiple items by IDs
	 * Override in subclasses that support batch lookups
	 *
	 * @param ids - Array of item identifiers
	 * @param ctx - Adapter context
	 * @returns Promise resolving to array of items
	 */
	async getByIds(_ids: string[], _ctx: AdapterContext): Promise<LayoutItem[]> {
		return [];
	}

	/**
	 * Get available categories/collections
	 * Override in subclasses that support category browsing
	 *
	 * @param ctx - Adapter context
	 * @returns Promise resolving to category list
	 */
	async getCategories(
		_ctx: AdapterContext,
	): Promise<Array<{ id: string; name: string; count?: number }>> {
		return [];
	}

	/**
	 * Check if the adapter is healthy and can respond to requests
	 * Used for monitoring and fallback decisions
	 *
	 * @param ctx - Adapter context
	 * @returns Promise resolving to health status
	 */
	async healthCheck(
		_ctx: AdapterContext,
	): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
		return { healthy: true };
	}

	// =========================================================================
	// HELPER METHODS
	// =========================================================================

	/**
	 * Get the adapter ID from the config
	 */
	get id(): string {
		return this.adapterConfig.id;
	}

	/**
	 * Get the app ID this adapter belongs to
	 */
	get appId(): string {
		return this.adapterConfig.appId;
	}

	/**
	 * Get the adapter priority (higher = preferred)
	 */
	get priority(): number {
		return this.adapterConfig.priority ?? 0;
	}

	/**
	 * Check if this adapter is enabled
	 */
	get enabled(): boolean {
		return this.adapterConfig.enabled ?? true;
	}

	/**
	 * Get the adapter type
	 */
	get adapterType(): string {
		return this.adapterConfig.adapterType;
	}

	/**
	 * Get the display name for this adapter
	 */
	get displayName(): string {
		return this.adapterConfig.displayName ?? this.name;
	}

	/**
	 * Create an error result
	 * Helper for returning consistent error responses
	 */
	protected createErrorResult(
		error: string,
		errorCode?: string,
		responseTimeMs?: number,
	): AdapterResult {
		return {
			success: false,
			items: [],
			source: this.name,
			error,
			errorCode,
			responseTimeMs,
		};
	}

	/**
	 * Create a success result
	 * Helper for returning consistent success responses
	 */
	protected createSuccessResult(
		items: LayoutItem[],
		options?: {
			totalResults?: number;
			hasMore?: boolean;
			responseTimeMs?: number;
			meta?: AdapterResult["meta"];
		},
	): AdapterResult {
		return {
			success: true,
			items,
			source: this.name,
			totalResults: options?.totalResults ?? items.length,
			hasMore: options?.hasMore ?? false,
			responseTimeMs: options?.responseTimeMs,
			meta: options?.meta,
		};
	}
}
