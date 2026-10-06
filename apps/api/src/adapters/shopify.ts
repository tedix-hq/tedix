/**
 * Shopify Adapter
 *
 * Adapter implementation for Shopify Storefront API (GraphQL).
 * Queries Shopify stores for product search and transforms results
 * to LayoutItem format.
 *
 * Uses the Storefront API which is optimized for frontend/buyer experiences
 * and doesn't require admin credentials.
 *
 * @module @tedix/api/adapters/shopify
 */

import type {
	AppAdapter,
	ShopifyAdapterConfig,
} from "@tedix/db/schema/adapters";
import { isShopifyConfig } from "@tedix/db/schema/adapters";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import { omitUndefined } from "../lib/json";
import {
	type AdapterContext,
	type AdapterResult,
	BaseAdapter,
	type SearchOptions,
} from "./base";

// =============================================================================
// SHOPIFY API CONSTANTS
// =============================================================================

/** Default API version if not specified */
const DEFAULT_API_VERSION = "2024-01";

/** Default request timeout in ms */
const DEFAULT_TIMEOUT = 10000;

/** Maximum products per search (Shopify limit) */
const MAX_PRODUCTS_PER_SEARCH = 25;

// =============================================================================
// SHOPIFY GRAPHQL TYPES
// =============================================================================

/**
 * Shopify MoneyV2 type
 */
interface ShopifyMoneyV2 {
	amount: string;
	currencyCode: string;
}

/**
 * Shopify Image type
 */
interface ShopifyImage {
	url: string;
	altText?: string | null;
	width?: number;
	height?: number;
}

/**
 * Shopify Product Variant type
 */
interface ShopifyProductVariant {
	id: string;
	title: string;
	price: ShopifyMoneyV2;
	compareAtPrice?: ShopifyMoneyV2 | null;
	availableForSale: boolean;
	quantityAvailable?: number | null;
	sku?: string | null;
	image?: ShopifyImage | null;
	selectedOptions?: Array<{
		name: string;
		value: string;
	}>;
}

/**
 * Shopify Product type from GraphQL response
 */
interface ShopifyProduct {
	id: string;
	title: string;
	description: string;
	descriptionHtml?: string;
	handle: string;
	vendor: string;
	productType: string;
	tags: string[];
	availableForSale: boolean;
	onlineStoreUrl?: string | null;
	createdAt: string;
	updatedAt: string;
	priceRange: {
		minVariantPrice: ShopifyMoneyV2;
		maxVariantPrice: ShopifyMoneyV2;
	};
	compareAtPriceRange?: {
		minVariantPrice: ShopifyMoneyV2;
		maxVariantPrice: ShopifyMoneyV2;
	} | null;
	images: {
		edges: Array<{
			node: ShopifyImage;
		}>;
	};
	variants?: {
		edges: Array<{
			node: ShopifyProductVariant;
		}>;
	};
	featuredImage?: ShopifyImage | null;
}

/**
 * Shopify GraphQL search response
 */
interface ShopifySearchResponse {
	data: {
		products: {
			edges: Array<{
				node: ShopifyProduct;
				cursor: string;
			}>;
			pageInfo: {
				hasNextPage: boolean;
				hasPreviousPage: boolean;
				startCursor?: string | null;
				endCursor?: string | null;
			};
		};
	};
	errors?: Array<{
		message: string;
		locations?: Array<{ line: number; column: number }>;
		path?: string[];
	}>;
}

/**
 * Shopify GraphQL product by handle response
 */
interface ShopifyProductByHandleResponse {
	data: {
		productByHandle: ShopifyProduct | null;
	};
	errors?: Array<{
		message: string;
	}>;
}

// =============================================================================
// GRAPHQL QUERIES
// =============================================================================

/**
 * Product search query with all necessary fields
 */
const PRODUCT_SEARCH_QUERY = `
query searchProducts($query: String!, $first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    edges {
      node {
        id
        title
        description
        handle
        vendor
        productType
        tags
        availableForSale
        onlineStoreUrl
        createdAt
        updatedAt
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
          maxVariantPrice {
            amount
            currencyCode
          }
        }
        compareAtPriceRange {
          minVariantPrice {
            amount
            currencyCode
          }
          maxVariantPrice {
            amount
            currencyCode
          }
        }
        images(first: 5) {
          edges {
            node {
              url
              altText
              width
              height
            }
          }
        }
        featuredImage {
          url
          altText
        }
        variants(first: 10) {
          edges {
            node {
              id
              title
              price {
                amount
                currencyCode
              }
              compareAtPrice {
                amount
                currencyCode
              }
              availableForSale
              quantityAvailable
              sku
              image {
                url
                altText
              }
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
      cursor
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
  }
}
`;

/**
 * Product by handle query (for getById)
 */
const PRODUCT_BY_HANDLE_QUERY = `
query productByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    description
    handle
    vendor
    productType
    tags
    availableForSale
    onlineStoreUrl
    createdAt
    updatedAt
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    compareAtPriceRange {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    images(first: 10) {
      edges {
        node {
          url
          altText
          width
          height
        }
      }
    }
    featuredImage {
      url
      altText
    }
    variants(first: 50) {
      edges {
        node {
          id
          title
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
          availableForSale
          quantityAvailable
          sku
          image {
            url
            altText
          }
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
}
`;

// =============================================================================
// TRANSFORM UTILITIES
// =============================================================================

/**
 * Parse Shopify MoneyV2 to number
 */
function parseShopifyPrice(
	money: ShopifyMoneyV2 | undefined | null,
): number | undefined {
	if (!money?.amount) return undefined;
	const amount = Number.parseFloat(money.amount);
	return Number.isNaN(amount) ? undefined : amount;
}

/**
 * Extract numeric ID from Shopify global ID
 * e.g., "gid://shopify/Product/1234567890" -> "1234567890"
 */
function extractShopifyId(gid: string): string {
	const match = gid.match(/\/(\d+)$/);
	return match?.[1] ?? gid;
}

/**
 * Build product URL from store domain and handle
 */
function buildProductUrl(storeDomain: string, handle: string): string {
	const domain = storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return `https://${domain}/products/${handle}`;
}

/**
 * Map sort option to Shopify ProductSortKeys
 */
function mapSortToShopify(sort?: SearchOptions["sort"]): {
	sortKey: string | undefined;
	reverse: boolean;
} {
	switch (sort) {
		case "price_asc":
			return { sortKey: "PRICE", reverse: false };
		case "price_desc":
			return { sortKey: "PRICE", reverse: true };
		case "popularity":
			return { sortKey: "BEST_SELLING", reverse: false };
		case "newest":
			return { sortKey: "CREATED_AT", reverse: true };
		case "rating":
			// Shopify doesn't have native rating sort, use relevance
			return { sortKey: "RELEVANCE", reverse: false };
		case "relevance":
		default:
			return { sortKey: "RELEVANCE", reverse: false };
	}
}

/**
 * Transform Shopify product to LayoutItem
 */
function toLayoutItem(
	product: ShopifyProduct,
	storeDomain: string,
	includeVariants?: boolean,
): LayoutItem {
	const minPrice = parseShopifyPrice(product.priceRange.minVariantPrice);
	const maxPrice = parseShopifyPrice(product.priceRange.maxVariantPrice);
	const compareAtMin = parseShopifyPrice(
		product.compareAtPriceRange?.minVariantPrice,
	);
	const currency = product.priceRange.minVariantPrice.currencyCode;

	// Get images
	const images = product.images.edges.map((edge) => edge.node.url);
	const featuredImage = product.featuredImage?.url || images[0];

	// Calculate savings if compare-at price exists
	let savings: LayoutItem["savings"] | undefined;
	if (
		compareAtMin !== undefined &&
		minPrice !== undefined &&
		compareAtMin > minPrice
	) {
		const amount = compareAtMin - minPrice;
		const percentage = Math.round((amount / compareAtMin) * 100);
		if (percentage >= 5) {
			savings = { amount, percentage, originalPrice: compareAtMin };
		}
	}

	// Get variants for offers (if enabled)
	const variants = product.variants?.edges.map((edge) => edge.node) || [];
	const availableVariants = variants.filter((v) => v.availableForSale);

	// Build features from variant options (first variant)
	const features: LayoutItem["features"] = [];
	const firstVariant = variants[0];
	if (firstVariant?.selectedOptions) {
		for (const opt of firstVariant.selectedOptions) {
			if (opt.name.toLowerCase() !== "title" && opt.value !== "Default Title") {
				features.push({
					label: opt.name,
					value: opt.value,
				});
			}
		}
	}

	// Add product type as feature if exists
	if (product.productType) {
		features.push({ label: "Type", value: product.productType });
	}

	// Determine stock status
	let stockStatus: LayoutItem["stock"];
	if (!product.availableForSale) {
		stockStatus = { status: "out_of_stock" };
	} else if (
		availableVariants.length < variants.length &&
		variants.length > 0
	) {
		stockStatus = { status: "limited" };
	} else {
		stockStatus = { status: "in_stock" };
	}

	// Build subtitle from vendor and product type
	const subtitleParts: string[] = [];
	if (
		product.vendor &&
		product.vendor !== "Unknown" &&
		product.vendor !== product.title
	) {
		subtitleParts.push(product.vendor);
	}
	if (product.productType) {
		subtitleParts.push(product.productType);
	}

	// Product URL - prefer onlineStoreUrl, fallback to constructed URL
	const productUrl =
		product.onlineStoreUrl || buildProductUrl(storeDomain, product.handle);

	const layoutItem: LayoutItem = {
		id: extractShopifyId(product.id),
		title: product.title,
		subtitle: subtitleParts.length > 0 ? subtitleParts.join(" | ") : undefined,
		description: product.description || undefined,
		image: featuredImage,
		images: images.length > 1 ? images : undefined,
		url: productUrl,

		price:
			minPrice !== undefined
				? {
						amount: minPrice,
						currency,
						original: savings?.originalPrice,
						formatted: undefined, // Let the widget format it
					}
				: undefined,

		badge: !product.availableForSale
			? { text: "Out of Stock", variant: "destructive" }
			: savings && savings.percentage >= 10
				? { text: `${savings.percentage}% off`, variant: "success" }
				: variants.length > 1
					? { text: `${variants.length} options`, variant: "secondary" }
					: undefined,

		seller: product.vendor
			? {
					name: product.vendor,
				}
			: undefined,

		features: features.length > 0 ? features.slice(0, 5) : undefined,

		actions: [
			{
				label: "View Product",
				action: productUrl,
				primary: true,
				icon: "external-link",
			},
		],

		stock: stockStatus,
		savings,

		// Include variants as offers if enabled and multiple variants exist
		offers:
			includeVariants && availableVariants.length > 1
				? availableVariants.slice(0, 5).map((variant) => ({
						merchantId: extractShopifyId(variant.id),
						merchantName:
							variant.title !== "Default Title" ? variant.title : product.title,
						price: parseShopifyPrice(variant.price) ?? minPrice ?? 0,
						currency: variant.price.currencyCode,
						stockStatus: variant.availableForSale
							? ("in_stock" as const)
							: ("out_of_stock" as const),
						url: `${productUrl}?variant=${extractShopifyId(variant.id)}`,
					}))
				: undefined,

		offerCount:
			availableVariants.length > 1 ? availableVariants.length : undefined,

		metadata: omitUndefined({
			source: "shopify",
			handle: product.handle,
			vendor: product.vendor,
			productType: product.productType,
			tags: product.tags,
			shopifyId: product.id,
			hasMultipleVariants: variants.length > 1,
			priceRange:
				minPrice !== undefined &&
				maxPrice !== undefined &&
				minPrice !== maxPrice
					? {
							min: minPrice,
							max: maxPrice,
						}
					: undefined,
			createdAt: product.createdAt,
			updatedAt: product.updatedAt,
		}),
	};

	return layoutItem;
}

// =============================================================================
// SHOPIFY ADAPTER
// =============================================================================

/**
 * Shopify Adapter Implementation
 *
 * Connects to Shopify Storefront API (GraphQL) for product search.
 * Works with any Shopify store that has a Storefront access token.
 */
export class ShopifyAdapter extends BaseAdapter {
	readonly name = "shopify";
	readonly description = "Shopify Storefront API integration";
	readonly supportedMarkets = ["*"]; // Works globally

	/** Typed Shopify-specific configuration */
	private readonly shopifyConfig: ShopifyAdapterConfig;

	constructor(adapterConfig: AppAdapter) {
		super(adapterConfig);

		if (!isShopifyConfig(adapterConfig.config)) {
			throw new Error("Invalid Shopify adapter configuration");
		}

		this.shopifyConfig = adapterConfig.config;

		// Validate required config
		if (!this.shopifyConfig.storeDomain) {
			throw new Error("Shopify storeDomain is required");
		}
		// NOTE: storefrontToken is now provided via the adapter bindings system
		// The registry hydrates secrets into the config before the adapter is created
		// If missing, check that a SHOPIFY_STOREFRONT_TOKEN binding is configured
	}

	/**
	 * Get the Storefront API endpoint URL
	 */
	private get apiEndpoint(): string {
		const domain = this.shopifyConfig.storeDomain
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		const version = this.shopifyConfig.apiVersion ?? DEFAULT_API_VERSION;
		return `https://${domain}/api/${version}/graphql.json`;
	}

	/**
	 * Search for products via Shopify Storefront API
	 */
	async search(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		// Validate query
		if (!query || query.trim().length === 0) {
			return this.createErrorResult(
				"Search query is required",
				"missing_query",
			);
		}

		// Validate storefrontToken is present (injected by registry via bindings)
		// The shopifyConfig type may not include storefrontToken (removed from schema),
		// but the registry hydrates it from bindings at runtime
		const storefrontToken = (
			this.shopifyConfig as unknown as {
				storefrontToken?: string;
			}
		).storefrontToken;
		if (!storefrontToken) {
			return this.createErrorResult(
				"Shopify storefrontToken not configured. Add SHOPIFY_STOREFRONT_TOKEN binding via Settings > Secrets.",
				"missing_storefront_token",
			);
		}

		// Determine limit (clamp to Shopify max)
		// Priority: options.limit → config.limit → fallback to 10
		const limit = Math.min(
			options.limit ?? this.shopifyConfig.limit ?? 10,
			MAX_PRODUCTS_PER_SEARCH,
		);

		try {
			// Build search query with filters
			let searchQuery = query;

			// Add price filters if specified
			if (options.minPrice !== undefined || options.maxPrice !== undefined) {
				// Shopify uses "price:>X" and "price:<X" syntax
				if (options.minPrice !== undefined) {
					searchQuery += ` price:>${options.minPrice}`;
				}
				if (options.maxPrice !== undefined) {
					searchQuery += ` price:<${options.maxPrice}`;
				}
			}

			// Add brand/vendor filter if specified
			if (options.brand) {
				searchQuery += ` vendor:${options.brand}`;
			}

			// Add category/product type filter if specified
			if (options.category) {
				searchQuery += ` product_type:${options.category}`;
			}

			// Add in-stock filter if specified
			if (options.inStock) {
				searchQuery += ` available_for_sale:true`;
			}

			// Filter by collection if configured
			if (
				this.shopifyConfig.collectionIds &&
				this.shopifyConfig.collectionIds.length > 0
			) {
				// Note: Collection filtering in search query is limited
				// For strict collection filtering, use collection-based queries instead
			}

			// Map sort option
			const { sortKey, reverse } = mapSortToShopify(options.sort);

			// Execute GraphQL query
			const result = await this.executeGraphQL<ShopifySearchResponse>(
				PRODUCT_SEARCH_QUERY,
				{
					query: searchQuery,
					first: limit,
					after: options.offset ? String(options.offset) : null,
					sortKey,
					reverse,
				},
				ctx,
			);

			if (!result.success) {
				return this.createErrorResult(
					result.error ?? "Shopify API request failed",
					result.errorCode,
					Date.now() - startTime,
				);
			}

			// Check for GraphQL errors
			if (result.data.errors && result.data.errors.length > 0) {
				const errorMessage = result.data.errors
					.map((e) => e.message)
					.join("; ");
				return this.createErrorResult(
					`Shopify GraphQL error: ${errorMessage}`,
					"graphql_error",
					Date.now() - startTime,
				);
			}

			const products = result.data.data.products;

			// Transform products to LayoutItems
			const items = products.edges.map((edge) =>
				toLayoutItem(
					edge.node,
					this.shopifyConfig.storeDomain,
					this.shopifyConfig.includeVariants,
				),
			);

			return this.createSuccessResult(items, {
				totalResults: items.length, // Shopify doesn't provide total count in search
				hasMore: products.pageInfo.hasNextPage,
				responseTimeMs: Date.now() - startTime,
				meta: {
					query: searchQuery,
					cached: false,
				},
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
	 * Get a single product by handle
	 */
	async getById(id: string, ctx: AdapterContext): Promise<LayoutItem | null> {
		try {
			const result = await this.executeGraphQL<ShopifyProductByHandleResponse>(
				PRODUCT_BY_HANDLE_QUERY,
				{ handle: id },
				ctx,
			);

			if (!result.success || !result.data.data.productByHandle) {
				return null;
			}

			return toLayoutItem(
				result.data.data.productByHandle,
				this.shopifyConfig.storeDomain,
				this.shopifyConfig.includeVariants,
			);
		} catch {
			return null;
		}
	}

	/**
	 * Get multiple products by handles
	 *
	 * Processes in chunks of 5 to stay within the Workers 6 simultaneous
	 * connection limit. Excess connections are queued by the runtime, but
	 * chunking avoids latency spikes on large ID lists.
	 */
	async getByIds(ids: string[], ctx: AdapterContext): Promise<LayoutItem[]> {
		const CHUNK_SIZE = 5;
		const results: (LayoutItem | null)[] = [];

		for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
			const chunk = ids.slice(i, i + CHUNK_SIZE);
			const chunkResults = await Promise.all(
				chunk.map((id) => this.getById(id, ctx)),
			);
			results.push(...chunkResults);
		}

		return results.filter((item): item is LayoutItem => item !== null);
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

		try {
			// Quick search to verify API is responding
			const result = await this.executeGraphQL<ShopifySearchResponse>(
				PRODUCT_SEARCH_QUERY,
				{
					query: "*",
					first: 1,
				},
				ctx,
			);

			return {
				healthy: result.success,
				latencyMs: Date.now() - startTime,
				error: result.success ? undefined : result.error,
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
	 * Execute a GraphQL query against the Shopify Storefront API
	 */
	private async executeGraphQL<T>(
		query: string,
		variables: Record<string, unknown>,
		ctx: AdapterContext,
	): Promise<{
		success: boolean;
		data: T;
		error?: string;
		errorCode?: string;
	}> {
		const timeout = this.shopifyConfig.timeout ?? DEFAULT_TIMEOUT;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		// Combine signals if external signal provided
		const signal = ctx.signal
			? this.combineSignals(ctx.signal, controller.signal)
			: controller.signal;

		// Get storefrontToken from runtime-hydrated config
		// NOTE: storefrontToken is injected by the registry via bindings system
		const storefrontToken = (
			this.shopifyConfig as unknown as {
				storefrontToken?: string;
			}
		).storefrontToken as string;

		try {
			const response = await fetch(this.apiEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Shopify-Storefront-Access-Token": storefrontToken,
				},
				body: JSON.stringify({
					query,
					variables,
				}),
				signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorText = await response.text().catch(() => "Unknown error");
				return {
					success: false,
					data: {} as T,
					error: `Shopify API error: ${response.status} - ${errorText}`,
					errorCode: `http_${response.status}`,
				};
			}

			const data = (await response.json()) as T;
			return {
				success: true,
				data,
			};
		} catch (error) {
			clearTimeout(timeoutId);

			if (error instanceof Error && error.name === "AbortError") {
				return {
					success: false,
					data: {} as T,
					error: `Request timed out after ${timeout}ms`,
					errorCode: "timeout",
				};
			}

			return {
				success: false,
				data: {} as T,
				error: error instanceof Error ? error.message : "Unknown error",
				errorCode: "network_error",
			};
		}
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
