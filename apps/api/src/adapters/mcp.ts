/**
 * MCP Adapter
 *
 * Uses a third-party MCP server as a data source.
 * Translates MCP tool outputs into LayoutItem format.
 *
 * @module @tedix/api/adapters/mcp
 */

import { isUnsafePathSegment } from "@tedix/api-contract/schemas/adapter-bindings";
import type {
	BadgeVariant,
	StockStatus,
} from "@tedix/api-contract/schemas/common";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import type { AppAdapter, McpAdapterConfig } from "@tedix/db/schema/adapters";
import { isMcpConfig } from "@tedix/db/schema/adapters";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import { callMcpTool, type FetchFn } from "../lib/mcp-client";
import {
	type AdapterContext,
	type AdapterResult,
	BaseAdapter,
	type SearchOptions,
} from "./base";

// =============================================================================
// TYPES
// =============================================================================

type FieldMappings = Record<string, string>;

export type McpToolCallResult = {
	content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
	structuredContent?: unknown;
	isError?: boolean;
	_meta?: unknown;
};

export function normalizeMcpAdapterResult(
	result: McpToolCallResult,
	itemsPath?: string,
): unknown {
	if (itemsPath && getByPath(result, itemsPath) !== undefined) {
		return result;
	}

	return unwrapCallToolResult(result, "adapter tool");
}

function parsePriceValue(value: unknown): number | null {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return null;
	let cleaned = value.replace(/\s/g, "");
	// European format uses "," as the decimal separator and "." as a thousands
	// separator (e.g. "1.189,00" = 1189.00) — strip thousands dots before
	// swapping the decimal comma, or "1.189,00" misparses as 1.189.
	cleaned = cleaned.includes(",")
		? cleaned.replace(/\./g, "").replace(",", ".")
		: cleaned;
	const match = cleaned.match(/-?\d+(\.\d+)?/);
	if (!match) return null;
	const parsed = Number.parseFloat(match[0]);
	return Number.isNaN(parsed) ? null : parsed;
}

// =============================================================================
// JSONPATH UTILITIES
// =============================================================================

function getByPath(obj: unknown, path: string): unknown {
	if (!obj || typeof obj !== "object" || !path) {
		return undefined;
	}

	const segments = path
		.replace(/\[(\d+)\]/g, ".$1")
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

		if (/^\d+$/.test(segment)) {
			if (!Array.isArray(current)) {
				return undefined;
			}
			current = current[Number.parseInt(segment, 10)];
		} else {
			current = (current as Record<string, unknown>)[segment];
		}
	}

	return current;
}

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
		if (!segment) continue;

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
// MCP ADAPTER
// =============================================================================

const DEFAULT_TIMEOUT = 15000;

export class McpAdapter extends BaseAdapter {
	readonly name = "mcp";
	readonly description = "External MCP server integration";
	readonly supportedMarkets: string[] = ["*"];

	private readonly mcpConfig: McpAdapterConfig;
	private readonly fieldMappings: FieldMappings;

	constructor(adapterConfig: AppAdapter) {
		super(adapterConfig);

		if (!isMcpConfig(adapterConfig.config)) {
			throw new Error("Invalid MCP adapter configuration");
		}

		this.mcpConfig = adapterConfig.config;
		this.fieldMappings = (adapterConfig.fieldMappings as FieldMappings) ?? {};
	}

	async search(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		if (!query || query.trim().length === 0) {
			return this.createErrorResult(
				"Search query is required",
				"missing_query",
			);
		}

		const searchTool = this.mcpConfig.toolMap?.search;
		if (!searchTool) {
			return this.createErrorResult(
				"MCP search tool not configured",
				"missing_tool",
			);
		}

		try {
			let categoryRefData: Record<string, unknown> | null = null;
			const categoryRefTool = this.mcpConfig.toolMap.categoryRef;
			const categoryRefRequired = this.mcpConfig.categoryRefRequired ?? false;
			const shouldCallCategoryRef =
				Boolean(categoryRefTool) &&
				(categoryRefRequired || Boolean(options.category));

			if (categoryRefTool && shouldCallCategoryRef) {
				const categoryRefArgs = this.buildCategoryRefArgs(query, options);
				const categoryRefResult = await this.callTool(
					categoryRefTool,
					categoryRefArgs,
					ctx,
				);
				categoryRefData = this.extractStructured(categoryRefResult) as Record<
					string,
					unknown
				> | null;
			}

			const searchArgs = this.buildSearchArgs(query, options, categoryRefData);
			const searchResult = await this.callTool(searchTool, searchArgs, ctx);

			const structured = this.extractStructured(searchResult);
			const items = this.extractItems(structured);
			const totalResults = this.extractTotal(structured, items.length);

			const layoutItems = items
				.map((rawItem) => this.transformToLayoutItem(rawItem))
				.filter((item): item is LayoutItem => item !== null);

			return this.createSuccessResult(layoutItems, {
				totalResults,
				hasMore: layoutItems.length < totalResults,
				responseTimeMs: Date.now() - startTime,
				meta: { query, market: options.country, cached: false },
			});
		} catch (error) {
			return this.createErrorResult(
				error instanceof Error ? error.message : "MCP search failed",
				"mcp_error",
				Date.now() - startTime,
			);
		}
	}

	// =============================================================================
	// MCP CLIENT
	// =============================================================================

	private async callTool(
		name: string,
		args: Record<string, unknown>,
		ctx: AdapterContext,
	): Promise<McpToolCallResult> {
		const timeoutMs = this.mcpConfig.timeout ?? DEFAULT_TIMEOUT;
		if (ctx.signal?.aborted) {
			throw new Error("MCP call aborted");
		}

		const serviceBindingCall = this.buildServiceBindingCall(ctx);

		const result = await callMcpTool(
			serviceBindingCall?.serverUrl ?? this.mcpConfig.serverUrl,
			name,
			args,
			{
				timeout: timeoutMs,
				headers: serviceBindingCall?.headers,
				fetchFn: serviceBindingCall?.fetchFn,
			},
		);

		if (!result.success) {
			throw new Error(result.error ?? "MCP tool call failed");
		}

		const rawResult = result.rawResult as McpToolCallResult | undefined;
		if (!rawResult) {
			throw new Error("MCP response missing result");
		}

		if (result.isError || rawResult.isError) {
			const errorText = this.extractErrorText(rawResult);
			throw new Error(errorText ?? "MCP tool returned error");
		}

		return rawResult;
	}

	/**
	 * When `auth.type === "service-binding"`, route the call through Tedix's
	 * OWN mcp gateway over the Cloudflare MCP_SERVICE binding (see
	 * apps/api/src/rpc/routers/kernel/execute.ts `mcpCall` for the reference
	 * pattern) instead of fetching `mcpConfig.serverUrl` directly. Lets an
	 * adapter reuse an already-auth'd internal aggregate entry (for example
	 * client_credentials-gated tools) with no secret stored on this adapter —
	 * the service-binding boundary + PLATFORM_SERVICE_TOKEN are the trust
	 * anchor, both already on the Worker env.
	 */
	private buildServiceBindingCall(
		ctx: AdapterContext,
	):
		| { serverUrl: string; headers: Record<string, string>; fetchFn: FetchFn }
		| undefined {
		const auth = this.mcpConfig.auth;
		if (auth?.type !== "service-binding") return undefined;

		const env = ctx.env as unknown as {
			MCP_SERVICE?: { fetch: FetchFn };
			MCP_URL?: string;
			PLATFORM_SERVICE_TOKEN?: string;
		};
		if (!env.MCP_SERVICE || !env.MCP_URL) {
			throw new Error(
				"MCP_SERVICE binding or MCP_URL not available for service-binding MCP auth",
			);
		}

		const gatewayHost = new URL(env.MCP_URL).hostname;
		return {
			serverUrl: `${env.MCP_URL}/mcp`,
			fetchFn: env.MCP_SERVICE.fetch.bind(env.MCP_SERVICE),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": auth.organizationId,
				"X-Tedix-Host": `${auth.mcpSlug}.${gatewayHost}`,
				...(env.PLATFORM_SERVICE_TOKEN
					? { Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}` }
					: {}),
			},
		};
	}

	private extractStructured(result: McpToolCallResult): unknown {
		return normalizeMcpAdapterResult(result, this.mcpConfig.itemsPath);
	}

	private extractErrorText(result: McpToolCallResult): string | null {
		if (!Array.isArray(result.content)) return null;
		for (const item of result.content) {
			if (
				item.type === "text" &&
				typeof (item as { text?: string }).text === "string"
			) {
				const text = (item as { text: string }).text.trim();
				if (text) return text;
			}
		}
		return null;
	}

	// =============================================================================
	// ARG BUILDERS
	// =============================================================================

	private buildCategoryRefArgs(
		query: string,
		options: SearchOptions,
	): Record<string, unknown> {
		const categoryInput = this.mcpConfig.categoryRefInput ?? {};
		const categoryKey = categoryInput.categoryKey ?? "category";
		const categoryHintKey = categoryInput.categoryHintKey ?? "categoryHint";
		const userTextKey = categoryInput.userTextKey ?? "userText";

		const args: Record<string, unknown> = {};
		const categoryValue = options.category ?? query;

		if (categoryKey) args[categoryKey] = categoryValue;
		if (categoryHintKey) args[categoryHintKey] = categoryValue;

		if (this.mcpConfig.includeUserText ?? true) {
			args[userTextKey] = query;
		}

		if (this.mcpConfig.categoryRefArgs) {
			for (const [key, value] of Object.entries(
				this.mcpConfig.categoryRefArgs,
			)) {
				if (args[key] === undefined) {
					args[key] = value;
				}
			}
		}

		return args;
	}

	private buildSearchArgs(
		query: string,
		options: SearchOptions,
		categoryRefData: Record<string, unknown> | null,
	): Record<string, unknown> {
		const searchInput = this.mcpConfig.searchInput ?? {};
		const queryKey = searchInput.queryKey ?? "query";
		const queriesKey = searchInput.queriesKey ?? "queries";
		const userTextKey = searchInput.userTextKey ?? "userText";
		const useQueries = searchInput.useQueries ?? false;

		const args: Record<string, unknown> = {
			limit: options.limit,
			country: options.country,
			minPrice: options.minPrice,
			maxPrice: options.maxPrice,
			sort: options.sort,
		};

		if (useQueries) {
			const queries = options.queries?.length ? options.queries : [query];
			args[queriesKey] = queries;
		} else {
			args[queryKey] = query;
		}

		if (this.mcpConfig.includeUserText ?? true) {
			args[userTextKey] = query;
		}

		if (this.mcpConfig.allowGeneric === true) {
			args.allowGeneric = true;
		}

		if (categoryRefData) {
			const categoryRefIdPath =
				this.mcpConfig.categoryRefIdPath ?? "categoryRefId";
			const categoryPath = this.mcpConfig.categoryPath ?? "category";
			const attributesPath = this.mcpConfig.attributesPath ?? "attributes";

			const categoryRefId = getByPath(categoryRefData, categoryRefIdPath);
			const category = getByPath(categoryRefData, categoryPath);
			const attributes = getByPath(categoryRefData, attributesPath);

			if (categoryRefId !== undefined) args.categoryRefId = categoryRefId;
			if (category !== undefined) args.category = category;
			if (attributes !== undefined) args.attributes = attributes;
		}

		if (this.mcpConfig.searchArgs) {
			Object.assign(args, this.mcpConfig.searchArgs);
		}

		// Remove undefined keys to avoid confusing remote MCP servers
		for (const key of Object.keys(args)) {
			if (args[key] === undefined) {
				delete args[key];
			}
		}

		return args;
	}

	// =============================================================================
	// RESPONSE NORMALIZATION
	// =============================================================================

	private extractItems(structured: unknown): unknown[] {
		if (!structured) return [];

		if (Array.isArray(structured)) {
			return structured;
		}

		const root = structured as Record<string, unknown>;
		if (this.mcpConfig.itemsPath) {
			const fromPath = getByPath(root, this.mcpConfig.itemsPath);
			if (Array.isArray(fromPath)) return fromPath;
		}

		const candidates = [
			root.items,
			root.results,
			root.data,
			root.listings,
			root.ads,
		];

		for (const candidate of candidates) {
			if (Array.isArray(candidate)) return candidate as unknown[];
		}

		return [];
	}

	private extractTotal(structured: unknown, fallback: number): number {
		if (!structured || typeof structured !== "object") return fallback;
		const root = structured as Record<string, unknown>;

		if (this.mcpConfig.totalPath) {
			const value = getByPath(root, this.mcpConfig.totalPath);
			if (typeof value === "number") return value;
			if (typeof value === "string") return Number(value) || fallback;
		}

		const candidates = [root.totalResults, root.total, root.count];
		for (const candidate of candidates) {
			if (typeof candidate === "number") return candidate;
			if (typeof candidate === "string") {
				const parsed = Number(candidate);
				if (!Number.isNaN(parsed)) return parsed;
			}
		}

		return fallback;
	}

	private transformToLayoutItem(rawItem: unknown): LayoutItem | null {
		if (!rawItem || typeof rawItem !== "object") {
			return null;
		}

		const raw = rawItem as Record<string, unknown>;
		const result: Record<string, unknown> = {};

		for (const [targetPath, sourcePath] of Object.entries(this.fieldMappings)) {
			const value = getByPath(raw, sourcePath);
			if (value !== undefined) {
				setByPath(result, targetPath, value);
			}
		}

		if (!result.id) {
			result.id =
				raw.id ?? raw._id ?? raw.productId ?? raw.product_id ?? raw.sku ?? "";
		}

		if (!result.title) {
			result.title =
				raw.title ?? raw.name ?? raw.product_name ?? raw.productName ?? "";
		}

		if (!result.id || !result.title) {
			return null;
		}

		const item: LayoutItem = {
			id: String(result.id),
			title: String(result.title),
		};

		if (result.subtitle) item.subtitle = String(result.subtitle);
		if (result.description) item.description = String(result.description);
		if (result.image) {
			item.image = String(result.image);
		} else {
			const rawImage = raw.image ?? raw.imageUrl ?? raw.image_url;
			if (rawImage) item.image = String(rawImage);
		}
		if (result.url) {
			item.url = String(result.url);
		} else if (raw.url) {
			item.url = String(raw.url);
		}

		if (result.images && Array.isArray(result.images)) {
			item.images = result.images.map((img) => String(img));
		} else if (!result.images) {
			const rawImages = raw.images ?? raw.imageUrls ?? raw.image_urls;
			if (Array.isArray(rawImages)) {
				item.images = rawImages.map((img) => String(img));
			} else if (raw.image || raw.imageUrl || raw.image_url) {
				item.images = [String(raw.image ?? raw.imageUrl ?? raw.image_url)];
			}
		}

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
			const rawPricing = raw.pricing as Record<string, unknown> | undefined;
			const rawPrice =
				raw.priceEuros ??
				raw.price_euros ??
				raw.price ??
				raw.amount ??
				rawPricing?.value ??
				raw.currentPrice;
			const parsed = parsePriceValue(rawPrice);
			if (parsed !== null) {
				item.price = {
					amount: parsed,
					currency: String(raw.currency ?? raw.priceCurrency ?? "EUR"),
				};
			}
		}

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

		if (result.badge && typeof result.badge === "object") {
			const badgeObj = result.badge as Record<string, unknown>;
			if (badgeObj.text) {
				item.badge = {
					text: String(badgeObj.text),
					variant: (badgeObj.variant as BadgeVariant) ?? "default",
				};
			}
		}

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

		return item;
	}
}
