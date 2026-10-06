/**
 * Klarna Adapter
 *
 * Connects to Klarna's official shopping MCP server via Streamable HTTP.
 * Single-phase search: one MCP tool call returns products with full offer data,
 * historical price drops, trending badges, and installment info.
 *
 * @module @tedix/api/adapters/klarna
 */

import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import type {
	AppAdapter,
	KlarnaAdapterConfig,
} from "@tedix/db/schema/adapters";
import { isKlarnaConfig } from "@tedix/db/schema/adapters";
import { omitUndefined } from "../lib/json";
import { callMcpTool } from "../lib/mcp-client";
import {
	type AdapterContext,
	type AdapterResult,
	BaseAdapter,
	type SearchOptions,
} from "./base";

// =============================================================================
// KLARNA MCP TYPES
// =============================================================================

const KLARNA_MCP_ENDPOINT = "https://d2p3kt79hdhtiu.cloudfront.net/mcp";
const KLARNA_IMAGE_CDN = "https://owp.klarna.com/product";
const DEFAULT_TIMEOUT = 30000;
const MAX_PRODUCTS_PER_SEARCH = 50;

interface KlarnaMcpProduct {
	id: string;
	name: string;
	url: string;
	description?: string;
	category?: { id?: string; name?: string; url?: string } | string;
	brand?: string | null;
	rating?: {
		averageRating?: string;
		average?: string;
		count?: number;
		numberOfRatings?: number;
	} | null;
	lowestPrice?: { amount: string; currency: string } | null;
	priceDrop?: {
		oldPrice: { amount: string; currency: string };
		percent: string;
	} | null;
	image?: { id?: string; url: string } | null;
	rank?: { rank: number; trend: string } | null;
	ribbon?: {
		type: string;
		value: string | null;
		description: string | null;
	} | null;
	installment?: {
		price: { amount: string; currency: string };
		termLength: number;
		interval: string;
		frequency: number;
	} | null;
	cheapestOffer?: {
		price: { amount: string; currency: string };
		merchant: { id?: string; name?: string; image?: string | null };
		pricePerUnit?: string | null;
	} | null;
	outOfStock?: boolean;
	previewMerchants?: {
		count: number;
		merchants: Array<{ name: string; logo?: string }>;
	} | null;
	offers?: Array<{
		id: string;
		merchantName: string;
		price: { currency: string; amount: string };
		shipping?: { amount: string; isFree: boolean };
		url: string;
		stockStatus?: string;
	}>;
}

// =============================================================================
// TRANSFORM UTILITIES
// =============================================================================

function n2u<T>(value: T | null | undefined): T | undefined {
	return value === null ? undefined : value;
}

function parseAmount(val: string | undefined | null): number | undefined {
	if (!val) return undefined;
	const num = Number.parseFloat(val.replace(/[,\s]/g, ""));
	return Number.isNaN(num) ? undefined : num;
}

function toLayoutItem(product: KlarnaMcpProduct, market?: string): LayoutItem {
	const priceAmount = parseAmount(n2u(product.lowestPrice)?.amount);
	const currency = n2u(product.lowestPrice)?.currency ?? "EUR";

	let savings: LayoutItem["savings"];
	const drop = n2u(product.priceDrop);
	if (drop && priceAmount !== undefined) {
		const oldPrice = parseAmount(drop.oldPrice.amount);
		const pct = Number.parseFloat(drop.percent);
		if (oldPrice && !Number.isNaN(pct) && pct >= 5) {
			savings = {
				amount: oldPrice - priceAmount,
				percentage: Math.round(pct),
				originalPrice: oldPrice,
			};
		}
	}

	const ratingObj = n2u(product.rating);
	const ratingValue = parseAmount(
		ratingObj?.averageRating ?? ratingObj?.average,
	);

	const imageObj = n2u(product.image);
	const imageId = imageObj?.id;
	const imageUrl = imageObj?.url;
	const image = imageId
		? `${KLARNA_IMAGE_CDN}/${imageId}/image.jpg`
		: imageUrl && !imageUrl.startsWith("data:")
			? imageUrl
			: undefined;

	const ribbon = n2u(product.ribbon);
	const ribbonText = ribbon?.description ?? ribbon?.value;
	const badge: LayoutItem["badge"] | undefined =
		ribbon && ribbonText && ribbon.type !== "NONE"
			? { text: ribbonText, variant: "secondary" }
			: undefined;

	const categoryName =
		typeof product.category === "string"
			? product.category
			: n2u(product.category)?.name;
	const brand = n2u(product.brand);

	const transformedOffers = product.offers
		?.map((offer) => ({
			merchantName: offer.merchantName,
			price: parseAmount(offer.price.amount) ?? 0,
			currency: offer.price.currency,
			url: offer.url,
			shippingCost: offer.shipping
				? parseAmount(offer.shipping.amount)
				: undefined,
			stockStatus:
				offer.stockStatus === "IN_STOCK"
					? ("in_stock" as const)
					: ("out_of_stock" as const),
			verified: true,
		}))
		.sort((a, b) => a.price - b.price);

	const features: Array<{ label: string; value: string }> = [];
	if (brand) features.push({ label: "Brand", value: brand });
	if (categoryName) features.push({ label: "Category", value: categoryName });
	const inst = n2u(product.installment);
	if (inst) {
		features.push({
			label: "Installment",
			value: `${inst.price.amount} ${inst.price.currency}/mo x${inst.termLength}`,
		});
	}

	const cheapest = n2u(product.cheapestOffer);
	const firstMerchant = n2u(product.previewMerchants)?.merchants?.[0];
	const sellerName =
		cheapest?.merchant?.name || firstMerchant?.name || "Klarna";

	const bestOffer = transformedOffers?.[0];

	return {
		id: product.id,
		title: product.name,
		subtitle: [brand, categoryName].filter(Boolean).join(" | ") || undefined,
		description: n2u(product.description),
		image,
		url: product.url,
		price:
			priceAmount !== undefined
				? {
						amount: priceAmount,
						currency,
						original: savings?.originalPrice,
					}
				: undefined,
		rating:
			ratingValue !== undefined
				? {
						value: ratingValue,
						max: 5,
						count:
							n2u(product.rating)?.count ??
							n2u(product.rating)?.numberOfRatings,
					}
				: undefined,
		badge,
		seller: { name: sellerName },
		features: features.length > 0 ? features : undefined,
		actions: [
			{
				label:
					sellerName !== "Klarna" ? `Buy from ${sellerName}` : "View on Klarna",
				action: product.url,
				primary: true,
				icon: "external-link",
			},
		],
		offers: transformedOffers,
		shipping:
			bestOffer?.shippingCost !== undefined
				? {
						cost: bestOffer.shippingCost,
						free: bestOffer.shippingCost === 0,
						currency,
					}
				: undefined,
		stock: product.outOfStock
			? { status: "out_of_stock" }
			: { status: "in_stock" },
		savings,
		offerCount: product.offers?.length ?? n2u(product.previewMerchants)?.count,
		metadata: omitUndefined({
			source: "klarna",
			market,
			brand,
			category: categoryName,
			rank: n2u(product.rank)?.rank,
			rankTrend: n2u(product.rank)?.trend,
			ribbonType: ribbon?.type,
			cheapestMerchant: cheapest?.merchant?.name || undefined,
			merchantCount: n2u(product.previewMerchants)?.count,
		}),
	};
}

// =============================================================================
// KLARNA ADAPTER
// =============================================================================

export class KlarnaAdapter extends BaseAdapter {
	readonly name = "klarna";
	readonly description = "Klarna shopping price comparison via MCP";
	readonly supportedMarkets = [
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
	];

	private readonly klarnaConfig: KlarnaAdapterConfig;

	constructor(adapterConfig: AppAdapter) {
		super(adapterConfig);
		if (!isKlarnaConfig(adapterConfig.config)) {
			throw new Error("Invalid Klarna adapter configuration");
		}
		this.klarnaConfig = adapterConfig.config;
	}

	async search(
		query: string,
		options: SearchOptions,
		_ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		if (!query || query.trim().length === 0) {
			return this.createErrorResult(
				"Search query is required",
				"missing_query",
			);
		}

		const market = this.resolveMarket(options.country);
		const configuredLimit =
			this.klarnaConfig.maxProducts ?? this.klarnaConfig.limit ?? 10;
		const limit = Math.min(
			options.limit ?? configuredLimit,
			MAX_PRODUCTS_PER_SEARCH,
		);

		// Build MCP tool arguments
		const args: Record<string, unknown> = {
			query,
			country: market,
			size: limit,
		};
		if (options.offset) args.offset = options.offset;

		// Build filters
		const filters: Record<string, string> = {};
		if (options.minPrice !== undefined || options.maxPrice !== undefined) {
			filters.priceRange = `${options.minPrice ?? 0}_${options.maxPrice ?? 999999}`;
		}
		if (options.priceDrop) {
			filters.priceDrop = "-90_-10";
		}
		if (Object.keys(filters).length > 0) {
			args.filters = filters;
		}

		try {
			const result = await callMcpTool(
				KLARNA_MCP_ENDPOINT,
				"search_products",
				args,
				{ timeout: this.klarnaConfig.timeout ?? DEFAULT_TIMEOUT },
			);

			if (!result.success) {
				return this.createErrorResult(
					result.error ?? "Klarna MCP call failed",
					result.errorCode,
					Date.now() - startTime,
				);
			}

			// Extract products from _meta.allProducts (rich data) or structuredContent (fallback)
			const meta = result.rawResult?._meta as
				| { allProducts?: KlarnaMcpProduct[] }
				| undefined;
			const structured = result.rawResult?.structuredContent as
				| {
						products?: Array<{
							id: string;
							name: string;
							price: string;
							url: string;
						}>;
						hasMore?: boolean;
				  }
				| undefined;

			let items: LayoutItem[];
			let hasMore = false;

			if (meta?.allProducts && meta.allProducts.length > 0) {
				items = meta.allProducts.map((p) => toLayoutItem(p, market));
				hasMore = structured?.hasMore ?? false;
			} else if (structured?.products && structured.products.length > 0) {
				// Fallback: structured products have less data
				items = structured.products.map((p) => ({
					id: p.id,
					title: p.name,
					url: p.url,
					metadata: omitUndefined({ source: "klarna", market }),
				}));
				hasMore = structured.hasMore ?? false;
			} else {
				items = [];
			}

			return this.createSuccessResult(items, {
				totalResults: items.length,
				hasMore,
				responseTimeMs: Date.now() - startTime,
				meta: { query, market, cached: false },
			});
		} catch (error) {
			return this.createErrorResult(
				error instanceof Error ? error.message : "Unknown error",
				"request_failed",
				Date.now() - startTime,
			);
		}
	}

	async healthCheck(_ctx: AdapterContext): Promise<{
		healthy: boolean;
		latencyMs?: number;
		error?: string;
	}> {
		const startTime = Date.now();
		try {
			const result = await callMcpTool(
				KLARNA_MCP_ENDPOINT,
				"search_products",
				{
					query: "test",
					country: this.klarnaConfig.defaultMarket ?? "DE",
					size: 1,
				},
				{ timeout: 5000 },
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

	private resolveMarket(country?: string): string {
		if (country && this.supportedMarkets.includes(country.toUpperCase())) {
			return country.toUpperCase();
		}
		return (
			this.klarnaConfig.defaultMarket ?? this.klarnaConfig.markets?.[0] ?? "DE"
		);
	}
}
