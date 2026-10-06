/**
 * Custom REST API Adapter
 *
 * Generic adapter for connecting to custom REST APIs with configurable
 * authentication and response transformation. Supports apps that have
 * their own APIs (like a marketplace or exchange).
 *
 * Features:
 * - Multiple authentication methods (bearer, api_key, basic, oauth2)
 * - JSONPath-like field mappings for response transformation
 * - Configurable endpoints for search, detail, categories
 * - Pagination support
 * - Request/response timeout handling
 *
 * @module @tedix/api/adapters/custom
 */

import { isUnsafePathSegment } from "@tedix/api-contract/schemas/adapter-bindings";
import type {
	AppAdapter,
	CustomAdapterConfig,
} from "@tedix/db/schema/adapters";
import { isCustomConfig } from "@tedix/db/schema/adapters";
import type {
	BadgeVariant,
	StockStatus,
} from "@tedix/api-contract/schemas/common";
import type {
	LayoutItemSchemaType as LayoutItem,
	LayoutItemOfferSchemaType as LayoutItemOffer,
	LayoutItemStockSchemaType as LayoutItemStock,
} from "@tedix/api-contract/schemas/layout";
import {
	type AdapterContext,
	type AdapterResult,
	BaseAdapter,
	type SearchOptions,
} from "./base";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default request timeout in ms */
const DEFAULT_TIMEOUT = 15000;

/** Default items limit per request */
const DEFAULT_LIMIT = 20;

// =============================================================================
// FIELD MAPPING TYPES
// =============================================================================

/**
 * Field mappings configuration for transforming API responses to LayoutItem
 * Stored in app_adapters.field_mappings column
 *
 * Keys are LayoutItem field paths, values are JSONPath-like source paths
 *
 * @example
 * {
 *   "id": "data.id",
 *   "title": "data.name",
 *   "price.amount": "data.price.value",
 *   "price.currency": "data.price.currency",
 *   "image": "data.images[0].url"
 * }
 */
export type FieldMappings = Record<string, string>;

// =============================================================================
// JSONPATH UTILITIES
// =============================================================================

/**
 * Extract a value from an object using a JSONPath-like path
 *
 * Supported path formats:
 * - "field" - Simple property access
 * - "parent.child" - Nested property access
 * - "array[0]" - Array index access
 * - "parent.array[0].field" - Combined access
 *
 * @param obj - Source object to extract from
 * @param path - JSONPath-like path string
 * @returns Extracted value or undefined
 *
 * @example
 * const data = { user: { name: "John", tags: ["a", "b"] } };
 * getByPath(data, "user.name"); // "John"
 * getByPath(data, "user.tags[1]"); // "b"
 */
function getByPath(obj: unknown, path: string): unknown {
	if (!obj || typeof obj !== "object" || !path) {
		return undefined;
	}

	// Split path by dots and brackets
	// "data.items[0].name" -> ["data", "items", "0", "name"]
	const segments = path
		.replace(/\[(\d+)\]/g, ".$1") // Convert [0] to .0
		.split(".")
		.filter(Boolean);

	let current: unknown = obj;

	for (const segment of segments) {
		if (current === null || current === undefined) {
			return undefined;
		}

		if (typeof current !== "object") {
			return undefined;
		}

		// Handle array index
		if (/^\d+$/.test(segment)) {
			if (!Array.isArray(current)) {
				return undefined;
			}
			current = current[Number.parseInt(segment, 10)];
		} else {
			// Handle object property
			current = (current as Record<string, unknown>)[segment];
		}
	}

	return current;
}

/**
 * Set a value in an object using a JSONPath-like path
 * Creates intermediate objects/arrays as needed
 *
 * @param obj - Target object to modify
 * @param path - JSONPath-like path string
 * @param value - Value to set
 *
 * @example
 * const data = {};
 * setByPath(data, "price.amount", 99.99);
 * // data = { price: { amount: 99.99 } }
 */
function setByPath(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	if (!path || value === undefined || value === null) {
		return;
	}

	const segments = path.split(".").filter(Boolean);
	if (segments.some(isUnsafePathSegment)) return;
	let current: Record<string, unknown> = obj;

	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (segment === undefined) continue;

		if (!(segment in current) || typeof current[segment] !== "object") {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}

	const lastSegment = segments[segments.length - 1];
	if (lastSegment) {
		current[lastSegment] = value;
	}
}

// =============================================================================
// CUSTOM ADAPTER
// =============================================================================

/**
 * Custom REST API Adapter Implementation
 *
 * Connects to any REST API with configurable authentication and field mappings.
 * Transforms API responses to LayoutItem format for unified widget rendering.
 *
 * @example
 * ```typescript
 * // D1 adapter config:
 * {
 *   adapterType: "custom",
 *   config: {
 *     baseUrl: "https://api.example.com",
 *     endpoints: { search: "/v1/listings/search" },
 *     auth: { type: "bearer", token: "xxx" },
 *     itemsPath: "data.results",
 *     totalPath: "meta.total"
 *   }
 * }
 *
 * // D1 field_mappings:
 * {
 *   "id": "listing_id",
 *   "title": "listing_name",
 *   "price.amount": "pricing.value",
 *   "price.currency": "pricing.currency"
 * }
 * ```
 */
export class CustomAdapter extends BaseAdapter {
	readonly name = "custom";
	readonly description = "Custom REST API integration";
	readonly supportedMarkets: string[] = [];

	/** Typed Custom-specific configuration */
	private readonly customConfig: CustomAdapterConfig;

	/** Field mappings from D1 */
	private readonly fieldMappings: FieldMappings;

	constructor(adapterConfig: AppAdapter) {
		super(adapterConfig);

		if (!isCustomConfig(adapterConfig.config)) {
			throw new Error("Invalid Custom adapter configuration");
		}

		this.customConfig = adapterConfig.config;
		this.fieldMappings = (adapterConfig.fieldMappings as FieldMappings) ?? {};
	}

	/**
	 * Search for items via the custom REST API
	 */
	async search(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		// Validate configuration
		if (!this.customConfig.baseUrl) {
			return this.createErrorResult(
				"Custom adapter baseUrl not configured",
				"missing_base_url",
			);
		}

		const searchEndpoint = this.customConfig.endpoints?.search;
		if (!searchEndpoint) {
			return this.createErrorResult(
				"Custom adapter search endpoint not configured",
				"missing_search_endpoint",
			);
		}

		try {
			// Build request URL
			const url = this.buildSearchUrl(query, options);

			// Build request headers
			const headers = await this.buildHeaders(ctx);

			// Make request
			const response = await this.makeRequest(url, {
				method: "GET",
				headers,
				timeout: this.customConfig.timeout ?? DEFAULT_TIMEOUT,
				signal: ctx.signal,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "Unknown error");
				return this.createErrorResult(
					`API error: ${response.status} - ${errorText}`,
					`http_${response.status}`,
					Date.now() - startTime,
				);
			}

			// Parse response
			const data = await this.parseResponse(response);

			// Extract items array from response
			const itemsPath = this.customConfig.itemsPath ?? "data";
			const rawItems = getByPath(data, itemsPath);

			if (!Array.isArray(rawItems)) {
				return this.createSuccessResult([], {
					totalResults: 0,
					hasMore: false,
					responseTimeMs: Date.now() - startTime,
					meta: { query, cached: false },
				});
			}

			// Transform items to LayoutItem format
			const items = rawItems
				.map((rawItem) => this.transformToLayoutItem(rawItem))
				.filter((item): item is LayoutItem => item !== null);

			// Extract total count if configured
			const totalPath = this.customConfig.totalPath;
			const totalResults = totalPath
				? ((getByPath(data, totalPath) as number) ?? items.length)
				: items.length;

			// Priority: options.limit → config.limit → fallback to DEFAULT_LIMIT
			const limit = options.limit ?? this.customConfig.limit ?? DEFAULT_LIMIT;
			const offset = options.offset ?? 0;

			return this.createSuccessResult(items, {
				totalResults,
				hasMore: totalResults > offset + items.length,
				responseTimeMs: Date.now() - startTime,
				meta: { query, cached: false },
			});
		} catch (error) {
			return this.createErrorResult(
				error instanceof Error ? error.message : "Unknown error",
				"request_failed",
				Date.now() - startTime,
			);
		}
	}

	/**
	 * Get a single item by ID
	 */
	async getById(id: string, ctx: AdapterContext): Promise<LayoutItem | null> {
		if (!this.customConfig.baseUrl) {
			return null;
		}

		const detailEndpoint = this.customConfig.endpoints?.detail;
		if (!detailEndpoint) {
			return null;
		}

		try {
			// Build URL with ID placeholder replacement
			const path = detailEndpoint.replace(":id", id).replace("{id}", id);
			const url = new URL(path, this.customConfig.baseUrl);

			const headers = await this.buildHeaders(ctx);

			const response = await this.makeRequest(url.toString(), {
				method: "GET",
				headers,
				timeout: this.customConfig.timeout ?? DEFAULT_TIMEOUT,
				signal: ctx.signal,
			});

			if (!response.ok) {
				return null;
			}

			const data = await this.parseResponse(response);

			// For detail endpoint, the response might be the item directly
			// or wrapped in a data object
			const rawItem =
				this.customConfig.itemsPath && typeof data === "object" && data !== null
					? getByPath(data, this.customConfig.itemsPath)
					: data;

			return this.transformToLayoutItem(rawItem);
		} catch {
			return null;
		}
	}

	/**
	 * Get available categories
	 */
	async getCategories(
		ctx: AdapterContext,
	): Promise<Array<{ id: string; name: string; count?: number }>> {
		const categoriesEndpoint = this.customConfig.endpoints?.categories;
		if (!this.customConfig.baseUrl || !categoriesEndpoint) {
			return [];
		}

		try {
			const url = new URL(categoriesEndpoint, this.customConfig.baseUrl);
			const headers = await this.buildHeaders(ctx);

			const response = await this.makeRequest(url.toString(), {
				method: "GET",
				headers,
				timeout: this.customConfig.timeout ?? DEFAULT_TIMEOUT,
				signal: ctx.signal,
			});

			if (!response.ok) {
				return [];
			}

			const data = await this.parseResponse(response);

			// Try to extract categories from response
			const rawCategories = Array.isArray(data)
				? data
				: ((getByPath(data, "data") as unknown[]) ??
					(getByPath(data, "categories") as unknown[]) ??
					[]);

			if (!Array.isArray(rawCategories)) {
				return [];
			}

			const categories: Array<{ id: string; name: string; count?: number }> =
				[];

			for (const cat of rawCategories) {
				if (typeof cat === "object" && cat !== null) {
					const catObj = cat as Record<string, unknown>;
					const id = String(catObj.id ?? catObj._id ?? "");
					const name = String(catObj.name ?? catObj.title ?? "");
					if (id && name) {
						categories.push({
							id,
							name,
							count:
								typeof catObj.count === "number" ? catObj.count : undefined,
						});
					}
				}
			}

			return categories;
		} catch {
			return [];
		}
	}

	/**
	 * Health check - verify API connectivity
	 */
	async healthCheck(ctx: AdapterContext): Promise<{
		healthy: boolean;
		latencyMs?: number;
		error?: string;
	}> {
		const startTime = Date.now();

		if (!this.customConfig.baseUrl) {
			return { healthy: false, error: "Base URL not configured" };
		}

		try {
			// Try a simple search or categories request
			const endpoint =
				this.customConfig.endpoints?.categories ??
				this.customConfig.endpoints?.search;
			if (!endpoint) {
				return { healthy: false, error: "No endpoints configured" };
			}

			let url: URL;
			if (endpoint === this.customConfig.endpoints?.search) {
				// For search endpoint, add a minimal query
				url = new URL(endpoint, this.customConfig.baseUrl);
				url.searchParams.set("q", "test");
				url.searchParams.set("limit", "1");
			} else {
				url = new URL(endpoint, this.customConfig.baseUrl);
			}

			const headers = await this.buildHeaders(ctx);

			const response = await this.makeRequest(url.toString(), {
				method: "GET",
				headers,
				timeout: 5000,
				signal: ctx.signal,
			});

			return {
				healthy: response.ok,
				latencyMs: Date.now() - startTime,
				error: response.ok ? undefined : `HTTP ${response.status}`,
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - startTime,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	// =========================================================================
	// PRIVATE METHODS
	// =========================================================================

	/**
	 * Build the search URL with query parameters
	 */
	private buildSearchUrl(query: string, options: SearchOptions): string {
		const searchEndpoint = this.customConfig.endpoints?.search ?? "/search";
		const url = new URL(searchEndpoint, this.customConfig.baseUrl);

		// Add query parameter
		// Common parameter names used by different APIs
		url.searchParams.set("q", query);

		// Add pagination
		// Priority: options.limit → config.limit → fallback to DEFAULT_LIMIT
		const limit = options.limit ?? this.customConfig.limit ?? DEFAULT_LIMIT;
		url.searchParams.set("limit", String(limit));

		if (options.offset !== undefined) {
			url.searchParams.set("offset", String(options.offset));
		}

		// Add filters
		if (options.minPrice !== undefined) {
			url.searchParams.set("minPrice", String(options.minPrice));
		}
		if (options.maxPrice !== undefined) {
			url.searchParams.set("maxPrice", String(options.maxPrice));
		}
		if (options.category) {
			url.searchParams.set("category", options.category);
		}
		if (options.brand) {
			url.searchParams.set("brand", options.brand);
		}
		if (options.inStock !== undefined) {
			url.searchParams.set("inStock", String(options.inStock));
		}

		// Add sort
		if (options.sort) {
			url.searchParams.set("sort", options.sort);
		}

		return url.toString();
	}

	/**
	 * Build request headers with authentication
	 *
	 * NOTE: Auth credentials (token, username, password, oauth2.clientId, oauth2.clientSecret)
	 * are now injected via the adapter bindings system. The registry hydrates these values
	 * from app_secrets into the config at runtime.
	 */
	private async buildHeaders(
		_ctx: AdapterContext,
	): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
		};

		// Add custom headers from config
		if (this.customConfig.headers) {
			Object.assign(headers, this.customConfig.headers);
		}

		// Add authentication
		// NOTE: Auth credentials are hydrated from bindings by the registry
		const auth = this.customConfig.auth as
			| (Record<string, unknown> & { type?: string; headerName?: string })
			| undefined;
		if (auth) {
			// Get credentials from runtime-hydrated config
			const token = auth.token as string | undefined;
			const username = auth.username as string | undefined;
			const password = auth.password as string | undefined;
			const oauth2 = auth.oauth2 as Record<string, unknown> | undefined;

			switch (auth.type) {
				case "bearer":
					if (token) {
						headers["Authorization"] = `Bearer ${token}`;
					}
					break;

				case "api_key":
					if (token) {
						const headerName = auth.headerName ?? "X-API-Key";
						headers[headerName] = token;
					}
					break;

				case "basic":
					if (username && password) {
						const credentials = btoa(`${username}:${password}`);
						headers["Authorization"] = `Basic ${credentials}`;
					}
					break;

				case "oauth2":
					// OAuth2 token should be pre-fetched and stored in auth.token
					// Token refresh logic would be implemented separately
					if (oauth2 && token) {
						headers["Authorization"] = `Bearer ${token}`;
					}
					break;

				case "none":
				default:
					// No authentication
					break;
			}
		}

		return headers;
	}

	/**
	 * Make an HTTP request with timeout handling
	 */
	private async makeRequest(
		url: string,
		options: {
			method: "GET" | "POST" | "PUT" | "DELETE";
			headers: Record<string, string>;
			body?: string;
			timeout: number;
			signal?: AbortSignal;
		},
	): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), options.timeout);

		// Combine signals if external signal provided
		const signal = options.signal
			? this.combineSignals(options.signal, controller.signal)
			: controller.signal;

		try {
			const response = await fetch(url, {
				method: options.method,
				headers: options.headers,
				body: options.body,
				signal,
			});

			clearTimeout(timeoutId);
			return response;
		} catch (error) {
			clearTimeout(timeoutId);

			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Request timed out after ${options.timeout}ms`);
			}
			throw error;
		}
	}

	/**
	 * Parse response based on configured format
	 */
	private async parseResponse(response: Response): Promise<unknown> {
		const responseFormat = this.customConfig.responseFormat ?? "json";

		if (responseFormat === "xml") {
			// XML parsing would require a library like fast-xml-parser
			// For now, try to parse as JSON anyway in case it's actually JSON
			const text = await response.text();
			try {
				return JSON.parse(text);
			} catch {
				throw new Error("XML response format not yet supported");
			}
		}

		return response.json();
	}

	/**
	 * Transform a raw API response item to LayoutItem format
	 * Uses field mappings from D1 configuration
	 */
	private transformToLayoutItem(rawItem: unknown): LayoutItem | null {
		if (!rawItem || typeof rawItem !== "object") {
			return null;
		}

		const raw = rawItem as Record<string, unknown>;
		const result: Record<string, unknown> = {};

		// Apply field mappings
		for (const [targetPath, sourcePath] of Object.entries(this.fieldMappings)) {
			const value = getByPath(raw, sourcePath);
			if (value !== undefined) {
				setByPath(result, targetPath, value);
			}
		}

		// Ensure required fields exist
		// If no mapping for id, try common field names
		if (!result.id) {
			result.id =
				raw.id ?? raw._id ?? raw.productId ?? raw.product_id ?? raw.sku ?? "";
		}

		// If no mapping for title, try common field names
		if (!result.title) {
			result.title =
				raw.title ?? raw.name ?? raw.product_name ?? raw.productName ?? "";
		}

		// Validate we have minimum required fields
		if (!result.id || !result.title) {
			return null;
		}

		// Build LayoutItem with sensible defaults for unmapped fields
		const item: LayoutItem = {
			id: String(result.id),
			title: String(result.title),
		};

		// Add optional string fields
		if (result.subtitle) item.subtitle = String(result.subtitle);
		if (result.description) item.description = String(result.description);
		if (result.image) item.image = String(result.image);
		if (result.url) item.url = String(result.url);

		// Handle images array
		if (result.images && Array.isArray(result.images)) {
			item.images = result.images.map((img) => String(img));
		} else if (!result.images && result.image) {
			// If we have a single image but no images array, also check raw
			const rawImages = raw.images ?? raw.imageUrls ?? raw.image_urls;
			if (Array.isArray(rawImages)) {
				item.images = rawImages.map((img) => String(img));
			}
		}

		// Handle price object
		if (result.price && typeof result.price === "object") {
			const priceObj = result.price as Record<string, unknown>;
			if (priceObj.amount !== undefined) {
				item.price = {
					amount: Number(priceObj.amount) || 0,
					currency: String(priceObj.currency ?? "EUR"),
					original: priceObj.original ? Number(priceObj.original) : undefined,
					formatted: priceObj.formatted
						? String(priceObj.formatted)
						: undefined,
				};
			}
		} else if (!result.price) {
			// Try to extract price from common raw field names
			const rawPricing = raw.pricing as Record<string, unknown> | undefined;
			const rawPrice =
				raw.price ?? raw.amount ?? rawPricing?.value ?? raw.currentPrice;
			if (typeof rawPrice === "number" || typeof rawPrice === "string") {
				item.price = {
					amount: Number(rawPrice) || 0,
					currency: String(raw.currency ?? raw.priceCurrency ?? "EUR"),
				};
			}
		}

		// Handle rating object
		if (result.rating && typeof result.rating === "object") {
			const ratingObj = result.rating as Record<string, unknown>;
			if (ratingObj.value !== undefined) {
				item.rating = {
					value: Number(ratingObj.value) || 0,
					count: ratingObj.count ? Number(ratingObj.count) : undefined,
					max: ratingObj.max ? Number(ratingObj.max) : 5,
				};
			}
		}

		// Handle badge object
		if (result.badge && typeof result.badge === "object") {
			const badgeObj = result.badge as Record<string, unknown>;
			if (badgeObj.text) {
				item.badge = {
					text: String(badgeObj.text),
					variant: (badgeObj.variant as BadgeVariant) ?? "default",
				};
			}
		}

		// Handle location object
		if (result.location && typeof result.location === "object") {
			const locObj = result.location as Record<string, unknown>;
			item.location = {
				lat: locObj.lat ? Number(locObj.lat) : undefined,
				lng:
					(locObj.lng ?? locObj.lon)
						? Number(locObj.lng ?? locObj.lon)
						: undefined,
				address: locObj.address ? String(locObj.address) : undefined,
				city: locObj.city ? String(locObj.city) : undefined,
				country: locObj.country ? String(locObj.country) : undefined,
			};
		}

		// Handle seller object
		if (result.seller && typeof result.seller === "object") {
			const sellerObj = result.seller as Record<string, unknown>;
			if (sellerObj.name) {
				item.seller = {
					id: sellerObj.id ? String(sellerObj.id) : undefined,
					name: String(sellerObj.name),
					avatar: sellerObj.avatar ? String(sellerObj.avatar) : undefined,
					verified:
						typeof sellerObj.verified === "boolean"
							? sellerObj.verified
							: undefined,
					rating: sellerObj.rating ? Number(sellerObj.rating) : undefined,
				};
			}
		}

		// Handle features array
		if (result.features && Array.isArray(result.features)) {
			item.features = result.features
				.filter(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as Record<string, unknown>).label,
				)
				.map((f) => {
					const feature = f as Record<string, unknown>;
					return {
						label: String(feature.label),
						value: String(feature.value ?? ""),
						icon: feature.icon ? String(feature.icon) : undefined,
					};
				});
		}

		// Handle actions array
		if (result.actions && Array.isArray(result.actions)) {
			item.actions = result.actions
				.filter(
					(a) =>
						typeof a === "object" &&
						a !== null &&
						(a as Record<string, unknown>).label,
				)
				.map((a) => {
					const action = a as Record<string, unknown>;
					return {
						label: String(action.label),
						action: String(action.action ?? action.url ?? ""),
						primary: action.primary === true,
						icon: action.icon ? String(action.icon) : undefined,
					};
				});
		}

		// Build default action if none provided and we have a URL
		if ((!item.actions || item.actions.length === 0) && item.url) {
			item.actions = [
				{
					label: "View",
					action: item.url,
					primary: true,
					icon: "external-link",
				},
			];
		}

		// Handle offers array (for price comparison)
		if (result.offers && Array.isArray(result.offers)) {
			item.offers = result.offers
				.filter(
					(o) =>
						typeof o === "object" &&
						o !== null &&
						(o as Record<string, unknown>).merchantName,
				)
				.map((o) => {
					const offer = o as Record<string, unknown>;
					return {
						merchantId: offer.merchantId ? String(offer.merchantId) : undefined,
						merchantName: String(offer.merchantName),
						merchantLogo: offer.merchantLogo
							? String(offer.merchantLogo)
							: undefined,
						price: Number(offer.price) || 0,
						currency: String(offer.currency ?? "EUR"),
						url: offer.url ? String(offer.url) : undefined,
						shippingCost:
							offer.shippingCost !== undefined
								? Number(offer.shippingCost)
								: undefined,
						deliveryDays:
							offer.deliveryDays !== undefined
								? Number(offer.deliveryDays)
								: undefined,
						stockStatus: offer.stockStatus
							? (String(offer.stockStatus) as StockStatus)
							: undefined,
						verified: offer.verified === true,
						paymentMethods: Array.isArray(offer.paymentMethods)
							? offer.paymentMethods.map((pm) => String(pm))
							: undefined,
					};
				});

			if (item.offers.length > 0) {
				item.offerCount = item.offers.length;
			}
		}

		// Handle shipping object
		if (result.shipping && typeof result.shipping === "object") {
			const shipObj = result.shipping as Record<string, unknown>;
			item.shipping = {
				cost: shipObj.cost !== undefined ? Number(shipObj.cost) : undefined,
				free: shipObj.free === true || shipObj.cost === 0,
				currency: shipObj.currency ? String(shipObj.currency) : undefined,
				minDays: shipObj.minDays ? Number(shipObj.minDays) : undefined,
				maxDays: shipObj.maxDays ? Number(shipObj.maxDays) : undefined,
				method: shipObj.method ? String(shipObj.method) : undefined,
			};
		}

		// Handle stock object
		if (result.stock && typeof result.stock === "object") {
			const stockObj = result.stock as Record<string, unknown>;
			item.stock = {
				status: (stockObj.status as StockStatus) ?? "unknown",
				quantity: stockObj.quantity ? Number(stockObj.quantity) : undefined,
				lowStockThreshold: stockObj.lowStockThreshold
					? Number(stockObj.lowStockThreshold)
					: undefined,
			};
		}

		// Handle savings object
		if (result.savings && typeof result.savings === "object") {
			const savingsObj = result.savings as Record<string, unknown>;
			if (
				savingsObj.amount !== undefined &&
				savingsObj.originalPrice !== undefined
			) {
				item.savings = {
					amount: Number(savingsObj.amount) || 0,
					percentage: Number(savingsObj.percentage) || 0,
					originalPrice: Number(savingsObj.originalPrice) || 0,
				};
			}
		}

		// Store any unmapped metadata
		item.metadata = {
			source: this.name,
			adapterId: this.id,
			appId: this.appId,
		};

		// Add any extra fields from result.metadata
		if (result.metadata && typeof result.metadata === "object") {
			Object.assign(item.metadata, result.metadata);
		}

		return item;
	}

	/**
	 * Combine multiple AbortSignals into one
	 */
	private combineSignals(...signals: AbortSignal[]): AbortSignal {
		const controller = new AbortController();

		for (const signal of signals) {
			if (signal.aborted) {
				controller.abort();
				break;
			}
			signal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}

		return controller.signal;
	}
}
